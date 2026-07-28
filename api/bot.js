import { MongoClient, ObjectId } from 'mongodb';
import * as XLSX from 'xlsx';

let cachedDb = null;

async function connectToDatabase() {
  if (cachedDb) return cachedDb;
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  cachedDb = client.db('quiz_bot_db'); 
  return cachedDb;
}

// دالة لخلط الأزرار عشوائياً
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
    return res.status(200).send('✅ البوت يعمل بنجاح (النسخة النهائية الذكية)!');
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
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  async function sendDocument(chatId, fileBuffer, fileName, caption) {
    const formData = new FormData();
    formData.append('chat_id', chatId);
    formData.append('document', new Blob([fileBuffer]), fileName);
    formData.append('caption', caption);

    await fetch(`https://api.telegram.org/bot${token}/sendDocument`, {
      method: 'POST',
      body: formData
    });
  }

  async function answerCallback(callbackId, text) {
    const payload = { callback_query_id: callbackId, text: text, show_alert: true };
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  try {
    const db = await connectToDatabase();
    const usersCollection = db.collection('users');
    const questionsCollection = db.collection('questions');

    // ----------------------------------------------------
    // معالجة الأزرار الشفافة للإجابات (التفاعل البصري ومنع التكرار)
    // ----------------------------------------------------
    if (body.callback_query) {
      const callbackQuery = body.callback_query;
      const callbackId = callbackQuery.id;
      const data = callbackQuery.data; 
      const chatId = callbackQuery.message.chat.id;
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
        const parts = data.split('_');
        const qId = parts[1];

        const user = await usersCollection.findOne({ userId: chatId.toString() });
        if (user && user.answered && user.answered.includes(qId)) {
          await answerCallback(callbackId, "⚠️ لقد تم تسجيل إجابتك على هذا السؤال مسبقاً.");
          return res.status(200).json({ success: true });
        }

        if (isCorrect) {
          await usersCollection.updateOne(
            { userId: chatId.toString() }, 
            { 
              $inc: { score: 10 }, 
              $set: { name: userName },
              $addToSet: { answered: qId }
            }, 
            { upsert: true }
          );
          await answerCallback(callbackId, "✅ إجابة صحيحة! حصلت على 10 نقاط.");
        } else {
          await usersCollection.updateOne(
            { userId: chatId.toString() }, 
            { 
              $set: { name: userName },
              $addToSet: { answered: qId }
            }, 
            { upsert: true }
          );
          await answerCallback(callbackId, "❌ إجابة خاطئة، حظاً أوفر!");
        }

        const newKeyboard = originalKeyboard.map(row => {
          return row.map(btn => {
            let newText = btn.text;
            if (btn.callback_data.startsWith('c_')) {
              newText = "✅ " + btn.text;
            } else if (btn.callback_data === data) {
              newText = "❌ " + btn.text;
            }
            return { text: newText, callback_data: "ignore" };
          });
        });

        await fetch(`https://api.telegram.org/bot${token}/editMessageReplyMarkup`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: newKeyboard }
          })
        });

        return res.status(200).json({ success: true });
      }
    }

    if (body.message) {
      const chatId = body.message.chat.id.toString();
      const text = body.message.text || "";
      const document = body.message.document;
      const userName = body.message.from.first_name || "مجهول";

      let userState = await usersCollection.findOne({ userId: chatId });
      let currentState = userState ? userState.state : null;

      // ----------------------------------------------------
      // الاستيراد الديناميكي للإكسل
      // ----------------------------------------------------
      if (document && chatId === adminId && currentState === "WAITING_FOR_EXCEL") {
        const fileName = document.file_name;
        if (!fileName.endsWith('.xlsx')) {
          await sendMessage(chatId, "❌ يرجى إرسال ملف بصيغة `.xlsx` فقط.", replyKeyboard);
          return res.status(200).json({ success: true });
        }

        const fileId = document.file_id;
        const fileRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
        const fileJson = await fileRes.json();
        
        if (fileJson.ok) {
          await sendMessage(chatId, "🔄 جاري معالجة ومزامنة البيانات ديناميكياً...");
          
          const filePath = fileJson.result.file_path;
          const downloadUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
          const fileBufferResponse = await fetch(downloadUrl);
          const arrayBuffer = await fileBufferResponse.arrayBuffer();
          
          const workbook = XLSX.read(arrayBuffer, { type: 'buffer' });
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];
          const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });

          if (rows.length < 2) {
             await sendMessage(chatId, "❌ الملف فارغ أو لا يحتوي على أسئلة.", replyKeyboard);
             return res.status(200).json({ success: true });
          }

          const headers = rows[0];
          const groupIdx = headers.findIndex(h => String(h).includes('المجموعة'));
          let bulkQuestions = [];
          
          for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const questionText = String(row[0]).trim();
            const correctText = String(row[1]).trim();
            if (!questionText || !correctText) continue;

            let group = 'عام';
            if (groupIdx !== -1 && row[groupIdx]) {
               group = String(row[groupIdx]).trim();
            }

            let wrong = [];
            for (let col = 2; col < headers.length; col++) {
               if (col === groupIdx) continue;
               const cellValue = String(row[col]).trim();
               if (cellValue !== "") wrong.push(cellValue);
            }

            bulkQuestions.push({
              question: questionText,
              correct: correctText,
              wrong: wrong,
              group: group,
              createdBy: userName
            });
          }

          if (bulkQuestions.length > 0) {
            await questionsCollection.deleteMany({});
            await questionsCollection.insertMany(bulkQuestions);
            // تصفير ذاكرة الإجابات لكل المستخدمين عند رفع بنك أسئلة جديد
            await usersCollection.updateMany({}, { $set: { answered: [] } });
            
            await sendMessage(chatId, `🎉 *تمت المزامنة بنجاح!*\nتم استيراد ${bulkQuestions.length} سؤالاً وتحديث بنك الأسئلة.`, replyKeyboard);
          } else {
            await sendMessage(chatId, "❌ لم يتم العثور على أسئلة قابلة للقراءة.", replyKeyboard);
          }
        }
        await usersCollection.updateOne({ userId: chatId }, { $set: { state: null } });
        return res.status(200).json({ success: true });
      }

      // ----------------------------------------------------
      // تصدير الإكسل الديناميكي
      // ----------------------------------------------------
      if ((text === '📤 تصدير إكسل' || text === '/export') && chatId === adminId) {
        const allQuestions = await questionsCollection.find({}).toArray();
        if (allQuestions.length === 0) {
          await sendMessage(chatId, "لا توجد أسئلة للتصدير حالياً.", replyKeyboard);
          return res.status(200).json({ success: true });
        }

        let maxWrong = 0;
        allQuestions.forEach(q => {
          if (q.wrong && q.wrong.length > maxWrong) maxWrong = q.wrong.length;
        });

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

        await sendDocument(chatId, excelBuffer, 'dynamic_questions_bank.xlsx', '📁 بنك الأسئلة المحدث');
        return res.status(200).json({ success: true });
      }

      if ((text === '📥 استيراد إكسل' || text === '/import') && chatId === adminId) {
        await usersCollection.updateOne({ userId: chatId }, { $set: { state: "WAITING_FOR_EXCEL" } }, { upsert: true });
        await sendMessage(chatId, "📥 **أرسل الآن ملف الإكسل (.xlsx)**.", replyKeyboard);
        return res.status(200).json({ success: true });
      }

      // ----------------------------------------------------
      // أوامر المسابقة وسحب الأسئلة
      // ----------------------------------------------------
      if (text === '/start' || text === '🚀 ابدأ من جديد') {
        await usersCollection.updateOne({ userId: chatId }, { $set: { state: null } });
        await sendMessage(chatId, `أهلاً بك يا *${userName}* في منصة المسابقات التفاعلية! 🎓\n\nاضغط على (سؤال جديد) للبدء:`, replyKeyboard);
      } 
      else if (text === '/quiz' || text === '🎮 سؤال جديد') {
        let answeredObjectIds = [];
        if (userState && userState.answered) {
           userState.answered.forEach(idStr => {
              try { answeredObjectIds.push(new ObjectId(idStr)); } catch(e) {}
           });
        }

        const randomQ = await questionsCollection.aggregate([
          { $match: { _id: { $nin: answeredObjectIds } } },
          { $sample: { size: 1 } }
        ]).toArray();
        
        if (randomQ.length === 0) {
          await sendMessage(chatId, "🎉 *تهانينا!* لقد أجبت على جميع الأسئلة المتاحة في بنك المعلومات. انتظر حتى يتم إضافة أسئلة جديدة.", replyKeyboard);
          return res.status(200).json({ success: true });
        }
        
        const q = randomQ[0];
        const qIdStr = q._id.toString();

        let buttons = [{ text: q.correct, callback_data: "c_" + qIdStr }];
        if (q.wrong) {
          q.wrong.forEach((w, idx) => {
            if(w) buttons.push({ text: w, callback_data: "w_" + qIdStr + "_" + idx });
          });
        }

        buttons = shuffleArray(buttons);

        let inline_keyboard = [];
        for (let i = 0; i < buttons.length; i += 2) {
          inline_keyboard.push(buttons.slice(i, i + 2));
        }

        const groupTag = q.group && q.group !== "عام" ? `📂 *قسم:* ${q.group}\n\n` : "";
        await sendMessage(chatId, `❓ ${groupTag}*${q.question}*`, { inline_keyboard });
      }
      else if (text === '/score' || text === '📊 رصيدي الحالي') {
        const user = await usersCollection.findOne({ userId: chatId });
        const currentScore = user ? user.score : 0;
        await sendMessage(chatId, `🏆 يا *${userName}*، رصيدك الحالي هو: *${currentScore} نقطة*`, replyKeyboard);
      }
      else if (text === '/top' || text === '🏆 لوحة الشرف') {
        const topUsers = await usersCollection.find().sort({ score: -1 }).limit(10).toArray();
        if (topUsers.length === 0) {
          await sendMessage(chatId, "لا توجد نقاط مسجلة حتى الآن.", replyKeyboard);
        } else {
          let topText = "🏆 *لوحة الشرف (أفضل اللاعبين):*\n\n";
          for (let i = 0; i < topUsers.length; i++) {
            topText += `${i + 1}. ${topUsers[i].name} - ${topUsers[i].score} نقطة\n`;
          }
          await sendMessage(chatId, topText, replyKeyboard);
        }
      }
    }
  } catch (error) {
    console.error("Database or execution error:", error);
  }

  return res.status(200).json({ success: true });
}
