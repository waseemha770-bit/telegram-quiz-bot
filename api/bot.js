import { initializeApp } from 'firebase/app';
// السحر هنا: استخدمنا نسخة lite المخصصة لـ Vercel والتي لا تنقطع أبداً
import { getFirestore, collection, getDocs, doc, setDoc, getDoc, writeBatch } from 'firebase/firestore/lite';
import * as XLSX from 'xlsx';

// إعداد الاتصال بـ Firebase
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  projectId: process.env.FIREBASE_PROJECT_ID,
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

// دالة خلط الأسئلة
function shuffleArray(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('✅ البوت يعمل بنجاح ومربوط بـ Firebase Lite!');
  }

  const token = process.env.TELEGRAM_TOKEN;
  const adminId = process.env.ADMIN_ID;
  const body = req.body;

  const replyKeyboard = {
    keyboard: [
      [{ text: "🚀 ابدأ من جديد" }, { text: "🎮 سؤال جديد" }],
      [{ text: "📥 استيراد إكسل" }, { text: "📤 تصدير إكسل" }],
      [{ text: "🏆 لوحة الشرف" }, { text: "📊 رصيدي الحالي" }]
    ],
    resize_keyboard: true
  };

  async function sendMessage(chatId, text, replyMarkup = null) {
    const payload = { chat_id: chatId, text: text, parse_mode: "Markdown" };
    if (replyMarkup) payload.reply_markup = replyMarkup;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  async function sendDocument(chatId, fileBuffer, fileName, caption) {
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('document', new Blob([fileBuffer]), fileName);
    formData.append('caption', caption);
    await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: 'POST', body: formData
    });
  }

  async function answerCallback(callbackId, text) {
    const payload = { callback_query_id: callbackId, text: text, show_alert: true };
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  try {
    // معالجة الأزرار الشفافة (الإجابات)
    if (body.callback_query) {
      const callbackQuery = body.callback_query;
      const callbackId = callbackQuery.id;
      const data = callbackQuery.data;
      const chatId = callbackQuery.message.chat.id.toString();
      const messageId = callbackQuery.message.message_id;
      const userName = callbackQuery.from.first_name || "مجهول";
      const originalKeyboard = callbackQuery.message.reply_markup ? callbackQuery.message.reply_markup.inline_keyboard : [];

      if (data === "ignore") {
        await answerCallback(callbackId, "⚠️ لقد قمت بالإجابة على هذا السؤال مسبقاً!");
        return res.status(200).json({ success: true });
      }

      const isCorrect = data.startsWith("c_");
      const isWrong = data.startsWith("w_");

      if (isCorrect || isWrong) {
        const qId = data.split('_')[1];
        const userRef = doc(db, "users", chatId);
        const userSnap = await getDoc(userRef);
        let userData = userSnap.exists() ? userSnap.data() : { score: 0, answered: [], name: userName };

        if (userData.answered && userData.answered.includes(qId)) {
          await answerCallback(callbackId, "⚠️ لقد تم تسجيل إجابتك على هذا السؤال مسبقاً.");
          return res.status(200).json({ success: true });
        }

        userData.answered = userData.answered || [];
        userData.answered.push(qId);
        userData.name = userName;

        if (isCorrect) {
          userData.score = (userData.score || 0) + 10;
          await answerCallback(callbackId, "✅ إجابة صحيحة! حصلت على 10 نقاط.");
        } else {
          await answerCallback(callbackId, "❌ إجابة خاطئة، حظاً أوفر!");
        }

        await setDoc(userRef, userData, { merge: true });

        const newKeyboard = originalKeyboard.map(row => {
          return row.map(btn => {
            let newText = btn.text;
            if (btn.callback_data.startsWith('c_')) newText = "✅ " + btn.text;
            else if (btn.callback_data === data) newText = "❌ " + btn.text;
            return { text: newText, callback_data: "ignore" };
          });
        });

        await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: newKeyboard } })
        });
        return res.status(200).json({ success: true });
      }
    }

    // معالجة الرسائل النصية والملفات
    if (body.message) {
      const chatId = body.message.chat.id.toString();
      const text = body.message.text || "";
      const document = body.message.document;
      const userName = body.message.from.first_name || "مجهول";

      const userRef = doc(db, "users", chatId);
      const userSnap = await getDoc(userRef);
      let userData = userSnap.exists() ? userSnap.data() : {};
      let currentState = userData.state || null;

      // استقبال ملف الإكسل
      if (document && chatId === adminId && currentState === "WAITING_FOR_EXCEL") {
        const fileName = document.file_name;
        if (!fileName.endsWith('.xlsx')) {
          await sendMessage(chatId, "❌ يرجى إرسال ملف بصيغة `.xlsx` فقط.", replyKeyboard);
          return res.status(200).json({ success: true });
        }

        await sendMessage(chatId, "🔄 جاري معالجة البيانات ورفعها إلى Firebase...");
        const fileId = document.file_id;
        const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
        const fileJson = await fileRes.json();

        if (fileJson.ok) {
          const filePath = fileJson.result.file_path;
          const downloadUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
          const fileBufferResponse = await fetch(downloadUrl);
          const arrayBuffer = await fileBufferResponse.arrayBuffer();

          const workbook = XLSX.read(arrayBuffer, { type: 'buffer' });
          const sheet = workbook.Sheets[workbook.SheetNames[0]];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

          const headers = rows[0];
          const groupIdx = headers.findIndex(h => String(h).includes('المجموعة'));
          let bulkQuestions = [];

          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const questionText = String(row[0]).trim();
            const correctText = String(row[1]).trim();
            if (!questionText || !correctText) continue;

            let group = 'عام';
            if (groupIdx !== -1 && row[groupIdx]) group = String(row[groupIdx]).trim();
            let wrong = [];
            for (let col = 2; col < headers.length; col++) {
              if (col === groupIdx) continue;
              const cellValue = String(row[col]).trim();
              if (cellValue !== "") wrong.push(cellValue);
            }
            bulkQuestions.push({ question: questionText, correct: correctText, wrong: wrong, group: group });
          }

          if (bulkQuestions.length > 0) {
            const qSnap = await getDocs(collection(db, "questions"));
            let deleteBatch = writeBatch(db);
            qSnap.forEach(d => deleteBatch.delete(d.ref));
            if(qSnap.size > 0) await deleteBatch.commit();

            let addBatch = writeBatch(db);
            bulkQuestions.forEach(q => {
              const newQRef = doc(collection(db, "questions"));
              addBatch.set(newQRef, q);
            });
            await addBatch.commit();

            const uSnap = await getDocs(collection(db, "users"));
            let uBatch = writeBatch(db);
            uSnap.forEach(u => uBatch.update(u.ref, { answered: [] }));
            if(uSnap.size > 0) await uBatch.commit();

            await sendMessage(chatId, `🎉 *تم تحديث بنك أسئلة Firebase بنجاح!*\nتم إدراج: ${bulkQuestions.length} سؤال.`, replyKeyboard);
          }
        }
        await setDoc(userRef, { state: null }, { merge: true });
        return res.status(200).json({ success: true });
      }

      if ((text === '📤 تصدير إكسل' || text === '/export') && chatId === adminId) {
         const qSnap = await getDocs(collection(db, "questions"));
         if (qSnap.empty) {
            await sendMessage(chatId, "لا توجد أسئلة للتصدير.", replyKeyboard);
            return res.status(200).json({ success: true });
         }
         let allQuestions = [];
         qSnap.forEach(d => allQuestions.push(d.data()));

         let maxWrong = 0;
         allQuestions.forEach(q => { if (q.wrong && q.wrong.length > maxWrong) maxWrong = q.wrong.length; });

         let exportHeaders = ['السؤال', 'الإجابة الصحيحة'];
         for (let i = 1; i <= maxWrong; i++) exportHeaders.push(`خطأ ${i}`);
         exportHeaders.push('المجموعة');

         const excelData = [exportHeaders];
         allQuestions.forEach(q => {
           let rowData = [q.question, q.correct];
           for (let i = 0; i < maxWrong; i++) rowData.push(q.wrong[i] || '');
           rowData.push(q.group || 'عام');
           excelData.push(rowData);
         });

         const ws = XLSX.utils.aoa_to_sheet(excelData);
         const wb = XLSX.utils.book_new();
         XLSX.utils.book_append_sheet(wb, ws, "Questions");
         const excelBuffer = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });

         await sendDocument(chatId, excelBuffer, 'firebase_questions.xlsx', '📁 بنك الأسئلة من Firebase');
         return res.status(200).json({ success: true });
      }

      if ((text === '📥 استيراد إكسل' || text === '/import') && chatId === adminId) {
        await setDoc(userRef, { state: "WAITING_FOR_EXCEL" }, { merge: true });
        await sendMessage(chatId, "📥 **أرسل الآن ملف الإكسل (.xlsx)**.", replyKeyboard);
        return res.status(200).json({ success: true });
      }

      if (text === '/start' || text === '🚀 ابدأ من جديد') {
        await setDoc(userRef, { state: null }, { merge: true });
        await sendMessage(chatId, `أهلاً بك يا *${userName}* في نسخة البوت الجديدة! 🚀\nاضغط على (سؤال جديد) للبدء:`, replyKeyboard);
      }
      else if (text === '/quiz' || text === '🎮 سؤال جديد') {
        const qSnap = await getDocs(collection(db, "questions"));
        let allQuestions = [];
        qSnap.forEach(d => { allQuestions.push({ id: d.id, ...d.data() }); });

        const answered = userData.answered || [];
        const availableQ = allQuestions.filter(q => !answered.includes(q.id));

        if (availableQ.length === 0) {
          await sendMessage(chatId, "🎉 *تهانينا!* لقد أجبت على جميع الأسئلة المتاحة.", replyKeyboard);
          return res.status(200).json({ success: true });
        }

        const q = availableQ[Math.floor(Math.random() * availableQ.length)];
        let buttons = [{ text: q.correct, callback_data: "c_" + q.id }];
        if (q.wrong) {
          q.wrong.forEach((w, idx) => {
            if(w) buttons.push({ text: w, callback_data: "w_" + q.id + "_" + idx });
          });
        }
        buttons = shuffleArray(buttons);
        let inline_keyboard = [];
        for (let i = 0; i < buttons.length; i += 2) inline_keyboard.push(buttons.slice(i, i + 2));

        await sendMessage(chatId, `❓ *${q.question}*`, { inline_keyboard });
      }
      else if (text === '/score' || text === '📊 رصيدي الحالي') {
        await sendMessage(chatId, `🏆 رصيدك الحالي هو: *${userData.score || 0} نقطة*`, replyKeyboard);
      }
      else if (text === '/top' || text === '🏆 لوحة الشرف') {
        const uSnap = await getDocs(collection(db, "users"));
        let topUsers = [];
        uSnap.forEach(d => {
           if(d.data().score > 0) topUsers.push({ name: d.data().name, score: d.data().score });
        });
        topUsers.sort((a, b) => b.score - a.score);
        topUsers = topUsers.slice(0, 10);

        if (topUsers.length === 0) {
          await sendMessage(chatId, "لا توجد نقاط مسجلة حتى الآن.", replyKeyboard);
        } else {
          let topText = "🏆 *لوحة الشرف:*\n\n";
          topUsers.forEach((u, i) => { topText += `${i + 1}. ${u.name || 'مجهول'} - ${u.score}\n`; });
          await sendMessage(chatId, topText, replyKeyboard);
        }
      }
    }
  } catch (error) {
    console.error("Execution error:", error);
  }
  return res.status(200).json({ success: true });
}
