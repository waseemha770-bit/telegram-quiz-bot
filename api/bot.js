// ==========================================
// 1. المكتبات والإعدادات (Imports & Config)
// ==========================================
import { initializeApp, getApps, getApp } from 'firebase/app';
import { initializeFirestore, collection, getDocs, doc, setDoc, getDoc, writeBatch } from 'firebase/firestore';
import * as XLSX from 'xlsx';

const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  projectId: process.env.FIREBASE_PROJECT_ID,
};

const app = getApps().length === 0 ? initializeApp(firebaseConfig) : getApp();
const db = initializeFirestore(app, { experimentalForceLongPolling: true });

const TIME_LIMIT_SECONDS = 30;

// ==========================================
// 2. قوائم الأزرار (Keyboards)
// ==========================================
const getAdminId = () => process.env.ADMIN_ID;
const getToken = () => process.env.TELEGRAM_TOKEN;

const USER_KEYBOARD = {
  keyboard: [
    [{ text: "🎮 سؤال جديد" }, { text: "🗂️ تغيير القسم" }],
    [{ text: "🏆 لوحة الشرف" }, { text: "📊 رصيدي الحالي" }],
    [{ text: "⭐ المفضلة" }, { text: "🚀 ابدأ من جديد" }]
  ],
  resize_keyboard: true
};

const ADMIN_KEYBOARD = {
  keyboard: [
    [{ text: "🎮 سؤال جديد" }, { text: "🧠 توليد أسئلة (AI)" }],
    [{ text: "📥 استيراد إكسل" }, { text: "📤 تصدير إكسل" }],
    [{ text: "👥 تقرير المتسابقين" }, { text: "📢 إرسال للمجموعة" }],
    [{ text: "📈 إحصائيات التفاعل" }, { text: "🔗 ربط بمجموعة" }],
    [{ text: "🏆 لوحة الشرف" }, { text: "🗂️ تغيير القسم" }],
    [{ text: "⭐ المفضلة" }, { text: "🚀 ابدأ من جديد" }]
  ],
  resize_keyboard: true
};

const OWNER_KEYBOARD = {
  keyboard: [
    [{ text: "🎮 سؤال جديد" }, { text: "🧠 توليد أسئلة (AI)" }],
    [{ text: "📥 استيراد إكسل" }, { text: "📤 تصدير إكسل" }],
    [{ text: "👥 تقرير المتسابقين" }, { text: "⚙️ إدارة المشرفين" }],
    [{ text: "📢 إرسال للمجموعة" }, { text: "📈 إحصائيات التفاعل" }],
    [{ text: "🏆 لوحة الشرف" }, { text: "🔗 ربط بمجموعة" }],
    [{ text: "📊 رصيدي الحالي" }, { text: "🗂️ تغيير القسم" }],
    [{ text: "⭐ المفضلة" }, { text: "🚀 ابدأ من جديد" }]
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
// 🧠 محرك الذكاء الاصطناعي (AI Generator)
// ==========================================
async function generateAIQuestions(text) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("API_KEY_MISSING");
  
  const prompt = `أنت خبير في إنشاء المسابقات. استخرج 3 أسئلة خيارات متعددة دقيقة من النص التالي.
يجب أن تكون النتيجة عبارة عن مصفوفة JSON صالحة (Valid JSON Array) حصراً بدون أي نصوص أو مقدمات إضافية.
صيغة الكائن المطلوب لكل سؤال يجب أن تكون هكذا بالضبط:
[{"question": "اكتب السؤال هنا", "correct": "الإجابة الصحيحة", "wrong": ["خطأ 1", "خطأ 2", "خطأ 3"]}]

النص:
${text.substring(0, 3000)}`; 

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
  });
  
  const data = await response.json();
  if (!data.candidates) throw new Error("AI_RESPONSE_ERROR");
  
  let rawText = data.candidates[0].content.parts[0].text;
  rawText = rawText.replace(/```json/gi, '').replace(/
