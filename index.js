require("dotenv").config();
const { Telegraf, session, Markup } = require("telegraf");
const { MongoClient } = require("mongodb");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");

const MONGO_URI =
  process.env.MONGO_URI ||
  "mongodb+srv://sbp31bot:iR5nObb0cm3JI5hj@sbp31bot.fnh49f1.mongodb.net/AutoPoster?retryWrites=true&w=majority&appName=sbp31bot";
const COVER_PHOTO = path.join(__dirname, "media/cover.jpg");
const ADMIN_ID = 7437546679;
const TRIAL_DAYS = 14;
const ANTISPAM_COOLDOWN = 1000;

const SUBSCRIPTIONS = {
  standard: { minInterval: 300, maxSchedules: 1, vpn: false },
  vip: { minInterval: 90, maxSchedules: 3, vpn: false },
  ultra: { minInterval: 30, maxSchedules: 5, vpn: true },
  trial_expired: { minInterval: Infinity, maxSchedules: 0, vpn: false },
};

let db;
let schedulesCollection;
let usersCollection;
let settingsCollection;
let transactionsCollection;
let weeklyWinnersCollection;
let intervals = {};
let vpnInterval;
let weeklyGiftInterval;
let reminderInterval;
let schedules = [];
let currentVpn = "";
let lastActionTimestamps = new Map();

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  const now = Date.now();
  const lastAction = lastActionTimestamps.get(userId) || 0;
  if (now - lastAction < ANTISPAM_COOLDOWN) {
    const msg = await ctx.reply("Gaty köp hereket, garaşyň! ⏳");
    setTimeout(async () => {
      try {
        await ctx.deleteMessage(msg.message_id);
      } catch (err) {}
    }, 1000);
    return;
  }
  lastActionTimestamps.set(userId, now);
  await next();
});

bot.use(async (ctx, next) => {
  const userId = ctx.from?.id;
  if (!userId) return;
  const userResult = await getUser(userId);
  if (userResult.success && userResult.data.banned) {
    const banMessage =
      userResult.data.ban_message ||
      "Sen ban boldyň, git aňyňdan ýala, ýaramaz! 🤬";
    await ctx.reply(banMessage);
    return;
  }
  await next();
});

bot.use(session());

async function connectMongo() {
  try {
    const client = new MongoClient(MONGO_URI);
    await client.connect();
    db = client.db("AutoPoster");
    schedulesCollection = db.collection("schedules");
    usersCollection = db.collection("users");
    settingsCollection = db.collection("settings");
    transactionsCollection = db.collection("transactions");
    weeklyWinnersCollection = db.collection("weekly_winners");
    const loadedSchedules = await schedulesCollection.find({}).toArray();
    schedules = loadedSchedules.map((sch) => {
      const newSch = { ...sch, id: sch._id };
      delete newSch._id;
      if (typeof newSch.active === "undefined") newSch.active = true;
      return newSch;
    });
    const vpnSetting = await settingsCollection.findOne({ _id: "current_vpn" });
    currentVpn = vpnSetting ? vpnSetting.value : "";
    return {
      success: true,
      message: "MongoDB baglantysy üstünlikli ýerine ýetirildi.",
    };
  } catch (err) {
    return {
      success: false,
      message: `MongoDB baglantysy başarmady: ${err.message}`,
    };
  }
}

async function saveSchedules() {
  try {
    for (const sch of schedules) {
      const updateData = { ...sch };
      delete updateData.id;
      await schedulesCollection.updateOne(
        { _id: sch.id },
        { $set: updateData },
        { upsert: true }
      );
    }
    return { success: true, message: "Maslahatlar üstünlikli ýazyldy." };
  } catch (err) {
    return {
      success: false,
      message: `Maslahatlary ýazmakda ýalňyşlyk: ${err.message}`,
    };
  }
}

async function initSchedules() {
  try {
    Object.values(intervals).forEach((interval) => clearInterval(interval));
    intervals = {};
    for (const [index, sch] of schedules.entries()) {
      if (!sch.active) continue;
      try {
        await bot.telegram.getChat(sch.chat_id);
        intervals[sch.id] = setInterval(async () => {
          try {
            if (sch.last_message_id) {
              await bot.telegram
                .deleteMessage(sch.chat_id, sch.last_message_id)
                .catch((err) => {});
            }
            let message;
            if (sch.media_url) {
              message = await bot.telegram.sendPhoto(
                sch.chat_id,
                sch.media_url,
                {
                  caption: sch.text,
                }
              );
            } else {
              message = await bot.telegram.sendMessage(sch.chat_id, sch.text);
            }
            sch.last_message_id = message.message_id;
            await saveSchedules();
          } catch (err) {
            if (
              err.description.includes("forbidden") ||
              err.description.includes("not allowed")
            ) {
              await bot.telegram.sendMessage(
                sch.user_id,
                `Kanalda ${sch.chat_id} administratory däl, administratory et we täzeden synan! Wagt gutardy, meni administratory etmegi ýatdan çykarmaň! 🚫`
              );
            }
            if (err.code === 429) {
              setTimeout(() => {
                if (intervals[sch.id]) intervals[sch.id]();
              }, 5000);
            }
          }
        }, Math.max(sch.interval * 1000, 30000));
      } catch (err) {}
    }
    return { success: true, message: "Maslahatlar üstünlikli başlatyldy." };
  } catch (err) {
    return {
      success: false,
      message: `Maslahatlary başlatmak başarmady: ${err.message}`,
    };
  }
}

async function getUser(userId) {
  let user = await usersCollection.findOne({ _id: userId });
  if (!user) {
    user = {
      _id: userId,
      subscription: "standard",
      expiration: Date.now() + TRIAL_DAYS * 86400000,
      vpn_channel: null,
      last_vpn_sent: null,
      created_at: Date.now(),
      spam_attempts: 0,
      banned: false,
      ban_message: null,
    };
    const result = await usersCollection.insertOne(user);
    if (result.acknowledged) {
      return {
        success: true,
        data: user,
        message: "Täze ulanyjy üstünlikli döredildi.",
      };
    } else {
      return { success: false, message: "Ulanyjy döretmek başarmady." };
    }
  }
  if (typeof user.spam_attempts === "undefined") user.spam_attempts = 0;
  if (typeof user.banned === "undefined") user.banned = false;
  if (typeof user.ban_message === "undefined") user.ban_message = null;
  return { success: true, data: user };
}

async function updateUser(user) {
  try {
    const result = await usersCollection.updateOne(
      { _id: user._id },
      { $set: user }
    );
    if (result.matchedCount > 0) {
      return {
        success: true,
        message: "Ulanyjy maglumatlary üstünlikli täzelendi.",
      };
    } else {
      return { success: false, message: "Ulanyjy tapylmady." };
    }
  } catch (err) {
    return {
      success: false,
      message: `Ulanyjy täzelemek başarmady: ${err.message}`,
    };
  }
}

async function getEffectiveSub(userId) {
  const userResult = await getUser(userId);
  if (!userResult.success) return "trial_expired";
  const user = userResult.data;
  if (user.expiration && user.expiration < Date.now()) {
    user.subscription = "trial_expired";
    user.expiration = null;
    await updateUser(user);
    return "trial_expired";
  }
  return user.subscription;
}

async function setSetting(key, value) {
  try {
    await settingsCollection.updateOne(
      { _id: key },
      { $set: { value } },
      { upsert: true }
    );
    return { success: true, message: "Aýratynlyk üstünlikli ýazyldy." };
  } catch (err) {
    return {
      success: false,
      message: `Aýratynlyk ýazmak başarmady: ${err.message}`,
    };
  }
}

