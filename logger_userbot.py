import os
import asyncio
from pathlib import Path
from dotenv import load_dotenv
from telethon import TelegramClient, events

from database import init_db, migrate_db, save_event, cache_upsert, cache_lookup, cache_lookup_by_message_id, find_original_message, cache_cleanup
from datetime import datetime, timezone

load_dotenv()

API_ID = int(os.getenv("API_ID"))
API_HASH = os.getenv("API_HASH")
PHONE = os.getenv("PHONE")
SESSION_NAME = os.getenv("SESSION_NAME", "telegram_logger")
MEDIA_DIR = Path(os.getenv("MEDIA_DIR", "media"))

MEDIA_DIR.mkdir(exist_ok=True)

client = TelegramClient(SESSION_NAME, API_ID, API_HASH)

last_message_ids = {}

# Cache: (chat_id, message_id) -> to'liq xabar ma'lumoti
# Restart bo'lsa cache tozalanadi — shuning uchun original_* DB ga ham saqlanadi
message_cache: dict = {}

# Media cache: media download tugagandan keyin cache yangilanadi
# (chat_id, message_id) -> {"media_type": ..., "media_path": ...}
media_cache: dict = {}


def build_link(chat, message_id):
    username = getattr(chat, "username", None)

    if username:
        return f"https://t.me/{username}/{message_id}"

    if str(chat.id).startswith("-100"):
        internal_id = str(chat.id)[4:]
        return f"https://t.me/c/{internal_id}/{message_id}"

    return None


async def detect_and_download_media(message, chat_id, message_id):
    if not message.media:
        return None, None

    media_type = "media"

    if message.photo:
        media_type = "photo"

    elif message.document:
        mime = getattr(message.document, "mime_type", "") or ""

        if mime == "video/mp4":
            for attr in message.document.attributes:
                if attr.__class__.__name__ == "DocumentAttributeAnimated":
                    media_type = "gif"
                    break
            else:
                media_type = "video"

        elif mime == "application/x-tgsticker":
            media_type = "animated_sticker"

        elif mime == "video/webm":
            is_sticker = any(
                attr.__class__.__name__ == "DocumentAttributeSticker"
                for attr in message.document.attributes
            )
            media_type = "video_sticker" if is_sticker else "video"

        elif any(
            attr.__class__.__name__ == "DocumentAttributeSticker"
            for attr in message.document.attributes
        ):
            media_type = "sticker"

        elif message.voice:
            media_type = "voice"

        elif message.video_note:
            media_type = "video_note"

        elif message.video:
            media_type = "video"

        elif message.audio:
            media_type = "audio"

        else:
            media_type = "document"

    elif message.voice:
        media_type = "voice"

    elif message.video_note:
        media_type = "video_note"

    elif message.video:
        media_type = "video"

    elif message.audio:
        media_type = "audio"

    folder = MEDIA_DIR / str(chat_id)
    folder.mkdir(parents=True, exist_ok=True)

    path = await message.download_media(file=str(folder / f"{message_id}_{media_type}"))

    return media_type, path


async def check_missing(chat_id, current_message_id, chat_title):
    last_id = last_message_ids.get(chat_id)

    if last_id and current_message_id > last_id + 1:
        missing_ids = list(range(last_id + 1, current_message_id))

        save_event({
            "event_type": "missing_ids",
            "chat_id": chat_id,
            "chat_title": chat_title,
            "missing_ids": missing_ids,
            "severity": "warning",
        })

    last_message_ids[chat_id] = current_message_id


