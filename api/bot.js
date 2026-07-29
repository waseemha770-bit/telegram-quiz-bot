// ==========================================
// 1. المكتبات والإعدادات (Imports & Config)
// ==========================================
import { initializeApp } from 'firebase/app';
import { initializeFirestore, collection, getDocs, doc, setDoc, getDoc, writeBatch, runTransaction } from 'firebase/firestore';
import * as XLSX from 'xlsx';

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  projectId: process.env.FIREBASE_PROJECT_ID,
};

const app = initializeApp(firebaseConfig);
const db = initializeFirestore(app, { experimentalForceLongPolling: true });

const TIME_LIMIT_SECONDS = 20; // ⏱️ وقت السؤال

// ==========================================
// 2. الثوابت والقوائم (Constants & Keyboards)
// ==========================================
const getAdminId = () => process.env.ADMIN_ID;
const getToken = () => process.env.TELEGRAM_TOKEN;

const USER_KEYBOARD = {
  keyboard: [
    [{ text: "🎮 سؤال جديد" }, { text: "🗂️ تغيير القسم" }],
    [{ text: "🏆 لوحة الشرف" }, { text: "📊 رصيدي الحالي" }],
    [{ text: "🚀 ابدأ من جديد" }]
  ],
  resize_keyboard: true
};

const ADMIN_KEYBOARD = {
  keyboard: [
    [{ text: "🎮 سؤال جديد" }, { text: "🗂️ تغيير القسم" }],
    [{ text: "📥 استيراد إكسل" }, { text: "📤 تصدير إكسل" }],
    [{ text: "👥 تقرير المتسابقين (إكسل)" }],
    [{ text: "🏆 لوحة الشرف" }, { text: "📊 رصيدي الحالي" }],
    [{ text: "🚀 ابدأ من جديد" }]
  ],
  resize_keyboard: true
};

const getKeyboard = (chatId) => (chatId === getAdminId()) ? ADMIN_KEYBOARD : USER_KEYBOARD;

// ==========================================
// 3. دوال مساعدة (Helper Functions)
// ==========================================
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function sendTgMessage(chatId, text, replyMarkup = null) {
  const payload = { chat_id: chatId, text: text, parse_mode: "Markdown" };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${getToken()}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

async function sendTgDocument(chatId, fileBuffer, fileName, caption) {
  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append('document', new Blob([fileBuffer]), fileName);
  formData.append('caption', caption);
  await fetch(`https://api.telegram.org/bot${getToken()}/sendDocument`, {
    method: 'POST', body: formData
  });
}

async function answerTgCallback(callbackId, text) {
  await fetch(`https://api.telegram.org/bot${getToken()}/answerCallbackQuery`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackId, text: text, show_alert: true })
  });
}