function sanitizeInput(input) {
  return input.replace(/[<>${}`]/g, "").trim();
}

async function getMainKeyboard(effectiveSub, isAdmin) {
  let buttons = [["Profil 👤", "Dükan 🛒"]];
  if (effectiveSub !== "trial_expired") {
    buttons.push(["Maslahat goş 💫", "Maslahatlary gör 📋", "VPNlary gör 📋"]);
    const conditionalButtons = [];
    if (effectiveSub === "ultra" || isAdmin) {
      conditionalButtons.push("VPN goş 🌐");
    }
    if (isAdmin) {
      conditionalButtons.push("Panel 🎛️");
    }
    if (conditionalButtons.length > 0) {
      buttons.push(conditionalButtons);
    }
  }
  return Markup.keyboard(buttons).resize();
}

async function showMainKeyboard(ctx) {
  const effectiveSub = await getEffectiveSub(ctx.from.id);
  const isAdmin = ctx.from.id === ADMIN_ID;
  const keyboard = await getMainKeyboard(effectiveSub, isAdmin);
  try {
    await ctx.replyWithPhoto(
      { source: COVER_PHOTO },
      {
        caption:
          effectiveSub === "trial_expired"
            ? "Synag möhletiňiz gutardy! 😔 Boty ulanmak üçin abuna boluň."
            : "Hoş geldiňiz! 🌟 Bir amal saýlaň:",
        ...keyboard,
      }
    );
    return { success: true, message: "Baş menýu üstünlikli görkezildi." };
  } catch (err) {
    await ctx.reply(
      effectiveSub === "trial_expired"
        ? "Synag möhletiňiz gutardy! 😔 Boty ulanmak üçin abuna boluň."
        : "Bir amal saýlaň! 😊",
      keyboard
    );
    return {
      success: false,
      message: `Baş menýu görkezmek başarmady: ${err.message}`,
    };
  }
}

bot.start(async (ctx) => {
  if (ctx.session?.started) return;
  ctx.session = { started: true };
  const userId = ctx.from.id;
  const username = ctx.from.username ? `@${ctx.from.username}` : null;
  const userResult = await getUser(userId);
  if (userResult.success) {
    const user = userResult.data;
    if (!user.username) {
      user.username = username;
      await updateUser(user);
    }
  }
  await showMainKeyboard(ctx);
});

bot.command("pp_cmd", async (ctx) => {
  await ctx.reply(
    "Gizlinlik syýasaty: 📜\n\nBiz siziň maglumatlaryňyzy howpsuz saklaýarys. Ulanyjy ID-si, abunalyk derejesi, maslahat nastroykalary we beýleki zerur maglumatlar MongoDB bazasynda saklanýar. Bu maglumatlar diňe botyň dogry işlemegi üçin ulanylýar we hiç haçan üçünji taraplara berilmeýär. Tölegler Telegram Stars arkaly amala aşyrylýar we Telegramyň gizlinlik syýasaty boýunça dolandyrylýar.We edilen töleg yzyna gaýtarylyp berilmeýär! Boty ulanmak bilen, siz bu şertleri kabul edýärsiňiz."
  );
});

bot.hears("Profil 👤", async (ctx) => {
  const userId = ctx.from.id;
  const userResult = await getUser(userId);
  if (!userResult.success) {
    await ctx.reply(`Ýalňyşlyk: ${userResult.message} 😔`);
    return userResult;
  }
  const user = userResult.data;
  const effectiveSub = await getEffectiveSub(userId);
  const subInfo = `👤 Profil maglumatlary:
Ulanyjy ID: ${user._id}
Ady: ${user.username || "Ýok"}
Abunalyk: ${effectiveSub.charAt(0).toUpperCase() + effectiveSub.slice(1)}
${
  user.expiration
    ? `Gutaryş senesi: ${new Date(user.expiration).toLocaleString()}`
    : effectiveSub === "trial_expired"
    ? "Ýagdaý: Synag möhleti gutardy 😔\nBoty ulanmak üçin abuna boluň."
    : "Gutaryş senesi: Ýok"
}
VPN kanaly: ${user.vpn_channel || "Bellenmedi"}
Soňky VPN ugradylan: ${
    user.last_vpn_sent
      ? new Date(user.last_vpn_sent).toLocaleString()
      : "Hiç haçan"
  }`;
  await ctx.reply(
    subInfo,
    Markup.inlineKeyboard([
      [Markup.button.callback("Meniň söwdalarym 💳", "my_transactions")],
    ])
  );
  return {
    success: true,
    message: "Profil maglumatlary üstünlikli görkezildi.",
  };
});

bot.action("my_transactions", async (ctx) => {
  await ctx.answerCbQuery();
  const userId = ctx.from.id;
  const trans = await transactionsCollection
    .find({ user_id: userId })
    .toArray();
  if (trans.length === 0) {
    await ctx.reply("Hiç hili söwda ýok. 😔");
    return { success: true, message: "Söwda ýok." };
  }
  for (const t of trans) {
    const info = `Söwda ID: ${t._id}\nDereje: ${
      t.type.charAt(0).toUpperCase() + t.type.slice(1)
    }\nMöhlet: ${t.period === "week" ? "Hepde" : "Aý"}\nStars: ${
      t.stars
    }\nSene: ${new Date(t.date).toLocaleString()}`;
    await ctx.reply(info);
  }
  return { success: true, message: "Söwdalar görkezildi." };
});

bot.hears("Maslahat goş 💫", async (ctx) => {
  const effectiveSub = await getEffectiveSub(ctx.from.id);
  if (effectiveSub === "trial_expired") {
    await ctx.reply(
      "Synag möhletiňiz gutardy! 😔 Boty ulanmak üçin abuna boluň.",
      Markup.inlineKeyboard([[Markup.button.callback("Dükan 🛒", "shop")]])
    );
    return { success: false, message: "Synag möhleti gutardy." };
  }
  ctx.session = { state: "add_channel", started: ctx.session?.started || true };
  await ctx.reply("Kanal ID-ni ýazyň (mysal: @kanal ýa-da -1001234567890): 📢");
  return {
    success: true,
    message: "Maslahat goşma soragy üstünlikli işledildi.",
  };
});

bot.hears("Maslahatlary gör 📋", async (ctx) => {
  const effectiveSub = await getEffectiveSub(ctx.from.id);
  if (effectiveSub === "trial_expired") {
    await ctx.reply(
      "Synag möhletiňiz gutardy! 😔 Boty ulanmak üçin abuna boluň."
    );
    return { success: false, message: "Synag möhleti gutardy." };
  }
  let userSchedules;
  const isAdmin = ctx.from.id === ADMIN_ID;
  if (isAdmin) {
    userSchedules = schedules;
  } else {
    userSchedules = schedules.filter((sch) => sch.user_id === ctx.from.id);
  }
  if (userSchedules.length === 0) {
    await ctx.reply("Hiç hili maslahat tapylmady. 😔");
    return { success: false, message: "Hiç hili maslahat tapylmady." };
  }
  for (const sch of userSchedules) {
    const info = `ID: ${sch.id}${
      isAdmin ? `\nUlanyjy: ${sch.user_id}` : ""
    }\nKanal: ${sch.chat_id}\nWagt aralygy: ${sch.interval} sekunt\nTekst: "${
      sch.text
    }"${sch.media_url ? `\nMedia: ${sch.media_url} 🖼️` : ""}\nAktiw: ${
      sch.active ? "Hawa" : "Ýok"
    }`;
    await ctx.reply(
      info,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            sch.active ? "Duruz 🛑" : "Başla ▶️",
            `toggle_${sch.id}`
          ),
        ],
        [Markup.button.callback("Teksti üýtget ✏️", `change_text_${sch.id}`)],
        [
          Markup.button.callback(
            "Wagt aralygyny üýtget ⏱️",
            `change_interval_${sch.id}`
          ),
        ],
        [Markup.button.callback("Poz 🗑️", `delete_${sch.id}`)],
      ])
    );
  }
  return { success: true, message: "Maslahatlar üstünlikli görkezildi." };
});

bot.hears("VPNlary gör 📋", async (ctx) => {
  const isAdmin = ctx.from.id === ADMIN_ID;
  const effectiveSub = await getEffectiveSub(ctx.from.id);
  if (effectiveSub !== "ultra" && !isAdmin) {
    await ctx.reply(
      effectiveSub === "trial_expired"
        ? "Synag möhletiňiz gutardy! 😔 Boty ulanmak üçin abuna boluň."
        : "Bu funksiýa diňe Ultra VIP ýa-da adminler üçin. 🚫"
    );
    return {
      success: false,
      message: "Ultra VIP ýa-da admin bolman VPN kanallary görkezilmez.",
    };
  }
  let vpnChannels = [];
  if (isAdmin) {
    vpnChannels = await usersCollection
      .find({ vpn_channel: { $ne: null } })
      .toArray();
  } else {
    const userResult = await getUser(ctx.from.id);
    if (userResult.success && userResult.data.vpn_channel) {
      vpnChannels = [userResult.data];
    }
  }
  if (vpnChannels.length === 0) {
    await ctx.reply("Hiç hili VPN kanaly tapylmady. 😔");
    return { success: false, message: "Hiç hili VPN kanaly tapylmady." };
  }
  for (const user of vpnChannels) {
    const info = `Ulanyjy ID: ${user._id}\nVPN kanaly: ${
      user.vpn_channel
    }\nSoňky VPN ugradylan: ${
      user.last_vpn_sent
        ? new Date(user.last_vpn_sent).toLocaleString()
        : "Hiç haçan"
    }`;
    await ctx.reply(
      info,
      Markup.inlineKeyboard([
        [Markup.button.callback("Poz 🗑️", `delete_vpn_${user._id}`)],
      ])
    );
  }
  return { success: true, message: "VPN kanallary üstünlikli görkezildi." };
});

bot.hears("VPN goş 🌐", async (ctx) => {
  const effectiveSub = await getEffectiveSub(ctx.from.id);
  const isAdmin = ctx.from.id === ADMIN_ID;
  if (effectiveSub !== "ultra" && !isAdmin) {
    await ctx.reply(
      effectiveSub === "trial_expired"
        ? "Synag möhletiňiz gutardy! 😔 Boty ulanmak üçin abuna boluň."
        : "Bu funksiýa diňe Ultra VIP ýa-da adminler üçin. 🚫"
    );
    return {
      success: false,
      message: "Ultra VIP ýa-da admin bolman VPN goşup bolmaz.",
    };
  }
  ctx.session = {
    state: "add_vpn_channel",
    started: ctx.session?.started || true,
  };
  await ctx.reply(
    "VPN kanalyň ID-ni ýazyň (mysal: @kanal ýa-da -1001234567890): 📢"
  );
  return {
    success: true,
    message: "VPN kanal goşma soragy üstünlikli işledildi.",
  };
});

async function showShop(ctx) {
  await ctx.reply(
    "Dükana hoş geldiňiz 🛒\nAbunalyk derejesini saýlaň: 🌟",
    Markup.inlineKeyboard([
      [Markup.button.callback("VIP 👑", "shop_vip")],
      [Markup.button.callback("Ultra VIP 🌟", "shop_ultra")],
    ])
  );
}

bot.hears("Dükan 🛒", showShop);

bot.action("shop", async (ctx) => {
  await ctx.answerCbQuery();
  await showShop(ctx);
});

bot.action("shop_vip", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `VIP abunalygy mümkinçilikleri:\n- Iň az wagt aralygy: 90 sekunt\n- Maksimum maslahat sany: 3\n- VPN goldawy: Ýok\n\nMöhleti saýlaň:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("1 Hepde (25 ⭐)", "pay_vip_week")],
      [Markup.button.callback("1 Aý (100 ⭐)", "pay_vip_month")],
    ])
  );
});

