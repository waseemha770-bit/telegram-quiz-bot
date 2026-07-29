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

const getKeyboard = (userId) => (userId === getAdminId()) ? ADMIN_KEYBOARD : USER_KEYBOARD;

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

function cleanName(name) {
  if (name.includes(':')) return name.split(':').pop().trim();
  return name.replace(/المجموعة/g, '').replace(/قسم/g, '').replace(/الأولى/g, '').trim();
}

function getRank(score) {
  if (score < 50) return "مبتدئ 🌱";
  if (score < 150) return "متسابق نشط ⚡";
  if (score < 300) return "محترف 🏅";
  return "أسطورة المعرفة 🔥";
}

// ✨ الدالة السحرية: تصميم ديناميكي للأزرار بناءً على طول النص
function buildDynamicKeyboard(buttonsArray, maxLength = 20) {
  let inline_keyboard = [];
  let currentRow = [];

  for (let btn of buttonsArray) {
    if (btn.text.length > maxLength) {
      // إذا كان النص طويلاً، ندفع الأزرار السابقة (إن وجدت) ثم نضع هذا الزر في سطر لوحده
      if (currentRow.length > 0) {
        inline_keyboard.push(currentRow);
        currentRow = [];
      }
      inline_keyboard.push([btn]);
    } else {
      // إذا كان النص قصيراً، نضعه في السطر الحالي
      currentRow.push(btn);
      // إذا اكتمل السطر (زرين)، نرسله ونفتح سطراً جديداً
      if (currentRow.length === 2) {
        inline_keyboard.push(currentRow);
        currentRow = [];
      }
    }
  }
  // إذا تبقى زر فردي في السطر الأخير، نرسله
  if (currentRow.length > 0) {
    inline_keyboard.push(currentRow);
  }

  return inline_keyboard;
}

