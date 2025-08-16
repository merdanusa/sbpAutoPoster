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
const ANTISPAM_COOLDOWN = 2000;

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
let intervals = {};
let vpnInterval;
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
    await ctx.reply("Gaty köp hereket, garaşyň! ⏳");
    return;
  }
  lastActionTimestamps.set(userId, now);
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
    const loadedSchedules = await schedulesCollection.find({}).toArray();
    schedules = loadedSchedules.map((sch) => {
      const newSch = { ...sch, id: sch._id };
      delete newSch._id;
      if (typeof newSch.active === "undefined") newSch.active = true;
      return newSch;
    });
    const vpnSetting = await settingsCollection.findOne({ _id: "current_vpn" });
    currentVpn = vpnSetting ? vpnSetting.value : "";
    console.log(
      "MongoDB baglantysy üstünlikli ýerine ýetirildi, ýüklenen maslahatlar:",
      schedules.length
    );
    return {
      success: true,
      message: "MongoDB baglantysy üstünlikli ýerine ýetirildi.",
    };
  } catch (err) {
    console.error("MongoDB baglantysy başarmady:", err.message);
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
    console.log("Maslahatlar üstünlikli ýazyldy! 📋");
    return { success: true, message: "Maslahatlar üstünlikli ýazyldy." };
  } catch (err) {
    console.error("Maslahatlary ýazmakda ýalňyşlyk:", err.message);
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
                .catch((err) => {
                  console.error(
                    `${sch.chat_id} kanalynyň ${sch.last_message_id} ID-li habaryny pozmak başarmady:`,
                    err.description || err.message
                  );
                });
            }
            let message;
            if (sch.media_url) {
              console.log(
                `${sch.chat_id} kanalyna ýazýar: ${sch.text}, media: ${sch.media_url} 🖼️`
              );
              message = await bot.telegram.sendPhoto(
                sch.chat_id,
                sch.media_url,
                {
                  caption: sch.text,
                }
              );
            } else {
              console.log(`${sch.chat_id} kanalyna ýazýar: ${sch.text} ✍️`);
              message = await bot.telegram.sendMessage(sch.chat_id, sch.text);
            }
            sch.last_message_id = message.message_id;
            await saveSchedules();
          } catch (err) {
            console.error(
              `${sch.chat_id} kanalyna ýazmakda ýalňyşlyk:`,
              err.description || err.message
            );
            if (err.code === 429) {
              console.log(
                "Çäk ýetdi, 5 sekuntdan soň gaýtadan synanyşýar... ⏳"
              );
              setTimeout(() => {
                if (intervals[sch.id]) intervals[sch.id]();
              }, 5000);
            }
          }
        }, Math.max(sch.interval * 1000, 30000));
      } catch (err) {
        console.error(
          `${index} ID-li maslahaty ${sch.chat_id} kanaly üçin başlatmak başarmady:`,
          err.description || err.message
        );
      }
    }
    console.log(
      "Maslahatlar başlatyldy, işjeň aralyklar:",
      Object.keys(intervals).length
    );
    return { success: true, message: "Maslahatlar üstünlikli başlatyldy." };
  } catch (err) {
    console.error("Maslahatlary başlatmak başarmady:", err.message);
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
    const result = await settingsCollection.updateOne(
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
  let buttons = [["Profil 👤"]];
  if (effectiveSub !== "trial_expired") {
    buttons.push(["Maslahat goş 💫", "Maslahatlary gör 📋"]);
    buttons.push(["VPNlary gör 📋"]);
    if (effectiveSub === "ultra" || isAdmin) {
      buttons.push(["VPN goş 🌐"]);
    }
    if (isAdmin) {
      buttons.push(["Panel 🎛️"]);
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
    console.error("Surat ugratmak başarmady:", err.message);
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
  console.log("Bot ulanyjy üçin başlady:", ctx.from?.id);
  await getUser(ctx.from.id);
  await showMainKeyboard(ctx);
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
  await ctx.reply(subInfo);
  return {
    success: true,
    message: "Profil maglumatlary üstünlikli görkezildi.",
  };
});

bot.hears("Maslahat goş 💫", async (ctx) => {
  const effectiveSub = await getEffectiveSub(ctx.from.id);
  if (effectiveSub === "trial_expired") {
    await ctx.reply(
      "Synag möhletiňiz gutardy! 😔 Boty ulanmak üçin abuna boluň."
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

bot.hears("Panel 🎛️", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.reply("Bu funksiýa diňe adminler üçin. 🚫");
    return { success: false, message: "Ygtyýarsyz funksiýa." };
  }
  await ctx.reply(
    "Admin paneline hoş geldiňiz! 🎛️\nAşakdaky amallary ýerine ýetiriň:",
    Markup.inlineKeyboard([
      [Markup.button.callback("VPN goş 🌐", "admin_add_vpn")],
      [Markup.button.callback("VPN poz 🗑️", "admin_delete_vpn")],
      [Markup.button.callback("Promo goş 🎟️", "admin_add_promo")],
    ])
  );
  return { success: true, message: "Admin paneli üstünlikli görkezildi." };
});

bot.action("admin_add_vpn", async (ctx) => {
  if (ctx.from.id !== ADMIN_ID) {
    await ctx.answerCbQuery("Bu funksiýa diňe adminler üçin. 🚫");
    return { success: false, message: "Ygtyýarsyz funksiýa." };
  }
  await ctx.answerCbQuery();
  ctx.session = {
    ...ctx.session,
    state: "admin_vpn_config",
    started: ctx.session?.started || true,
  };
  await ctx.reply("VPN konfigurasiýasyny ýazyň (mysal: vpnblahblah): 🌐");
  return {
    success: true,
    message: "VPN konfigurasiýa soragy üstünlikli işledildi.",
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
    console.log("Sessiya ýagdaýy tapylmady, ulanyjy:", ctx.from?.id);
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
      console.error(
        `${addData.chat_id} kanaly üçin maslahat goşmak başarmady:`,
        err.description || err.message
      );
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
          console.log(`VPN ${channel} kanalyna ugradyldy, ulanyjy: ${userId}`);
        } catch (err) {
          await ctx.reply(
            `VPN ugratmak başarmady: ${err.description || err.message} 😔`
          );
          console.error(
            `VPN ${channel} kanalyna ugratmak başarmady:`,
            err.message
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
  } else if (state === "admin_vpn_config") {
    if (ctx.from.id !== ADMIN_ID) {
      ctx.session = { started: ctx.session.started };
      await ctx.reply("Bu funksiýa diňe adminler üçin. 🚫");
      return { success: false, message: "Ygtyýarsyz funksiýa." };
    }
    const vpnConfig = sanitizeInput(ctx.message.text);
    if (!vpnConfig) {
      await ctx.reply("VPN konfigurasiýasyny ýazyň (mysal: vpnblahblah). 🚫");
      return { success: false, message: "VPN konfigurasiýasy berilmedi." };
    }
    currentVpn = vpnConfig;
    const setResult = await setSetting("current_vpn", vpnConfig);
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
    ctx.session = { started: ctx.session.started };
    await showMainKeyboard(ctx);
    return { success: true, message: "Abunalyk üstünlikli täzelendi." };
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

bot.catch((err, ctx) => {
  console.error(`Global ýalňyşlyk ${ctx.updateType}:`, err.message, err.stack);
  ctx.reply("Ýalňyşlyk ýüze çykdy. Täzeden synan. 😔");
  return { success: false, message: `Global ýalňyşlyk: ${err.message}` };
});

(async () => {
  try {
    const connectResult = await connectMongo();
    if (!connectResult.success) {
      console.error(connectResult.message);
      process.exit(1);
    }
    const initResult = await initSchedules();
    if (!initResult.success) {
      console.error(initResult.message);
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
            if (!updateResult.success) {
              console.error(
                `Ulanyjy ${user._id} täzelemek başarmady:`,
                updateResult.message
              );
            } else {
              console.log(
                `VPN ${user.vpn_channel} kanalyna ugradyldy, ulanyjy: ${user._id}`
              );
            }
          } catch (err) {
            console.error(
              `VPN ${user.vpn_channel} kanalyna ugratmak başarmady:`,
              err.message
            );
          }
        }
      }
    }, 3600000);
    bot.launch();
    console.log("Bot işläp başlady... 🚀");
  } catch (err) {
    console.error("Boty başlatmak başarmady:", err.message);
    process.exit(1);
  }
})();

process.once("SIGINT", async () => {
  console.log("SIGINT aldy, bot duruzylýar...");
  Object.values(intervals).forEach((interval) => clearInterval(interval));
  clearInterval(vpnInterval);
  bot.stop("SIGINT");
});

process.once("SIGTERM", async () => {
  console.log("SIGTERM aldy, bot duruzylýar...");
  Object.values(intervals).forEach((interval) => clearInterval(interval));
  clearInterval(vpnInterval);
  bot.stop("SIGTERM");
});
