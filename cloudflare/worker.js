/**
 * Shafaq News Telegram bot, Cloudflare Workers version
 *
 * - Anyone can press Start and get new Shafaq News articles in their chat
 * - Each user has their own language, sections and keyword alerts
 * - Commands reply instantly (Telegram webhook)
 * - Checks the feeds every minute (Cron Trigger)
 *
 * Needs:
 *   D1 database bound as  DB
 *   Secret  BOT_TOKEN       (from BotFather)
 *   Secret  WEBHOOK_SECRET  (any long random text you choose)
 *   Variable ADMIN_ID       (optional, your chat id, enables /stats)
 */

const FEEDS = {
  ar: "https://shafaq.com/rss/ar",
  en: "https://shafaq.com/rss/en",
};
const BREAKING_WORDS = ["عاجل", "breaking", "urgent"];
const SEND_PER_RUN = 40; // Cloudflare free plan allows 50 outgoing requests per run
const LANG_NAMES = { ar: "العربية", en: "English", both: "العربية + English" };

// ---------------- helpers ----------------

const esc = (s) =>
  String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&");
}

function cleanText(raw) {
  let t = decodeEntities(raw);
  t = t.replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, "");
  t = decodeEntities(t);
  return t
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !/^(read more|اقرأ أيضا|اقرأ ايضا)/i.test(l))
    .join("\n\n");
}

function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"));
  if (!m) return "";
  return m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim();
}

function splitList(arg) {
  return arg.split(/[,،\n]/).map((x) => x.trim()).filter(Boolean);
}

// ---------------- Telegram ----------------

async function tg(env, method, data) {
  const r = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  });
  let res = {};
  try { res = await r.json(); } catch { /* ignore */ }
  if (!r.ok) console.log(`Telegram ${method} error ${r.status}: ${JSON.stringify(res).slice(0, 200)}`);
  res.status = r.status;
  return res;
}

const say = (env, chatId, text, extra = {}) =>
  tg(env, "sendMessage", {
    chat_id: chatId, text, parse_mode: "HTML",
    link_preview_options: { is_disabled: true }, ...extra,
  });

const COMMANDS = [
  ["latest", "آخر الأخبار / Latest news"],
  ["lang", "اللغة / Language"],
  ["sections", "الأقسام / Sections"],
  ["all", "كل الأقسام / All sections"],
  ["watch", "تنبيه لكلمة / Keyword alert, e.g. /watch السليمانية"],
  ["unwatch", "حذف كلمة / Remove keyword"],
  ["keywords", "كلماتك / Your keywords"],
  ["status", "إعداداتك / Your settings"],
  ["help", "المساعدة / Help"],
];

// ---------------- database ----------------

async function setupDb(env) {
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS seen (id TEXT PRIMARY KEY, ts INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS recent (id TEXT PRIMARY KEY, title TEXT, link TEXT, category TEXT, lang TEXT, ts INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS users (chat_id TEXT PRIMARY KEY, lang TEXT DEFAULT 'both', only TEXT DEFAULT '[]', keywords TEXT DEFAULT '[]', joined INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS outbox (n INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT, item TEXT, created INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)"),
  ]);
}

async function getUser(env, chatId) {
  const u = await env.DB.prepare("SELECT * FROM users WHERE chat_id = ?").bind(String(chatId)).first();
  if (!u) return null;
  return { ...u, only: JSON.parse(u.only || "[]"), keywords: JSON.parse(u.keywords || "[]") };
}

async function saveUser(env, u) {
  await env.DB.prepare(
    "INSERT INTO users (chat_id, lang, only, keywords, joined) VALUES (?, ?, ?, ?, ?) " +
    "ON CONFLICT(chat_id) DO UPDATE SET lang = excluded.lang, only = excluded.only, keywords = excluded.keywords"
  ).bind(String(u.chat_id), u.lang, JSON.stringify(u.only), JSON.stringify(u.keywords), u.joined || Date.now()).run();
}

const newUser = (chatId) => ({ chat_id: String(chatId), lang: "both", only: [], keywords: [], joined: Date.now() });

// ---------------- feeds ----------------

// Step 1: split the feed into items and read only their ids (cheap)
async function fetchFeed(lang, url) {
  const r = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (ShafaqTelegramBot)" } });
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
  const xml = await r.text();
  const items = [];
  let pos = 0;
  while ((pos = xml.indexOf("<item", pos)) !== -1) {
    const end = xml.indexOf("</item>", pos);
    if (end === -1) break;
    const head = xml.slice(pos, Math.min(end, pos + 1500)); // guid and link come first
    const id = decodeEntities(tag(head, "guid") || tag(head, "link"));
    if (id) items.push({ id, lang, xml, start: pos, end });
    pos = end + 7;
  }
  return items.reverse(); // oldest first
}

// Step 2: fully read only the new items
function parseItem(raw) {
  const body = raw.xml.slice(raw.start, raw.end);
  const enc = body.match(/<enclosure[^>]*url="([^"]+)"/i);
  return {
    id: raw.id, lang: raw.lang,
    link: decodeEntities(tag(body, "link")) || raw.id,
    title: decodeEntities(tag(body, "title")),
    category: decodeEntities(tag(body, "category")),
    image: enc ? decodeEntities(enc[1]) : null,
    summary: cleanText(tag(body, "description") || tag(body, "content:encoded")),
  };
}