bot.action("shop_ultra", async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply(
    `Ultra VIP abunalygy mümkinçilikleri:\n- Iň az wagt aralygy: 30 sekunt\n- Maksimum maslahat sany: 5\n- VPN goldawy: Hawa\n\nMöhleti saýlaň:`,
    Markup.inlineKeyboard([
      [Markup.button.callback("1 Hepde (35 ⭐)", "pay_ultra_week")],
      [Markup.button.callback("1 Aý (150 ⭐)", "pay_ultra_month")],
    ])
  );
});

bot.action("pay_vip_week", async (ctx) => {
  await ctx.answerCbQuery();

  const title = "VIP abunalygy 1 hepde";
  const desc =
    "VIP abunalygy 1 hepde üçin. Töleg etmek bilen, gizlinlik syýasatymyz bilen ylalaşýarsyňyz!";

  const payload = JSON.stringify({
    type: "vip",
    period: "week",
    user_id: ctx.from.id,
  });

  const prices = [{ label: "VIP 1 hepde", amount: 25 }];

  await ctx.telegram.sendInvoice(ctx.from.id, {
    title,
    description: desc,
    payload,
    currency: "XTR",
    prices,
    start_parameter: "pay",
    provider_token: process.env.PROVIDER_TOKEN,
  });
});

bot.action("pay_vip_month", async (ctx) => {
  await ctx.answerCbQuery();
  const title = "VIP abunalygy 1 aý";
  const desc =
    "VIP abunalygy 1 aý üçin. Töleg etmek bilen, gizlinlik syýasatymyz bilen ylalaşýarsyňyz!";
  const payload = JSON.stringify({
    type: "vip",
    period: "month",
    user_id: ctx.from.id,
  });
  const prices = [{ label: "VIP 1 aý", amount: 100 }];
  await ctx.telegram.sendInvoice(ctx.from.id, {
    title,
    description: desc,
    payload,
    currency: "XTR",
    prices,
    start_parameter: "pay",
    provider_token: process.env.PROVIDER_TOKEN,
  });
});

bot.action("pay_ultra_week", async (ctx) => {
  await ctx.answerCbQuery();
  const title = "Ultra VIP abunalygy 1 hepde";
  const desc =
    "Ultra VIP abunalygy 1 hepde üçin. Töleg etmek bilen, gizlinlik syýasatymyz bilen ylalaşýarsyňyz!";
  const payload = JSON.stringify({
    type: "ultra",
    period: "week",
    user_id: ctx.from.id,
  });
  const prices = [{ label: "Ultra VIP 1 hepde", amount: 35 }];
  await ctx.telegram.sendInvoice(ctx.from.id, {
    title,
    description: desc,
    payload,
    currency: "XTR",
    prices,
    start_parameter: "pay",
    provider_token: process.env.PROVIDER_TOKEN,
  });
});

bot.action("pay_ultra_month", async (ctx) => {
  await ctx.answerCbQuery();
  const title = "Ultra VIP abunalygy 1 aý";
  const desc =
    "Ultra VIP abunalygy 1 aý üçin. Töleg etmek bilen, gizlinlik syýasatymyz bilen ylalaşýarsyňyz!";
  const payload = JSON.stringify({
    type: "ultra",
    period: "month",
    user_id: ctx.from.id,
  });
  const prices = [{ label: "Ultra VIP 1 aý", amount: 150 }];
  await ctx.telegram.sendInvoice(ctx.from.id, {
    title,
    description: desc,
    payload,
    currency: "XTR",
    prices,
    start_parameter: "pay",
    provider_token: process.env.PROVIDER_TOKEN,
  });
});

bot.on("pre_checkout_query", async (ctx) => {
  await ctx.answerPreCheckoutQuery(true);
});

bot.on("successful_payment", async (ctx) => {
  const payment = ctx.message.successful_payment;
  let payload;
  try {
    payload = JSON.parse(payment.invoice_payload);
  } catch (err) {
    console.error("Payload parse ýalňyşlyk:", err);
    return;
  }
  const days = payload.period === "week" ? 7 : 30;
  const expiration = Date.now() + days * 86400000;
  const userResult = await getUser(payload.user_id);
  if (!userResult.success) return;
  const user = userResult.data;
  user.subscription = payload.type;
  user.expiration = expiration;
  await updateUser(user);
  const trans = {
    _id: uuidv4(),
    user_id: payload.user_id,
    type: payload.type,
    period: payload.period,
    stars: payment.total_amount,
    date: Date.now(),
    telegram_charge_id: payment.telegram_payment_charge_id,
  };
  await transactionsCollection.insertOne(trans);
  await ctx.reply(
    `Sag boluň tölegiňiz üçin! 🎉\nSöwda ID: ${
      trans._id
    }\nAbunalyk: ${payload.type.toUpperCase()} (${
      payload.period === "week" ? "Hepde" : "Aý"
    })\nGutaryş senesi: ${new Date(expiration).toLocaleString()}`
  );
  await initSchedules();
});

bot.command("broadcast", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.reply("Bu funksiýa diňe adminler üçin. 🚫");
    return;
  }
  ctx.session = {
    state: "broadcast_message",
    started: ctx.session?.started || true,
  };
  await ctx.reply("Ähli ulanyjylara iberiljek habary ýazyň: 📢");
});

bot.hears("Panel 🎛️", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.reply("Bu funksiýa diňe adminler üçin. 🚫");
    return { success: false, message: "Ygtyýarsyz funksiýa." };
  }
  await ctx.reply(
    "Admin paneline hoş geldiňiz! 🎛️\nAşakdaky amallary ýerine ýetiriň:",
    Markup.inlineKeyboard([
      [
        Markup.button.callback("VPN goş 🌐", "admin_add_vpn"),
        Markup.button.callback("VPN poz 🗑️", "admin_delete_vpn"),
      ],
      [
        Markup.button.callback("Stars çykar 💰", "admin_withdraw"),
        Markup.button.callback(
          "Hepdelik utuş taryhy 📜",
          "admin_weekly_history"
        ),
      ],
      [
        Markup.button.callback("Ulanyjy ban et 🚫", "admin_ban"),
        Markup.button.callback("Ulanyjy bany aç 🚪", "admin_unban"),
      ],
      [
        Markup.button.callback(
          "Ban habary bellemek 📝",
          "admin_set_ban_message"
        ),
        Markup.button.callback("Promo goş 🎟️", "admin_add_promo"),
      ],
      [Markup.button.callback("Mahabat 📡", "/broadcast")],
    ])
  );
  return { success: true, message: "Admin paneli üstünlikli görkezildi." };
});

bot.action("admin_weekly_history", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery("Bu funksiýa diňe adminler üçin. 🚫");
    return;
  }
  await ctx.answerCbQuery();
  const winners = await weeklyWinnersCollection.find({}).toArray();
  if (winners.length === 0) {
    await ctx.reply("Hiç hili hepdelik utuş taryhy ýok. 😔");
    return;
  }
  let message = "Hepdelik utuş taryhy: 📜\n";
  for (const winner of winners) {
    message += `Ulanyjy: ${winner.username || winner.user_id}, Sene: ${new Date(
      winner.date
    ).toLocaleString()}\n`;
  }
  await ctx.reply(message);
});

bot.action("admin_withdraw", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery("Bu funksiýa diňe adminler üçin. 🚫");
    return { success: false, message: "Ygtyýarsyz funksiýa." };
  }
  await ctx.answerCbQuery();
  await ctx.reply(
    "Stars çykarmak üçin @PremiumBot-a ýüz tutuň we balansyňyzy çykaryň. 💰"
  );
  return { success: true, message: "Çykarma maglumaty görkezildi." };
});

