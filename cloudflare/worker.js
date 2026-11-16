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
// Breaking news markers: the #عاجل / #breaking hashtag or tag anywhere in the item,
// a category called عاجل / Breaking, or a headline that starts with عاجل / Breaking
const BREAKING_TAGS = ["عاجل", "breaking", "breaking news", "breakingnews", "urgent"];

function safeDecodeURI(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

// Shafaq's breaking flashes have no article body: the text is just the headline again
const norm = (s) => String(s || "").toLowerCase().replace(/[\s"'“”«».,،:؛!?؟\-–—|()\[\]]/g, "");
function textIsJustHeadline(title, summary) {
  // ignore a "شفق نيوز- بغداد" / "Shafaq News- Baghdad" dateline line
  const body = String(summary || "").split("\n").filter((l) => !/^\s*(شفق\s*نيوز|shafaq\s*news)\s*[-–—/]/i.test(l)).join(" ");
  const t = norm(title), b = norm(body);
  if (!t) return false;
  return !b || b === t || (b.startsWith(t) && b.length - t.length < 25);
}

function isBreaking(title, categories, rawBody) {
  const t = title.trim().toLowerCase();
  if (/^(🔴\s*)?(عاجل|breaking|urgent)(?![a-z])/.test(t)) return true;
  if (categories.some((c) => BREAKING_TAGS.includes(c.trim().toLowerCase()))) return true;
  const text = safeDecodeURI(decodeEntities(rawBody)).toLowerCase();
  if (/#\s?(عاجل|breaking_?news|breaking|urgent)/.test(text)) return true;
  if (/\/tags?\/(عاجل|breaking[-_ ]?news|breaking|urgent)(?=[\/"'?#&\s<]|$)/.test(text)) return true;
  return false;
}
const SEND_PER_RUN = 40; // Cloudflare free plan allows 50 outgoing requests per run
// Free Cloudflare AI models for captions, tried in order
const CAPTION_MODELS = ["@cf/google/gemma-4-26b-a4b-it", "@cf/zai-org/glm-4.7-flash"];
const CAPTIONS_PER_USER_PER_DAY = 30; // safety limit for everyone except the admin
// Starting word list for captions (avoid -> use instead). Change it in Telegram with /avoid
const DEFAULT_AVOID = {
  killed: "lost their lives",
  kill: "harm",
  killing: "deaths",
  dead: "victims",
  destroyed: "damaged",
  massacre: "deadly attack",
  bloody: "violent",
};

async function getAvoidList(env) {
  const m = await env.DB.prepare("SELECT v FROM meta WHERE k = 'avoid_words'").first();
  return m ? JSON.parse(m.v) : { ...DEFAULT_AVOID };
}

async function saveAvoidList(env, list) {
  await env.DB.prepare("INSERT INTO meta (k, v) VALUES ('avoid_words', ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v")
    .bind(JSON.stringify(list)).run();
}

const escRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// safety net: replace any avoided word the AI still used (keeps a capital first letter)
function applyAvoidList(text, list) {
  let out = text;
  // drop hashtags that contain an avoided word, e.g. #Killed
  for (const bad of Object.keys(list)) {
    out = out.replace(new RegExp(`\\s?#[\\p{L}\\p{N}_]*${escRe(bad)}[\\p{L}\\p{N}_]*`, "giu"), "");
  }
  for (const [bad, good] of Object.entries(list)) {
    const re = new RegExp(`(^|[^\\p{L}#])(${escRe(bad)})(?=$|[^\\p{L}])`, "giu");
    out = out.replace(re, (all, pre, word) => {
      const rep = word[0] === word[0].toUpperCase() && word[0] !== word[0].toLowerCase()
        ? good.charAt(0).toUpperCase() + good.slice(1) : good;
      return pre + rep;
    });
  }
  return out;
}
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

function shortHash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
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
    env.DB.prepare("CREATE TABLE IF NOT EXISTS breaking_log (id TEXT PRIMARY KEY, title TEXT, ts INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS caption_use (chat_id TEXT, day TEXT, n INTEGER, PRIMARY KEY (chat_id, day))"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS articles (h TEXT PRIMARY KEY, title TEXT, summary TEXT, lang TEXT, ts INTEGER)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS delay_log (id TEXT PRIMARY KEY, title TEXT, pub INTEGER, found INTEGER, sent INTEGER)"),
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
  const opts = {
    headers: { "User-Agent": "Mozilla/5.0 (ShafaqTelegramBot)", "Cache-Control": "no-cache", Pragma: "no-cache" },
    cf: { cacheTtl: 0, cacheEverything: false },
  };
  // ask for a fresh copy every time (skip any cache), fall back to the plain URL if that fails
  let r = await fetch(`${url}?nocache=${Date.now()}`, opts);
  if (!r.ok) r = await fetch(url, opts);
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
  const categories = [...body.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)]
    .map((m) => decodeEntities(m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, "$1").trim()));
  const title = decodeEntities(tag(body, "title"));
  const summary = cleanText(tag(body, "description") || tag(body, "content:encoded"));
  const flash = textIsJustHeadline(title, summary);
  return {
    breaking: flash || isBreaking(title, categories, body),
    pub: Date.parse(decodeEntities(tag(body, "pubDate"))) || 0,
    categories,
    id: raw.id, lang: raw.lang,
    link: decodeEntities(tag(body, "link")) || raw.id,
    title,
    category: categories[0] || "",
    image: enc ? decodeEntities(enc[1]) : null,
    summary: flash ? "" : summary,   // don't repeat the headline as the text
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
  const captionRow = item.lang === "en"
    ? [[{ text: "✍️ Caption", callback_data: "cap:" + shortHash(item.id) }]] : [];
  const reply_markup = {
    inline_keyboard: [[
      { text: "📋 نسخ / Copy", copy_text: { text: `${item.title}\n${item.link}`.slice(0, 256) } },
      { text: "🔗 فتح / Open", url: item.link },
    ], [
      { text: "📝 نسخ العنوان / Copy title", copy_text: { text: item.title.slice(0, 256) } },
    ], ...captionRow],
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
      if (i.lang === "en") {
        stmts.push(env.DB.prepare("INSERT OR IGNORE INTO articles (h, title, summary, lang, ts) VALUES (?, ?, ?, ?, ?)")
          .bind(shortHash(i.id), i.title, (i.summary || "").slice(0, 2500), i.lang, now));
      }
      if (!firstRun && i.pub) {
        stmts.push(env.DB.prepare("INSERT OR IGNORE INTO delay_log (id, title, pub, found) VALUES (?, ?, ?, ?)").bind(i.id, i.title, i.pub, now));
      }
      if (i.breaking) {
        stmts.push(env.DB.prepare("INSERT OR IGNORE INTO breaking_log (id, title, ts) VALUES (?, ?, ?)").bind(i.id, i.title, now));
      }
      stmts.push(env.DB.prepare(
        "INSERT OR IGNORE INTO recent (id, title, link, category, lang, ts) VALUES (?, ?, ?, ?, ?, ?)"
      ).bind(i.id, i.title, i.link, i.category, i.lang, now));
    }
    if (!firstRun) {
      const users = (await env.DB.prepare("SELECT * FROM users").all()).results.map((u) => ({
        ...u, only: JSON.parse(u.only || "[]"), keywords: JSON.parse(u.keywords || "[]"),
      }));
      for (const i of fresh) {
        const breaking = !!i.breaking;
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
    env.DB.prepare("DELETE FROM delay_log WHERE found < ?").bind(Date.now() - 2 * day),
    env.DB.prepare("DELETE FROM articles WHERE ts < ?").bind(Date.now() - 3 * day),
    env.DB.prepare("DELETE FROM recent WHERE id NOT IN (SELECT id FROM recent ORDER BY ts DESC, rowid DESC LIMIT 60)"),
  ]);
}

async function sendOutbox(env) {
  const rows = (await env.DB.prepare("SELECT * FROM outbox ORDER BY n LIMIT ?").bind(SEND_PER_RUN).all()).results;
  const done = [];
  for (const row of rows) {
    const item = JSON.parse(row.item);
    const res = await sendArticle(env, row.chat_id, item);
    if (res.ok) {
      await env.DB.prepare("UPDATE delay_log SET sent = ? WHERE id = ? AND sent IS NULL").bind(Date.now(), item.id).run();
    }
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

// ---------------- AI caption ----------------

async function makeCaption(env, a) {
  if (!env.AI) return { error: "AI is not connected" };
  const avoid = await getAvoidList(env);
  const avoidRules = Object.entries(avoid).map(([b, g]) => `"${b}" -> "${g}"`).join(", ");
  const prompt = `Write an Instagram caption for this Shafaq News article.

Title: ${a.title}
Article: ${(a.summary || "").slice(0, 2000)}

Rules:
- Keep it short: one or two lines, accurate and catchy, safe for Instagram Explore.
- Never use these words. Use the replacement instead and keep the sentence natural: ${avoidRules || "none"}.
- Keep the tone calm and neutral, no graphic or violent wording.
- No em dashes. At most one emoji.
- Then one new line with exactly 5 trending hashtags about the topic. The first must be #Shafaq_news.

Reply with only the caption and the hashtags, nothing else.`;
  let lastErr = "";
  for (const model of CAPTION_MODELS) {
    try {
      const out = await env.AI.run(model, {
        messages: [{ role: "user", content: prompt }],
        max_tokens: 200,
      });
      const text = (out?.response ?? out?.choices?.[0]?.message?.content ?? "").trim();
      if (text) {
        const clean = text.replace(/\s*[—–]\s*/g, ", ").replace(/^["']|["']$/g, "");
        return { text: applyAvoidList(clean, avoid) };
      }
      lastErr = "empty answer";
    } catch (e) {
      lastErr = String(e.message || e);
      console.log(`Caption with ${model} failed: ${lastErr}`);
    }
  }
  return { error: lastErr };
}

async function handleCaption(env, cq, chatId, h) {
  await tg(env, "answerCallbackQuery", { callback_query_id: cq.id, text: "✍️ ..." });
  const a = await env.DB.prepare("SELECT * FROM articles WHERE h = ?").bind(h).first();
  if (!a) return say(env, chatId, "This article is too old for a caption.");
  const r = await makeCaption(env, a);
  if (r.error) {
    const limit = /limit|quota|neuron|429|exceed/i.test(r.error);
    return say(env, chatId, limit ? "Daily free AI limit reached. Try again tomorrow." : "Couldn't write a caption: " + esc(r.error.slice(0, 200)));
  }
  return say(env, chatId, `<pre>${esc(r.text)}</pre>`, {
    reply_parameters: { message_id: cq.message.message_id, allow_sending_without_reply: true },
    reply_markup: { inline_keyboard: [[
      ...(r.text.length <= 256 ? [{ text: "📋 Copy", copy_text: { text: r.text } }] : []),
      { text: "🔄 Another one", callback_data: "cap:" + h },
    ]] },
  });
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

    case "/avoid": {
      const list = await getAvoidList(env);
      const isAdmin = env.ADMIN_ID && chatId === String(env.ADMIN_ID);
      if (arg.toLowerCase() === "reset" && isAdmin) {
        await saveAvoidList(env, { ...DEFAULT_AVOID });
        return say(env, chatId, "✅ Word list reset.");
      }
      const m = arg.match(/^(.+?)\s*(?:=|->|→)\s*(.+)$/);
      if (m && isAdmin) {
        list[m[1].trim().toLowerCase()] = m[2].trim();
        await saveAvoidList(env, list);
      } else if (m) {
        return say(env, chatId, "Only the bot owner can change the word list.");
      }
      const lines = Object.entries(list).map(([b, g]) => `• ${esc(b)} → ${esc(g)}`);
      return say(env, chatId,
        `<b>Caption word list</b>\n\n${lines.join("\n") || "Empty"}` +
        (isAdmin ? `\n\nAdd or change:\n<code>/avoid word = replacement</code>\nRemove:\n<code>/unavoid word</code>\nBack to the starting list:\n<code>/avoid reset</code>` : ""));
    }

    case "/unavoid": {
      if (!(env.ADMIN_ID && chatId === String(env.ADMIN_ID))) return say(env, chatId, "Only the bot owner can change the word list.");
      const list = await getAvoidList(env);
      const words = splitList(arg).map((w) => w.toLowerCase());
      if (!words.length) return say(env, chatId, "Use: <code>/unavoid word</code>");
      for (const w of words) delete list[w];
      await saveAvoidList(env, list);
      return say(env, chatId, "✅ Removed: " + esc(words.join(", ")));
    }

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

  if (data.startsWith("cap:")) {
    const isAdmin = env.ADMIN_ID && chatId === String(env.ADMIN_ID);
    if (!isAdmin) {
      const day = new Date().toISOString().slice(0, 10);
      const row = await env.DB.prepare("SELECT n FROM caption_use WHERE chat_id = ? AND day = ?").bind(chatId, day).first();
      if (row && row.n >= CAPTIONS_PER_USER_PER_DAY) {
        return tg(env, "answerCallbackQuery", { callback_query_id: cq.id, show_alert: true,
          text: `You've used today's ${CAPTIONS_PER_USER_PER_DAY} captions. More tomorrow.` });
      }
      await env.DB.batch([
        env.DB.prepare("INSERT INTO caption_use (chat_id, day, n) VALUES (?, ?, 1) ON CONFLICT(chat_id, day) DO UPDATE SET n = n + 1").bind(chatId, day),
        env.DB.prepare("DELETE FROM caption_use WHERE day < ?").bind(new Date(Date.now() - 2 * 864e5).toISOString().slice(0, 10)),
      ]);
    }
    return handleCaption(env, cq, chatId, data.slice(4));
  }

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
        const mins = (ms) => Math.round(ms / 6000) / 10;
        report.delays = (await env.DB.prepare("SELECT * FROM delay_log ORDER BY found DESC LIMIT 10").all()).results.map((d) => ({
          title: d.title.slice(0, 60),
          published: new Date(d.pub).toISOString().slice(11, 19),
          feedDelayMin: mins(d.found - d.pub),
          sendDelayMin: d.sent ? mins(d.sent - d.found) : null,
        }));
        report.breakingSeen = (await env.DB.prepare("SELECT title FROM breaking_log ORDER BY ts DESC LIMIT 5").all()).results.map((r) => r.title);
        const sample = (await fetchFeed("ar", FEEDS.ar)).slice(-3).map(parseItem);
        report.latestArabic = sample.map((i) => ({ title: i.title, categories: i.categories, breaking: i.breaking, image: i.image }));
      } catch (e) { report.sampleError = String(e); }
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
