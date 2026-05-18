import os
from datetime import datetime, timedelta
from pathlib import Path
from sqlalchemy import (
    create_engine,
    Column,
    Integer,
    String,
    Text,
    DateTime,
    JSON,
)
from sqlalchemy.orm import declarative_base, sessionmaker
from datetime import datetime

DB_PATH = os.getenv("DB_PATH", "data/telegram_monitor.db")

Path("data").mkdir(exist_ok=True)

engine = create_engine(f"sqlite:///{DB_PATH}", echo=False)
SessionLocal = sessionmaker(bind=engine)

Base = declarative_base()


class MessageEvent(Base):
    __tablename__ = "message_events"

    id = Column(Integer, primary_key=True)
    event_type = Column(String, index=True)
    sender_username = Column(String)

    chat_id = Column(String, index=True)
    chat_title = Column(String)

    message_id = Column(Integer, index=True)

    sender_id = Column(String)
    sender_name = Column(String)

    text = Column(Text)
    old_text = Column(Text)
    new_text = Column(Text)

    media_type = Column(String)
    media_path = Column(String)

    deleted_ids = Column(JSON)
    missing_ids = Column(JSON)

    telegram_link = Column(String)

    severity = Column(String, default="info")

    created_at = Column(
        DateTime,
        default=lambda: datetime.utcnow() + timedelta(hours=5)
    )

    is_forwarded = Column(Integer, default=0)
    forward_from_name = Column(String)
    forward_from_chat_id = Column(String)
    forward_from_chat_title = Column(String)

    # ── Deleted message uchun original ma'lumotlar ───────────────────────────
    # deleted_message eventida cache dan olinib to'g'ridan-to'g'ri saqlanadi.
    # DB JOIN kerak emas — tezroq va ishonchli.
    original_text            = Column(Text)
    original_sender_id       = Column(String)
    original_sender_name     = Column(String)
    original_sender_username = Column(String)
    original_media_type      = Column(String)
    original_media_path      = Column(String)
    original_created_at      = Column(DateTime)   # xabar yuborilgan vaqt
    time_to_delete           = Column(Integer)    # soniya: yuborildi → o'chirildi


class MessageCacheEntry(Base):
    """
    Persistent message cache — restart bo'lsa ham yo'qolmaydi.
    Har new_message da yoziladi, deleted_message da o'qiladi.
    Oxirgi CACHE_TTL_DAYS kundan eskilari avtomatik tozalanadi.
    """
    __tablename__ = "message_cache"

    id               = Column(Integer, primary_key=True)
    chat_id          = Column(String, index=True, nullable=False)
    message_id       = Column(Integer, index=True, nullable=False)

    sender_id        = Column(String)
    sender_name      = Column(String)
    sender_username  = Column(String)
    chat_title       = Column(String)

    text             = Column(Text)
    media_type       = Column(String)
    media_path       = Column(String)
    telegram_link    = Column(String)

    created_at       = Column(DateTime, default=datetime.utcnow)
    updated_at       = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

    __table_args__ = (
        # Bir xil (chat_id, message_id) bo'lmasin
        __import__('sqlalchemy').UniqueConstraint('chat_id', 'message_id', name='uq_cache_chat_msg'),
    )


class KeywordAlert(Base):
    """
    Admin tomonidan qo'shilgan kuzatuv so'zlari.
    .env dagi KEYWORD_ALERTS fallback sifatida qoladi —
    DB bo'sh bo'lsa .env dan o'qiladi.
    """
    __tablename__ = "keyword_alerts"

    id         = Column(Integer, primary_key=True)
    keyword    = Column(String, unique=True, nullable=False, index=True)
    created_by = Column(String, nullable=False)
    created_at = Column(DateTime, default=datetime.utcnow)
    is_active  = Column(Integer, default=1)  # 0 = soft delete


def init_db():
    Base.metadata.create_all(bind=engine)


def save_event(data: dict):
    db = SessionLocal()


    event = MessageEvent(
        event_type=data.get("event_type"),
        chat_id=str(data.get("chat_id")),
        chat_title=data.get("chat_title"),
        message_id=data.get("message_id"),
        sender_id=str(data.get("sender_id")) if data.get("sender_id") else None,
        sender_name=data.get("sender_name"),
        sender_username=data.get("sender_username"),
        text=data.get("text"),
        old_text=data.get("old_text"),
        new_text=data.get("new_text"),
        media_type=data.get("media_type"),
        media_path=data.get("media_path"),
        deleted_ids=data.get("deleted_ids"),
        missing_ids=data.get("missing_ids"),
        telegram_link=data.get("telegram_link"),
        severity=data.get("severity", "info"),
        is_forwarded=1 if data.get("is_forwarded") else 0,
        forward_from_name=data.get("forward_from_name"),
        forward_from_chat_id=str(data.get("forward_from_chat_id")) if data.get("forward_from_chat_id") else None,
        forward_from_chat_title=data.get("forward_from_chat_title"),
        # original_* fieldlar
        original_text=data.get("original_text"),
        original_sender_id=str(data.get("original_sender_id")) if data.get("original_sender_id") else None,
        original_sender_name=data.get("original_sender_name"),
        original_sender_username=data.get("original_sender_username"),
        original_media_type=data.get("original_media_type"),
        original_media_path=data.get("original_media_path"),
        original_created_at=data.get("original_created_at"),
        time_to_delete=data.get("time_to_delete"),
    )

    db.add(event)
    db.commit()
    db.close()

CACHE_TTL_DAYS = int(os.getenv("CACHE_TTL_DAYS", "7"))