bot.action("admin_add_vpn", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery("Bu funksiýa diňe adminler üçin. 🚫");
    return { success: false, message: "Ygtyýarsyz funksiýa." };
  }
  await ctx.answerCbQuery();
  ctx.session = {
    ...ctx.session,
    state: "admin_vpn_title",
    started: ctx.session?.started || true,
  };
  await ctx.reply("VPN adyny (title) ýazyň: 📝");
  return {
    success: true,
    message: "VPN title soragy üstünlikli işledildi.",
  };
});

bot.action("admin_delete_vpn", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery("Bu funksiýa diňe adminler üçin. 🚫");
    return { success: false, message: "Ygtyýarsyz funksiýa." };
  }
  await ctx.answerCbQuery();
  const vpnChannels = await usersCollection
    .find({ vpn_channel: { $ne: null } })
    .toArray();
  if (vpnChannels.length === 0) {
    await ctx.reply("Hiç hili VPN kanaly tapylmady. 😔");
    return { success: false, message: "Hiç hili VPN kanaly tapylmady." };
  }
  for (const user of vpnChannels) {
    const info = `Ulanyjy ID: ${user._id}\nVPN kanaly: ${
      user.vpn_channel
    }\nSoňky VPN ugradylan: ${
      user.last_vpn_sent
        ? new Date(user.last_vpn_sent).toLocaleString()
        : "Hiç haçan"
    }`;
    await ctx.reply(
      info,
      Markup.inlineKeyboard([
        [Markup.button.callback("Poz 🗑️", `delete_vpn_${user._id}`)],
      ])
    );
  }
  return { success: true, message: "VPN kanallary üstünlikli görkezildi." };
});

bot.action("admin_add_promo", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery("Bu funksiýa diňe adminler üçin. 🚫");
    return { success: false, message: "Ygtyýarsyz funksiýa." };
  }
  await ctx.answerCbQuery();
  ctx.session = {
    ...ctx.session,
    state: "admin_promo",
    started: ctx.session?.started || true,
  };
  await ctx.reply(
    "Abunalyk görnüşini, ulanyjy ID-ni we günleri ýazyň (mysal: ultra 123456789 30): 🎟️"
  );
  return { success: true, message: "Promo goşma soragy üstünlikli işledildi." };
});

bot.action("admin_ban", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery("Bu funksiýa diňe adminler üçin. 🚫");
    return { success: false, message: "Ygtyýarsyz funksiýa." };
  }
  await ctx.answerCbQuery();
  ctx.session = {
    ...ctx.session,
    state: "admin_ban_username",
    started: ctx.session?.started || true,
  };
  await ctx.reply(
    "Ban edilmeli ulanyjynyň @adyny ýazyň (mysal: @username): 🚫"
  );
  return { success: true, message: "Ban soragy üstünlikli işledildi." };
});

bot.action("admin_unban", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery("Bu funksiýa diňe adminler üçin. 🚫");
    return { success: false, message: "Ygtyýarsyz funksiýa." };
  }
  await ctx.answerCbQuery();
  ctx.session = {
    ...ctx.session,
    state: "admin_unban_username",
    started: ctx.session?.started || true,
  };
  await ctx.reply(
    "Bany açylmaly ulanyjynyň @adyny ýazyň (mysal: @username): 🚪"
  );
  return { success: true, message: "Unban soragy üstünlikli işledildi." };
});

bot.action("admin_set_ban_message", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery("Bu funksiýa diňe adminler üçin. 🚫");
    return { success: false, message: "Ygtyýarsyz funksiýa." };
  }
  await ctx.answerCbQuery();
  ctx.session = {
    ...ctx.session,
    state: "admin_set_ban_message_username",
    started: ctx.session?.started || true,
  };
  await ctx.reply(
    "Habar bellenmeli ulanyjynyň @adyny ýazyň (mysal: @username): 📝"
  );
  return { success: true, message: "Ban habary soragy üstünlikli işledildi." };
});

bot.action("add", async (ctx) => {
  const effectiveSub = await getEffectiveSub(ctx.from.id);
  if (effectiveSub === "trial_expired") {
    await ctx.answerCbQuery(
      "Synag möhletiňiz gutardy! 😔 Boty ulanmak üçin abuna boluň."
    );
    return { success: false, message: "Synag möhleti gutardy." };
  }
  await ctx.answerCbQuery();
  ctx.session = { state: "add_channel", started: ctx.session?.started || true };
  await ctx.reply("Kanal ID-ni ýazyň (mysal: @kanal ýa-da -1001234567890): 📢");
  return {
    success: true,
    message: "Maslahat goşma soragy üstünlikli işledildi.",
  };
});

bot.action("list", async (ctx) => {
  const effectiveSub = await getEffectiveSub(ctx.from.id);
  if (effectiveSub === "trial_expired") {
    await ctx.answerCbQuery(
      "Synag möhletiňiz gutardy! 😔 Boty ulanmak üçin abuna boluň."
    );
    return { success: false, message: "Synag möhleti gutardy." };
  }
  await ctx.answerCbQuery();
  let userSchedules;
  const isAdmin = ctx.from.id === ADMIN_ID;
  if (isAdmin) {
    userSchedules = schedules;
  } else {
    userSchedules = schedules.filter((sch) => sch.user_id === ctx.from.id);
  }
  if (userSchedules.length === 0) {
    await ctx.reply("Hiç hili maslahat tapylmady. 😔", {
      reply_markup: Markup.inlineKeyboard([
        [Markup.button.callback("Maslahat goş 💫", "add")],
        [Markup.button.callback("Maslahatlary gör 📋", "list")],
      ]),
    });
    return { success: false, message: "Hiç hili maslahat tapylmady." };
  }
  for (const sch of userSchedules) {
    const info = `ID: ${sch.id}${
      isAdmin ? `\nUlanyjy: ${sch.user_id}` : ""
    }\nKanal: ${sch.chat_id}\nWagt aralygy: ${sch.interval} sekunt\nTekst: "${
      sch.text
    }"${sch.media_url ? `\nMedia: ${sch.media_url} 🖼️` : ""}\nAktiw: ${
      sch.active ? "Hawa" : "Ýok"
    }`;
    await ctx.reply(
      info,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            sch.active ? "Duruz 🛑" : "Başla ▶️",
            `toggle_${sch.id}`
          ),
        ],
        [Markup.button.callback("Teksti üýtget ✏️", `change_text_${sch.id}`)],
        [
          Markup.button.callback(
            "Wagt aralygyny üýtget ⏱️",
            `change_interval_${sch.id}`
          ),
        ],
        [Markup.button.callback("Poz 🗑️", `delete_${sch.id}`)],
      ])
    );
  }
  return { success: true, message: "Maslahatlar üstünlikli görkezildi." };
});

bot.action(/^toggle_(.+)$/, async (ctx) => {
  const effectiveSub = await getEffectiveSub(ctx.from.id);
  if (effectiveSub === "trial_expired") {
    await ctx.answerCbQuery(
      "Synag möhletiňiz gutardy! 😔 Boty ulanmak üçin abuna boluň."
    );
    return { success: false, message: "Synag möhleti gutardy." };
  }
  const id = ctx.match[1];
  const sch = schedules.find((s) => s.id === id);
  if (!sch || (sch.user_id !== ctx.from.id && ctx.from.id !== ADMIN_ID)) {
    await ctx.answerCbQuery("Bu maslahat size degişli däl. 🚫");
    return { success: false, message: "Bu maslahat size degişli däl." };
  }
  sch.active = !sch.active;
  const saveResult = await saveSchedules();
  if (!saveResult.success) {
    await ctx.answerCbQuery(
      "Ýalňyşlyk: Maslahat ýagdaýyny üýtgetmek başarmady. 😔"
    );
    return saveResult;
  }
  const initResult = await initSchedules();
  if (!initResult.success) {
    await ctx.answerCbQuery("Ýalňyşlyk: Maslahatlary başlatmak başarmady. 😔");
    return initResult;
  }
  await ctx.answerCbQuery(`Ýagdaý: ${sch.active ? "Aktiw" : "Passiw"}`);
  const isAdmin = ctx.from.id === ADMIN_ID;
  const newInfo = `ID: ${sch.id}${
    isAdmin ? `\nUlanyjy: ${sch.user_id}` : ""
  }\nKanal: ${sch.chat_id}\nWagt aralygy: ${sch.interval} sekunt\nTekst: "${
    sch.text
  }"${sch.media_url ? `\nMedia: ${sch.media_url} 🖼️` : ""}\nAktiw: ${
    sch.active ? "Hawa" : "Ýok"
  }`;
  await ctx.editMessageText(
    newInfo,
    Markup.inlineKeyboard([
      [
        Markup.button.callback(
          sch.active ? "Duruz 🛑" : "Başla ▶️",
          `toggle_${sch.id}`
        ),
      ],
      [Markup.button.callback("Teksti üýtget ✏️", `change_text_${sch.id}`)],
      [
        Markup.button.callback(
          "Wagt aralygyny üýtget ⏱️",
          `change_interval_${sch.id}`
        ),
      ],
      [Markup.button.callback("Poz 🗑️", `delete_${sch.id}`)],
    ])
  );
  return { success: true, message: "Maslahat ýagdaýy üstünlikli üýtgedildi." };
});

