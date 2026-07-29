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

const TIME_LIMIT_SECONDS = 20;

// ==========================================
// 2. قوائم الأزرار (Keyboards)
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

// لوحة المالك (تحتوي على زر إدارة المشرفين السري)
const OWNER_KEYBOARD = {
  keyboard: [
    [{ text: "🎮 سؤال جديد" }, { text: "🗂️ تغيير القسم" }],
    [{ text: "📥 استيراد إكسل" }, { text: "📤 تصدير إكسل" }],
    [{ text: "👥 تقرير المتسابقين (إكسل)" }, { text: "⚙️ إدارة المشرفين" }],
    [{ text: "🏆 لوحة الشرف" }, { text: "📊 رصيدي الحالي" }],
    [{ text: "🚀 ابدأ من جديد" }]
  ],
  resize_keyboard: true
};

function getKeyboard(isOwner, isAdmin) {
  if (isOwner) return OWNER_KEYBOARD;
  if (isAdmin) return ADMIN_KEYBOARD;
  return USER_KEYBOARD;
}

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
  if (!name) return 'عام';
  if (name.includes(':')) return name.split(':').pop().trim();
  return name.replace(/المجموعة/g, '').replace(/قسم/g, '').replace(/الأولى/g, '').trim();
}

function getRank(score) {
  if (score < 50) return "مبتدئ 🌱";
  if (score < 150) return "متسابق نشط ⚡";
  if (score < 300) return "محترف 🏅";
  return "أسطورة المعرفة 🔥";
}

function buildDynamicKeyboard(buttonsArray, maxLength = 20) {
  let inline_keyboard = [];
  let currentRow = [];
  for (let btn of buttonsArray) {
    if (btn.text.length > maxLength) {
      if (currentRow.length > 0) { inline_keyboard.push(currentRow); currentRow = []; }
      inline_keyboard.push([btn]);
    } else {
      currentRow.push(btn);
      if (currentRow.length === 2) { inline_keyboard.push(currentRow); currentRow = []; }
    }
  }
  if (currentRow.length > 0) inline_keyboard.push(currentRow);
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
// 4. محرك الأسئلة والأقسام (Quiz Engine)
// ==========================================
async function showCategories(chatId, isOwner, isAdmin) {
  const qSnap = await getDocs(collection(db, "questions"));
  let groupsArray = Array.from(new Set(qSnap.docs.map(d => d.data().group || 'عام')));
  
  if (groupsArray.length === 0) return sendTgMessage(chatId, "لا توجد أسئلة متاحة حالياً.", getKeyboard(isOwner, isAdmin));

  let catButtons = groupsArray.map(g => ({ text: `📁 ${cleanName(g)}`, callback_data: `cat_${g}` }));
  let inline_keyboard = buildDynamicKeyboard(catButtons, 18); 

  return sendTgMessage(chatId, "📚 *اختر القسم الذي ترغب في اختباره:*", { inline_keyboard });
}

async function askQuestion(chatId, category, messageIdToEdit = null, callbackId = null, isOwner, isAdmin) {
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
    return sendTgMessage(chatId, endMsg, getKeyboard(isOwner, isAdmin));
  }

  const q = availableQ[Math.floor(Math.random() * availableQ.length)];
  const timestamp = Date.now(); 
  const isGold = Math.random() < 0.15 ? 1 : 0; 
  
  let rawButtons = [{ text: q.correct, callback_data: `c_${q.id}_${timestamp}_${isGold}` }];
  (q.wrong || []).forEach((w, idx) => { if(w) rawButtons.push({ text: w, callback_data: `w_${q.id}_${idx}_${timestamp}_${isGold}` }) });
  rawButtons = shuffleArray(rawButtons);
  let inline_keyboard = buildDynamicKeyboard(rawButtons, 20); 

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
async function processExcelImport(document, chatId, isOwner, isAdmin) {
  const fileName = document.file_name;
  if (!fileName.endsWith('.xlsx')) return sendTgMessage(chatId, "❌ يرجى إرسال ملف بصيغة `.xlsx` فقط.", getKeyboard(isOwner, isAdmin));
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
      await sendTgMessage(chatId, `🎉 *تم التحديث!*\nتم إدراج: ${bulkQuestions.length} سؤال.`, getKeyboard(isOwner, isAdmin));
    }
  }
}