function wanted(item, user) {
  if (user.lang !== "both" && item.lang !== user.lang) return false;
  if (user.only.length) {
    const cat = item.category.toLowerCase();
    if (!user.only.some((o) => cat.includes(o.toLowerCase()))) return false;
  }
  return true;
}

// ---------------- building messages ----------------

function buildText(item, limit) {
  let head = `<b>${esc(item.title)}</b>`;
  if (item.breaking) head = "🔴 " + head;
  if (item.hits?.length) head = "⭐ " + head;
  let tail = "";
  if (item.hits?.length) tail += "\n\n⭐ " + esc(item.hits.join(", "));
  if (item.category) tail += `\n\n#${esc(item.category.replace(/ /g, "_").replace(/&/g, "and"))}`;
  let summary = item.summary || "";
  const room = limit - head.length - tail.length - 10;
  if (summary && room > 50) {
    if (esc(summary).length > room) {
      summary = summary.slice(0, room - 20);
      summary = summary.slice(0, summary.lastIndexOf(" ") > 0 ? summary.lastIndexOf(" ") : summary.length) + "...";
    }
    return `${head}\n\n${esc(summary)}${tail}`;
  }
  return head + tail;
}

async function sendArticle(env, chatId, item) {
  const silent = !(item.breaking || item.hits?.length);
  const reply_markup = {
    inline_keyboard: [[
      { text: "📋 نسخ / Copy", copy_text: { text: `${item.title}\n${item.link}`.slice(0, 256) } },
      { text: "🔗 فتح / Open", url: item.link },
    ]],
  };
  let res = {};
  if (item.image) {
    res = await tg(env, "sendPhoto", {
      chat_id: chatId, photo: item.image, caption: buildText(item, 1024),
      parse_mode: "HTML", disable_notification: silent, reply_markup,
    });
  }
  if (!res.ok && res.status !== 403 && res.status !== 429) {
    res = await say(env, chatId, buildText(item, 4096), { disable_notification: silent, reply_markup });
  }
  if (res.ok && item.hits?.length) {
    await tg(env, "pinChatMessage", { chat_id: chatId, message_id: res.result.message_id, disable_notification: true });
  }
  return res;
}

// ---------------- cron: check feeds + send ----------------