bot.action(/^change_text_(.+)$/, async (ctx) => {
  const effectiveSub = await getEffectiveSub(ctx.from.id);
  if (effectiveSub === "trial_expired") {
    await ctx.answerCbQuery(
      "Synag möhletiňiz gutardy! 😔 Boty ulanmak üçin abuna boluň."
    );
    return { success: false, message: "Synag möhleti gutardy." };
  }
  const id = ctx.match[1];
  const sch = schedules.find((s) => s.id === id);
  if (!sch || (sch.user_id !== ctx.from.id && ctx.from.id !== ADMIN_ID)) {
    await ctx.answerCbQuery("Bu maslahat size degişli däl. 🚫");
    return { success: false, message: "Bu maslahat size degişli däl." };
  }
  ctx.session = { ...ctx.session, state: "change_text", change_id: id };
  await ctx.answerCbQuery();
  await ctx.reply("Täze tekst ýazyň: ✍️");
  return {
    success: true,
    message: "Tekst üýtgetme soragy üstünlikli işledildi.",
  };
});

bot.action(/^change_interval_(.+)$/, async (ctx) => {
  const effectiveSub = await getEffectiveSub(ctx.from.id);
  if (effectiveSub === "trial_expired") {
    await ctx.answerCbQuery(
      "Synag möhletiňiz gutardy! 😔 Boty ulanmak üçin abuna boluň."
    );
    return { success: false, message: "Synag möhleti gutardy." };
  }
  const id = ctx.match[1];
  const sch = schedules.find((s) => s.id === id);
  if (!sch || (sch.user_id !== ctx.from.id && ctx.from.id !== ADMIN_ID)) {
    await ctx.answerCbQuery("Bu maslahat size degişli däl. 🚫");
    return { success: false, message: "Bu maslahat size degişli däl." };
  }
  ctx.session = { ...ctx.session, state: "change_interval", change_id: id };
  await ctx.answerCbQuery();
  await ctx.reply("Täze wagt aralygyny sekuntlarda ýazyň: ⏱️");
  return {
    success: true,
    message: "Wagt aralygyny üýtgetme soragy üstünlikli işledildi.",
  };
});

bot.action(/^delete_(.+)$/, async (ctx) => {
  const effectiveSub = await getEffectiveSub(ctx.from.id);
  if (effectiveSub === "trial_expired") {
    await ctx.answerCbQuery(
      "Synag möhletiňiz gutardy! 😔 Boty ulanmak üçin abuna boluň."
    );
    return { success: false, message: "Synag möhleti gutardy." };
  }
  const id = ctx.match[1];
  const sch = schedules.find((s) => s.id === id);
  if (!sch || (sch.user_id !== ctx.from.id && ctx.from.id !== ADMIN_ID)) {
    await ctx.answerCbQuery("Bu maslahat size degişli däl. 🚫");
    return { success: false, message: "Bu maslahat size degişli däl." };
  }
  if (intervals[id]) {
    clearInterval(intervals[id]);
    delete intervals[id];
  }
  const index = schedules.findIndex((s) => s.id === id);
  schedules.splice(index, 1);
  try {
    await schedulesCollection.deleteOne({ _id: id });
    const initResult = await initSchedules();
    if (!initResult.success) {
      await ctx.answerCbQuery(
        "Ýalňyşlyk: Maslahatlary başlatmak başarmady. 😔"
      );
      return initResult;
    }
    await ctx.answerCbQuery("Pozuldy. 🗑️");
    await ctx.deleteMessage();
    return { success: true, message: "Maslahat üstünlikli pozuldy." };
  } catch (err) {
    await ctx.answerCbQuery("Ýalňyşlyk: Maslahat pozmak başarmady. 😔");
    return {
      success: false,
      message: `Maslahat pozmak başarmady: ${err.message}`,
    };
  }
});

bot.action(/^delete_vpn_(.+)$/, async (ctx) => {
  const effectiveSub = await getEffectiveSub(ctx.from.id);
  if (effectiveSub === "trial_expired") {
    await ctx.answerCbQuery(
      "Synag möhletiňiz gutardy! 😔 Boty ulanmak üçin abuna boluň."
    );
    return { success: false, message: "Synag möhleti gutardy." };
  }
  const userId = parseInt(ctx.match[1], 10);
  const isAdmin = ctx.from.id === ADMIN_ID;
  if (userId !== ctx.from.id && !isAdmin) {
    await ctx.answerCbQuery("Bu VPN kanaly size degişli däl. 🚫");
    return { success: false, message: "Bu VPN kanaly size degişli däl." };
  }
  const userResult = await getUser(userId);
  if (!userResult.success) {
    await ctx.answerCbQuery(`Ýalňyşlyk: ${userResult.message} 😔`);
    return userResult;
  }
  const user = userResult.data;
  user.vpn_channel = null;
  user.last_vpn_sent = null;
  const updateResult = await updateUser(user);
  if (!updateResult.success) {
    await ctx.answerCbQuery(`Ýalňyşlyk: ${updateResult.message} 😔`);
    return updateResult;
  }
  await ctx.answerCbQuery("VPN kanaly pozuldy. 🗑️");
  await ctx.deleteMessage();
  return { success: true, message: "VPN kanaly üstünlikli pozuldy." };
});