async function editTgMessage(chatId, messageId, text = null, replyMarkup = null) {
  const payload = { chat_id: chatId, message_id: messageId };
  if (text) payload.text = text; payload.parse_mode = "Markdown";
  if (replyMarkup) payload.reply_markup = replyMarkup;
  const endpoint = text ? 'editMessageText' : 'editMessageReplyMarkup';
  await fetch(`https://api.telegram.org/bot${getToken()}/${endpoint}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
}

// ==========================================
// 4. دوال نظام الأسئلة والأقسام (Quiz Engine)
// ==========================================
async function showCategories(chatId) {
  const qSnap = await getDocs(collection(db, "questions"));
  let groupsArray = Array.from(new Set(qSnap.docs.map(d => d.data().group || 'عام')));
  
  if (groupsArray.length === 0) return sendTgMessage(chatId, "لا توجد أسئلة متاحة حالياً.", getKeyboard(chatId));

  let inline_keyboard = [];
  for (let i = 0; i < groupsArray.length; i += 2) {
    let row = [{ text: `📁 ${groupsArray[i]}`, callback_data: `cat_${groupsArray[i]}` }];
    if (groupsArray[i+1]) row.push({ text: `📁 ${groupsArray[i+1]}`, callback_data: `cat_${groupsArray[i+1]}` });
    inline_keyboard.push(row);
  }
  return sendTgMessage(chatId, "📚 *اختر القسم الذي ترغب في اختباره:*", { inline_keyboard });
}

async function askQuestion(chatId, category, messageIdToEdit = null, callbackId = null) {
  const userRef = doc(db, "users", chatId);
  const userSnap = await getDoc(userRef);
  let uData = userSnap.exists() ? userSnap.data() : { answered: [] };
  const answered = uData.answered || [];

  const qSnap = await getDocs(collection(db, "questions"));
  let availableQ = [];
  qSnap.forEach(d => {
    const q = d.data();
    if ((q.group || 'عام') === category && !answered.includes(d.id)) availableQ.push({ id: d.id, ...q });
  });

  if (availableQ.length === 0) {
    const endMsg = `🎉 لقد أتممت جميع أسئلة قسم: *${category}*`;
    if (callbackId) await answerTgCallback(callbackId, `🎉 أتممت أسئلة: ${category}`);
    if (messageIdToEdit) return editTgMessage(chatId, messageIdToEdit, endMsg);
    return sendTgMessage(chatId, endMsg, getKeyboard(chatId));
  }

  const q = availableQ[Math.floor(Math.random() * availableQ.length)];
  let buttons = [{ text: q.correct, callback_data: "c_" + q.id }];
  (q.wrong || []).forEach((w, idx) => { if(w) buttons.push({ text: w, callback_data: "w_" + q.id + "_" + idx }) });
  buttons = shuffleArray(buttons);
  
  let inline_keyboard = [];
  for (let i = 0; i < buttons.length; i += 2) inline_keyboard.push(buttons.slice(i, i + 2));

  // تحديث المؤقت وتسجيل القسم النشط لعدم سؤال المستخدم مرة أخرى
  await setDoc(userRef, { last_q_time: Date.now(), active_category: category }, { merge: true });
  
  const qText = `📁 قسم: *${category}*\n\n❓ *${q.question}*\n\n⏱️ أمامك ${TIME_LIMIT_SECONDS} ثانية للإجابة!`;
  
  if (messageIdToEdit) {
      return editTgMessage(chatId, messageIdToEdit, qText, { inline_keyboard });
  } else {
      return sendTgMessage(chatId, qText, { inline_keyboard });
  }
}

// ==========================================
// 5. دوال الإدارة والإكسل (Admin & Excel Functions)
// ==========================================
async function processExcelImport(document, chatId) {
  const fileName = document.file_name;
  if (!fileName.endsWith('.xlsx')) return sendTgMessage(chatId, "❌ يرجى إرسال ملف بصيغة `.xlsx` فقط.", getKeyboard(chatId));

  await sendTgMessage(chatId, "🔄 جاري معالجة البيانات...");
  const fileRes = await fetch(`https://api.telegram.org/bot${getToken()}/getFile?file_id=${document.file_id}`);
  const fileJson = await fileRes.json();

  if (fileJson.ok) {
    const fileBufferResponse = await fetch(`https://api.telegram.org/file/bot${getToken()}/${fileJson.result.file_path}`);
    const arrayBuffer = await fileBufferResponse.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], { header: 1, defval: "" });

    const headers = rows[0];
    const groupIdx = headers.findIndex(h => String(h).includes('المجموعة'));
    let bulkQuestions = [];

    for (let i = 1; i < rows.length; i++) {
      const row = rows[i];
      if (!String(row[0]).trim() || !String(row[1]).trim()) continue;
      let wrong = [];
      for (let col = 2; col < headers.length; col++) {
        if (col !== groupIdx && String(row[col]).trim() !== "") wrong.push(String(row[col]).trim());
      }
      bulkQuestions.push({
        question: String(row[0]).trim(), correct: String(row[1]).trim(),
        wrong: wrong, group: (groupIdx !== -1 && row[groupIdx]) ? String(row[groupIdx]).trim() : 'عام'
      });
    }

    if (bulkQuestions.length > 0) {
      const qSnap = await getDocs(collection(db, "questions"));
      let deleteBatch = writeBatch(db);
      qSnap.forEach(d => deleteBatch.delete(d.ref));
      if (qSnap.size > 0) await deleteBatch.commit();

      let addBatch = writeBatch(db);
      bulkQuestions.forEach(q => addBatch.set(doc(collection(db, "questions")), q));
      await addBatch.commit();

      const uSnap = await getDocs(collection(db, "users"));
      let uBatch = writeBatch(db);
      uSnap.forEach(u => uBatch.update(u.ref, { answered: [] }));
      if (uSnap.size > 0) await uBatch.commit();

      await sendTgMessage(chatId, `🎉 *تم التحديث!*\nتم إدراج: ${bulkQuestions.length} سؤال.`, getKeyboard(chatId));
    }
  }
}

