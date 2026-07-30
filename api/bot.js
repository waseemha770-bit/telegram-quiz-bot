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
    [{ text: "👥 تقرير المتسابقين" }, { text: "📢 إرسال للمجموعة" }],
    [{ text: "📈 إحصائيات التفاعل" }, { text: "🔗 ربط بمجموعة" }],
    [{ text: "🏆 لوحة الشرف" }, { text: "📊 رصيدي الحالي" }],
    [{ text: "🚀 ابدأ من جديد" }]
  ],
  resize_keyboard: true
};

const OWNER_KEYBOARD = {
  keyboard: [
    [{ text: "🎮 سؤال جديد" }, { text: "🗂️ تغيير القسم" }],
    [{ text: "📥 استيراد إكسل" }, { text: "📤 تصدير إكسل" }],
    [{ text: "👥 تقرير المتسابقين" }, { text: "⚙️ إدارة المشرفين" }],
    [{ text: "📢 إرسال للمجموعة" }, { text: "📈 إحصائيات التفاعل" }],
    [{ text: "🏆 لوحة الشرف" }, { text: "🔗 ربط بمجموعة" }],
    [{ text: "📊 رصيدي الحالي" }, { text: "🚀 ابدأ من جديد" }]
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
  if (name.includes('-')) return name.split('-').pop().trim();
  if (name.includes(':')) return name.split(':').pop().trim();
  return name.replace(/المجموعة/g, '').replace(/قسم/g, '').replace(/الأولى/g, '').trim();
}

function cleanDisplayName(name) {
  if (!name) return 'عام';
  let cleaned = name.replace(/(المجموعة|مجموعة|قسم)\s*([0-9٠-٩]+|الأولى|الثانية|الثالثة|الرابعة|الخامسة|السادسة|السابعة|الثامنة|التاسعة|العاشرة)?/g, '');
  cleaned = cleaned.replace(/^[:\-]+|[:\-]+$/g, '').trim();
  return cleaned || 'عام';
}

function getRank(score) {
  if (score < 50) return "مبتدئ 🌱";
  if (score < 150) return "متسابق نشط ⚡";
  if (score < 300) return "محترف 🏅";
  return "أسطورة المعرفة 🔥";
}

function buildDynamicKeyboard(buttonsArray) {
  let inline_keyboard = [];
  let currentRow = [];
  let currentRowChars = 0; 

  for (let btn of buttonsArray) {
    const textLen = btn.text.length;

    if (textLen > 16) {
      if (currentRow.length > 0) { 
        inline_keyboard.push(currentRow); 
        currentRow = []; 
        currentRowChars = 0; 
      }
      inline_keyboard.push([btn]);
    } else {
      if (currentRow.length >= 2 || (currentRowChars + textLen > 32)) {
        inline_keyboard.push(currentRow);
        currentRow = [btn];
        currentRowChars = textLen;
      } else {
        currentRow.push(btn);
        currentRowChars += textLen;
      }
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
async function showCategories(chatId, isOwner, isAdmin, messageIdToEdit = null) {
  const qSnap = await getDocs(collection(db, "questions"));
  let allGroups = qSnap.docs.map(d => d.data().group || 'عام');
  let mainCats = Array.from(new Set(allGroups.map(g => g.split('-')[0].trim())));
  
  if (mainCats.length === 0) return sendTgMessage(chatId, "لا توجد أسئلة متاحة حالياً.", getKeyboard(isOwner, isAdmin));

  let catButtons = mainCats.map(m => ({ text: `📁 ${cleanDisplayName(m)}`, callback_data: `mcat_${m}` }));
  let inline_keyboard = buildDynamicKeyboard(catButtons); 

  const text = "📚 *اختر القسم الرئيسي:*";
  if (messageIdToEdit) return editTgMessage(chatId, messageIdToEdit, text, { inline_keyboard });
  return sendTgMessage(chatId, text, { inline_keyboard });
}

async function showSubCategories(chatId, mainCat, messageIdToEdit, isOwner, isAdmin) {
  const qSnap = await getDocs(collection(db, "questions"));
  let allGroups = qSnap.docs.map(d => d.data().group || 'عام');
  let subGroups = Array.from(new Set(allGroups.filter(g => g.split('-')[0].trim() === mainCat)));
  
  if (subGroups.length === 1 && !subGroups[0].includes('-')) {
      return askQuestion(chatId, subGroups[0], messageIdToEdit, null, isOwner, isAdmin);
  }

  let catButtons = subGroups.map(g => {
      let subName = g.includes('-') ? g.split('-').pop().trim() : g;
      return { text: `📂 ${cleanDisplayName(subName)}`, callback_data: `cat_${g}` };
  });

  let inline_keyboard = buildDynamicKeyboard(catButtons);
  inline_keyboard.push([{ text: "🔙 رجوع للأقسام", callback_data: "back_to_maincat" }]);

  return editTgMessage(chatId, messageIdToEdit, `📂 *القسم: ${cleanDisplayName(mainCat)}*\n\nاختر القسم الفرعي:`, { inline_keyboard });
}

async function sendQuestionToGroup(groupId, questionDoc, category) {
  const q = questionDoc.data();
  const qId = questionDoc.id;
  const timestamp = Date.now();
  const isGold = Math.random() < 0.15 ? 1 : 0; 
  
  let rawButtons = [{ text: q.correct, callback_data: `c_${qId}_${timestamp}_${isGold}` }];
  (q.wrong || []).forEach((w, idx) => { if(w) rawButtons.push({ text: w, callback_data: `w_${qId}_${idx}_${timestamp}_${isGold}` }) });
  rawButtons = shuffleArray(rawButtons);
  let inline_keyboard = buildDynamicKeyboard(rawButtons); 

  let displayCat = cleanDisplayName(category.includes('-') ? category.split('-').pop() : category);
  let qText = `📁 *${displayCat}*\n\n`;
  if (isGold === 1) qText += `🌟 *سؤال ذهبي! نقاط مضاعفة!* 🌟\n\n`;
  qText += `❓ *${q.question}*\n\n⏱️ أمامك ${TIME_LIMIT_SECONDS} ثانية للإجابة!`;
  await sendTgMessage(groupId, qText, { inline_keyboard });
}

async function askQuestion(chatId, category, messageIdToEdit = null, callbackId = null, isOwner, isAdmin) {
  const chatRef = doc(db, "users", chatId);
  const chatSnap = await getDoc(chatRef);
  const answered = chatSnap.exists() ? (chatSnap.data().answered || []) : [];

  const qSnap = await getDocs(collection(db, "questions"));
  let availableQ = [];
  
  // ✨ حفظ بيانات السؤال كاملة ليتم ترتيبها ✨
  qSnap.forEach(d => {
    if ((d.data().group || 'عام') === category && !answered.includes(d.id)) {
        availableQ.push({ doc: d, data: d.data() });
    }
  });

  let displayCat = cleanDisplayName(category.includes('-') ? category.split('-').pop() : category);

  if (availableQ.length === 0) {
    const endMsg = `🎉 لقد أتممت جميع أسئلة: *${displayCat}*`;
    if (callbackId) await answerTgCallback(callbackId, `🎉 أتممت أسئلة: ${displayCat}`);
    if (messageIdToEdit) return editTgMessage(chatId, messageIdToEdit, endMsg);
    return sendTgMessage(chatId, endMsg, getKeyboard(isOwner, isAdmin));
  }

  // ✨ الترتيب التصاعدي حسب رقم الصف في الإكسل (حقل order) ✨
  availableQ.sort((a, b) => (a.data.order || 0) - (b.data.order || 0));

  // ✨ اختيار السؤال الأول في الترتيب بدلاً من الاختيار العشوائي ✨
  const selectedItem = availableQ[0];
  const q = selectedItem.data;
  const qId = selectedItem.doc.id;
  
  const timestamp = Date.now(); 
  const isGold = Math.random() < 0.15 ? 1 : 0; 
  
  let rawButtons = [{ text: q.correct, callback_data: `c_${qId}_${timestamp}_${isGold}` }];
  (q.wrong || []).forEach((w, idx) => { if(w) rawButtons.push({ text: w, callback_data: `w_${qId}_${idx}_${timestamp}_${isGold}` }) });
  
  // خلط الإجابات فقط لضمان التحدي
  rawButtons = shuffleArray(rawButtons);
  let inline_keyboard = buildDynamicKeyboard(rawButtons); 

  await setDoc(chatRef, { active_category: category }, { merge: true });
  
  let qText = `📁 *${displayCat}*\n\n`;
  if (isGold === 1) qText += `🌟 *سؤال ذهبي! نقاط مضاعفة!* 🌟\n\n`;
  qText += `❓ *${q.question}*\n\n⏱️ أمامك ${TIME_LIMIT_SECONDS} ثانية للإجابة!`;
  
  if (messageIdToEdit) return editTgMessage(chatId, messageIdToEdit, qText, { inline_keyboard });
  return sendTgMessage(chatId, qText, { inline_keyboard });
}

// ==========================================
// 5. دوال الإدارة والإكسل والرسوم البيانية
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

    // ✨ إضافة حقل order لحفظ الترتيب الأصلي للأسئلة ✨
    for (let i = 1; i < rows.length; i++) {
      if (!String(rows[i][0]).trim() || !String(rows[i][1]).trim()) continue;
      let wrong = [];
      for (let col = 2; col < rows[0].length; col++) if (col !== groupIdx && String(rows[i][col]).trim() !== "") wrong.push(String(rows[i][col]).trim());
      bulkQuestions.push({ 
          question: String(rows[i][0]).trim(), 
          correct: String(rows[i][1]).trim(), 
          wrong: wrong, 
          group: (groupIdx !== -1 && rows[i][groupIdx]) ? String(rows[i][groupIdx]).trim() : 'عام',
          order: i // تسجيل رقم الصف لضمان التسلسل
      });
    }

    if (bulkQuestions.length > 0) {
      const qSnap = await getDocs(collection(db, "questions"));
      let deleteBatch = writeBatch(db); qSnap.forEach(d => deleteBatch.delete(d.ref)); if (qSnap.size > 0) await deleteBatch.commit();
      let addBatch = writeBatch(db); bulkQuestions.forEach(q => addBatch.set(doc(collection(db, "questions")), q)); await addBatch.commit();
      const uSnap = await getDocs(collection(db, "users"));
      let uBatch = writeBatch(db); uSnap.forEach(u => uBatch.update(u.ref, { answered: [] })); if (uSnap.size > 0) await uBatch.commit();
      await sendTgMessage(chatId, `🎉 *تم التحديث!*\nتم إدراج: ${bulkQuestions.length} سؤال، مع حفظ الترتيب الأصلي.`, getKeyboard(isOwner, isAdmin));
    }
  }
}

async function exportQuestions(chatId) {
  const qSnap = await getDocs(collection(db, "questions"));
  if (qSnap.empty) return sendTgMessage(chatId, "لا توجد أسئلة للتصدير.");
  let allQs = []; qSnap.forEach(d => allQs.push(d.data()));
  
  // ✨ ترتيب الأسئلة المصدرة حسب الترتيب الأصلي ✨
  allQs.sort((a, b) => (a.order || 0) - (b.order || 0));
  
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

async function sendGraphicalChart(chatId) {
  await sendTgMessage(chatId, "⏳ جاري توليد الرسم البياني للتفاعل...");
  const uSnap = await getDocs(collection(db, "users"));
  let categoryTotals = {};
  let totalPlays = 0;

  uSnap.forEach(d => {
      let plays = d.data().category_plays || {};
      for (let cat in plays) {
          categoryTotals[cat] = (categoryTotals[cat] || 0) + plays[cat];
          totalPlays += plays[cat];
      }
  });

  if (totalPlays === 0) return sendTgMessage(chatId, "⚠️ لا توجد بيانات تفاعل كافية لرسم المخطط حتى الآن.");

  let sortedCats = Object.keys(categoryTotals).sort((a, b) => categoryTotals[b] - categoryTotals[a]).slice(0, 10);
  let labels = sortedCats.map(c => cleanDisplayName(c.includes('-') ? c.split('-').pop() : c));
  let data = sortedCats.map(c => categoryTotals[c]);

  const chartConfig = {
      type: 'bar',
      data: {
          labels: labels,
          datasets: [{
              label: 'عدد الإجابات',
              data: data,
              backgroundColor: 'rgba(54, 162, 235, 0.7)',
              borderColor: 'rgba(54, 162, 235, 1)',
              borderWidth: 1
          }]
      },
      options: {
          plugins: {
              title: { display: true, text: 'الأقسام المفضلة للمتسابقين', font: { size: 16 } },
              datalabels: { anchor: 'end', align: 'top', color: '#fff', backgroundColor: '#000', borderRadius: 3 }
          },
          scales: { y: { beginAtZero: true } }
      }
  };

  const chartUrl = `https://quickchart.io/chart?c=${encodeURIComponent(JSON.stringify(chartConfig))}&w=600&h=400&bkg=white`;

  const payload = {
      chat_id: chatId,
      photo: chartUrl,
      caption: `📊 *تقرير تفاعل المتسابقين*\n\nإجمالي الإجابات المسجلة: *${totalPlays}*\nالقسم الأكثر شعبية: *${cleanDisplayName(sortedCats[0].includes('-') ? sortedCats[0].split('-').pop() : sortedCats[0])}*`,
      parse_mode: "Markdown"
  };

  await fetch(`https://api.telegram.org/bot${getToken()}/sendPhoto`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
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

  const adminDocRef = doc(db, "bot_settings", "admins");
  const adminDocSnap = await getDoc(adminDocRef);
  let adminsArray = adminDocSnap.exists() ? (adminDocSnap.data().list || []) : [];
  const isOwner = (userId === getAdminId());
  const isAdmin = isOwner || adminsArray.includes(userId);

  if (data === "ignore") return answerTgCallback(callbackId, "⚠️ لا يمكنك الضغط هنا مجدداً.");

  if (data === "back_to_maincat") {
    return showCategories(chatId, isOwner, isAdmin, messageId);
  }

  if (data.startsWith("mcat_")) {
    const mainCat = data.replace("mcat_", "");
    return showSubCategories(chatId, mainCat, messageId, isOwner, isAdmin);
  }

  if (data === "bc_mode_rand" || data === "bc_mode_spec") {
    if (!isAdmin) return answerTgCallback(callbackId, "⚠️ ليس لديك صلاحية.");
    const isRandom = (data === "bc_mode_rand");
    const qSnap = await getDocs(collection(db, "questions"));
    let allGroups = qSnap.docs.map(d => d.data().group || 'عام');
    let mainCats = Array.from(new Set(allGroups.map(g => g.split('-')[0].trim())));
    
    let prefix = isRandom ? "rmcat_" : "smcat_";
    let catButtons = mainCats.map(m => ({ text: `📁 ${cleanDisplayName(m)}`, callback_data: `${prefix}${m}` }));
    let inline_keyboard = buildDynamicKeyboard(catButtons);
    const title = isRandom ? "🎲 اختر القسم (سؤال عشوائي):" : "🎯 اختر القسم (سؤال محدد):";
    return editTgMessage(chatId, messageId, title, { inline_keyboard });
  }

  if (data.startsWith("rmcat_") || data.startsWith("smcat_")) {
    if (!isAdmin) return answerTgCallback(callbackId, "⚠️ ليس لديك صلاحية.");
    const isRandom = data.startsWith("rmcat_");
    const mainCat = data.replace(isRandom ? "rmcat_" : "smcat_", "");
    const qSnap = await getDocs(collection(db, "questions"));
    let allGroups = qSnap.docs.map(d => d.data().group || 'عام');
    let subGroups = Array.from(new Set(allGroups.filter(g => g.split('-')[0].trim() === mainCat)));
    
    let prefix = isRandom ? "rcat_" : "scat_";
    let catButtons = subGroups.map(g => {
        let subName = g.includes('-') ? g.split('-').pop().trim() : g;
        return { text: `📂 ${cleanDisplayName(subName)}`, callback_data: `${prefix}${g}` };
    });
    let inline_keyboard = buildDynamicKeyboard(catButtons);
    inline_keyboard.push([{ text: "🔙 رجوع", callback_data: isRandom ? "bc_mode_rand" : "bc_mode_spec" }]);
    
    return editTgMessage(chatId, messageId, `📂 *القسم: ${cleanDisplayName(mainCat)}*\n\nاختر القسم الفرعي لإرسال السؤال:`, { inline_keyboard });
  }

  if (data.startsWith("rcat_")) {
    if (!isAdmin) return answerTgCallback(callbackId, "⚠️ ليس لديك صلاحية.");
    const category = data.replace("rcat_", "");
    const groupSnap = await getDoc(doc(db, "bot_settings", "linked_group"));
    if (!groupSnap.exists()) return answerTgCallback(callbackId, "⚠️ لم تقم بربط أي مجموعة بعد.");
    const groupId = groupSnap.data().id;
    const qSnap = await getDocs(collection(db, "questions"));
    let matchingQ = [];
    qSnap.forEach(d => { if ((d.data().group || 'عام') === category) matchingQ.push(d); });
    if (matchingQ.length === 0) return answerTgCallback(callbackId, "لا توجد أسئلة في هذا القسم.");
    
    // حتى في الإرسال العشوائي، يمكننا تركه عشوائياً كما هو لأن المدير اختار "سؤال عشوائي"
    const randomDoc = matchingQ[Math.floor(Math.random() * matchingQ.length)];
    await sendQuestionToGroup(groupId, randomDoc, category);
    await answerTgCallback(callbackId, "✅ تم إرسال السؤال عشوائياً للمجموعة!");
    let disp = cleanDisplayName(category.includes('-') ? category.split('-').pop() : category);
    return editTgMessage(chatId, messageId, `✅ تم إرسال سؤال عشوائي من قسم *${disp}* بنجاح! 🚀`);
  }

  if (data.startsWith("scat_")) {
    if (!isAdmin) return answerTgCallback(callbackId, "⚠️ ليس لديك صلاحية.");
    const category = data.replace("scat_", "");
    const qSnap = await getDocs(collection(db, "questions"));
    let qList = [];
    qSnap.forEach(d => { if ((d.data().group || 'عام') === category) qList.push({ id: d.id, ...d.data() }); });
    if (qList.length === 0) return answerTgCallback(callbackId, "لا توجد أسئلة في هذا القسم.");
    
    // ✨ ترتيب قائمة الأسئلة المحددة تصاعدياً حسب الترتيب الأصلي في الإكسل ✨
    qList.sort((a, b) => (a.order || 0) - (b.order || 0));

    let inline_keyboard = qList.map(q => ([{ text: q.question.length > 35 ? q.question.substring(0, 35) + '...' : q.question, callback_data: `send_q_${q.id}` }]));
    const mainCat = category.split('-')[0].trim();
    inline_keyboard.push([{ text: "🔙 رجوع للأقسام", callback_data: `smcat_${mainCat}` }]);
    let disp = cleanDisplayName(category.includes('-') ? category.split('-').pop() : category);
    return editTgMessage(chatId, messageId, `🎯 *اختر السؤال المطلوب إرساله من قسم (${disp}):*`, { inline_keyboard });
  }

  if (data.startsWith("send_q_")) {
    if (!isAdmin) return answerTgCallback(callbackId, "⚠️ ليس لديك صلاحية.");
    const qId = data.replace("send_q_", "");
    const groupSnap = await getDoc(doc(db, "bot_settings", "linked_group"));
    if (!groupSnap.exists()) return answerTgCallback(callbackId, "⚠️ لم تقم بربط أي مجموعة بعد.");
    const groupId = groupSnap.data().id;
    const qDocRef = doc(db, "questions", qId);
    const qDocSnap = await getDoc(qDocRef);
    if (!qDocSnap.exists()) return answerTgCallback(callbackId, "⚠️ السؤال غير موجود.");
    await sendQuestionToGroup(groupId, qDocSnap, qDocSnap.data().group || 'عام');
    await answerTgCallback(callbackId, "✅ تم إرسال السؤال المحدد للمجموعة!");
    return editTgMessage(chatId, messageId, `✅ تم إرسال السؤال المختار بنجاح إلى المجموعة! 🎯`);
  }

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
        let uData = uSnap.exists() ? uSnap.data() : { score: 0, streak: 0, name: userName, category_plays: {} };
        const activeCat = chatSnap.exists() ? (chatSnap.data().active_category || 'عام') : 'عام';

        const currentTime = Date.now();
        const timeDiffSeconds = (currentTime - timestamp) / 1000;
        
        if (timeDiffSeconds > TIME_LIMIT_SECONDS) throw new Error("TIMEOUT");
        if ((chatData.answered || []).includes(qId)) throw new Error("ALREADY_ANSWERED");

        let earnedPoints = 0;
        let currentStreak = uData.streak || 0;
        let categoryPlays = uData.category_plays || {};
        
        categoryPlays[activeCat] = (categoryPlays[activeCat] || 0) + 1;

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
        let updatedUData = { score: (uData.score || 0) + earnedPoints, streak: currentStreak, name: userName, category_plays: categoryPlays };

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
  
  const adminDocRef = doc(db, "bot_settings", "admins");
  const adminDocSnap = await getDoc(adminDocRef);
  let adminsArray = adminDocSnap.exists() ? (adminDocSnap.data().list || []) : [];
  const isOwner = (userId === getAdminId());
  const isAdmin = isOwner || adminsArray.includes(userId);

  const currentKeyboard = getKeyboard(isOwner, isAdmin);
  
  const userRef = doc(db, "users", userId);
  const chatRef = doc(db, "users", chatId); 
  
  if (isAdmin && (text === '/link' || text === '🔗 ربط بمجموعة')) {
    if (message.chat.type === 'private') {
      return sendTgMessage(chatId, "⚠️ **تنبيه:** لا يمكن ربط البوت من المحادثة الخاصة!\n\n💡 **طريقة الربط:**\n1. قم بإضافة البوت إلى مجموعتك.\n2. اذهب إلى المجموعة واكتب الأمر `/link` هناك.", currentKeyboard);
    }
    await setDoc(doc(db, "bot_settings", "linked_group"), { id: chatId, name: message.chat.title || "مجموعة المسابقات" }, { merge: true });
    return sendTgMessage(chatId, "🔗 *تم ربط هذه المجموعة بنجاح!*\nسيتم إرسال أسئلة المسابقة إلى هنا عند طلب الإرسال من لوحة الإدارة.");
  }

  if (message.new_chat_members) {
    for (let member of message.new_chat_members) {
      if (member.is_bot && member.username === message.chat.username) {
        await sendTgMessage(chatId, `مرحباً بالجميع! 🌟\nأنا بوت المسابقات. يمكن للمشرفين الآن ربط المجموعة بإرسال أمر /link`);
      } else if (!member.is_bot) {
        await sendTgMessage(chatId, `أهلاً بك يا [${member.first_name}](tg://user?id=${member.id}) في المجموعة! 🥳\nهل أنت مستعد لاختبار معلوماتك؟`);
      }
    }
    return;
  }

  const userSnap = await getDoc(userRef);
  const chatSnap = await getDoc(chatRef);

  let currentState = userSnap.exists() ? userSnap.data().state : null;
  const knownCommands = ['/start', '🚀 ابدأ من جديد', '🎮 سؤال جديد', '🗂️ تغيير القسم', '📊 رصيدي الحالي', '🏆 لوحة الشرف', '⚙️ إدارة المشرفين', '📥 استيراد إكسل', '/import', '📤 تصدير إكسل', '/export', '👥 تقرير المتسابقين', '📢 إرسال للمجموعة', '📈 إحصائيات التفاعل', '🔗 ربط بمجموعة'];
  if (knownCommands.includes(text) && currentState) {
    await setDoc(userRef, { state: null }, { merge: true });
    currentState = null; 
  }

  if (isOwner && currentState === "WAITING_FOR_ADMIN_ADD") {
    const newAdminId = text.trim();
    if (!/^\d+$/.test(newAdminId)) return sendTgMessage(chatId, "⚠️ يرجى إرسال أرقام الآيدي (ID) فقط.\n💡 (أو اضغط على أي زر لإلغاء هذه العملية)", currentKeyboard);
    if (!adminsArray.includes(newAdminId)) {
       adminsArray.push(newAdminId);
       await setDoc(adminDocRef, { list: adminsArray }, { merge: true });
    }
    await setDoc(userRef, { state: null }, { merge: true });
    return sendTgMessage(chatId, `✅ تم تعيين المستخدم (${newAdminId}) كمشرف بنجاح!`, currentKeyboard);
  }

  if (isAdmin && text === '📢 إرسال للمجموعة') {
    const groupSnap = await getDoc(doc(db, "bot_settings", "linked_group"));
    if (!groupSnap.exists()) return sendTgMessage(chatId, "⚠️ **لم تقم بـ ربط أي مجموعة بعد!**\n\nقم بإضافة البوت إلى مجموعتك، ثم أرسل الأمر `/link` داخل المجموعة لربطها.", currentKeyboard);
    const inline_keyboard = [[{ text: "🎲 إرسال سؤال عشوائي", callback_data: "bc_mode_rand" }], [{ text: "🎯 اختيار سؤال محدد بالذات", callback_data: "bc_mode_spec" }]];
    return sendTgMessage(chatId, `📢 *لوحة إرسال الأسئلة إلى (${groupSnap.data().name}):*\n\nكيف ترغب في اختيار السؤال؟`, { inline_keyboard });
  }

  if (isAdmin && text === '📈 إحصائيات التفاعل') {
    return sendGraphicalChart(chatId);
  }

  if (isOwner && text === '⚙️ إدارة المشرفين') {
    const inline_keyboard = [[{ text: "➕ إضافة مشرف", callback_data: "add_admin" }, { text: "📋 قائمة المشرفين", callback_data: "list_admins" }], [{ text: "➖ إزالة مشرف", callback_data: "remove_admin" }]];
    return sendTgMessage(chatId, "⚙️ *لوحة إدارة المشرفين:*\n\nالرجاء اختيار الإجراء المطلوب من الأزرار بالأسفل:", { inline_keyboard });
  }

  if (text === '/start' || text === '🚀 ابدأ من جديد') {
    await setDoc(userRef, { score: 0, streak: 0, name: userName }, { merge: true });
    await setDoc(chatRef, { answered: [], active_category: null }, { merge: true });
    const welcomeText = `مرحباً بك يا *${userName}* في عالم التحدي والمعرفة! 🌟🎮\n\n*📋 قواعد الإجابة الصحيحة:* \n⏱️ *الوقت:* أمامك 20 ثانية فقط للإجابة.\n⚡ *السرعة:* إجابتك في أول 5 ثوانٍ تمنحك (+5 نقاط إضافية).\n🔥 *السلسلة:* 3 إجابات صحيحة متتالية تضاعف نقاطك!\n🌟 *الأسئلة الذهبية:* تظهر فجأة وتضاعف رصيدك.\n\nاضغط على (🎮 *سؤال جديد*) من القائمة بالأسفل للبدء! 👇`;
    return sendTgMessage(chatId, welcomeText, currentKeyboard);
  }

  if (document && isAdmin && currentState === "WAITING_FOR_EXCEL") {
    await setDoc(userRef, { state: null }, { merge: true });
    return processExcelImport(document, chatId, isOwner, isAdmin);
  }

  if (isAdmin && (text === '📥 استيراد إكسل' || text === '/import')) {
    await setDoc(userRef, { state: "WAITING_FOR_EXCEL" }, { merge: true });
    return sendTgMessage(chatId, "📥 **أرسل الآن ملف الإكسل (.xlsx)**.\n💡 (لإلغاء العملية اضغط على أي زر)", currentKeyboard);
  }

  if (isAdmin && (text === '📤 تصدير إكسل' || text === '/export')) return exportQuestions(chatId);
  
  if (isAdmin && (text === '👥 تقرير المتسابقين' || text === '👥 تقرير المتسابقين (إكسل)')) return exportUsersReport(chatId);

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
  if (req.method !== 'POST') return res.status(200).send('✅ البوت يعمل بكفاءة. الآن يعرض الأسئلة بالتسلسل الأصلي الموجود في ملف الإكسل بالضبط!');
  try {
    const body = req.body;
    if (body.callback_query) await handleCallbackQuery(body.callback_query);
    else if (body.message) await handleMessage(body.message);
  } catch (error) { console.error("Execution error:", error); }
  return res.status(200).json({ success: true });
}