async function checkFeeds(env, report = {}) {
  await setupDb(env);
  const firstRun = !(await env.DB.prepare("SELECT 1 FROM seen LIMIT 1").first());

  const results = await Promise.allSettled(
    Object.entries(FEEDS).map(([lang, url]) => fetchFeed(lang, url))
  );
  const fresh = [];
  for (const r of results) {
    if (r.status !== "fulfilled") {
      console.log("Feed error:", r.reason?.message);
      (report.feedErrors ||= []).push(String(r.reason?.message || r.reason));
      continue;
    }
    const items = r.value;
    (report.feedItems ||= []).push(items.length);
    if (!items.length) continue;
    const ids = items.map((i) => i.id);
    const known = new Set();
    for (let k = 0; k < ids.length; k += 90) {
      const part = ids.slice(k, k + 90);
      const rows = await env.DB.prepare(
        `SELECT id FROM seen WHERE id IN (${part.map(() => "?").join(",")})`
      ).bind(...part).all();
      rows.results.forEach((x) => known.add(x.id));
    }
    let newOnes = items.filter((i) => !known.has(i.id));
    if (firstRun) {
      // first run: remember everything, but only read the latest 15 for /latest
      fresh.push(...newOnes.slice(0, -15).map((i) => ({ id: i.id, lang: i.lang, skipRecent: true })));
      newOnes = newOnes.slice(-15);
    }
    fresh.push(...newOnes.map(parseItem));
  }

  if (fresh.length) {
    const now = Date.now();
    const stmts = [];
    for (const i of fresh) {
      stmts.push(env.DB.prepare("INSERT OR IGNORE INTO seen (id, ts) VALUES (?, ?)").bind(i.id, now));
      if (i.skipRecent) continue;
      stmts.push(env.DB.prepare(
        "INSERT OR IGNORE INTO recent (id, title, link, category, lang, ts) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(i.id, i.title, i.link, i.category, i.lang, now));
    }
    if (!firstRun) {
      const users = (await env.DB.prepare("SELECT * FROM users").all()).results.map((u) => ({
        ...u, only: JSON.parse(u.only || "[]"), keywords: JSON.parse(u.keywords || "[]"),
      }));
      for (const i of fresh) {
        const breaking = BREAKING_WORDS.some((w) => i.title.toLowerCase().includes(w));
        const text = (i.title + " " + i.summary).toLowerCase();
        for (const u of users) {
          if (!wanted(i, u)) continue;
          const hits = u.keywords.filter((k) => text.includes(k.toLowerCase()));
          stmts.push(env.DB.prepare("INSERT INTO outbox (chat_id, item, created) VALUES (?, ?, ?)")
            .bind(u.chat_id, JSON.stringify({ ...i, breaking, hits }), now));
        }
      }
    }
    for (let k = 0; k < stmts.length; k += 50) await env.DB.batch(stmts.slice(k, k + 50));
    console.log(`New articles: ${fresh.length}${firstRun ? " (first run, saved only)" : ""}`);
  }
  report.firstRun = firstRun;
  report.newArticles = fresh.length;

  await sendOutbox(env);

  // housekeeping
  const day = 24 * 3600 * 1000;
  await env.DB.batch([
    env.DB.prepare("DELETE FROM seen WHERE ts < ?").bind(Date.now() - 4 * day),
    env.DB.prepare("DELETE FROM outbox WHERE created < ?").bind(Date.now() - day),
    env.DB.prepare("DELETE FROM recent WHERE id NOT IN (SELECT id FROM recent ORDER BY ts DESC, rowid DESC LIMIT 60)"),
  ]);
}

async function sendOutbox(env) {
  const rows = (await env.DB.prepare("SELECT * FROM outbox ORDER BY n LIMIT ?").bind(SEND_PER_RUN).all()).results;
  const done = [];
  for (const row of rows) {
    const res = await sendArticle(env, row.chat_id, JSON.parse(row.item));
    if (res.status === 429) break; // Telegram says slow down, try the rest next minute
    done.push(row.n);
    if (res.status === 403) {
      // user blocked the bot, remove them
      await env.DB.batch([
        env.DB.prepare("DELETE FROM users WHERE chat_id = ?").bind(row.chat_id),
        env.DB.prepare("DELETE FROM outbox WHERE chat_id = ?").bind(row.chat_id),
      ]);
    }
  }
  if (done.length) {
    await env.DB.prepare(`DELETE FROM outbox WHERE n IN (${done.map(() => "?").join(",")})`).bind(...done).run();
  }
}

// ---------------- commands ----------------

const HELP = `<b>بوت أخبار شفق نيوز</b>
يرسل لك آخر الأخبار فور نشرها.

/latest  آخر الأخبار
/lang  اختيار اللغة
/sections  اختيار الأقسام
/all  كل الأقسام
/watch كلمة  تنبيه عند ذكر كلمة (مثال: /watch السليمانية)
/unwatch كلمة  حذف كلمة
/keywords  كلماتك
/status  إعداداتك

<b>Shafaq News bot</b>: latest news the moment it's published. Same commands in English.`;

function langButtons(user) {
  const b = (code) => ({ text: (user.lang === code ? "✅ " : "") + LANG_NAMES[code], callback_data: `lang:${code}` });
  return { inline_keyboard: [[b("ar"), b("en")], [b("both")]] };
}

async function sectionsView(env, user) {
  const where = user.lang === "both" ? "" : "WHERE lang = ?";
  const stmt = env.DB.prepare(`SELECT DISTINCT category FROM recent ${where} ORDER BY category`);
  const rows = (await (user.lang === "both" ? stmt : stmt.bind(user.lang)).all()).results;
  const cats = rows.map((r) => r.category).filter(Boolean);
  if (!cats.length) return { text: "لا توجد أقسام بعد، جرّب لاحقاً / No sections yet, try later." };
  const isOn = (c) => user.only.some((o) => c.toLowerCase().includes(o.toLowerCase()));
  const keyboard = cats.map((c) => [{
    text: (isOn(c) ? "✅ " : "") + c,
    callback_data: "sec:" + c.slice(0, 25),
  }]);
  keyboard.push([{ text: (user.only.length ? "" : "✅ ") + "كل الأقسام / All", callback_data: "sec:*" }]);
  const chosen = user.only.length ? esc(user.only.join(", ")) : "كل الأقسام / All";
  return {
    text: `<b>الأقسام / Sections</b>\nاضغط لاختيار أو إلغاء قسم.\nTap to turn a section on or off.\n\nالحالي / Now: ${chosen}`,
    reply_markup: { inline_keyboard: keyboard },
  };
}

function statusText(user) {
  return `<b>إعداداتك / Your settings</b>

اللغة / Language: ${LANG_NAMES[user.lang]}
الأقسام / Sections: ${user.only.length ? esc(user.only.join(", ")) : "كل الأقسام / All"}
الكلمات / Keywords: ${user.keywords.length ? esc(user.keywords.join(", ")) : "لا شيء / none"}`;
}

async function handleMessage(env, msg) {
  if (msg.chat?.type !== "private") return; // only private chats
  const chatId = String(msg.chat.id);
  const text = (msg.text || "").trim();
  let user = await getUser(env, chatId);

  if (!user || text.startsWith("/start")) {
    const isNew = !user;
    user = user || newUser(chatId);
    await saveUser(env, user);
    await say(env, chatId,
      (isNew ? "👋 أهلاً! ستصلك أخبار شفق نيوز هنا فور نشرها.\nWelcome! Shafaq News will arrive here as soon as it's published.\n\n" : "") +
      "اختر اللغة / Choose a language:",
      { reply_markup: langButtons(user) });
    if (!text.startsWith("/") || text.startsWith("/start")) return;
  }

  if (!text.startsWith("/")) {
    return say(env, chatId, "اكتب /help لرؤية الأوامر / Type /help to see the commands.");
  }

  const [rawCmd, ...rest] = text.split(/\s+/);
  const cmd = rawCmd.split("@")[0].toLowerCase();
  const arg = rest.join(" ").trim();

  switch (cmd) {
    case "/help":
      return say(env, chatId, HELP);

    case "/latest": {
      const n = Math.min(parseInt(arg, 10) || 5, 20);
      const where = user.lang === "both" ? "" : "WHERE lang = ?";
      const stmt = env.DB.prepare(`SELECT * FROM recent ${where} ORDER BY ts DESC, rowid DESC LIMIT ?`);
      const rows = (await (user.lang === "both" ? stmt.bind(n) : stmt.bind(user.lang, n)).all()).results;
      if (!rows.length) return say(env, chatId, "لا توجد أخبار بعد / No news yet.");
      const lines = rows.map((i) => `• <a href="${esc(i.link)}">${esc(i.title)}</a>`);
      return say(env, chatId, "<b>آخر الأخبار / Latest</b>\n\n" + lines.join("\n\n"));
    }

    case "/lang":
      if (["ar", "en", "both"].includes(arg.toLowerCase())) {
        user.lang = arg.toLowerCase();
        await saveUser(env, user);
        return say(env, chatId, `✅ ${LANG_NAMES[user.lang]}`);
      }
      return say(env, chatId, "اختر اللغة / Choose a language:", { reply_markup: langButtons(user) });

    case "/sections":
    case "/only": {
      if (cmd === "/only" && arg) {
        user.only = splitList(arg);
        await saveUser(env, user);
      }
      const v = await sectionsView(env, user);
      return say(env, chatId, v.text, v.reply_markup ? { reply_markup: v.reply_markup } : {});
    }

    case "/all":
      user.only = [];
      await saveUser(env, user);
      return say(env, chatId, "✅ كل الأقسام / All sections.");

    case "/watch": {
      const words = splitList(arg);
      if (!words.length) return say(env, chatId, "اكتب الكلمة بعد الأمر، مثال:\n/watch السليمانية\n/watch dollar, election");
      for (const w of words) {
        if (!user.keywords.some((k) => k.toLowerCase() === w.toLowerCase())) user.keywords.push(w);
      }
      user.keywords = user.keywords.slice(0, 20);
      await saveUser(env, user);
      return say(env, chatId, "⭐ " + esc(user.keywords.join(", ")));
    }

    case "/unwatch": {
      const words = splitList(arg).map((w) => w.toLowerCase());
      if (!words.length && user.keywords.length) {
        return say(env, chatId, "اختر كلمة لحذفها / Tap a keyword to remove it:", {
          reply_markup: { inline_keyboard: user.keywords.map((k) => [{ text: "❌ " + k, callback_data: "unw:" + k.slice(0, 40) }]) },
        });
      }
      user.keywords = user.keywords.filter((k) => !words.includes(k.toLowerCase()));
      await saveUser(env, user);
      return say(env, chatId, "⭐ " + (esc(user.keywords.join(", ")) || "لا شيء / none"));
    }

    case "/keywords":
      return say(env, chatId, "⭐ " + (esc(user.keywords.join(", ")) || "لا شيء / none") +
        "\n\n/watch كلمة  للإضافة / to add\n/unwatch  للحذف / to remove");

    case "/status":
      return say(env, chatId, statusText(user));

    case "/stats":
      if (env.ADMIN_ID && chatId === String(env.ADMIN_ID)) {
        const u = await env.DB.prepare("SELECT COUNT(*) AS c FROM users").first();
        const o = await env.DB.prepare("SELECT COUNT(*) AS c FROM outbox").first();
        return say(env, chatId, `👥 Users: ${u.c}\n📨 Waiting to send: ${o.c}`);
      }
      return say(env, chatId, "اكتب /help لرؤية الأوامر / Type /help to see the commands.");

    default:
      return say(env, chatId, "اكتب /help لرؤية الأوامر / Type /help to see the commands.");
  }
}

async function handleCallback(env, cq) {
  const chatId = String(cq.message?.chat?.id || cq.from.id);
  const user = (await getUser(env, chatId)) || newUser(chatId);
  const data = cq.data || "";
  let toast = "✅";

  if (data.startsWith("lang:")) {
    user.lang = data.slice(5);
    await saveUser(env, user);
    toast = "✅ " + LANG_NAMES[user.lang];
    await tg(env, "editMessageText", {
      chat_id: chatId, message_id: cq.message.message_id, parse_mode: "HTML",
      text: `اللغة / Language: <b>${LANG_NAMES[user.lang]}</b>\n\nاضغط للتغيير / Tap to change:`,
      reply_markup: langButtons(user),
    });
  } else if (data.startsWith("sec:")) {
    const name = data.slice(4);
    if (name === "*") user.only = [];
    else if (user.only.some((o) => o.toLowerCase() === name.toLowerCase())) {
      user.only = user.only.filter((o) => o.toLowerCase() !== name.toLowerCase());
    } else user.only.push(name);
    await saveUser(env, user);
    const v = await sectionsView(env, user);
    await tg(env, "editMessageText", {
      chat_id: chatId, message_id: cq.message.message_id, parse_mode: "HTML",
      text: v.text, reply_markup: v.reply_markup,
    });
  } else if (data.startsWith("unw:")) {
    const k = data.slice(4).toLowerCase();
    user.keywords = user.keywords.filter((w) => !w.toLowerCase().startsWith(k));
    await saveUser(env, user);
    toast = "❌";
    await tg(env, "editMessageText", {
      chat_id: chatId, message_id: cq.message.message_id, parse_mode: "HTML",
      text: "⭐ " + (esc(user.keywords.join(", ")) || "لا شيء / none"),
    });
  }
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: toast });
}