@client.on(events.NewMessage)
async def new_message_handler(event):
    msg = event.message

    chat = await event.get_chat()
    sender = await event.get_sender()

    chat_title = getattr(chat, "title", None)
    sender_id = getattr(sender, "id", None)
    sender_name = getattr(sender, "first_name", None)
    sender_username = getattr(sender, "username", None)

    is_forwarded = bool(msg.forward)

    forward_from_name = None
    forward_from_chat_id = None
    forward_from_chat_title = None

    if msg.forward:
        if getattr(msg.forward, "sender", None):
            forward_from_name = getattr(msg.forward.sender, "first_name", None)
            forward_from_chat_id = getattr(msg.forward.sender, "id", None)

        if getattr(msg.forward, "chat", None):
            forward_from_chat_id = getattr(msg.forward.chat, "id", None)
            forward_from_chat_title = getattr(msg.forward.chat, "title", None)

    # 1) In-memory cache (tez, lekin restart da yo'qoladi)
    cache_key = (event.chat_id, msg.id)
    now_local = datetime.utcnow()
    msg_cache_data = {
        "sender_id":       sender_id,
        "sender_name":     sender_name,
        "sender_username": sender_username,
        "chat_title":      chat_title,
        "text":            msg.raw_text,
        "media_type":      None,
        "media_path":      None,
        "created_at":      now_local,
        "telegram_link":   build_link(chat, msg.id),
    }
    message_cache[cache_key] = msg_cache_data

    # 2) Persistent DB cache (restart dan himoyalangan)
    cache_upsert({
        "chat_id":      event.chat_id,
        "message_id":   msg.id,
        **msg_cache_data,
    })

    await check_missing(event.chat_id, msg.id, chat_title)

    # 1) Avval darhol DB save (text + IDs)
    save_event({
        "event_type": "new_message",
        "chat_id": event.chat_id,
        "chat_title": chat_title,
        "message_id": msg.id,
        "sender_id": sender_id,
        "sender_name": sender_name,
        "sender_username": sender_username,

        "is_forwarded": is_forwarded,
        "forward_from_name": forward_from_name,
        "forward_from_chat_id": forward_from_chat_id,
        "forward_from_chat_title": forward_from_chat_title,

        "text": msg.raw_text,
        "media_type": "pending" if msg.media else None,
        "media_path": None,
        "telegram_link": build_link(chat, msg.id),
        "severity": "info",
    })

    # 2) Keyin media download
    if msg.media:
        media_type, media_path = await detect_and_download_media(
            msg,
            event.chat_id,
            msg.id,
        )

        # 3) In-memory cache yangilanadi
        if cache_key in message_cache:
            message_cache[cache_key]["media_type"] = media_type
            message_cache[cache_key]["media_path"] = media_path

        # 4) DB cache ham yangilanadi
        cache_upsert({
            "chat_id":    event.chat_id,
            "message_id": msg.id,
            "media_type": media_type,
            "media_path": media_path,
        })

        # 4) Media alohida event sifatida save
        save_event({
            "event_type": "media_download",
            "chat_id": event.chat_id,
            "chat_title": chat_title,
            "message_id": msg.id,
            "sender_id": sender_id,
            "sender_name": sender_name,
            "sender_username": sender_username,

            "media_type": media_type,
            "media_path": media_path,
            "telegram_link": build_link(chat, msg.id),
            "severity": "info",
        })
    print("----- NEW MESSAGE -----")
    print("NAME:", sender_name)
    print("USERNAME:", sender_username)
    print("SENDER:", sender)


@client.on(events.MessageEdited)
async def edited_message_handler(event):
    msg = event.message

    chat = await event.get_chat()
    sender = await event.get_sender()

    chat_title = getattr(chat, "title", None)
    sender_id = getattr(sender, "id", None)
    sender_name = getattr(sender, "first_name", None)
    sender_username = getattr(sender, "username", None)

    # If sender info missing (e.g. channel post), try cache
    cache_key = (event.chat_id, msg.id)
    if not sender_username and cache_key in message_cache:
        cached = message_cache[cache_key]
        sender_id = sender_id or cached.get("sender_id")
        sender_name = sender_name or cached.get("sender_name")
        sender_username = sender_username or cached.get("sender_username")
        chat_title = chat_title or cached.get("chat_title")

    media_type, media_path = await detect_and_download_media(msg, event.chat_id, msg.id)

    save_event({
        "event_type": "edited_message",
        "chat_id": event.chat_id,
        "chat_title": chat_title,
        "message_id": msg.id,
        "sender_id": sender_id,
        "sender_name": sender_name,
        "sender_username": sender_username,
        "new_text": msg.raw_text,
        "media_type": media_type,
        "media_path": media_path,
        "telegram_link": build_link(chat, msg.id),
        "severity": "warning",
    })