async function exportQuestions(chatId) {
  const qSnap = await getDocs(collection(db, "questions"));
  if (qSnap.empty) return sendTgMessage(chatId, "لا توجد أسئلة للتصدير.", getKeyboard(chatId));

  let allQs = []; qSnap.forEach(d => allQs.push(d.data()));
  let maxWrong = Math.max(...allQs.map(q => q.wrong?.length || 0));

  let exportHeaders = ['السؤال', 'الإجابة الصحيحة', ...Array.from({length: maxWrong}, (_, i) => `خطأ ${i+1}`), 'المجموعة'];
  const excelData = [exportHeaders, ...allQs.map(q => [q.question, q.correct, ...Array.from({length: maxWrong}, (_, i) => q.wrong[i] || ''), q.group || 'عام'])];

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(excelData), "Questions");
  await sendTgDocument(chatId, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), 'firebase_questions.xlsx', '📁 بنك الأسئلة الحالي');
}

async function exportUsersReport(chatId) {
  const uSnap = await getDocs(collection(db, "users"));
  let allUsers = []; uSnap.forEach(d => allUsers.push(d.data()));
  allUsers.sort((a, b) => (b.score || 0) - (a.score || 0));

  const excelData = [['المركز', 'اسم المتسابق', 'إجمالي النقاط', 'الأسئلة المجاب عليها']];
  allUsers.forEach((u, i) => excelData.push([i + 1, u.name || 'مجهول', u.score || 0, (u.answered || []).length]));

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(excelData), "Contestants");
  await sendTgDocument(chatId, XLSX.write(wb, { type: "buffer", bookType: "xlsx" }), 'contestants_report.xlsx', '📊 تقرير المتسابقين');
}

// ==========================================
// 6. معالجة الأزرار الشفافة (Callback Query)
// ==========================================
async function handleCallbackQuery(callbackQuery) {
  const { id: callbackId, data, message, from } = callbackQuery;
  const chatId = message.chat.id.toString();
  const messageId = message.message_id;
  const userName = from.first_name || "مجهول";
  const originalKeyboard = message.reply_markup?.inline_keyboard || [];

  if (data === "ignore") return answerTgCallback(callbackId, "⚠️ لا يمكنك الضغط هنا مجدداً.");

  // 1. اختيار القسم (Category)
  if (data.startsWith("cat_")) {
    const selectedGroup = data.replace("cat_", "");
    return askQuestion(chatId, selectedGroup, messageId, callbackId);
  }

  // 2. طلب السؤال التالي (Next Question)
  if (data === "next_q") {
    // حذف زر "التالي" من الرسالة السابقة لتجنب الضغط المزدوج
    const strippedKeyboard = originalKeyboard.filter(row => !row.some(btn => btn.callback_data === "next_q"));
    await editTgMessage(chatId, messageId, null, { inline_keyboard: strippedKeyboard });

    const userSnap = await getDoc(doc(db, "users", chatId));
    const activeCat = userSnap.exists() ? (userSnap.data().active_category || 'عام') : 'عام';
    return askQuestion(chatId, activeCat, null, callbackId); // نرسله كرسالة جديدة
  }

  // 3. الإجابة على السؤال
  if (data.startsWith("c_") || data.startsWith("w_")) {
    const isCorrect = data.startsWith("c_");
    const qId = data.split('_')[1];
    const userRef = doc(db, "users", chatId);

    try {
      await runTransaction(db, async (transaction) => {
        const uSnap = await transaction.get(userRef);
        let uData = uSnap.exists() ? uSnap.data() : { score: 0, answered: [], name: userName, last_q_time: 0 };
        
        const timeDiff = (Date.now() - (uData.last_q_time || 0)) / 1000;
        if (timeDiff > TIME_LIMIT_SECONDS && (uData.last_q_time || 0) !== 0) throw new Error("TIMEOUT");
        if ((uData.answered || []).includes(qId)) throw new Error("ALREADY_ANSWERED");

        transaction.set(userRef, {
          score: (uData.score || 0) + (isCorrect ? 10 : 0),
          answered: [...(uData.answered || []), qId],
          name: userName
        }, { merge: true });
      });

      // إذا نجحت الإجابة
      await answerTgCallback(callbackId, isCorrect ? "✅ إجابة صحيحة! (+10 نقاط)" : "❌ إجابة خاطئة، حظاً أوفر!");
      const newKeyboard = originalKeyboard.map(row => row.map(btn => ({
        text: btn.callback_data.startsWith('c_') ? "✅ " + btn.text : (btn.callback_data === data ? "❌ " + btn.text : btn.text),
        callback_data: "ignore"
      })));
      
      // ✨ إضافة زر السؤال التالي تحت الإجابة
      newKeyboard.push([{ text: "⏭️ السؤال التالي", callback_data: "next_q" }]);
      await editTgMessage(chatId, messageId, null, { inline_keyboard: newKeyboard });

    } catch (err) {
      if (err.message === "TIMEOUT") {
        await answerTgCallback(callbackId, `⏳ انتهى الوقت!`);
        const timeoutKeyboard = originalKeyboard.map(row => row.map(b => ({ text: "⏳ " + b.text, callback_data: "ignore" })));
        timeoutKeyboard.push([{ text: "⏭️ السؤال التالي", callback_data: "next_q" }]); // إتاحة زر التالي حتى لو انتهى الوقت
        await editTgMessage(chatId, messageId, null, { inline_keyboard: timeoutKeyboard });
      } else if (err.message === "ALREADY_ANSWERED") {
        await answerTgCallback(callbackId, "⚠️ لقد تم تسجيل إجابتك مسبقاً.");
      }
    }
  }
}

