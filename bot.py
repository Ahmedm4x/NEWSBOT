"""
Shafaq News -> Telegram bot

Features
  - New Shafaq News articles (Arabic + English) with photo, text and hashtag
  - Breaking news (عاجل / Breaking) arrives with sound and a red mark, the rest is silent
  - Filters: language and sections
  - Keyword alerts: marked with a star, pinned, and sent with sound
  - Copy + Open buttons under every article
  - Commands: /latest /lang /only /all /sections /watch /unwatch /keywords /status /help
"""
import html
import json
import os
import re
import time
import xml.etree.ElementTree as ET

import requests

# ===== Settings =====
BOT_TOKEN = os.getenv("BOT_TOKEN", "PUT_YOUR_BOT_TOKEN_HERE")
CHAT_ID = os.getenv("CHAT_ID", "PUT_YOUR_CHAT_ID_HERE")

FEEDS = {
    "ar": "https://shafaq.com/rss/ar",
    "en": "https://shafaq.com/rss/en",
}
BREAKING_WORDS = ["عاجل", "breaking", "urgent"]

CHECK_EVERY_SECONDS = 60
HERE = os.path.dirname(os.path.abspath(__file__))
SEEN_FILE = os.path.join(HERE, "seen.json")
STATE_FILE = os.path.join(HERE, "state.json")
HEADERS = {"User-Agent": "Mozilla/5.0 (ShafaqTelegramBot)"}
COMMANDS_VERSION = 2
# ====================

DEFAULT_STATE = {
    "offset": 0,          # last Telegram update we handled
    "lang": "both",       # ar / en / both
    "only": [],           # sections filter, empty = all sections
    "keywords": [],       # keyword alerts
    "recent": [],         # last 30 articles, for /latest and /sections
    "commands_v": 0,
}


# ---------- storage ----------

def load_json(path, default):
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(path, data):
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=1)


def load_state():
    state = dict(DEFAULT_STATE)
    state.update(load_json(STATE_FILE, {}))
    state.pop("paused_until", None)   # pause feature was removed
    return state


# ---------- Telegram ----------

def tg(method, **data):
    try:
        r = requests.post(f"https://api.telegram.org/bot{BOT_TOKEN}/{method}",
                          json=data, timeout=25)
    except requests.RequestException as e:
        print(f"Telegram {method} failed: {e}")
        return {}
    res = r.json() if r.headers.get("content-type", "").startswith("application/json") else {}
    if r.status_code == 429:
        time.sleep(res.get("parameters", {}).get("retry_after", 5))
        return tg(method, **data)
    if not r.ok:
        print(f"Telegram {method} error: {r.text[:300]}")
    return res


def say(text):
    return tg("sendMessage", chat_id=CHAT_ID, text=text, parse_mode="HTML",
              link_preview_options={"is_disabled": True})


def set_commands_menu(state):
    if state.get("commands_v") == COMMANDS_VERSION:
        return
    cmds = [
        ("latest", "Last 5 articles / آخر 5 أخبار"),
        ("lang", "ar / en / both"),
        ("only", "Only some sections, e.g. /only Iraq, Kurdistan"),
        ("all", "All sections again"),
        ("sections", "Sections seen recently"),
        ("watch", "Keyword alert, e.g. /watch السليمانية"),
        ("unwatch", "Remove a keyword"),
        ("keywords", "Your keywords"),
        ("status", "Current settings"),
        ("help", "Help"),
    ]
    res = tg("setMyCommands", commands=[{"command": c, "description": d} for c, d in cmds])
    if res.get("ok"):
        state["commands_v"] = COMMANDS_VERSION


# ---------- feeds ----------

def clean_text(raw):
    """Turn the feed's HTML description into plain text."""
    text = re.sub(r"<br\s*/?>|</p>", "\n", raw, flags=re.I)
    text = re.sub(r"<[^>]+>", "", text)
    text = html.unescape(text)
    lines = [l.strip() for l in text.splitlines()]
    lines = [l for l in lines if l and not l.lower().startswith(("read more", "اقرأ أيضا", "اقرأ ايضا"))]
    return "\n\n".join(lines)