async function exportQuestions(chatId) {
  const qSnap = await getDocs(collection(db, "questions"));
  if (qSnap.empty) return sendTgMessage(chatId, "لا توجد أسئلة للتصدير.");

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

  // ✨ جلب قائمة المشرفين للتحقق ✨
  const adminDocRef = doc(db, "bot_settings", "admins");
  const adminDocSnap = await getDoc(adminDocRef);
  let adminsArray = adminDocSnap.exists() ? (adminDocSnap.data().list || []) : [];
  const isOwner = (userId === getAdminId());
  const isAdmin = isOwner || adminsArray.includes(userId);

  if (data === "ignore") return answerTgCallback(callbackId, "⚠️ لا يمكنك الضغط هنا مجدداً.");

  // ✨ أوامر المالك: إضافة أو إزالة مشرف ✨
  if (isOwner) {
    if (data === "add_admin") {
      await setDoc(doc(db, "users", userId), { state: "WAITING_FOR_ADMIN_ADD" }, { merge: true });
      return editTgMessage(chatId, messageId, "➕ *إضافة مشرف جديد:*\n\nالرجاء إرسال الآيدي (ID) الخاص بالشخص الذي تريد تعيينه كمشرف الآن:");
    }
    if (data === "list_admins") {
      let txt = "📋 *قائمة المشرفين الحاليين:*\n\n";
      if (adminsArray.length === 0) txt += "لا يوجد مشرفين إضافيين (أنت فقط).";
      else adminsArray.forEach((id, i) => txt += `${i+1}. 🆔 \`${id}\`\n`);
      return editTgMessage(chatId, messageId, txt);
    }
    if (data === "remove_admin") {
      if (adminsArray.length === 0) return answerTgCallback(callbackId, "لا يوجد مشرفين إضافيين لحذفهم.");
      let inline_keyboard = adminsArray.map(id => ([{ text: `❌ حذف ${id}`, callback_data: `del_adm_${id}` }]));
      return editTgMessage(chatId, messageId, "➖ *إزالة مشرف:*\n\nاضغط على المشرف الذي ترغب في إزالته:", { inline_keyboard });
    }
    if (data.startsWith("del_adm_")) {
      const idToRemove = data.replace("del_adm_", "");
      adminsArray = adminsArray.filter(id => id !== idToRemove);
      await setDoc(adminDocRef, { list: adminsArray }, { merge: true });
      await answerTgCallback(callbackId, `تم إزالة المشرف (${idToRemove}) بنجاح!`);
      return editTgMessage(chatId, messageId, `✅ تمت إزالة المشرف: \`${idToRemove}\``);
    }
  }

  if (data.startsWith("cat_")) {
    const selectedGroup = data.replace("cat_", "");
    return askQuestion(chatId, selectedGroup, messageId, callbackId, isOwner, isAdmin);
  }

  if (data === "next_q") {
    const strippedKeyboard = originalKeyboard.filter(row => !row.some(btn => btn.callback_data === "next_q"));
    await editTgMessage(chatId, messageId, null, { inline_keyboard: strippedKeyboard });
    const chatSnap = await getDoc(doc(db, "users", chatId));
    const activeCat = chatSnap.exists() ? (chatSnap.data().active_category || 'عام') : 'عام';
    return askQuestion(chatId, activeCat, null, callbackId, isOwner, isAdmin);
  }

  if (data.startsWith("c_") || data.startsWith("w_")) {
    const parts = data.split('_');
    const isCorrect = parts[0] === 'c';
    const qId = parts[1];
    const timestamp = parseInt(parts[2]);
    const isGold = parseInt(parts[3]) === 1;

    const chatRef = doc(db, "users", chatId);
    const userRef = doc(db, "users", userId);
    let alertMsg = "";

    try {
      await runTransaction(db, async (transaction) => {
        const chatSnap = await transaction.get(chatRef);
        const uSnap = (chatId === userId) ? chatSnap : await transaction.get(userRef);
        
        let chatData = chatSnap.exists() ? chatSnap.data() : { answered: [] };
        let uData = uSnap.exists() ? uSnap.data() : { score: 0, streak: 0, name: userName };
        
        const currentTime = Date.now();
        const timeDiffSeconds = (currentTime - timestamp) / 1000;
        
        if (timeDiffSeconds > TIME_LIMIT_SECONDS) throw new Error("TIMEOUT");
        if ((chatData.answered || []).includes(qId)) throw new Error("ALREADY_ANSWERED");

        let earnedPoints = 0;
        let currentStreak = uData.streak || 0;

        if (isCorrect) {
            earnedPoints = 10;
            let msgParts = [`✅ إجابة صحيحة! (+10)`];
            msgParts.push(`⏱️ استغرقت: ${timeDiffSeconds.toFixed(1)} ثانية`);
            
            if (timeDiffSeconds <= 5) { earnedPoints += 5; msgParts.push("⚡ سرعة خارقة (+5)"); }
            currentStreak += 1;
            if (currentStreak >= 3) { earnedPoints += 5; msgParts.push(`🔥 سلسلة ${currentStreak} إجابات (+5)`); }
            if (isGold) { earnedPoints *= 2; msgParts.push("🌟 ضربة ذهبية! (النقاط x2)"); }
            
            alertMsg = msgParts.join("\n") + `\n\nالمجموع: +${earnedPoints} نقطة!`;
        } else {
            currentStreak = 0;
            alertMsg = `❌ إجابة خاطئة!\n⏱️ استغرقت: ${timeDiffSeconds.toFixed(1)} ثانية\nانكسرت سلسلة انتصاراتك!`;
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
  const userId = message.from ? message.from.id.toString() : chatId;
  const text = message.text || "";
  const document = message.document;
  const userName = message.from ? (message.from.first_name || "مجهول") : "مجهول";
  
  // ✨ جلب قائمة المشرفين وتحديد الصلاحيات ✨
  const adminDocRef = doc(db, "bot_settings", "admins");
  const adminDocSnap = await getDoc(adminDocRef);
  let adminsArray = adminDocSnap.exists() ? (adminDocSnap.data().list || []) : [];
  const isOwner = (userId === getAdminId());
  const isAdmin = isOwner || adminsArray.includes(userId);

  const currentKeyboard = getKeyboard(isOwner, isAdmin);
  
  const userRef = doc(db, "users", userId);
  const chatRef = doc(db, "users", chatId); 
  
  if (message.new_chat_members) {
    for (let member of message.new_chat_members) {
      if (member.is_bot && member.username === message.chat.username) {
        await sendTgMessage(chatId, `مرحباً بالجميع! 🌟\nأنا بوت المسابقات الذكي. أرسلوا /quiz لنبدأ!`);
      } else if (!member.is_bot) {
        await sendTgMessage(chatId, `أهلاً بك يا [${member.first_name}](tg://user?id=${member.id}) في المجموعة! 🥳\nهل أنت مستعد لاختبار معلوماتك؟ أرسل /quiz للبدء!`);
      }
    }
    return;
  }

  const userSnap = await getDoc(userRef);
  const chatSnap = await getDoc(chatRef);

  // ✨ استقبال الآيدي الخاص بالمشرف الجديد من المالك ✨
  if (isOwner && userSnap.exists() && userSnap.data().state === "WAITING_FOR_ADMIN_ADD") {
    const newAdminId = text.trim();
    if (!/^\d+$/.test(newAdminId)) { // التحقق من أن النص أرقام فقط
      return sendTgMessage(chatId, "⚠️ يرجى إرسال أرقام الآيدي (ID) بشكل صحيح فقط.", currentKeyboard);
    }
    if (!adminsArray.includes(newAdminId)) {
       adminsArray.push(newAdminId);
       await setDoc(adminDocRef, { list: adminsArray }, { merge: true });
    }
    await setDoc(userRef, { state: null }, { merge: true });
    return sendTgMessage(chatId, `✅ تم تعيين المستخدم (${newAdminId}) كمشرف بنجاح!`, currentKeyboard);
  }

  // ✨ فتح لوحة إدارة المشرفين السريّة للمالك ✨
  if (isOwner && text === '⚙️ إدارة المشرفين') {
    const inline_keyboard = [
      [{ text: "➕ إضافة مشرف", callback_data: "add_admin" }, { text: "📋 قائمة المشرفين", callback_data: "list_admins" }],
      [{ text: "➖ إزالة مشرف", callback_data: "remove_admin" }]
    ];
    return sendTgMessage(chatId, "⚙️ *لوحة إدارة المشرفين:*\n\nالرجاء اختيار الإجراء المطلوب من الأزرار بالأسفل:", { inline_keyboard });
  }

  if (text === '/start' || text === '🚀 ابدأ من جديد') {
    await setDoc(userRef, { score: 0, streak: 0, name: userName }, { merge: true });
    await setDoc(chatRef, { answered: [], active_category: null }, { merge: true });
    
    const welcomeText = `مرحباً بك يا *${userName}* في عالم التحدي والمعرفة! 🌟🎮\n\n` +
                        `*📋 قواعد الإجابة الصحيحة:* \n` +
                        `⏱️ *الوقت:* أمامك 20 ثانية فقط للإجابة.\n` +
                        `⚡ *السرعة:* إجابتك في أول 5 ثوانٍ تمنحك (+5 نقاط إضافية).\n` +
                        `🔥 *السلسلة:* 3 إجابات صحيحة متتالية تضاعف نقاطك!\n` +
                        `🌟 *الأسئلة الذهبية:* تظهر فجأة وتضاعف رصيدك.\n\n` +
                        `اضغط على (🎮 *سؤال جديد*) من القائمة بالأسفل للبدء! 👇`;
                        
    return sendTgMessage(chatId, welcomeText, currentKeyboard);
  }

  if (document && isAdmin && (userSnap.exists() && userSnap.data().state === "WAITING_FOR_EXCEL")) {
    await setDoc(userRef, { state: null }, { merge: true });
    return processExcelImport(document, chatId, isOwner, isAdmin);
  }

  if (isAdmin && (text === '📥 استيراد إكسل' || text === '/import')) {
    await setDoc(userRef, { state: "WAITING_FOR_EXCEL" }, { merge: true });
    return sendTgMessage(chatId, "📥 **أرسل الآن ملف الإكسل (.xlsx)**.", currentKeyboard);
  }

  if (isAdmin && (text === '📤 تصدير إكسل' || text === '/export')) return exportQuestions(chatId);
  if (isAdmin && text === '👥 تقرير المتسابقين (إكسل)') return exportUsersReport(chatId);

  if (text === '🗂️ تغيير القسم') return showCategories(chatId, isOwner, isAdmin);

  if (text === '/quiz' || text === '🎮 سؤال جديد') {
    const activeCat = chatSnap.exists() ? chatSnap.data().active_category : null;
    if (activeCat) return askQuestion(chatId, activeCat, null, null, isOwner, isAdmin); 
    return showCategories(chatId, isOwner, isAdmin); 
  }

  if (text === '/score' || text === '📊 رصيدي الحالي') {
    const score = userSnap.exists() ? (userSnap.data().score || 0) : 0;
    return sendTgMessage(chatId, `🏆 رصيدك الحالي: *${score} نقطة*\n🎖️ اللقب: *${getRank(score)}*`, currentKeyboard);
  }

  if (text === '/top' || text === '🏆 لوحة الشرف') {
    const uSnap = await getDocs(collection(db, "users"));
    let topUsers = uSnap.docs.map(d => d.data()).filter(u => (u.score || 0) > 0).sort((a, b) => b.score - a.score).slice(0, 10);
    if (topUsers.length === 0) return sendTgMessage(chatId, "لا توجد نقاط مسجلة حتى الآن.", currentKeyboard);
    
    let topText = "🏆 *أفضل المتسابقين:*\n\n" + topUsers.map((u, i) => `${i + 1}. ${u.name || 'مجهول'} - ${u.score} نقطة (${getRank(u.score)})`).join('\n');
    return sendTgMessage(chatId, topText, currentKeyboard);
  }
}

// ==========================================
// 8. النقطة الرئيسية (Vercel Handler)
// ==========================================
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(200).send('✅ البوت الخارق يعمل مع نظام إدارة الصلاحيات والمشرفين!');
  try {
    const body = req.body;
    if (body.callback_query) await handleCallbackQuery(body.callback_query);
    else if (body.message) await handleMessage(body.message);
  } catch (error) { console.error("Execution error:", error); }
  return res.status(200).json({ success: true });
}
