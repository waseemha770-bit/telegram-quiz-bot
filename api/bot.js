import { kv } from '@vercel/kv';

export default async function handler(req, res) {
  // 1. فحص حالة السيرفر (عند فتح الرابط في المتصفح)
  if (req.method !== 'POST') {
    return res.status(200).send('✅ البوت يعمل بنجاح ومتصل بقاعدة بيانات Vercel KV!');
  }

  const token = process.env.TELEGRAM_TOKEN; // التوكن السري من إعدادات Vercel
  const body = req.body;

  // 2. دالة مساعدة لإرسال الرسائل إلى تيليجرام
  async function sendMessage(chatId, text, keyboard = null) {
    const payload = { chat_id: chatId, text: text, parse_mode: "Markdown" };
    if (keyboard) payload.reply_markup = keyboard;

    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  // 3. دالة مساعدة لإظهار إشعارات منبثقة عند النقر على الأزرار
  async function answerCallback(callbackId, text) {
    const payload = { callback_query_id: callbackId, text: text, show_alert: true };
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  // 4. معالجة الرسائل الواردة
  try {
    // أ: إذا كانت رسالة نصية
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
        // جلب رصيد المستخدم من قاعدة البيانات
        let currentScore = await kv.zscore('leaderboard', userName) || 0;
        await sendMessage(chatId, `🏆 يا *${userName}*، رصيدك الحالي هو: *${currentScore} نقطة*`);
      }
      else if (text === '/top') {
        // جلب أفضل 10 لاعبين مرتبين من الأعلى للأقل
        const leaders = await kv.zrange('leaderboard', 0, 9, { rev: true, withScores: true });
        
        if (!leaders || leaders.length === 0) {
          await sendMessage(chatId, "لا يوجد أي نقاط مسجلة حتى الآن.");
        } else {
          let topText = "🏆 *أفضل اللاعبين:*\n\n";
          // ترتيب البيانات المستخرجة
          for (let i = 0; i < leaders.length; i++) {
            topText += `${i + 1}. ${leaders[i].member} - ${leaders[i].score} نقطة\n`;
          }
          await sendMessage(chatId, topText);
        }
      }
    } 
    // ب: إذا كانت نقرة على زر (Callback Query)
    else if (body.callback_query) {
      const callbackId = body.callback_query.id;
      const data = body.callback_query.data;
      const userName = body.callback_query.from.first_name || "مجهول";

      if (data === "correct") {
        // قراءة الرصيد القديم، زيادة 10 نقاط، وحفظه مجدداً في لوحة الشرف
        const currentScore = await kv.zscore('leaderboard', userName) || 0;
        const newScore = currentScore + 10;
        
        // استخدام zadd لحفظ الاسم مع الرصيد كنظام ترتيب
        await kv.zadd('leaderboard', { score: newScore, member: userName });
        
        await answerCallback(callbackId, "✅ إجابة صحيحة! تمت إضافة 10 نقاط لرصيدك.");
      } else if (data === "wrong") {
        await answerCallback(callbackId, "❌ إجابة خاطئة، لم يتم خصم نقاط.");
      }
    }
  } catch (error) {
    console.error("Error processing request:", error);
  }

  // 5. إرسال استجابة 200 لتيليجرام لإنهاء الطلب بنجاح (ضروري جداً)
  return res.status(200).json({ success: true });
}
