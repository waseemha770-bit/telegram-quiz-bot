import { MongoClient } from 'mongodb';

// الاحتفاظ بالاتصال نشطاً لتسريع الردود في بيئة Vercel
let cachedDb = null;

async function connectToDatabase() {
  if (cachedDb) return cachedDb;
  
  // الاتصال بقاعدة البيانات باستخدام الرابط السري
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  
  // إنشاء/اختيار قاعدة بيانات باسم "quiz_bot_db"
  cachedDb = client.db('quiz_bot_db'); 
  return cachedDb;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('✅ البوت يعمل بنجاح ومتصل بقاعدة بيانات MongoDB!');
  }

  const token = process.env.TELEGRAM_TOKEN;
  const body = req.body;

  async function sendMessage(chatId, text, keyboard = null) {
    const payload = { chat_id: chatId, text: text, parse_mode: "Markdown" };
    if (keyboard) payload.reply_markup = keyboard;

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
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
    // الاتصال بقاعدة البيانات واختيار جدول (collection) المستخدمين
    const db = await connectToDatabase();
    const usersCollection = db.collection('users');

    if (body.message) {
      const chatId = body.message.chat.id;
      const text = body.message.text;
      const userName = body.message.from.first_name || "مجهول";

      if (text === '/start') {
        await sendMessage(chatId, "مرحباً بكم في منصة المسابقات التفاعلية! 🎓\n- أرسل `/quiz` لطرح سؤال.\n- أرسل `/score` لمعرفة رصيدك.\n- أرسل `/top` لعرض لوحة الشرف.");
      } 
      else if (text === '/quiz') {
        const keyboard = {
          inline_keyboard: [
            [{ text: "باريس", callback_data: "wrong" }, { text: "مدريد", callback_data: "wrong" }],
            [{ text: "طوكيو", callback_data: "correct" }, { text: "لندن", callback_data: "wrong" }]
          ]
        };
        await sendMessage(chatId, "🌍 *سؤال:*\n\nما هي عاصمة اليابان؟", keyboard);
      }
      else if (text === '/score') {
        // جلب رصيد المستخدم من MongoDB
        const user = await usersCollection.findOne({ userId: chatId });
        const currentScore = user ? user.score : 0;
        await sendMessage(chatId, `🏆 يا *${userName}*، رصيدك الحالي هو: *${currentScore} نقطة*`);
      }
      else if (text === '/top') {
        // جلب أفضل 10 لاعبين مرتبين تنازلياً حسب النقاط
        const topUsers = await usersCollection.find().sort({ score: -1 }).limit(10).toArray();
        
        if (topUsers.length === 0) {
          await sendMessage(chatId, "لا يوجد أي نقاط مسجلة حتى الآن.");
        } else {
          let topText = "🏆 *أفضل اللاعبين:*\n\n";
          for (let i = 0; i < topUsers.length; i++) {
            topText += `${i + 1}. ${topUsers[i].name} - ${topUsers[i].score} نقطة\n`;
          }
          await sendMessage(chatId, topText);
        }
      }
    } 
    else if (body.callback_query) {
      const callbackId = body.callback_query.id;
      const data = body.callback_query.data;
      const chatId = body.callback_query.message.chat.id;
      const userName = body.callback_query.from.first_name || "مجهول";

      if (data === "correct") {
        // الاتصال بقاعدة البيانات
        const db = await connectToDatabase();
        const usersCollection = db.collection('users');

        // إضافة 10 نقاط للمستخدم (وإنشاء حسابه إن لم يكن موجوداً باستخدام upsert)
        await usersCollection.updateOne(
          { userId: chatId }, 
          { 
            $inc: { score: 10 }, 
            $set: { name: userName } 
          }, 
          { upsert: true }
        );
        
        await answerCallback(callbackId, "✅ إجابة صحيحة! تمت إضافة 10 نقاط لرصيدك.");
      } else if (data === "wrong") {
        await answerCallback(callbackId, "❌ إجابة خاطئة، لم يتم خصم نقاط.");
      }
    }
  } catch (error) {
    console.error("Database or execution error:", error);
  }

  return res.status(200).json({ success: true });
}