def cache_upsert(data: dict):
    """
    Xabar cache ga yozish yoki yangilash (upsert).
    new_message va media_download eventlarida chaqiriladi.
    """
    db = SessionLocal()
    try:
        existing = db.query(MessageCacheEntry).filter(
            MessageCacheEntry.chat_id   == str(data["chat_id"]),
            MessageCacheEntry.message_id == int(data["message_id"]),
        ).first()

        if existing:
            # Mavjud yozuvni yangilash (media_path kelishi kechikishi mumkin)
            for field in ("text", "media_type", "media_path", "sender_name",
                          "sender_username", "sender_id", "chat_title", "telegram_link"):
                val = data.get(field)
                if val is not None:
                    setattr(existing, field, val)
            existing.updated_at = datetime.utcnow()
        else:
            entry = MessageCacheEntry(
                chat_id       = str(data["chat_id"]),
                message_id    = int(data["message_id"]),
                sender_id     = str(data["sender_id"]) if data.get("sender_id") else None,
                sender_name   = data.get("sender_name"),
                sender_username = data.get("sender_username"),
                chat_title    = data.get("chat_title"),
                text          = data.get("text"),
                media_type    = data.get("media_type"),
                media_path    = data.get("media_path"),
                telegram_link = data.get("telegram_link"),
                created_at    = data.get("created_at") or datetime.utcnow(),
            )
            db.add(entry)

        db.commit()
    except Exception as e:
        db.rollback()
        print(f"[cache_upsert] error: {e}")
    finally:
        db.close()


def _entry_to_dict(entry) -> dict:
    return {
        "chat_id":         entry.chat_id,
        "sender_id":       entry.sender_id,
        "sender_name":     entry.sender_name,
        "sender_username": entry.sender_username,
        "chat_title":      entry.chat_title,
        "text":            entry.text,
        "media_type":      entry.media_type,
        "media_path":      entry.media_path,
        "telegram_link":   entry.telegram_link,
        "created_at":      entry.created_at,
    }


def cache_lookup(chat_id: str, message_id: int) -> dict | None:
    """Exact lookup by (chat_id, message_id)."""
    db = SessionLocal()
    try:
        entry = db.query(MessageCacheEntry).filter(
            MessageCacheEntry.chat_id    == str(chat_id),
            MessageCacheEntry.message_id == int(message_id),
        ).first()
        return _entry_to_dict(entry) if entry else None
    finally:
        db.close()


def cache_lookup_by_message_id(message_id: int) -> dict | None:
    """Fallback lookup by message_id alone — used when chat_id is None (regular group deletes)."""
    db = SessionLocal()
    try:
        entry = db.query(MessageCacheEntry).filter(
            MessageCacheEntry.message_id == int(message_id),
        ).order_by(MessageCacheEntry.created_at.desc()).first()
        return _entry_to_dict(entry) if entry else None
    finally:
        db.close()


def find_original_message(message_id: int, chat_id: str | None = None) -> dict | None:
    """
    Last-resort fallback: search message_events table for the original new_message.
    Works even if the message was never in cache (bot added after message was sent).
    """
    db = SessionLocal()
    try:
        q = db.query(MessageEvent).filter(
            MessageEvent.message_id == int(message_id),
            MessageEvent.event_type == "new_message",
        )
        if chat_id:
            q = q.filter(MessageEvent.chat_id == str(chat_id))
        row = q.order_by(MessageEvent.created_at.asc()).first()
        if not row:
            return None
        return {
            "chat_id":         row.chat_id,
            "sender_id":       row.sender_id,
            "sender_name":     row.sender_name,
            "sender_username": row.sender_username,
            "chat_title":      row.chat_title,
            "text":            row.text,
            "media_type":      row.media_type,
            "media_path":      row.media_path,
            "telegram_link":   row.telegram_link,
            "created_at":      row.created_at,
        }
    finally:
        db.close()


def cache_cleanup():
    """
    CACHE_TTL_DAYS kundan eski yozuvlarni o'chirish.
    Server startup da va kuniga bir marta chaqiriladi.
    """
    db = SessionLocal()
    try:
        cutoff = datetime.utcnow() - __import__('datetime').timedelta(days=CACHE_TTL_DAYS)
        deleted = db.query(MessageCacheEntry).filter(
            MessageCacheEntry.created_at < cutoff
        ).delete()
        db.commit()
        if deleted:
            print(f"  ✓ Cache cleanup: {deleted} eski yozuv o'chirildi")
    except Exception as e:
        db.rollback()
        print(f"[cache_cleanup] error: {e}")
    finally:
        db.close()


def migrate_db():
    """
    Mavjud DB ga yangi ustunlar qo'shish (agar yo'q bo'lsa).
    init_db() dan keyin chaqiriladi.
    SQLite ALTER TABLE faqat ustun qo'shishni qo'llab-quvvatlaydi.
    """
    from sqlalchemy import text, inspect

    inspector = inspect(engine)
    existing = {col["name"] for col in inspector.get_columns("message_events")}

    new_columns = [
        ("original_text",            "TEXT"),
        ("original_sender_id",       "VARCHAR"),
        ("original_sender_name",     "VARCHAR"),
        ("original_sender_username", "VARCHAR"),
        ("original_media_type",      "VARCHAR"),
        ("original_media_path",      "VARCHAR"),
        ("original_created_at",      "DATETIME"),
        ("time_to_delete",           "INTEGER"),
    ]

    with engine.connect() as conn:
        for col_name, col_type in new_columns:
            if col_name not in existing:
                conn.execute(text(f"ALTER TABLE message_events ADD COLUMN {col_name} {col_type}"))
                print(f"  ✓ Added column: {col_name}")
        conn.commit()