// ==========================================
// 7. معالجة الرسائل النصية (Text Messages)
// ==========================================
async function handleMessage(message) {
  const chatId = message.chat.id.toString();
  const text = message.text || "";
  const document = message.document;
  const userName = message.from.first_name || "مجهول";
  const userRef = doc(db, "users", chatId);

  const userSnap = await getDoc(userRef);
  const currentState = userSnap.exists() ? userSnap.data().state : null;
  const activeCat = userSnap.exists() ? userSnap.data().active_category : null;

  if (text === '/start' || text === '🚀 ابدأ من جديد') {
    await setDoc(userRef, { score: 0, answered: [], state: null, name: userName, last_q_time: 0, active_category: null });
    return sendTgMessage(chatId, `أهلاً بك يا *${userName}*! 🚀\nتم تصفير نقاطك. اضغط (سؤال جديد) للبدء:`, getKeyboard(chatId));
  }

  // المدير يرسل الملف
  if (document && chatId === getAdminId() && currentState === "WAITING_FOR_EXCEL") {
    await setDoc(userRef, { state: null }, { merge: true });
    return processExcelImport(document, chatId);
  }

  // أوامر الإدارة
  if ((text === '📤 تصدير إكسل' || text === '/export') && chatId === getAdminId()) return exportQuestions(chatId);
  if (text === '👥 تقرير المتسابقين (إكسل)' && chatId === getAdminId()) return exportUsersReport(chatId);
  if ((text === '📥 استيراد إكسل' || text === '/import') && chatId === getAdminId()) {
    await setDoc(userRef, { state: "WAITING_FOR_EXCEL" }, { merge: true });
    return sendTgMessage(chatId, "📥 **أرسل الآن ملف الإكسل (.xlsx)**.", getKeyboard(chatId));
  }

  // تغيير القسم يدوياً
  if (text === '🗂️ تغيير القسم') {
    return showCategories(chatId);
  }

  // طلب سؤال جديد
  if (text === '/quiz' || text === '🎮 سؤال جديد') {
    if (activeCat) {
       return askQuestion(chatId, activeCat, null, null); // إرسال سؤال فوراً دون سؤال المستخدم
    } else {
       return showCategories(chatId); // سؤاله عن القسم لأول مرة
    }
  }

  if (text === '/score' || text === '📊 رصيدي الحالي') {
    return sendTgMessage(chatId, `🏆 رصيدك الحالي: *${userSnap.exists() ? (userSnap.data().score || 0) : 0} نقطة*`, getKeyboard(chatId));
  }

  if (text === '/top' || text === '🏆 لوحة الشرف') {
    const uSnap = await getDocs(collection(db, "users"));
    let topUsers = uSnap.docs.map(d => d.data()).filter(u => (u.score || 0) > 0).sort((a, b) => b.score - a.score).slice(0, 10);
    
    if (topUsers.length === 0) return sendTgMessage(chatId, "لا توجد نقاط مسجلة حتى الآن.", getKeyboard(chatId));
    
    let topText = "🏆 *أفضل 10 متسابقين:*\n\n" + topUsers.map((u, i) => `${i + 1}. ${u.name || 'مجهول'} - ${u.score} نقطة`).join('\n');
    return sendTgMessage(chatId, topText, getKeyboard(chatId));
  }
}

// ==========================================
// 8. النقطة الرئيسية (Vercel Handler)
// ==========================================
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('✅ البوت يعمل بنجاح (مع ميزة تخطي اختيار الأقسام وتسريع اللعب)!');
  
  try {
    const body = req.body;
    if (body.callback_query) await handleCallbackQuery(body.callback_query);
    else if (body.message) await handleMessage(body.message);
  } catch (error) {
    console.error("Execution error:", error);
  }
  
  return res.status(200).json({ success: true });
}