def fetch_items(lang, feed_url):
    r = requests.get(feed_url, headers=HEADERS, timeout=20)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    items = []
    for it in root.iter("item"):
        link = (it.findtext("link") or "").strip()
        guid = (it.findtext("guid") or link).strip()
        desc = (it.findtext("description")
                or it.findtext("{http://purl.org/rss/1.0/modules/content/}encoded") or "")
        enc = it.find("enclosure")
        if guid:
            items.append({
                "id": guid,
                "link": link,
                "title": (it.findtext("title") or "").strip(),
                "category": (it.findtext("category") or "").strip(),
                "image": enc.get("url") if enc is not None else None,
                "summary": clean_text(desc),
                "lang": lang,
            })
    items.reverse()  # oldest first, so messages arrive in order
    return items


# ---------- sending ----------

def wanted(item, state):
    if state["lang"] != "both" and item["lang"] != state["lang"]:
        return False
    if state["only"]:
        cat = item["category"].lower()
        if not any(o.lower() in cat for o in state["only"]):
            return False
    return True


def build_text(item, limit, breaking, hits):
    head = f"<b>{html.escape(item['title'])}</b>"
    if breaking:
        head = "🔴 " + head
    if hits:
        head = "⭐ " + head
    tail = ""
    if hits:
        tail += "\n\n⭐ " + html.escape(", ".join(hits))
    if item["category"]:
        tail += f"\n\n#{html.escape(item['category'].replace(' ', '_').replace('&', 'and'))}"
    summary = item.get("summary", "")
    room = limit - len(head) - len(tail) - 10
    if summary and room > 50:
        if len(html.escape(summary)) > room:
            summary = summary[:room - 20].rsplit(" ", 1)[0] + "..."
        return f"{head}\n\n{html.escape(summary)}{tail}"
    return head + tail


def send_article(item, state):
    text_all = (item["title"] + " " + item["summary"]).lower()
    breaking = any(w in item["title"].lower() for w in BREAKING_WORDS)
    hits = [k for k in state["keywords"] if k.lower() in text_all]
    silent = not (breaking or hits)

    buttons = {"inline_keyboard": [[
        {"text": "📋 نسخ / Copy",
         "copy_text": {"text": (item["title"] + "\n" + item["link"])[:256]}},
        {"text": "🔗 فتح / Open", "url": item["link"]},
    ]]}

    res = {}
    if item["image"]:
        res = tg("sendPhoto", chat_id=CHAT_ID, photo=item["image"],
                 caption=build_text(item, 1024, breaking, hits), parse_mode="HTML",
                 disable_notification=silent, reply_markup=buttons)
    if not res.get("ok"):
        res = tg("sendMessage", chat_id=CHAT_ID,
                 text=build_text(item, 4096, breaking, hits), parse_mode="HTML",
                 disable_notification=silent, reply_markup=buttons,
                 link_preview_options={"is_disabled": True})
    if not res.get("ok"):
        return

    msg_id = res["result"]["message_id"]
    if hits:
        tg("pinChatMessage", chat_id=CHAT_ID, message_id=msg_id, disable_notification=True)

    print(f"Sent: {item['title']} (text: {len(item['summary'])} chars"
          f"{', breaking' if breaking else ''}{', keywords: ' + ', '.join(hits) if hits else ''}"
          ")")


# ---------- commands ----------

HELP = """<b>الأوامر / Commands</b>

/latest  آخر 5 أخبار (or /latest 10)
/lang ar | en | both  اللغة
/only Iraq, Kurdistan  أقسام معينة فقط
/all  كل الأقسام
/sections  الأقسام الموجودة
/watch كلمة  تنبيه عند ذكر كلمة
/unwatch كلمة  حذف كلمة
/keywords  كلماتك
/status  الإعدادات الحالية"""


def split_list(arg):
    return [x.strip() for x in re.split(r"[,،\n]", arg) if x.strip()]