// ---------------- entry points ----------------

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // one-time setup: open https://<your-worker>/setup?key=<WEBHOOK_SECRET>
    if (url.pathname === "/setup") {
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("Wrong key", { status: 403 });
      await setupDb(env);
      const hook = await tg(env, "setWebhook", {
        url: `${url.origin}/telegram`,
        secret_token: env.WEBHOOK_SECRET,
        allowed_updates: ["message", "callback_query"],
        drop_pending_updates: true,
      });
      const cmds = await tg(env, "setMyCommands", {
        commands: COMMANDS.map(([command, description]) => ({ command, description })),
      });
      return Response.json({ webhook: hook.ok, commands: cmds.ok, details: hook.description || "" });
    }

    // health check: open https://<your-worker>/debug?key=<WEBHOOK_SECRET>
    if (url.pathname === "/debug") {
      if (url.searchParams.get("key") !== env.WEBHOOK_SECRET) return new Response("Wrong key", { status: 403 });
      const report = {};
      try {
        await checkFeeds(env, report);
      } catch (e) {
        report.error = String(e.stack || e);
      }
      const count = async (t) => (await env.DB.prepare(`SELECT COUNT(*) AS c FROM ${t}`).first()).c;
      try {
        report.saved = { seen: await count("seen"), recent: await count("recent"), users: await count("users"), waiting: await count("outbox") };
      } catch (e) { report.dbError = String(e); }
      try {
        const t = await fetch(FEEDS.ar, { headers: { "User-Agent": "Mozilla/5.0 (ShafaqTelegramBot)" } });
        report.feedTest = { status: t.status, start: (await t.text()).slice(0, 120) };
      } catch (e) { report.feedTest = String(e); }
      try {
        const m = await env.DB.prepare("SELECT v FROM meta WHERE k = 'last_cron'").first();
        report.lastAutomaticRun = m ? JSON.parse(m.v) : "never";
      } catch (e) { report.lastAutomaticRun = "never"; }
      return Response.json(report);
    }

    if (url.pathname === "/telegram" && request.method === "POST") {
      if (request.headers.get("X-Telegram-Bot-Api-Secret-Token") !== env.WEBHOOK_SECRET) {
        return new Response("Forbidden", { status: 403 });
      }
      const update = await request.json();
      try {
        if (update.message) await handleMessage(env, update.message);
        else if (update.callback_query) await handleCallback(env, update.callback_query);
      } catch (e) {
        console.log("Update error:", e.stack || e);
      }
      return new Response("ok");
    }

    return new Response("Shafaq News bot is running.");
  },

  async scheduled(event, env, ctx) {
    const report = {};
    try {
      await checkFeeds(env, report);
    } catch (e) {
      report.error = String(e.stack || e).slice(0, 500);
      console.log("Cron error:", report.error);
    }
    report.at = new Date().toISOString();
    try {
      await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('last_cron', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
        .bind(JSON.stringify(report)).run();
    } catch (e) { console.log("meta save failed:", e); }
  },
};