bot.on("text", async (ctx) => {
  const state = ctx.session?.state;
  const userId = ctx.from.id;
  const effectiveSub = await getEffectiveSub(userId);
  if (!state) {
    await showMainKeyboard(ctx);
    return { success: false, message: "Sessiya ýagdaýy tapylmady." };
  }
  if (effectiveSub === "trial_expired") {
    await ctx.reply(
      "Synag möhletiňiz gutardy! 😔 Boty ulanmak üçin abuna boluň."
    );
    ctx.session = { started: ctx.session.started };
    return { success: false, message: "Synag möhleti gutardy." };
  }
  const subConfig = SUBSCRIPTIONS[effectiveSub];
  if (state === "add_channel") {
    const chat_id = sanitizeInput(ctx.message.text);
    if (!chat_id.match(/^(@[a-zA-Z0-9_]+|-100\d+)$/)) {
      ctx.session = { started: ctx.session.started };
      await ctx.reply(
        "Nädogry kanal ID formaty (mysal: @kanal ýa-da -1001234567890). 🚫"
      );
      await showMainKeyboard(ctx);
      return { success: false, message: "Nädogry kanal ID formaty." };
    }
    if (schedules.some((sch) => sch.chat_id === chat_id)) {
      ctx.session = { started: ctx.session.started };
      await ctx.reply(
        `Bu kanal (@${chat_id} ýa-da ${chat_id}) üçin eýýäm maslahat bar. Bir kanalda diňe bir maslahat bolup biler. 😔`
      );
      await showMainKeyboard(ctx);
      return { success: false, message: "Kanalda eýýäm maslahat bar." };
    }
    const userSchedules = schedules.filter(
      (sch) => sch.user_id === userId
    ).length;
    if (userSchedules >= subConfig.maxSchedules) {
      ctx.session = { started: ctx.session.started };
      await ctx.reply(
        `Siziň abunalyk derejäňiz boýunça maksimum ${subConfig.maxSchedules} maslahat goşup bilersiňiz. 😔`
      );
      await showMainKeyboard(ctx);
      return { success: false, message: "Maksimum maslahat sany doldu." };
    }
    const userResult = await getUser(userId);
    const user = userResult.data;
    try {
      const admins = await bot.telegram.getChatAdministrators(chat_id);
      const botInfo = await bot.telegram.getMe();
      const botId = botInfo.id;
      const isBotAdmin = admins.some(
        (admin) =>
          admin.user.id === botId &&
          admin.can_post_messages &&
          admin.can_delete_messages
      );
      if (!isBotAdmin) {
        ctx.session = { started: ctx.session.started };
        await ctx.reply(
          "Bot kanal administratory däl ýa-da ýeterlik ygtyýarlar ýok. Boty administratory edip goşuň we ýazgy we pozmak hukugyny beriň. Soň täzeden synan. 🚫"
        );
        await showMainKeyboard(ctx);
        return { success: false, message: "Bot administratory däl." };
      }
      const owner = admins.find((admin) => admin.status === "creator");
      if (!owner || owner.user.id !== userId) {
        user.spam_attempts += 1;
        await updateUser(user);
        const remaining = 3 - user.spam_attempts;
        if (user.spam_attempts >= 3) {
          user.banned = true;
          await updateUser(user);
          await ctx.reply(
            "Başga biriniň kanalyny spam etmek synanyşygyňyz sebäpli ban boldyňyz! Git aňyňdan ýala! 🤬"
          );
          return { success: false, message: "Ulanyjy ban edildi." };
        } else {
          ctx.session = { started: ctx.session.started };
          await ctx.reply(
            `Başga biriniň kanalyny spam etmek isleýärsiňiz! Size ${remaining} synanyşyk galdy. 🚫`
          );
          await showMainKeyboard(ctx);
          return { success: false, message: "Spam synanyşygy." };
        }
      }
    } catch (err) {
      ctx.session = { started: ctx.session.started };
      await ctx.reply(
        "Bot kanal agzasy däl ýa-da adminleri almak başarmady. Boty kanal agzasy we administratory edip goşuň. Soň täzeden synan. 🚫"
      );
      await showMainKeyboard(ctx);
      return { success: false, message: "Kanal adminlerini almak başarmady." };
    }
    ctx.session.add = { chat_id };
    ctx.session.state = "add_text";
    await ctx.reply("Habaryň tekstini ýazyň: ✍️");
    return { success: true, message: "Kanal ID üstünlikli kabul edildi." };
  } else if (state === "add_text") {
    const text = sanitizeInput(ctx.message.text);
    if (!text) {
      await ctx.reply("Tekst boş bolmaly däl. 🚫");
      return { success: false, message: "Tekst boş bolmaly däl." };
    }
    ctx.session.add.text = text;
    ctx.session.state = "add_interval";
    await ctx.reply(
      `Wagt aralygyny sekuntlarda ýazyň (iň az ${subConfig.minInterval}): ⏱️`
    );
    return { success: true, message: "Tekst üstünlikli kabul edildi." };
  } else if (state === "add_interval") {
    const interval = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(interval) || interval < subConfig.minInterval) {
      await ctx.reply(
        `Wagt aralygy ${subConfig.minInterval} sekuntdan az bolmaly däl. Täzeden synan: ⏳`
      );
      return { success: false, message: "Nädogry wagt aralygy." };
    }
    const addData = ctx.session.add;
    addData.interval = interval;
    addData.media_url = null;
    addData.last_message_id = null;
    addData.id = uuidv4();
    addData.user_id = ctx.from.id;
    addData.active = true;
    try {
      await bot.telegram.getChat(addData.chat_id);
      schedules.push(addData);
      const saveResult = await saveSchedules();
      if (!saveResult.success) {
        await ctx.reply(`Ýalňyşlyk: ${saveResult.message} 😔`);
        ctx.session = { started: ctx.session.started };
        await showMainKeyboard(ctx);
        return saveResult;
      }
      const initResult = await initSchedules();
      if (!initResult.success) {
        await ctx.reply(`Ýalňyşlyk: ${initResult.message} 😔`);
        ctx.session = { started: ctx.session.started };
        await showMainKeyboard(ctx);
        return initResult;
      }
      await ctx.reply(`Maslahat üstünlikli goşuldy, ID: ${addData.id} 🎉`);
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return { success: true, message: "Maslahat üstünlikli goşuldy." };
    } catch (err) {
      await ctx.reply(
        `Maslahat goşmak başarmady: ${err.description || err.message} 😔`
      );
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return {
        success: false,
        message: `Maslahat goşmak başarmady: ${err.message}`,
      };
    }
  } else if (state === "change_text") {
    const id = ctx.session.change_id;
    const sch = schedules.find((s) => s.id === id);
    if (!sch || (sch.user_id !== ctx.from.id && ctx.from.id !== ADMIN_ID)) {
      ctx.session = { started: ctx.session.started };
      await ctx.reply("Bu maslahat size degişli däl. 🚫");
      return { success: false, message: "Bu maslahat size degişli däl." };
    }
    const text = sanitizeInput(ctx.message.text);
    if (!text) {
      await ctx.reply("Tekst boş bolmaly däl. 🚫");
      return { success: false, message: "Tekst boş bolmaly däl." };
    }
    sch.text = text;
    const saveResult = await saveSchedules();
    if (!saveResult.success) {
      await ctx.reply(`Ýalňyşlyk: ${saveResult.message} 😔`);
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return saveResult;
    }
    ctx.session = { started: ctx.session.started };
    await ctx.reply("Tekst täzelendi. 🎉");
    await showMainKeyboard(ctx);
    return { success: true, message: "Tekst üstünlikli täzelendi." };
  } else if (state === "change_interval") {
    const id = ctx.session.change_id;
    const sch = schedules.find((s) => s.id === id);
    if (!sch || (sch.user_id !== ctx.from.id && ctx.from.id !== ADMIN_ID)) {
      ctx.session = { started: ctx.session.started };
      await ctx.reply("Bu maslahat size degişli däl. 🚫");
      return { success: false, message: "Bu maslahat size degişli däl." };
    }
    const interval = parseInt(ctx.message.text.trim(), 10);
    if (isNaN(interval) || interval < subConfig.minInterval) {
      await ctx.reply(
        `Wagt aralygy ${subConfig.minInterval} sekuntdan az bolmaly däl. Täzeden synan: ⏳`
      );
      return { success: false, message: "Nädogry wagt aralygy." };
    }
    sch.interval = interval;
    const saveResult = await saveSchedules();
    if (!saveResult.success) {
      await ctx.reply(`Ýalňyşlyk: ${saveResult.message} 😔`);
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return saveResult;
    }
    const initResult = await initSchedules();
    if (!initResult.success) {
      await ctx.reply(`Ýalňyşlyk: ${initResult.message} 😔`);
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return initResult;
    }
    ctx.session = { started: ctx.session.started };
    await ctx.reply("Wagt aralygy täzelendi. 🎉");
    await showMainKeyboard(ctx);
    return { success: true, message: "Wagt aralygy üstünlikli täzelendi." };
  } else if (state === "add_vpn_channel") {
    const isAdmin = ctx.from.id === ADMIN_ID;
    if (effectiveSub !== "ultra" && !isAdmin) {
      ctx.session = { started: ctx.session.started };
      await ctx.reply(
        effectiveSub === "trial_expired"
          ? "Synag möhletiňiz gutardy! 😔 Boty ulanmak üçin abuna boluň."
          : "Bu funksiýa diňe Ultra VIP ýa-da adminler üçin. 🚫"
      );
      return {
        success: false,
        message: "Ultra VIP ýa-da admin bolman VPN kanal goşup bolmaz.",
      };
    }
    const channel = sanitizeInput(ctx.message.text);
    if (!channel.match(/^(@[a-zA-Z0-9_]+|-100\d+)$/)) {
      ctx.session = { started: ctx.session.started };
      await ctx.reply(
        "Nädogry kanal ID formaty (mysal: @kanal ýa-da -1001234567890). 🚫"
      );
      await showMainKeyboard(ctx);
      return { success: false, message: "Nädogry kanal ID formaty." };
    }
    try {
      await bot.telegram.getChat(channel);
      const userResult = await getUser(userId);
      if (!userResult.success) {
        await ctx.reply(`Ýalňyşlyk: ${userResult.message} 😔`);
        return userResult;
      }
      const user = userResult.data;
      user.vpn_channel = channel;
      user.last_vpn_sent = null;
      const updateResult = await updateUser(user);
      if (!updateResult.success) {
        await ctx.reply(`Ýalňyşlyk: ${updateResult.message} 😔`);
        return updateResult;
      }
      if (currentVpn) {
        try {
          await bot.telegram.sendMessage(channel, currentVpn);
          user.last_vpn_sent = Date.now();
          await updateUser(user);
        } catch (err) {
          await ctx.reply(
            `VPN ugratmak başarmady: ${err.description || err.message} 😔`
          );
        }
      }
      await ctx.reply("VPN kanaly üstünlikli goşuldy! 🎉");
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return { success: true, message: "VPN kanaly üstünlikli goşuldy." };
    } catch (err) {
      await ctx.reply(`Nädogry kanal ID: ${err.description || err.message} 🚫`);
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return { success: false, message: `Nädogry kanal ID: ${err.message}` };
    }
  } else if (state === "admin_vpn_title") {
    if (ctx.from.id !== ADMIN_ID) {
      ctx.session = { started: ctx.session.started };
      await ctx.reply("Bu funksiýa diňe adminler üçin. 🚫");
      return { success: false, message: "Ygtyýarsyz funksiýa." };
    }
    const title = sanitizeInput(ctx.message.text);
    if (!title) {
      await ctx.reply("Title ýazyň. 🚫");
      return { success: false, message: "Title berilmedi." };
    }
    ctx.session.vpn_title = title;
    ctx.session.state = "admin_vpn_config";
    await ctx.reply("VPN kody ýazyň: 🌐");
    return { success: true, message: "VPN title kabul edildi." };
  } else if (state === "admin_vpn_config") {
    if (ctx.from.id !== ADMIN_ID) {
      ctx.session = { started: ctx.session.started };
      await ctx.reply("Bu funksiýa diňe adminler üçin. 🚫");
      return { success: false, message: "Ygtyýarsyz funksiýa." };
    }
    const vpnCode = sanitizeInput(ctx.message.text);
    if (!vpnCode) {
      await ctx.reply("VPN kody ýazyň. 🚫");
      return { success: false, message: "VPN kody berilmedi." };
    }
    const title = ctx.session.vpn_title;
    currentVpn = `${title}\n\`${vpnCode}\`\n#sbp31PosterBot`;
    const setResult = await setSetting("current_vpn", currentVpn);
    if (!setResult.success) {
      await ctx.reply(`Ýalňyşlyk: ${setResult.message} 😔`);
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return setResult;
    }
    await ctx.reply("VPN konfigurasiýasy täzelendi. 🎉");
    ctx.session = { started: ctx.session.started };
    await showMainKeyboard(ctx);
    return {
      success: true,
      message: "VPN konfigurasiýasy üstünlikli täzelendi.",
    };
  } else if (state === "admin_promo") {
    if (ctx.from.id !== ADMIN_ID) {
      ctx.session = { started: ctx.session.started };
      await ctx.reply("Bu funksiýa diňe adminler üçin. 🚫");
      return { success: false, message: "Ygtyýarsyz funksiýa." };
    }
    const [, type, userIdStr, daysStr] =
      ctx.message.text.match(/(\w+)\s+(\d+)\s+(\d+)/) || [];
    if (!type || !userIdStr || !daysStr) {
      await ctx.reply("Nädogry format. Mysal: ultra 123456789 30 🚫");
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return { success: false, message: "Nädogry buýruk formaty." };
    }
    if (!["vip", "ultra", "standard"].includes(type)) {
      await ctx.reply(
        "Nädogry abunalyk görnüşi: vip, ultra ýa-da standard. 🚫"
      );
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return { success: false, message: "Nädogry abunalyk görnüşi." };
    }
    const targetUserId = parseInt(userIdStr, 10);
    const days = parseInt(daysStr, 10);
    if (isNaN(targetUserId) || isNaN(days)) {
      await ctx.reply("Nädogry ulanyjy ID ýa-da gün sany. 🚫");
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return { success: false, message: "Nädogry ulanyjy ID ýa-da gün sany." };
    }
    const targetUserResult = await getUser(targetUserId);
    if (!targetUserResult.success) {
      await ctx.reply(`Ýalňyşlyk: ${targetUserResult.message} 😔`);
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return targetUserResult;
    }
    const targetUser = targetUserResult.data;
    targetUser.subscription = type;
    targetUser.expiration = days > 0 ? Date.now() + days * 86400000 : null;
    const updateResult = await updateUser(targetUser);
    if (!updateResult.success) {
      await ctx.reply(`Ýalňyşlyk: ${updateResult.message} 😔`);
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return updateResult;
    }
    await ctx.reply(
      `Ulanyjy ${targetUserId} abunalygy ${type} boldy, ${days} gün. 🎉`
    );
    try {
      await bot.telegram.sendMessage(
        targetUserId,
        "Abunaňyz üstünlikli täzelendi! 🎉"
      );
    } catch (err) {}
    ctx.session = { started: ctx.session.started };
    await showMainKeyboard(ctx);
    return { success: true, message: "Abunalyk üstünlikli täzelendi." };
  } else if (state === "admin_ban_username") {
    if (ctx.from.id !== ADMIN_ID) {
      ctx.session = { started: ctx.session.started };
      await ctx.reply("Bu funksiýa diňe adminler üçin. 🚫");
      return { success: false, message: "Ygtyýarsyz funksiýa." };
    }
    const username = sanitizeInput(ctx.message.text);
    if (!username.startsWith("@")) {
      await ctx.reply("Nädogry format. Mysal: @username. Täzeden synan. 🚫");
      return { success: false, message: "Nädogry username formaty." };
    }
    try {
      const chat = await bot.telegram.getChat(username);
      if (chat.type !== "private") {
        await ctx.reply("Bu ulanyjy däl, kanal ýa-da toparyň ady. 🚫");
        return { success: false, message: "Nädogry chat tipleri." };
      }
      const targetUserId = chat.id;
      const targetUserResult = await getUser(targetUserId);
      if (!targetUserResult.success) {
        await ctx.reply(`Ýalňyşlyk: ${targetUserResult.message} 😔`);
        ctx.session = { started: ctx.session.started };
        await showMainKeyboard(ctx);
        return targetUserResult;
      }
      const targetUser = targetUserResult.data;
      targetUser.banned = true;
      const updateResult = await updateUser(targetUser);
      if (!updateResult.success) {
        await ctx.reply(`Ýalňyşlyk: ${updateResult.message} 😔`);
        ctx.session = { started: ctx.session.started };
        await showMainKeyboard(ctx);
        return updateResult;
      }
      await ctx.reply(`Ulanyjy ${username} ban edildi. 🚫`);
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return { success: true, message: "Ulanyjy üstünlikli ban edildi." };
    } catch (err) {
      await ctx.reply(
        `Ulanyjy tapylmady ýa-da ýalňyşlyk: ${
          err.description || err.message
        } 🚫`
      );
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return { success: false, message: `Ulanyjy tapylmady: ${err.message}` };
    }
  } else if (state === "admin_unban_username") {
    if (ctx.from.id !== ADMIN_ID) {
      ctx.session = { started: ctx.session.started };
      await ctx.reply("Bu funksiýa diňe adminler üçin. 🚫");
      return { success: false, message: "Ygtyýarsyz funksiýa." };
    }
    const username = sanitizeInput(ctx.message.text);
    if (!username.startsWith("@")) {
      await ctx.reply("Nädogry format. Mysal: @username. Täzeden synan. 🚫");
      return { success: false, message: "Nädogry username formaty." };
    }
    try {
      const chat = await bot.telegram.getChat(username);
      if (chat.type !== "private") {
        await ctx.reply("Bu ulanyjy däl, kanal ýa-da toparyň ady. 🚫");
        return { success: false, message: "Nädogry chat tipleri." };
      }
      const targetUserId = chat.id;
      const targetUserResult = await getUser(targetUserId);
      if (!targetUserResult.success) {
        await ctx.reply(`Ýalňyşlyk: ${targetUserResult.message} 😔`);
        ctx.session = { started: ctx.session.started };
        await showMainKeyboard(ctx);
        return targetUserResult;
      }
      const targetUser = targetUserResult.data;
      targetUser.banned = false;
      const updateResult = await updateUser(targetUser);
      if (!updateResult.success) {
        await ctx.reply(`Ýalňyşlyk: ${updateResult.message} 😔`);
        ctx.session = { started: ctx.session.started };
        await showMainKeyboard(ctx);
        return updateResult;
      }
      await ctx.reply(`Ulanyjy ${username} bany açyldy. 🚪`);
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return { success: true, message: "Ulanyjy üstünlikli unban edildi." };
    } catch (err) {
      await ctx.reply(
        `Ulanyjy tapylmady ýa-da ýalňyşlyk: ${
          err.description || err.message
        } 🚫`
      );
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return { success: false, message: `Ulanyjy tapylmady: ${err.message}` };
    }
  } else if (state === "admin_set_ban_message_username") {
    if (ctx.from.id !== ADMIN_ID) {
      ctx.session = { started: ctx.session.started };
      await ctx.reply("Bu funksiýa diňe adminler üçin. 🚫");
      return { success: false, message: "Ygtyýarsyz funksiýa." };
    }
    const username = sanitizeInput(ctx.message.text);
    if (!username.startsWith("@")) {
      await ctx.reply("Nädogry format. Mysal: @username. Täzeden synan. 🚫");
      return { success: false, message: "Nädogry username formaty." };
    }
    try {
      const chat = await bot.telegram.getChat(username);
      if (chat.type !== "private") {
        await ctx.reply("Bu ulanyjy däl, kanal ýa-da toparyň ady. 🚫");
        return { success: false, message: "Nädogry chat tipleri." };
      }
      const targetUserId = chat.id;
      const targetUserResult = await getUser(targetUserId);
      if (!targetUserResult.success) {
        await ctx.reply(`Ýalňyşlyk: ${targetUserResult.message} 😔`);
        ctx.session = { started: ctx.session.started };
        await showMainKeyboard(ctx);
        return targetUserResult;
      }
      ctx.session.target_user_id_for_message = targetUserId;
      ctx.session.state = "admin_set_ban_message_text";
      await ctx.reply("Ulanyjy üçin ban habaryny ýazyň: 📝");
      return { success: true, message: "Ban habary tekst soragy işledildi." };
    } catch (err) {
      await ctx.reply(
        `Ulanyjy tapylmady ýa-da ýalňyşlyk: ${
          err.description || err.message
        } 🚫`
      );
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return { success: false, message: `Ulanyjy tapylmady: ${err.message}` };
    }
  } else if (state === "admin_set_ban_message_text") {
    if (ctx.from.id !== ADMIN_ID) {
      ctx.session = { started: ctx.session.started };
      await ctx.reply("Bu funksiýa diňe adminler üçin. 🚫");
      return { success: false, message: "Ygtyýarsyz funksiýa." };
    }
    const message = sanitizeInput(ctx.message.text);
    if (!message) {
      await ctx.reply("Habar boş bolmaly däl. 🚫");
      return { success: false, message: "Habar boş bolmaly däl." };
    }
    const targetUserId = ctx.session.target_user_id_for_message;
    if (!targetUserId) {
      await ctx.reply("Ýalňyşlyk: Ulanyjy tapylmady. 😔");
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return { success: false, message: "Ulanyjy tapylmady." };
    }
    const targetUserResult = await getUser(targetUserId);
    if (!targetUserResult.success) {
      await ctx.reply(`Ýalňyşlyk: ${targetUserResult.message} 😔`);
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return targetUserResult;
    }
    const targetUser = targetUserResult.data;
    targetUser.ban_message = message;
    const updateResult = await updateUser(targetUser);
    if (!updateResult.success) {
      await ctx.reply(`Ýalňyşlyk: ${updateResult.message} 😔`);
      ctx.session = { started: ctx.session.started };
      await showMainKeyboard(ctx);
      return updateResult;
    }
    await ctx.reply(`Ulanyjy üçin ban habary bellenildi. 📝`);
    ctx.session = { started: ctx.session.started };
    await showMainKeyboard(ctx);
    return { success: true, message: "Ban habary üstünlikli bellenildi." };
  } else if (state === "broadcast_message") {
    if (ctx.from.id !== ADMIN_ID) {
      ctx.session = { started: ctx.session.started };
      await ctx.reply("Bu funksiýa diňe adminler üçin. 🚫");
      return { success: false, message: "Ygtyýarsyz funksiýa." };
    }
    const broadcastText = ctx.message.text;
    const users = await usersCollection.find({}).toArray();
    for (const user of users) {
      try {
        await bot.telegram.sendMessage(user._id, broadcastText);
      } catch (err) {}
    }
    await ctx.reply("Habar ähli ulanyjylara ugradyldy! 📢");
    ctx.session = { started: ctx.session.started };
    await showMainKeyboard(ctx);
    return { success: true, message: "Broadcast üstünlikli ugradyldy." };
  }
  return { success: false, message: "Bilinmedik ýagdaý." };
});

