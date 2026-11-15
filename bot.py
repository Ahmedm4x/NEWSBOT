"""
Shafaq News -> Telegram bot
Polls Shafaq News RSS feeds and sends every new article to your Telegram chat.
"""
import html
import json
import os
import time
import xml.etree.ElementTree as ET

import requests

# ===== Settings =====
BOT_TOKEN = os.getenv("BOT_TOKEN", "PUT_YOUR_BOT_TOKEN_HERE")
CHAT_ID = os.getenv("CHAT_ID", "PUT_YOUR_CHAT_ID_HERE")

# Add or remove feeds as you like. Section feeds also work, e.g.
# https://shafaq.com/rss/en/Iraq  or  https://shafaq.com/rss/en/Kurdistan
FEEDS = [
    "https://shafaq.com/rss/ar",
    "https://shafaq.com/rss/en",
]

CHECK_EVERY_SECONDS = 60
SEEN_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "seen.json")
HEADERS = {"User-Agent": "Mozilla/5.0 (ShafaqTelegramBot)"}
# ====================


def load_seen():
    try:
        with open(SEEN_FILE, encoding="utf-8") as f:
            return set(json.load(f))
    except (FileNotFoundError, json.JSONDecodeError):
        return set()


def save_seen(seen):
    # keep the file small: only the last 2000 links
    with open(SEEN_FILE, "w", encoding="utf-8") as f:
        json.dump(list(seen)[-2000:], f, ensure_ascii=False)


def fetch_items(feed_url):
    r = requests.get(feed_url, headers=HEADERS, timeout=20)
    r.raise_for_status()
    root = ET.fromstring(r.content)
    items = []
    for it in root.iter("item"):
        link = (it.findtext("link") or "").strip()
        guid = (it.findtext("guid") or link).strip()
        title = (it.findtext("title") or "").strip()
        category = (it.findtext("category") or "").strip()
        enc = it.find("enclosure")
        image = enc.get("url") if enc is not None else None
        if guid:
            items.append({"id": guid, "link": link, "title": title,
                          "category": category, "image": image})
    items.reverse()  # oldest first, so messages arrive in order
    return items


def send(item):
    text = f"<b>{html.escape(item['title'])}</b>"
    if item["category"]:
        text += f"\n#{html.escape(item['category'].replace(' ', '_'))}"
    text += f"\n\n{html.escape(item['link'])}"

    api = f"https://api.telegram.org/bot{BOT_TOKEN}"
    if item["image"]:
        r = requests.post(f"{api}/sendPhoto", timeout=20, data={
            "chat_id": CHAT_ID, "photo": item["image"],
            "caption": text, "parse_mode": "HTML"})
        if r.ok:
            return
    # no image, or the image failed: send plain text
    r = requests.post(f"{api}/sendMessage", timeout=20, data={
        "chat_id": CHAT_ID, "text": text, "parse_mode": "HTML"})
    if r.status_code == 429:  # Telegram rate limit
        wait = r.json().get("parameters", {}).get("retry_after", 5)
        time.sleep(wait)
        send(item)
    elif not r.ok:
        print("Telegram error:", r.text)


def check_once(seen, first_run):
    for feed in FEEDS:
        try:
            for item in fetch_items(feed):
                if item["id"] in seen:
                    continue
                seen.add(item["id"])
                if not first_run:  # first run: just remember current news, don't spam
                    send(item)
                    time.sleep(1.5)
        except Exception as e:
            print(f"Error with {feed}: {e}")
    save_seen(seen)


def main():
    seen = load_seen()
    first_run = not seen

    # GitHub Actions mode: check one time and exit (GitHub runs it every few minutes)
    if os.getenv("RUN_ONCE"):
        check_once(seen, first_run)
        return

    print("Bot started. Checking every", CHECK_EVERY_SECONDS, "seconds.")
    while True:
        check_once(seen, first_run)
        first_run = False
        time.sleep(CHECK_EVERY_SECONDS)


if __name__ == "__main__":
    main()