@client.on(events.MessageDeleted)
async def deleted_message_handler(event):
    event_chat_id = event.chat_id   # None for regular groups (MTProto limitation)
    deleted_ids = event.deleted_ids
    deleted_at = datetime.utcnow()

    for msg_id in (deleted_ids or []):
        resolved_chat_id = event_chat_id
        cached = None

        # 1) In-memory cache — exact key match
        if resolved_chat_id is not None:
            cached = message_cache.get((resolved_chat_id, msg_id))
            if cached:
                cached = dict(cached)

        # 2) chat_id is None (regular group) — scan in-memory cache by msg_id
        if cached is None and resolved_chat_id is None:
            for key, val in message_cache.items():
                if key[1] == msg_id:
                    resolved_chat_id = key[0]
                    cached = dict(val)
                    print(f"[DEL] msg_id={msg_id} — in-memory chat_id recovered: {resolved_chat_id}")
                    break

        # 3) DB cache — exact lookup
        if cached is None and resolved_chat_id is not None:
            cached = cache_lookup(str(resolved_chat_id), msg_id)
            if cached:
                print(f"[DEL] msg_id={msg_id} — DB cache (exact) ✓")

        # 4) DB cache — search by msg_id only (chat_id still unknown)
        if cached is None:
            cached = cache_lookup_by_message_id(msg_id)
            if cached:
                resolved_chat_id = cached.get("chat_id") or resolved_chat_id
                print(f"[DEL] msg_id={msg_id} — DB cache (by msg_id) chat_id={resolved_chat_id} ✓")

        # 5) message_events DB dan qidirish — cache'da umuman bo'lmagan xabarlar uchun
        if cached is None:
            cached = find_original_message(msg_id, str(resolved_chat_id) if resolved_chat_id else None)
            if cached:
                resolved_chat_id = cached.get("chat_id") or resolved_chat_id
                print(f"[DEL] msg_id={msg_id} — message_events DB dan topildi chat_id={resolved_chat_id} ✓")

        cached = cached or {}

        original_created_at = cached.get("created_at")
        time_to_delete = None
        if original_created_at:
            try:
                delta = (deleted_at - original_created_at).total_seconds()
                time_to_delete = max(0, int(delta))
            except Exception:
                pass

        save_event({
            "event_type":   "deleted_message",
            "chat_id":      resolved_chat_id,
            "chat_title":   cached.get("chat_title"),
            "message_id":   msg_id,
            "sender_id":       cached.get("sender_id"),
            "sender_name":     cached.get("sender_name"),
            "sender_username": cached.get("sender_username"),
            "original_text":            cached.get("text"),
            "original_sender_id":       cached.get("sender_id"),
            "original_sender_name":     cached.get("sender_name"),
            "original_sender_username": cached.get("sender_username"),
            "original_media_type":      cached.get("media_type"),
            "original_media_path":      cached.get("media_path"),
            "original_created_at":      original_created_at,
            "time_to_delete":           time_to_delete,
            "deleted_ids": [msg_id],
            "telegram_link": cached.get("telegram_link"),
            "severity": "alarm",
        })

        print(f"[DEL] msg_id={msg_id} | chat={resolved_chat_id} | user={cached.get('sender_name')} "
              f"| text={str(cached.get('text',''))[:40]!r} | after={time_to_delete}s")

    if not deleted_ids:
        save_event({
            "event_type": "deleted_message",
            "chat_id":    event_chat_id,
            "deleted_ids": deleted_ids,
            "severity":   "alarm",
        })


async def main():
    init_db()
    migrate_db()     # Mavjud DB ga yangi ustunlar qo'shadi (idempotent)
    cache_cleanup()  # Eski cache yozuvlarini tozalash

    await client.start(phone=PHONE)

    print("Userbot started...")

    await client.run_until_disconnected()



if __name__ == "__main__":
    asyncio.run(main())