bot.hears(/^maslahaty täzele\s+(\S+)\s+([^\s]+)\s+"([^"]+)"$/i, async (ctx) => {
  const effectiveSub = await getEffectiveSub(ctx.from.id);
  if (effectiveSub === "trial_expired") {
    await ctx.reply(
      "Synag möhletiňiz gutardy! 😔 Boty ulanmak üçin abuna boluň."
    );
    return { success: false, message: "Synag möhleti gutardy." };
  }
  const [, id, field, value] = ctx.match;
  const sch = schedules.find((s) => s.id === id);
  if (!sch || (sch.user_id !== ctx.from.id && ctx.from.id !== ADMIN_ID)) {
    await ctx.reply("Bu maslahat size degişli däl. 🚫");
    return { success: false, message: "Bu maslahat size degişli däl." };
  }
  const index = schedules.findIndex((s) => s.id === id);
  if (
    index === -1 ||
    !["chat_id", "text", "interval", "media_url"].includes(field)
  ) {
    await ctx.reply(
      "Nädogry ID ýa-da meýdan. Meýdanlar: chat_id, text, interval, media_url 🚫"
    );
    return { success: false, message: "Nädogry ID ýa-da meýdan." };
  }
  const effectiveSubConfig = SUBSCRIPTIONS[effectiveSub];
  if (field === "chat_id") {
    const sanitizedValue = sanitizeInput(value);
    if (!sanitizedValue.match(/^(@[a-zA-Z0-9_]+|-100\d+)$/)) {
      await ctx.reply(
        "Nädogry kanal ID formaty (mysal: @kanal ýa-da -1001234567890). 🚫"
      );
      return { success: false, message: "Nädogry kanal ID formaty." };
    }
    if (
      schedules.some((sch) => sch.chat_id === sanitizedValue && sch.id !== id)
    ) {
      await ctx.reply(
        `Bu kanal (@${sanitizedValue} ýa-da ${sanitizedValue}) üçin eýýäm maslahat bar. Bir kanalda diňe bir maslahat bolup biler. 😔`
      );
      return { success: false, message: "Kanalda eýýäm maslahat bar." };
    }
    try {
      await bot.telegram.getChat(sanitizedValue);
      schedules[index][field] = sanitizedValue;
    } catch (err) {
      await ctx.reply(`Nädogry kanal ID: ${err.description || err.message} 🚫`);
      return { success: false, message: `Nädogry kanal ID: ${err.message}` };
    }
  } else if (field === "interval") {
    const intValue = parseInt(value, 10);
    if (isNaN(intValue) || intValue < effectiveSubConfig.minInterval) {
      await ctx.reply(
        `Wagt aralygy ${effectiveSubConfig.minInterval} sekuntdan az bolmaly däl. 😔`
      );
      return { success: false, message: "Nädogry wagt aralygy." };
    }
    schedules[index][field] = intValue;
  } else if (field === "text") {
    const sanitizedValue = sanitizeInput(value);
    if (!sanitizedValue) {
      await ctx.reply("Tekst boş bolmaly däl. 🚫");
      return { success: false, message: "Tekst boş bolmaly däl." };
    }
    schedules[index][field] = sanitizedValue;
  } else {
    schedules[index][field] =
      field === "media_url" && value === "null" ? null : sanitizeInput(value);
  }
  const saveResult = await saveSchedules();
  if (!saveResult.success) {
    await ctx.reply(`Ýalňyşlyk: ${saveResult.message} 😔`);
    return saveResult;
  }
  const initResult = await initSchedules();
  if (!initResult.success) {
    await ctx.reply(`Ýalňyşlyk: ${initResult.message} 😔`);
    return initResult;
  }
  await ctx.reply(`Maslahat ${id} täzelendi. 🎉`);
  await showMainKeyboard(ctx);
  return { success: true, message: "Maslahat üstünlikli täzelendi." };
});

