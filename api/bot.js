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

  // ✨ ميزة الترحيب التلقائي عند انضمام شخص للمجموعة أو إضافة البوت ✨
  if (message.new_chat_members) {
    for (let member of message.new_chat_members) {
      if (member.is_bot && member.username === message.chat.username) { 
        // إذا تم إضافة البوت للمجموعة
        return sendTgMessage(chatId, `مرحباً بالجميع! 🌟\nأنا بوت المسابقات الذكي. جاهزون للتحدي؟ أرسلوا /quiz لنبدأ!`);
      } else if (!member.is_bot) {
        // إذا انضم مستخدم جديد للمجموعة
        return sendTgMessage(chatId, `أهلاً بك يا [${member.first_name}](tg://user?id=${member.id}) في المجموعة! 🥳\nهل أنت مستعد لاختبار معلوماتك؟ أرسل /quiz للبدء!`);
      }
    }
    return;
  }

  // ✨ رسالة الترحيب الاحترافية عند الدخول للبوت ✨
  if (text === '/start' || text === '🚀 ابدأ من جديد') {
    await setDoc(userRef, { score: 0, streak: 0, name: userName }, { merge: true });
    await setDoc(chatRef, { answered: [], active_category: null }, { merge: true });
    
    const welcomeText = `مرحباً بك يا *${userName}* في عالم التحدي والمعرفة! 🌟🎮\n\n` +
                        `*📋 قواعد اللعبة:* \n` +
                        `⏱️ *الوقت:* أمامك 20 ثانية فقط للإجابة.\n` +
                        `⚡ *السرعة:* إجابتك في أول 5 ثوانٍ تمنحك (+5 نقاط إضافية).\n` +
                        `🔥 *السلسلة:* 3 إجابات صحيحة متتالية تضاعف نقاطك!\n` +
                        `🌟 *الأسئلة الذهبية:* تظهر فجأة وتضاعف رصيدك فوراً.\n\n` +
                        `اضغط على (🎮 *سؤال جديد*) من القائمة بالأسفل للبدء! 👇`;
                        
    return sendTgMessage(chatId, welcomeText, getKeyboard(userId));
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