async function sendTgMessage(chatId, text, replyMarkup = null) {
  const payload = { chat_id: chatId, text: text, parse_mode: "Markdown" };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${getToken()}/sendMessage`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

async function sendTgDocument(chatId, fileBuffer, fileName, caption) {
  const formData = new FormData();
  formData.append('chat_id', chatId);
  formData.append('document', new Blob([fileBuffer]), fileName);
  formData.append('caption', caption);
  await fetch(`https://api.telegram.org/bot${getToken()}/sendDocument`, { method: 'POST', body: formData });
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
  await fetch(`https://api.telegram.org/bot${getToken()}/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
}

// ==========================================
// 4. دوال نظام الأسئلة والأقسام (Quiz Engine)
// ==========================================
async function showCategories(chatId, userId) {
  const qSnap = await getDocs(collection(db, "questions"));
  let groupsArray = Array.from(new Set(qSnap.docs.map(d => d.data().group || 'عام')));
  
  if (groupsArray.length === 0) return sendTgMessage(chatId, "لا توجد أسئلة متاحة حالياً.", getKeyboard(userId));

  // تحويل الأقسام إلى مصفوفة أزرار ثم تمريرها للدالة الديناميكية
  let catButtons = groupsArray.map(g => ({
      text: `📁 ${cleanName(g)}`,
      callback_data: `cat_${g}`
  }));

  let inline_keyboard = buildDynamicKeyboard(catButtons, 18); // حد أقصى 18 حرف للزر القصير

  return sendTgMessage(chatId, "📚 *اختر القسم الذي ترغب في اختباره:*", { inline_keyboard });
}

async function askQuestion(chatId, category, messageIdToEdit = null, callbackId = null, userId = null) {
  const chatRef = doc(db, "users", chatId);
  const chatSnap = await getDoc(chatRef);
  const answered = chatSnap.exists() ? (chatSnap.data().answered || []) : [];

  const qSnap = await getDocs(collection(db, "questions"));
  let availableQ = [];
  qSnap.forEach(d => {
    if ((d.data().group || 'عام') === category && !answered.includes(d.id)) availableQ.push({ id: d.id, ...d.data() });
  });

  let displayCat = cleanName(category);

  if (availableQ.length === 0) {
    const endMsg = `🎉 لقد أتممت جميع أسئلة: *${displayCat}*`;
    if (callbackId) await answerTgCallback(callbackId, `🎉 أتممت أسئلة: ${displayCat}`);
    if (messageIdToEdit) return editTgMessage(chatId, messageIdToEdit, endMsg);
    return sendTgMessage(chatId, endMsg, getKeyboard(userId));
  }

  const q = availableQ[Math.floor(Math.random() * availableQ.length)];
  
  const timestamp = Math.floor(Date.now() / 1000);
  const isGold = Math.random() < 0.15 ? 1 : 0; 
  
  let rawButtons = [{ text: q.correct, callback_data: `c_${q.id}_${timestamp}_${isGold}` }];
  (q.wrong || []).forEach((w, idx) => { if(w) rawButtons.push({ text: w, callback_data: `w_${q.id}_${idx}_${timestamp}_${isGold}` }) });
  
  // خلط الأزرار عشوائياً
  rawButtons = shuffleArray(rawButtons);
  
  // بناء لوحة الأزرار بشكل ديناميكي (النص الطويل سطر كامل، القصير زرين)
  let inline_keyboard = buildDynamicKeyboard(rawButtons, 20); // 20 حرف كحد للزر

  await setDoc(chatRef, { active_category: category }, { merge: true });
  
  let qText = `📁 *${displayCat}*\n\n`;
  if (isGold === 1) qText += `🌟 *سؤال ذهبي! نقاط مضاعفة!* 🌟\n\n`;
  qText += `❓ *${q.question}*\n\n⏱️ أمامك ${TIME_LIMIT_SECONDS} ثانية للإجابة!`;
  
  if (messageIdToEdit) return editTgMessage(chatId, messageIdToEdit, qText, { inline_keyboard });
  return sendTgMessage(chatId, qText, { inline_keyboard });
}

// ==========================================
// 5. دوال الإدارة والإكسل (Admin & Excel Functions)
// ==========================================
async function processExcelImport(document, chatId, userId) {
  const fileName = document.file_name;
  if (!fileName.endsWith('.xlsx')) return sendTgMessage(chatId, "❌ يرجى إرسال ملف بصيغة `.xlsx` فقط.", getKeyboard(userId));
  await sendTgMessage(chatId, "🔄 جاري معالجة البيانات...");
  const fileRes = await fetch(`https://api.telegram.org/bot${getToken()}/getFile?file_id=${document.file_id}`);
  const fileJson = await fileRes.json();

  if (fileJson.ok) {
    const arrayBuffer = await (await fetch(`https://api.telegram.org/file/bot${getToken()}/${fileJson.result.file_path}`)).arrayBuffer();
    const rows = XLSX.utils.sheet_to_json(XLSX.read(arrayBuffer, { type: 'buffer' }).Sheets[XLSX.read(arrayBuffer, { type: 'buffer' }).SheetNames[0]], { header: 1, defval: "" });
    const groupIdx = rows[0].findIndex(h => String(h).includes('المجموعة'));
    let bulkQuestions = [];

    for (let i = 1; i < rows.length; i++) {
      if (!String(rows[i][0]).trim() || !String(rows[i][1]).trim()) continue;
      let wrong = [];
      for (let col = 2; col < rows[0].length; col++) if (col !== groupIdx && String(rows[i][col]).trim() !== "") wrong.push(String(rows[i][col]).trim());
      bulkQuestions.push({ question: String(rows[i][0]).trim(), correct: String(rows[i][1]).trim(), wrong: wrong, group: (groupIdx !== -1 && rows[i][groupIdx]) ? String(rows[i][groupIdx]).trim() : 'عام' });
    }

    if (bulkQuestions.length > 0) {
      const qSnap = await getDocs(collection(db, "questions"));
      let deleteBatch = writeBatch(db); qSnap.forEach(d => deleteBatch.delete(d.ref)); if (qSnap.size > 0) await deleteBatch.commit();
      let addBatch = writeBatch(db); bulkQuestions.forEach(q => addBatch.set(doc(collection(db, "questions")), q)); await addBatch.commit();
      const uSnap = await getDocs(collection(db, "users"));
      let uBatch = writeBatch(db); uSnap.forEach(u => uBatch.update(u.ref, { answered: [] })); if (uSnap.size > 0) await uBatch.commit();
      await sendTgMessage(chatId, `🎉 *تم التحديث!*\nتم إدراج: ${bulkQuestions.length} سؤال.`, getKeyboard(userId));
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
  const userId = from.id.toString(); 
  const messageId = message.message_id;
  const userName = from.first_name || "مجهول";
  const originalKeyboard = message.reply_markup?.inline_keyboard || [];

  if (data === "ignore") return answerTgCallback(callbackId, "⚠️ لا يمكنك الضغط هنا مجدداً.");

  if (data.startsWith("cat_")) {
    const selectedGroup = data.replace("cat_", "");
    return askQuestion(chatId, selectedGroup, messageId, callbackId, userId);
  }

  if (data === "next_q") {
    const strippedKeyboard = originalKeyboard.filter(row => !row.some(btn => btn.callback_data === "next_q"));
    await editTgMessage(chatId, messageId, null, { inline_keyboard: strippedKeyboard });
    const chatSnap = await getDoc(doc(db, "users", chatId));
    const activeCat = chatSnap.exists() ? (chatSnap.data().active_category || 'عام') : 'عام';
    return askQuestion(chatId, activeCat, null, callbackId, userId);
  }

  if (data.startsWith("c_") || data.startsWith("w_")) {
    const parts = data.split('_');
    const isCorrect = parts[0] === 'c';
    const qId = parts[1];
    const timestamp = isCorrect ? parseInt(parts[2]) : parseInt(parts[3]);
    const isGold = (isCorrect ? parseInt(parts[3]) : parseInt(parts[4])) === 1;

    const chatRef = doc(db, "users", chatId);
    const userRef = doc(db, "users", userId);
    let alertMsg = "";

    try {
      await runTransaction(db, async (transaction) => {
        const chatSnap = await transaction.get(chatRef);
        const uSnap = (chatId === userId) ? chatSnap : await transaction.get(userRef);
        
        let chatData = chatSnap.exists() ? chatSnap.data() : { answered: [] };
        let uData = uSnap.exists() ? uSnap.data() : { score: 0, streak: 0, name: userName };
        
        if (((Date.now() / 1000) - timestamp) > TIME_LIMIT_SECONDS) throw new Error("TIMEOUT");
        if ((chatData.answered || []).includes(qId)) throw new Error("ALREADY_ANSWERED");

        let earnedPoints = 0;
        let currentStreak = uData.streak || 0;

        if (isCorrect) {
            earnedPoints = 10;
            let msgParts = ["✅ إجابة صحيحة! (+10)"];
            
            if (((Date.now() / 1000) - timestamp) <= 5) { earnedPoints += 5; msgParts.push("⚡ سرعة خارقة (+5)"); }
            
            currentStreak += 1;
            if (currentStreak >= 3) { earnedPoints += 5; msgParts.push(`🔥 سلسلة ${currentStreak} إجابات (+5)`); }
            
            if (isGold) { earnedPoints *= 2; msgParts.push("🌟 ضربة ذهبية! (النقاط x2)"); }
            
            alertMsg = msgParts.join("\n") + `\n\nالمجموع: +${earnedPoints} نقطة!`;
        } else {
            currentStreak = 0;
            alertMsg = "❌ إجابة خاطئة، انكسرت سلسلة انتصاراتك!";
        }

        let updatedChatData = { answered: [...(chatData.answered || []), qId] };
        let updatedUData = { score: (uData.score || 0) + earnedPoints, streak: currentStreak, name: userName };

        if (chatId === userId) {
            transaction.set(userRef, { ...updatedChatData, ...updatedUData }, { merge: true });
        } else {
            transaction.set(chatRef, updatedChatData, { merge: true });
            transaction.set(userRef, updatedUData, { merge: true });
        }
      });

      await answerTgCallback(callbackId, alertMsg);
      
      const newKeyboard = originalKeyboard.map(row => row.map(btn => ({
        text: btn.callback_data.startsWith('c_') ? "✅ " + btn.text : (btn.callback_data === data ? "❌ " + btn.text : btn.text),
        callback_data: "ignore"
      })));
      newKeyboard.push([{ text: "⏭️ السؤال التالي", callback_data: "next_q" }]);
      await editTgMessage(chatId, messageId, null, { inline_keyboard: newKeyboard });

    } catch (err) {
      if (err.message === "TIMEOUT") {
        await answerTgCallback(callbackId, `⏳ انتهى الوقت!`);
        const timeoutKeyboard = originalKeyboard.map(row => row.map(b => ({ text: "⏳ " + b.text, callback_data: "ignore" })));
        timeoutKeyboard.push([{ text: "⏭️ السؤال التالي", callback_data: "next_q" }]); 
        await editTgMessage(chatId, messageId, null, { inline_keyboard: timeoutKeyboard });
      } else if (err.message === "ALREADY_ANSWERED") {
        await answerTgCallback(callbackId, "⚠️ لقد تم الإجابة على هذا السؤال بالفعل.");
      }
    }
  }
}

// ==========================================
// 7. معالجة الرسائل النصية (Text Messages)
// ==========================================
async function handleMessage(message) {
  const chatId = message.chat.id.toString();
  const userId = message.from.id.toString();
  const isAdmin = (userId === getAdminId());
  const text = message.text || "";
  const document = message.document;
  const userName = message.from.first_name || "مجهول";
  
  const userRef = doc(db, "users", userId);
  const chatRef = doc(db, "users", chatId); 
  const userSnap = await getDoc(userRef);
  const chatSnap = await getDoc(chatRef);

  if (text === '/start' || text === '🚀 ابدأ من جديد') {
    await setDoc(userRef, { score: 0, streak: 0, name: userName }, { merge: true });
    await setDoc(chatRef, { answered: [], active_category: null }, { merge: true });
    return sendTgMessage(chatId, `أهلاً بك يا *${userName}*! 🚀\nتم تصفير الرصيد. اضغط (سؤال جديد) للبدء:`, getKeyboard(userId));
  }

  if (document && isAdmin && (userSnap.exists() && userSnap.data().state === "WAITING_FOR_EXCEL")) {
    await setDoc(userRef, { state: null }, { merge: true });
    return processExcelImport(document, chatId, userId);
  }

  if (isAdmin && (text === '📥 استيراد إكسل' || text === '/import')) {
    await setDoc(userRef, { state: "WAITING_FOR_EXCEL" }, { merge: true });
    return sendTgMessage(chatId, "📥 **أرسل الآن ملف الإكسل (.xlsx)**.", getKeyboard(userId));
  }

  if (text === '🗂️ تغيير القسم') return showCategories(chatId, userId);

  if (text === '/quiz' || text === '🎮 سؤال جديد') {
    const activeCat = chatSnap.exists() ? chatSnap.data().active_category : null;
    if (activeCat) return askQuestion(chatId, activeCat, null, null, userId); 
    return showCategories(chatId, userId); 
  }

  if (text === '/score' || text === '📊 رصيدي الحالي') {
    const score = userSnap.exists() ? (userSnap.data().score || 0) : 0;
    return sendTgMessage(chatId, `🏆 رصيدك الحالي: *${score} نقطة*\n🎖️ اللقب: *${getRank(score)}*`, getKeyboard(userId));
  }

  if (text === '/top' || text === '🏆 لوحة الشرف') {
    const uSnap = await getDocs(collection(db, "users"));
    let topUsers = uSnap.docs.map(d => d.data()).filter(u => (u.score || 0) > 0).sort((a, b) => b.score - a.score).slice(0, 10);
    if (topUsers.length === 0) return sendTgMessage(chatId, "لا توجد نقاط مسجلة حتى الآن.", getKeyboard(userId));
    
    let topText = "🏆 *أفضل المتسابقين:*\n\n" + topUsers.map((u, i) => `${i + 1}. ${u.name || 'مجهول'} - ${u.score} نقطة (${getRank(u.score)})`).join('\n');
    return sendTgMessage(chatId, topText, getKeyboard(userId));
  }
}

// ==========================================
// 8. النقطة الرئيسية (Vercel Handler)
// ==========================================
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('✅ البوت يعمل بواجهة استجابة ديناميكية مذهلة!');
  try {
    const body = req.body;
    if (body.callback_query) await handleCallbackQuery(body.callback_query);
    else if (body.message) await handleMessage(body.message);
  } catch (error) { console.error("Execution error:", error); }
  return res.status(200).json({ success: true });
}