def run_command(cmd, arg, state):
    now = time.time()
    if cmd in ("/start", "/help"):
        return HELP

    if cmd == "/latest":
        n = int(arg) if arg.isdigit() else 5
        items = state["recent"][-min(n, 30):]
        if not items:
            return "لا توجد أخبار بعد / No news yet."
        lines = [f"• <a href=\"{html.escape(i['link'])}\">{html.escape(i['title'])}</a>"
                 for i in reversed(items)]
        return "<b>آخر الأخبار / Latest</b>\n\n" + "\n\n".join(lines)

    if cmd == "/lang":
        if arg.lower() in ("ar", "en", "both"):
            state["lang"] = arg.lower()
            return f"✅ Language: {state['lang']}"
        return "Use: /lang ar  or  /lang en  or  /lang both"

    if cmd == "/only":
        if not arg:
            return "Use: /only Iraq, Kurdistan  (see /sections)"
        state["only"] = split_list(arg)
        return "✅ Only: " + html.escape(", ".join(state["only"])) + "\n/all to get everything again."

    if cmd == "/all":
        state["only"] = []
        return "✅ All sections."

    if cmd == "/sections":
        cats = sorted({i["category"] for i in state["recent"] if i.get("category")})
        if not cats:
            return "No sections seen yet, try again later."
        return "<b>Sections seen recently</b>\n\n" + "\n".join(html.escape(c) for c in cats)

    if cmd == "/watch":
        words = split_list(arg)
        if not words:
            return "Use: /watch السليمانية  or  /watch dollar, election"
        for w in words:
            if w.lower() not in [k.lower() for k in state["keywords"]]:
                state["keywords"].append(w)
        return "⭐ Watching: " + html.escape(", ".join(state["keywords"]))

    if cmd == "/unwatch":
        words = [w.lower() for w in split_list(arg)]
        state["keywords"] = [k for k in state["keywords"] if k.lower() not in words]
        return "⭐ Watching: " + (html.escape(", ".join(state["keywords"])) or "nothing")

    if cmd == "/keywords":
        return "⭐ Watching: " + (html.escape(", ".join(state["keywords"])) or "nothing")

    if cmd == "/status":
        return (
            "<b>Status</b>\n\n"
            f"Language: {state['lang']}\n"
            f"Sections: {html.escape(', '.join(state['only'])) or 'all'}\n"
            f"Keywords: {html.escape(', '.join(state['keywords'])) or 'none'}"
        )

    return "Unknown command. /help"


def handle_commands(state):
    res = tg("getUpdates", offset=state["offset"], timeout=0, allowed_updates=["message"])
    for u in res.get("result", []):
        state["offset"] = u["update_id"] + 1
        msg = u.get("message") or {}
        if str(msg.get("chat", {}).get("id")) != str(CHAT_ID):
            continue  # ignore anyone else
        text = (msg.get("text") or "").strip()
        if not text.startswith("/"):
            continue
        cmd, _, arg = text.partition(" ")
        cmd = cmd.split("@")[0].lower()
        try:
            reply = run_command(cmd, arg.strip(), state)
        except Exception as e:
            reply = f"Error: {html.escape(str(e))}"
        if reply:
            say(reply)


# ---------- main loop ----------

def check_once(seen, state, first_run):
    seen_set = set(seen)
    for lang, feed in FEEDS.items():
        try:
            for item in fetch_items(lang, feed):
                if item["id"] in seen_set:
                    continue
                seen_set.add(item["id"])
                seen.append(item["id"])
                state["recent"].append({"title": item["title"], "link": item["link"],
                                        "category": item["category"], "lang": lang})
                if first_run or not wanted(item, state):
                    continue
                send_article(item, state)
                time.sleep(1)
        except Exception as e:
            print(f"Error with {feed}: {e}")
    state["recent"] = state["recent"][-30:]
    del seen[:-2000]


def run_cycle(seen, state, first_run):
    set_commands_menu(state)
    handle_commands(state)
    check_once(seen, state, first_run)
    save_json(SEEN_FILE, seen)
    save_json(STATE_FILE, state)


def main():
    seen = load_json(SEEN_FILE, [])
    state = load_state()
    first_run = not seen

    if os.getenv("RUN_ONCE"):   # GitHub Actions: one check per run
        run_for = int(os.getenv("RUN_FOR", "0"))
        start = time.time()
        while True:
            run_cycle(seen, state, first_run)
            first_run = False
            if time.time() - start + CHECK_EVERY_SECONDS > run_for:
                break
            time.sleep(CHECK_EVERY_SECONDS)
        return

    print("Bot started. Checking every", CHECK_EVERY_SECONDS, "seconds.")
    while True:
        run_cycle(seen, state, first_run)
        first_run = False
        time.sleep(CHECK_EVERY_SECONDS)


if __name__ == "__main__":
    main()