bot.catch(async (err, ctx) => {
  try {
    if (ctx && ctx.reply) {
      await ctx.reply("Ýalňyşlyk ýüze çykdy. Täzeden synan. 😔");
    }
  } catch (replyErr) {
    console.error("Failed to send error message:", replyErr.message);
  }
  console.error("Global error:", err.message);
  return { success: false, message: `Global ýalňyşlyk: ${err.message}` };
});

(async () => {
  try {
    const connectResult = await connectMongo();
    if (!connectResult.success) {
      process.exit(1);
    }
    const initResult = await initSchedules();
    if (!initResult.success) {
      process.exit(1);
    }
    vpnInterval = setInterval(async () => {
      const ultraUsers = await usersCollection
        .find({ subscription: "ultra" })
        .toArray();
      for (const user of ultraUsers) {
        const effectiveSub = await getEffectiveSub(user._id);
        if (effectiveSub !== "ultra") continue;
        if (
          user.vpn_channel &&
          currentVpn &&
          (!user.last_vpn_sent || Date.now() - user.last_vpn_sent > 604800000)
        ) {
          try {
            await bot.telegram.sendMessage(user.vpn_channel, currentVpn);
            user.last_vpn_sent = Date.now();
            const updateResult = await updateUser(user);
          } catch (err) {}
        }
      }
    }, 3600000);
    reminderInterval = setInterval(async () => {
      const now = new Date();
      if (now.getDay() === 0) {
        try {
          await bot.telegram.sendMessage(
            ADMIN_ID,
            "Hepde gutarýar, VPN kody üýtgetmegi ýatdan çykarmaň! 🔄"
          );
        } catch (err) {}
      }
    }, 86400000);
    weeklyGiftInterval = setInterval(async () => {
      const candidates = await usersCollection
        .find({ subscription: { $ne: "ultra" } })
        .toArray();
      if (candidates.length === 0) return;
      const winner = candidates[Math.floor(Math.random() * candidates.length)];
      winner.subscription = "ultra";
      winner.expiration = Date.now() + 3 * 86400000;
      await updateUser(winner);
      try {
        await bot.telegram.sendMessage(
          winner._id,
          "Gutlaýarys! Siz hepdelik utuşda Ultra VIP 3 gün aldňyz! 🎁"
        );
      } catch (err) {}
      await weeklyWinnersCollection.insertOne({
        user_id: winner._id,
        username: winner.username,
        date: Date.now(),
      });
    }, 604800000);
    bot.launch();
  } catch (err) {
    process.exit(1);
  }
})();

process.once("SIGINT", async () => {
  Object.values(intervals).forEach((interval) => clearInterval(interval));
  clearInterval(vpnInterval);
  clearInterval(weeklyGiftInterval);
  clearInterval(reminderInterval);
  bot.stop("SIGINT");
});

process.once("SIGTERM", async () => {
  Object.values(intervals).forEach((interval) => clearInterval(interval));
  clearInterval(vpnInterval);
  clearInterval(weeklyGiftInterval);
  clearInterval(reminderInterval);
  bot.stop("SIGTERM");
});
