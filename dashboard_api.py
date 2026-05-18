import os
import re
import secrets
import threading
from collections import Counter, defaultdict
from datetime import datetime, timedelta
from typing import Optional, List, Generator, Any, Tuple

from cachetools import TTLCache

from fastapi import Depends, FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from fastapi.staticfiles import StaticFiles
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel

from sqlalchemy import create_engine, func, case
from sqlalchemy.orm import sessionmaker, Session

from database import MessageEvent, KeywordAlert, MessageCacheEntry, DB_PATH, init_db, migrate_db, cache_cleanup

app = FastAPI()

@app.on_event("startup")
def on_startup():
    """Server start bo'lganda DB yaratiladi, migration va cache cleanup ishlaydi."""
    import threading

    try:
        init_db()        # barcha tablelarni yaratadi
        migrate_db()     # message_events ga yangi ustunlar
        cache_cleanup()  # eski cache yozuvlarni tozalash
        print("✓ DB init + migration + cache cleanup OK")
    except Exception as e:
        print(f"⚠ DB startup warning: {e}")

    # Har 24 soatda cache cleanup (background thread)
    def daily_cleanup():
        import time
        while True:
            time.sleep(86400)  # 24 soat
            try:
                cache_cleanup()
            except Exception as ex:
                print(f"[daily_cleanup] {ex}")

    t = threading.Thread(target=daily_cleanup, daemon=True)
    t.start()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/media", StaticFiles(directory="media"), name="media")

engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
    pool_pre_ping=True,
)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


# ─── DB Dependency ────────────────────────────────────────────────────────────
def get_db() -> Generator:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ─── In-memory TTL Cache ─────────────────────────────────────────────────────
# maxsize=256 — bir vaqtda 256 ta unikal (endpoint, date, chat_id) kombinatsiya
# ttl=120     — 2 daqiqa: yangi ma'lumot kelsa nisbatan tez yangilanadi
# thread-safe: TTLCache o'zi thread-safe emas, shuning uchun Lock ishlatamiz

_cache: TTLCache = TTLCache(maxsize=256, ttl=int(os.getenv("CACHE_TTL_SECONDS", "120")))
_cache_lock = threading.Lock()


def cache_get(key: Tuple) -> Any:
    with _cache_lock:
        return _cache.get(key)


def cache_set(key: Tuple, value: Any) -> None:
    with _cache_lock:
        _cache[key] = value


def cache_invalidate_date(date: str) -> None:
    """Berilgan sana uchun barcha cache yozuvlarini o'chirish.
    Yangi event kelganda chaqiriladi — hozircha manual, keyinchalik webhook bilan."""
    with _cache_lock:
        keys_to_del = [k for k in list(_cache.keys()) if isinstance(k, tuple) and date in k]
        for k in keys_to_del:
            _cache.pop(k, None)


# ─── JWT Config ───────────────────────────────────────────────────────────────
# .env da SECRET_KEY o'rnatish SHART — ishlatmasdan oldin o'zgartiring!
# Generatsiya: python -c "import secrets; print(secrets.token_hex(32))"
SECRET_KEY      = os.getenv("JWT_SECRET_KEY", secrets.token_hex(32))
ALGORITHM       = "HS256"
# Token muddati — .env da JWT_EXPIRE_MINUTES=480 (8 soat) kabi o'rnatish mumkin
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", "60"))

pwd_context    = CryptContext(schemes=["sha256_crypt"], deprecated="auto")
oauth2_scheme  = OAuth2PasswordBearer(tokenUrl="/auth/login")


# ─── Users config ─────────────────────────────────────────────────────────────
# Parollar bcrypt hash sifatida saqlansa xavfsizroq.
# Agar plain-text bo'lsa, birinchi login da avtomatik hash qilinadi (quyida).
# .env: ADMIN_PASSWORD=mypassword  — ishlatilsa hash avtomatik hosil qilinadi.
def _make_user(username_env: str, password_env: str, default_user: str, default_pass: str, role: str) -> dict:
    username = os.getenv(username_env, default_user)
    raw_pass = os.getenv(password_env, default_pass)
    # Agar hash bo'lmasa (bcrypt hashi $2b$ bilan boshlanadi) — hash qilib saqlaymiz
    hashed = raw_pass if raw_pass.startswith("$2b$") else pwd_context.hash(raw_pass)
    return {"username": username, "hashed_password": hashed, "role": role}


USERS: dict = {
    u["username"]: u
    for u in [
        _make_user("ADMIN_USERNAME",    "ADMIN_PASSWORD",    "admin",    "admin123",    "admin"),
        _make_user("ANALYTIC_USERNAME", "ANALYTIC_PASSWORD", "analytic", "analytic123", "analytic"),
        _make_user("USER_USERNAME",     "USER_PASSWORD",     "user",     "user123",     "user"),
    ]
}

USER_ALLOWED_CHATS = set(
    c.strip() for c in os.getenv("USER_ALLOWED_CHATS", "").split(",") if c.strip()
)

# .env dagi fallback — DB bo'sh bo'lganda ishlatiladi
_KW_ENV_FALLBACK = [
    k.strip().lower()
    for k in os.getenv("KEYWORD_ALERTS", "scam,spam,btc,warning,raid,drop,hack,fraud,ban").split(",")
    if k.strip()
]


def get_active_keywords(db: Session) -> list[str]:
    """DB dan aktiv keywordlarni o'qiydi. Bo'sh bo'lsa .env fallback."""
    rows = db.query(KeywordAlert).filter(KeywordAlert.is_active == 1).all()
    if rows:
        return [r.keyword for r in rows]
    return _KW_ENV_FALLBACK


# Backwards compat uchun — cached endpoint va check_keyword_alert uchun
# (DB connection yo'q joylar uchun fallback list)
KEYWORD_ALERTS: list[str] = _KW_ENV_FALLBACK


# ─── Token helpers ────────────────────────────────────────────────────────────
class Token(BaseModel):
    access_token: str
    token_type: str
    expires_in: int   # soniya
    role: str
    username: str


def create_access_token(data: dict) -> str:
    payload = data.copy()
    payload["exp"] = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    payload["iat"] = datetime.utcnow()
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


# ─── Auth dependency ──────────────────────────────────────────────────────────
def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    credentials_exception = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Token noto'g'ri yoki muddati tugagan",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if not username:
            raise credentials_exception
    except JWTError:
        raise credentials_exception

    user = USERS.get(username)
    if not user:
        raise credentials_exception

    return {"username": username, "role": user["role"]}


def require_analytic(cu=Depends(get_current_user)):
    if cu["role"] not in ("admin", "analytic"):
        raise HTTPException(status_code=403, detail="Analytic/Admin roli talab qilinadi")
    return cu


# ─── Login endpoint ───────────────────────────────────────────────────────────
@app.post("/auth/login", response_model=Token)
def login(form_data: OAuth2PasswordRequestForm = Depends()):
    """
    Username + password → JWT access token qaytaradi.
    Frontend bu tokenni localStorage da saqlaydi va keyingi
    barcha so'rovlarda  Authorization: Bearer <token>  header bilan yuboradi.
    """
    user = USERS.get(form_data.username)
    if not user or not verify_password(form_data.password, user["hashed_password"]):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Login yoki parol noto'g'ri",
            headers={"WWW-Authenticate": "Bearer"},
        )
    token = create_access_token({"sub": user["username"], "role": user["role"]})
    return Token(
        access_token=token,
        token_type="bearer",
        expires_in=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        role=user["role"],
        username=user["username"],
    )


@app.post("/auth/refresh", response_model=Token)
def refresh_token(cu=Depends(get_current_user)):
    """
    Hali muddati tugamagan token bilan yangi token olish.
    Frontend tokenExpiry ga 5 daqiqa qolganida avtomatik chaqiradi.
    """
    token = create_access_token({"sub": cu["username"], "role": cu["role"]})
    return Token(
        access_token=token,
        token_type="bearer",
        expires_in=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        role=cu["role"],
        username=cu["username"],
    )


# ─── Helpers ──────────────────────────────────────────────────────────────────
LINK_PATTERNS = {
    "telegram":  r"t\.me/[^\s]+",
    "youtube":   r"(?:youtube\.com|youtu\.be)/[^\s]+",
    "instagram": r"instagram\.com/[^\s]+",
    "twitter":   r"(?:twitter\.com|x\.com)/[^\s]+",
    "crypto":    r"(?:binance\.com|coinbase\.com|bybit\.com|okx\.com|ton\.org)/[^\s]+",
}
MENTION_RE = re.compile(r"@([A-Za-z0-9_]{3,32})")
STOPWORDS = {
    "va","bu","bilan","ham","emas","lekin","agar","chunki","yoki","men","sen","u","biz","siz","ular","bir","ikki",
    "the","a","an","is","it","in","on","at","to","of","and","or","but","for","not","be","was","are","with",
    "this","that","have","from","by","as","do","i","you","he","she","we","they","what","so","if","its","my",
}


def extract_links(text: str) -> dict:
    if not text:
        return {}
    return {
        cat: matches
        for cat, pattern in LINK_PATTERNS.items()
        if (matches := re.findall(pattern, text, re.IGNORECASE))
    }


def extract_phrases(text: str) -> List[str]:
    if not text:
        return []
    clean = re.sub(r"[^\w\s]", " ", text.lower())
    words = [w for w in clean.split() if len(w) >= 3 and w not in STOPWORDS]
    return [
        " ".join(words[i:i+n])
        for n in range(2, min(5, len(words) + 1))
        for i in range(len(words) - n + 1)
    ]


def check_keyword_alert(text: str, keywords: list[str] | None = None) -> List[str]:
    """keywords berilmasa global KEYWORD_ALERTS ishlatadi.
    DB ga kirish mumkin bo'lgan joylarda get_active_keywords(db) bering."""
    if not text:
        return []
    kws = keywords if keywords is not None else KEYWORD_ALERTS
    low = text.lower()
    return [kw for kw in kws if kw in low]


# ─── Cache management endpoints ──────────────────────────────────────────────
@app.delete("/cache/invalidate")
def invalidate_cache(date: str, cu=Depends(require_analytic)):
    """Admin/Analytic: berilgan kun uchun cache ni tozalash."""
    cache_invalidate_date(date)
    return {"invalidated": True, "date": date}


@app.get("/cache/stats")
def cache_stats(cu=Depends(require_analytic)):
    """Cache holati: nechta yozuv, TTL, limit."""
    with _cache_lock:
        return {
            "current_size": len(_cache),
            "maxsize": _cache.maxsize,
            "ttl_seconds": _cache.ttl,
            "keys": [str(k) for k in list(_cache.keys())[:20]],
        }


# ─── Keyword management endpoints ────────────────────────────────────────────

@app.get("/keywords")
def list_keywords(
    db: Session = Depends(get_db),
    cu=Depends(get_current_user),
):
    """Barcha aktiv + o'chirilgan keywordlar ro'yxati."""
    rows = db.query(KeywordAlert).order_by(KeywordAlert.created_at.desc()).all()
    # DB bo'sh bo'lsa — .env fallback ni ko'rsatamiz
    if not rows:
        return {
            "source": "env_fallback",
            "keywords": [
                {"id": None, "keyword": kw, "is_active": 1,
                 "created_by": "env", "created_at": None}
                for kw in _KW_ENV_FALLBACK
            ],
        }
    return {
        "source": "database",
        "keywords": [
            {"id": r.id, "keyword": r.keyword, "is_active": r.is_active,
             "created_by": r.created_by,
             "created_at": r.created_at.isoformat() if r.created_at else None}
            for r in rows
        ],
    }


@app.post("/keywords")
def add_keyword(
    keyword: str,
    db: Session = Depends(get_db),
    cu=Depends(require_analytic),
):
    """Yangi keyword qo'shish. Faqat admin/analytic."""
    kw = keyword.strip().lower()
    if not kw or len(kw) < 2:
        raise HTTPException(status_code=400, detail="Keyword kamida 2 ta harf bo'lishi kerak")
    if len(kw) > 50:
        raise HTTPException(status_code=400, detail="Keyword 50 ta harfdan oshmasin")

    existing = db.query(KeywordAlert).filter(KeywordAlert.keyword == kw).first()
    if existing:
        if existing.is_active:
            raise HTTPException(status_code=409, detail=f"'{kw}' allaqachon mavjud")
        # O'chirilgan bo'lsa — qayta faollashtirish
        existing.is_active = 1
        existing.created_by = cu["username"]
        db.commit()
        # Cache yangilash — keyword o'zgarganda eski natijalar noto'g'ri bo'ladi
        with _cache_lock:
            keys_to_del = [k for k in list(_cache.keys())
                           if isinstance(k, tuple) and k[0] in ("keyword_alerts",)]
            for k in keys_to_del:
                _cache.pop(k, None)
        return {"action": "reactivated", "keyword": kw, "id": existing.id}

    row = KeywordAlert(keyword=kw, created_by=cu["username"])
    db.add(row)
    db.commit()
    db.refresh(row)

    # Cache ni tozalaymiz
    with _cache_lock:
        keys_to_del = [k for k in list(_cache.keys())
                       if isinstance(k, tuple) and k[0] in ("keyword_alerts",)]
        for k in keys_to_del:
            _cache.pop(k, None)

    return {"action": "created", "keyword": kw, "id": row.id}


@app.delete("/keywords/{keyword_id}")
def delete_keyword(
    keyword_id: int,
    db: Session = Depends(get_db),
    cu=Depends(require_analytic),
):
    """Keywordni o'chirish (soft delete — DB dan o'chmaydi)."""
    row = db.query(KeywordAlert).filter(KeywordAlert.id == keyword_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Keyword topilmadi")
    row.is_active = 0
    db.commit()

    with _cache_lock:
        keys_to_del = [k for k in list(_cache.keys())
                       if isinstance(k, tuple) and k[0] in ("keyword_alerts",)]
        for k in keys_to_del:
            _cache.pop(k, None)

    return {"action": "deleted", "keyword": row.keyword}


@app.post("/keywords/seed-from-env")
def seed_keywords_from_env(
    db: Session = Depends(get_db),
    cu=Depends(require_analytic),
):
    """
    .env dagi KEYWORD_ALERTS ni DB ga ko'chirish.
    Bir martalik migration uchun.
    """
    added = []
    for kw in _KW_ENV_FALLBACK:
        existing = db.query(KeywordAlert).filter(KeywordAlert.keyword == kw).first()
        if not existing:
            db.add(KeywordAlert(keyword=kw, created_by=cu["username"]))
            added.append(kw)
    db.commit()
    return {"seeded": added, "total": len(added)}


# ─── Base endpoints ───────────────────────────────────────────────────────────
@app.get("/deleted-feed")
def deleted_feed(
    date: str,
    chat_id: Optional[str] = None,
    speed: Optional[str] = None,   # "quick"(<10s), "fast"(<1min), "slow"(>1min)
    sender: Optional[str] = None,  # username yoki name filter
    limit: int = 100,
    db: Session = Depends(get_db),
    cu=Depends(get_current_user),
):
    """
    Barcha chatlar bo'yicha o'chirilgan xabarlar feed i.
    original_* fieldlar to'g'ridan-to'g'ri DB dan o'qiladi.
    """
    q = db.query(MessageEvent).filter(
        func.date(MessageEvent.created_at) == date,
        MessageEvent.event_type == "deleted_message",
        MessageEvent.message_id.isnot(None),
    )

    if cu["role"] == "user" and USER_ALLOWED_CHATS:
        q = q.filter(MessageEvent.chat_id.in_(USER_ALLOWED_CHATS))

    if chat_id:
        q = q.filter(MessageEvent.chat_id == chat_id)

    if sender:
        s = f"%{sender.lower()}%"
        q = q.filter(
            (func.lower(MessageEvent.original_sender_username).like(s)) |
            (func.lower(MessageEvent.original_sender_name).like(s))
        )

    rows = q.order_by(MessageEvent.created_at.desc()).limit(limit).all()

    result = []
    for e in rows:
        # Speed filter
        ttd = e.time_to_delete
        if speed == "quick"  and (ttd is None or ttd >= 10):   continue
        if speed == "fast"   and (ttd is None or ttd >= 60):   continue
        if speed == "slow"   and (ttd is not None and ttd < 60): continue

        # Agar original_* bo'sh bo'lsa — eski JOIN usuli
        orig_text   = e.original_text
        orig_mtype  = e.original_media_type
        orig_mpath  = e.original_media_path
        orig_sender_name = e.original_sender_name
        orig_sender_uname = e.original_sender_username
        orig_created_at = e.original_created_at

        if not orig_text and not orig_mtype:
            # Fallback: DB dan qidirish
            original = db.query(MessageEvent).filter(
                MessageEvent.chat_id    == e.chat_id,
                MessageEvent.message_id == e.message_id,
                MessageEvent.event_type == "new_message",
            ).first()
            if original:
                orig_text        = original.text
                orig_mtype       = original.media_type
                orig_mpath       = original.media_path
                orig_sender_name = original.sender_name
                orig_sender_uname= original.sender_username
                orig_created_at  = original.created_at

        result.append({
            "id":          e.id,
            "message_id":  e.message_id,
            "chat_id":     e.chat_id,
            "chat_title":  e.chat_title,
            "deleted_at":  str(e.created_at),

            # Kim o'chirdi (delete event da sender)
            "deleted_by_name":     e.sender_name,
            "deleted_by_username": e.sender_username,

            # Original xabar ma'lumotlari
            "original_text":            orig_text,
            "original_sender_name":     orig_sender_name,
            "original_sender_username": orig_sender_uname,
            "original_media_type":      orig_mtype,
            "original_media_path":      orig_mpath,
            "original_created_at":      str(orig_created_at) if orig_created_at else None,

            # O'chirish tezligi
            "time_to_delete":   ttd,
            "speed_label":      (
                "⚡ quick (<10s)"  if ttd is not None and ttd < 10   else
                "🔴 fast (<1min)"  if ttd is not None and ttd < 60   else
                "🟡 normal (<5min)"if ttd is not None and ttd < 300  else
                "🟢 slow (>5min)"  if ttd is not None               else
                "❓ unknown"
            ),

            "telegram_link":   e.telegram_link,
            "keyword_alerts":  check_keyword_alert(orig_text or ""),
        })

    # Stats
    total = len(result)
    quick = sum(1 for r in result if r["time_to_delete"] is not None and r["time_to_delete"] < 10)
    fast  = sum(1 for r in result if r["time_to_delete"] is not None and 10 <= r["time_to_delete"] < 60)
    with_text  = sum(1 for r in result if r["original_text"])
    with_media = sum(1 for r in result if r["original_media_type"])
    no_info    = sum(1 for r in result if not r["original_text"] and not r["original_media_type"])

    return {
        "date":   date,
        "total":  total,
        "stats": {
            "quick_deletes":  quick,
            "fast_deletes":   fast,
            "with_text":      with_text,
            "with_media":     with_media,
            "no_info":        no_info,     # cache da bo'lmagan (restart oldin)
        },
        "events": result,
    }


@app.get("/message-lookup")
def message_lookup(
    chat_id: str,
    message_id: int,
    db: Session = Depends(get_db),
    cu=Depends(get_current_user),
):
    """
    Bitta xabar haqida to'liq ma'lumot — cache + DB dan.
    Deleted feed dagi "ma'lumot yo'q" xabarlar uchun ishlatiladi.
    """
    # 1) Persistent cache dan qidirish (eng tez)
    cached = db.query(MessageCacheEntry).filter(
        MessageCacheEntry.chat_id    == str(chat_id),
        MessageCacheEntry.message_id == int(message_id),
    ).first()

    if cached:
        return {
            "source":          "cache",
            "chat_id":         cached.chat_id,
            "message_id":      cached.message_id,
            "sender_name":     cached.sender_name,
            "sender_username": cached.sender_username,
            "chat_title":      cached.chat_title,
            "text":            cached.text,
            "media_type":      cached.media_type,
            "media_path":      cached.media_path,
            "telegram_link":   cached.telegram_link,
            "created_at":      str(cached.created_at) if cached.created_at else None,
        }

    # 2) message_events dan new_message qidirish (eski yozuvlar)
    original = db.query(MessageEvent).filter(
        MessageEvent.chat_id    == str(chat_id),
        MessageEvent.message_id == int(message_id),
        MessageEvent.event_type == "new_message",
    ).order_by(MessageEvent.created_at.asc()).first()

    if original:
        # media_download eventdan media_path olish
        media_ev = db.query(MessageEvent).filter(
            MessageEvent.chat_id    == str(chat_id),
            MessageEvent.message_id == int(message_id),
            MessageEvent.event_type == "media_download",
        ).first()

        return {
            "source":          "events_db",
            "chat_id":         original.chat_id,
            "message_id":      original.message_id,
            "sender_name":     original.sender_name,
            "sender_username": original.sender_username,
            "chat_title":      original.chat_title,
            "text":            original.text,
            "media_type":      media_ev.media_type if media_ev else original.media_type,
            "media_path":      media_ev.media_path if media_ev else original.media_path,
            "telegram_link":   original.telegram_link,
            "created_at":      str(original.created_at) if original.created_at else None,
        }

    # 3) Topilmadi
    return {
        "source":     "not_found",
        "chat_id":    chat_id,
        "message_id": message_id,
        "text":       None,
        "media_path": None,
    }


@app.get("/cache/size")
def cache_size(db: Session = Depends(get_db), cu=Depends(require_analytic)):
    """Persistent cache statistikasi."""
    total = db.query(MessageCacheEntry).count()
    with_text  = db.query(MessageCacheEntry).filter(MessageCacheEntry.text.isnot(None)).count()
    with_media = db.query(MessageCacheEntry).filter(MessageCacheEntry.media_path.isnot(None)).count()
    return {
        "total_cached":  total,
        "with_text":     with_text,
        "with_media":    with_media,
        "without_info":  total - with_text - with_media,
    }


@app.get("/")
def home():
    return {"status": "running"}


@app.get("/me")
def get_me(cu=Depends(get_current_user)):
    return {"username": cu["username"], "role": cu["role"]}


@app.get("/days")
def get_days(
    db: Session = Depends(get_db),
    cu=Depends(get_current_user),
):
    days = (
        db.query(func.date(MessageEvent.created_at))
        .distinct()
        .order_by(func.date(MessageEvent.created_at).desc())
        .all()
    )
    return {"days": [d[0] for d in days]}


@app.get("/day-summary")
def day_summary(
    date: str,
    db: Session = Depends(get_db),
    cu=Depends(get_current_user),
):
    q = db.query(MessageEvent).filter(func.date(MessageEvent.created_at) == date)
    if cu["role"] == "user" and USER_ALLOWED_CHATS:
        q = q.filter(MessageEvent.chat_id.in_(USER_ALLOWED_CHATS))
    total   = q.count()
    edited  = q.filter(MessageEvent.event_type == "edited_message").count()
    deleted = q.filter(MessageEvent.event_type == "deleted_message").count()
    missing = q.filter(MessageEvent.event_type == "missing_ids").count()
    return {"date": date, "total": total, "edited": edited, "deleted": deleted, "missing": missing}


@app.get("/groups-summary")
def groups_summary(
    date: str,
    db: Session = Depends(get_db),
    cu=Depends(get_current_user),
):
    q = db.query(
        MessageEvent.chat_id,
        MessageEvent.chat_title,
        func.count(MessageEvent.id).label("total"),
        func.sum(case((MessageEvent.event_type == "edited_message",  1), else_=0)).label("edited"),
        func.sum(case((MessageEvent.event_type == "deleted_message", 1), else_=0)).label("deleted"),
        func.sum(case((MessageEvent.event_type == "missing_ids",     1), else_=0)).label("missing"),
    ).filter(func.date(MessageEvent.created_at) == date)
    if cu["role"] == "user" and USER_ALLOWED_CHATS:
        q = q.filter(MessageEvent.chat_id.in_(USER_ALLOWED_CHATS))
    groups = q.group_by(MessageEvent.chat_id, MessageEvent.chat_title).all()
    return [
        {"chat_id": g.chat_id, "chat_title": g.chat_title,
         "total": g.total or 0, "edited": g.edited or 0,
         "deleted": g.deleted or 0, "missing": g.missing or 0}
        for g in groups
    ]


@app.get("/events")
def get_events(
    date: str,
    chat_id: str,
    db: Session = Depends(get_db),
    cu=Depends(get_current_user),
):
    if cu["role"] == "user" and USER_ALLOWED_CHATS and chat_id not in USER_ALLOWED_CHATS:
        raise HTTPException(status_code=403, detail="Bu chatga ruxsat yo'q")

    rows = (
        db.query(MessageEvent)
        .filter(func.date(MessageEvent.created_at) == date, MessageEvent.chat_id == chat_id)
        .order_by(MessageEvent.created_at.desc())
        .all()
    )

    result = []
    for e in rows:
        original = None
        if e.event_type == "deleted_message" and e.message_id:
            original = (
                db.query(MessageEvent)
                .filter(
                    MessageEvent.chat_id == e.chat_id,
                    MessageEvent.message_id == e.message_id,
                    MessageEvent.event_type == "new_message",
                )
                .order_by(MessageEvent.created_at.asc())
                .first()
            )
        all_text = " ".join(filter(None, [e.text, e.new_text, e.old_text,
                                               e.original_text]))
        # original_* — avval DB JOIN bilan qidirilardi,
        # endi to'g'ridan-to'g'ri e.original_* dan o'qiladi (tezroq)
        # Agar yangi field yo'q bo'lsa (eski DB) — JOIN fallback
        orig_text     = e.original_text     or (original.text       if original else None)
        orig_mtype    = e.original_media_type or (original.media_type if original else None)
        orig_mpath    = e.original_media_path or (original.media_path if original else None)
        orig_sender   = e.original_sender_name or (original.sender_name if original else None)
        orig_username = e.original_sender_username or (original.sender_username if original else None)

        result.append({
            "id": e.id, "event_type": e.event_type, "message_id": e.message_id,
            "sender_name": e.sender_name, "sender_username": e.sender_username,
            "text": e.text, "old_text": e.old_text, "new_text": e.new_text,

            # Deleted original — ikki manbadan (yangi field yoki JOIN fallback)
            "deleted_original_text":           orig_text,
            "deleted_original_media_type":     orig_mtype,
            "deleted_original_media_path":     orig_mpath,
            "deleted_original_sender_name":    orig_sender,
            "deleted_original_sender_username":orig_username,
            "deleted_original_created_at":     e.original_created_at,
            "time_to_delete":                  e.time_to_delete,

            "media_type": e.media_type, "media_path": e.media_path,
            "deleted_ids": e.deleted_ids, "missing_ids": e.missing_ids,
            "telegram_link": e.telegram_link, "severity": e.severity,
            "created_at": e.created_at,
            "is_forwarded": bool(e.is_forwarded),
            "forward_from_name": e.forward_from_name,
            "forward_from_chat_id": e.forward_from_chat_id,
            "forward_from_chat_title": e.forward_from_chat_title,
            "keyword_alerts": check_keyword_alert(all_text),
        })
    return result


# ─── Analytics: Hourly ───────────────────────────────────────────────────────
@app.get("/analytics/hourly")
def analytics_hourly(
    date: str,
    db: Session = Depends(get_db),
    cu=Depends(require_analytic),
):
    rows = (
        db.query(
            func.strftime("%H", MessageEvent.created_at).label("hour"),
            MessageEvent.event_type,
            func.count(MessageEvent.id).label("count"),
        )
        .filter(func.date(MessageEvent.created_at) == date)
        .group_by("hour", MessageEvent.event_type)
        .all()
    )
    result = {
        str(h).zfill(2): {"new_message": 0, "edited_message": 0, "deleted_message": 0, "missing_ids": 0}
        for h in range(24)
    }
    for row in rows:
        if row.hour in result and row.event_type in result[row.hour]:
            result[row.hour][row.event_type] = row.count
    return [{"hour": f"{h}:00", **result[h]} for h in sorted(result.keys())]


# ─── Analytics: Weekly trend ─────────────────────────────────────────────────
@app.get("/analytics/weekly-trend")
def analytics_weekly_trend(
    db: Session = Depends(get_db),
    cu=Depends(require_analytic),
):
    rows = (
        db.query(
            func.date(MessageEvent.created_at).label("date"),
            func.count(MessageEvent.id).label("total"),
            func.sum(case((MessageEvent.event_type == "deleted_message", 1), else_=0)).label("deleted"),
            func.sum(case((MessageEvent.event_type == "edited_message",  1), else_=0)).label("edited"),
            func.sum(case((MessageEvent.event_type == "missing_ids",     1), else_=0)).label("missing"),
        )
        .group_by(func.date(MessageEvent.created_at))
        .order_by(func.date(MessageEvent.created_at).desc())
        .limit(7)
        .all()
    )
    return [
        {"date": r.date, "total": r.total or 0, "deleted": r.deleted or 0,
         "edited": r.edited or 0, "missing": r.missing or 0}
        for r in reversed(rows)
    ]


# ─── Analytics: Event distribution ──────────────────────────────────────────
@app.get("/analytics/event-distribution")
def analytics_event_distribution(
    date: str,
    db: Session = Depends(get_db),
    cu=Depends(require_analytic),
):
    rows = (
        db.query(MessageEvent.event_type, func.count(MessageEvent.id).label("count"))
        .filter(func.date(MessageEvent.created_at) == date)
        .group_by(MessageEvent.event_type)
        .all()
    )
    return [{"event_type": r.event_type, "count": r.count} for r in rows]


# ─── Analytics: Top active groups ───────────────────────────────────────────
@app.get("/analytics/top-active")
def analytics_top_active(
    date: str,
    limit: int = 10,
    db: Session = Depends(get_db),
    cu=Depends(require_analytic),
):
    groups = (
        db.query(
            MessageEvent.chat_id, MessageEvent.chat_title,
            func.count(MessageEvent.id).label("total"),
            func.sum(case((MessageEvent.event_type == "deleted_message", 1), else_=0)).label("deleted"),
            func.sum(case((MessageEvent.event_type == "edited_message",  1), else_=0)).label("edited"),
        )
        .filter(func.date(MessageEvent.created_at) == date)
        .group_by(MessageEvent.chat_id, MessageEvent.chat_title)
        .order_by(func.count(MessageEvent.id).desc())
        .limit(limit)
        .all()
    )
    return [
        {"chat_id": g.chat_id, "chat_title": g.chat_title or g.chat_id,
         "total": g.total or 0, "deleted": g.deleted or 0, "edited": g.edited or 0,
         "delete_rate": round((g.deleted or 0) / (g.total or 1) * 100, 1)}
        for g in groups
    ]


# ─── Analytics: Top senders ──────────────────────────────────────────────────
@app.get("/analytics/top-senders")
def analytics_top_senders(
    date: str,
    limit: int = 10,
    db: Session = Depends(get_db),
    cu=Depends(require_analytic),
):
    senders = (
        db.query(
            MessageEvent.sender_id, MessageEvent.sender_name, MessageEvent.sender_username,
            func.count(MessageEvent.id).label("total"),
            func.sum(case((MessageEvent.event_type == "deleted_message", 1), else_=0)).label("deleted"),
            func.sum(case((MessageEvent.event_type == "edited_message",  1), else_=0)).label("edited"),
        )
        .filter(
            func.date(MessageEvent.created_at) == date,
            MessageEvent.event_type == "new_message",
            MessageEvent.sender_name.isnot(None),
        )
        .group_by(MessageEvent.sender_id, MessageEvent.sender_name, MessageEvent.sender_username)
        .order_by(func.count(MessageEvent.id).desc())
        .limit(limit)
        .all()
    )
    return [
        {"sender_id": s.sender_id, "sender_name": s.sender_name or "Unknown",
         "sender_username": s.sender_username, "total": s.total or 0,
         "deleted": s.deleted or 0, "edited": s.edited or 0}
        for s in senders
    ]


# ─── Analytics: Edit analytics ───────────────────────────────────────────────
@app.get("/analytics/edit-analytics")
def edit_analytics(
    date: str,
    chat_id: Optional[str] = None,
    db: Session = Depends(get_db),
    cu=Depends(require_analytic),
):
    _key = ("edit_analytics", date, chat_id)
    if (cached := cache_get(_key)) is not None:
        return cached
    q = db.query(MessageEvent).filter(
        func.date(MessageEvent.created_at) == date,
        MessageEvent.event_type == "edited_message",
    )
    if chat_id:
        q = q.filter(MessageEvent.chat_id == chat_id)
    edits = q.order_by(MessageEvent.created_at.desc()).all()

    user_counts: Counter = Counter()
    msg_counts:  Counter = Counter()
    diffs = []

    for e in edits:
        key = e.sender_username or e.sender_name or str(e.sender_id) or "unknown"
        user_counts[key] += 1
        if e.message_id:
            msg_counts[e.message_id] += 1
        if (e.old_text or e.new_text) and len(diffs) < 20:
            diffs.append({
                "message_id": e.message_id, "chat_id": e.chat_id, "chat_title": e.chat_title,
                "sender_name": e.sender_name, "sender_username": e.sender_username,
                "old_text": e.old_text or "", "new_text": e.new_text or "",
                "created_at": str(e.created_at),
            })

    result = {
        "total_edits": len(edits),
        "most_edited_users":    [{"user": u, "count": c} for u, c in user_counts.most_common(10)],
        "most_edited_messages": [{"message_id": mid, "edit_count": cnt} for mid, cnt in msg_counts.most_common(10)],
        "recent_diffs": diffs,
    }
    cache_set(_key, result)
    return result


# ─── Analytics: Delete analytics ─────────────────────────────────────────────
@app.get("/analytics/delete-analytics")
def delete_analytics(
    date: str,
    chat_id: Optional[str] = None,
    db: Session = Depends(get_db),
    cu=Depends(require_analytic),
):
    _key = ("delete_analytics", date, chat_id)
    if (cached := cache_get(_key)) is not None:
        return cached
    q = db.query(MessageEvent).filter(
        func.date(MessageEvent.created_at) == date,
        MessageEvent.event_type == "deleted_message",
        MessageEvent.message_id.isnot(None),
    )
    if chat_id:
        q = q.filter(MessageEvent.chat_id == chat_id)
    deleted_events = q.all()

    buckets = {"lt_10s": 0, "lt_1min": 0, "lt_5min": 0, "lt_1h": 0, "gt_1h": 0, "unknown": 0}
    user_counts:   Counter = Counter()
    quick_samples: list    = []

    for de in deleted_events:
        ukey = de.sender_username or de.sender_name or "unknown"
        user_counts[ukey] += 1

        if not de.message_id:
            buckets["unknown"] += 1
            continue

        original = db.query(MessageEvent).filter(
            MessageEvent.chat_id    == de.chat_id,
            MessageEvent.message_id == de.message_id,
            MessageEvent.event_type == "new_message",
        ).first()

        if not original or not original.created_at or not de.created_at:
            buckets["unknown"] += 1
            continue

        try:
            def _to_dt(v):
                return v if isinstance(v, datetime) else datetime.fromisoformat(str(v))
            delta = (_to_dt(de.created_at) - _to_dt(original.created_at)).total_seconds()
        except Exception:
            buckets["unknown"] += 1
            continue

        if   delta < 0:    buckets["unknown"] += 1
        elif delta < 10:
            buckets["lt_10s"] += 1
            if len(quick_samples) < 15:
                quick_samples.append({
                    "sender_name": de.sender_name, "sender_username": de.sender_username,
                    "message_id": de.message_id, "delta_sec": round(delta, 1),
                    "text_preview": (original.text or "")[:80], "created_at": str(de.created_at),
                })
        elif delta < 60:   buckets["lt_1min"] += 1
        elif delta < 300:  buckets["lt_5min"] += 1
        elif delta < 3600: buckets["lt_1h"]   += 1
        else:              buckets["gt_1h"]   += 1

    result = {
        "total_deleted": len(deleted_events),
        "speed_buckets": buckets,
        "most_deleted_users":   [{"user": u, "count": c} for u, c in user_counts.most_common(10)],
        "quick_delete_samples": quick_samples,
    }
    cache_set(_key, result)
    return result


# ─── Analytics: Media ────────────────────────────────────────────────────────
@app.get("/analytics/media-analytics")
def media_analytics(
    date: str,
    chat_id: Optional[str] = None,
    db: Session = Depends(get_db),
    cu=Depends(require_analytic),
):
    q = db.query(MessageEvent).filter(
        func.date(MessageEvent.created_at) == date,
        MessageEvent.media_type.isnot(None),
        MessageEvent.media_path.isnot(None),
        MessageEvent.event_type == "new_message",
    )
    if chat_id:
        q = q.filter(MessageEvent.chat_id == chat_id)
    rows = q.order_by(MessageEvent.created_at.desc()).all()

    counts:  Counter = Counter()
    gallery: list    = []

    for r in rows:
        mtype = r.media_type or "other"
        if mtype == "pending":
            continue
        counts[mtype] += 1
        if len(gallery) < 60 and mtype in ("photo","gif","video","sticker","animated_sticker","video_sticker"):
            gallery.append({
                "message_id": r.message_id, "media_type": mtype, "media_path": r.media_path,
                "sender_name": r.sender_name, "sender_username": r.sender_username,
                "chat_id": r.chat_id, "chat_title": r.chat_title, "created_at": str(r.created_at),
            })

    return {"total_media": sum(counts.values()), "breakdown": dict(counts.most_common()), "gallery": gallery}


# ─── Analytics: Forwards ─────────────────────────────────────────────────────
@app.get("/analytics/forward-analytics")
def forward_analytics(
    date: str,
    chat_id: Optional[str] = None,
    db: Session = Depends(get_db),
    cu=Depends(require_analytic),
):
    q = db.query(MessageEvent).filter(
        func.date(MessageEvent.created_at) == date,
        MessageEvent.is_forwarded == 1,
    )
    if chat_id:
        q = q.filter(MessageEvent.chat_id == chat_id)
    rows = q.all()

    source_counts: Counter = Counter()
    dest_counts:   Counter = Counter()
    for r in rows:
        source = r.forward_from_chat_title or r.forward_from_name or str(r.forward_from_chat_id) or "Unknown"
        source_counts[source] += 1
        dest_counts[r.chat_title or r.chat_id or "Unknown"] += 1

    return {
        "total_forwarded":    len(rows),
        "top_sources":        [{"source": s, "count": c} for s, c in source_counts.most_common(15)],
        "top_destinations":   [{"chat": d,   "count": c} for d, c in dest_counts.most_common(10)],
    }


# ─── Analytics: Links ────────────────────────────────────────────────────────
@app.get("/analytics/link-analytics")
def link_analytics(
    date: str,
    chat_id: Optional[str] = None,
    db: Session = Depends(get_db),
    cu=Depends(require_analytic),
):
    q = db.query(MessageEvent).filter(
        func.date(MessageEvent.created_at) == date,
        MessageEvent.event_type == "new_message",
        MessageEvent.text.isnot(None),
    )
    if chat_id:
        q = q.filter(MessageEvent.chat_id == chat_id)
    rows = q.all()

    category_counts: Counter = Counter()
    all_links: dict = defaultdict(Counter)

    for r in rows:
        for cat, urls in extract_links(r.text or "").items():
            category_counts[cat] += len(urls)
            for url in urls:
                all_links[cat][url] += 1

    return {
        "category_counts":        dict(category_counts.most_common()),
        "top_links_by_category":  {
            cat: [{"url": u, "count": c} for u, c in ctr.most_common(5)]
            for cat, ctr in all_links.items()
        },
    }


# ─── Analytics: Mentions ─────────────────────────────────────────────────────
@app.get("/analytics/mention-analytics")
def mention_analytics(
    date: str,
    chat_id: Optional[str] = None,
    db: Session = Depends(get_db),
    cu=Depends(require_analytic),
):
    _key = ("mention_analytics", date, chat_id)
    if (cached := cache_get(_key)) is not None:
        return cached
    q = db.query(MessageEvent).filter(
        func.date(MessageEvent.created_at) == date,
        MessageEvent.event_type == "new_message",
        MessageEvent.text.isnot(None),
    )
    if chat_id:
        q = q.filter(MessageEvent.chat_id == chat_id)
    rows = q.all()

    mention_counts:   Counter = Counter()
    mentioner_counts: Counter = Counter()

    for r in rows:
        mentions = MENTION_RE.findall(r.text or "")
        for m in mentions:
            mention_counts[m.lower()] += 1
        if mentions:
            sender = r.sender_username or r.sender_name or "unknown"
            mentioner_counts[sender] += len(mentions)

    result = {
        "total_mentions": sum(mention_counts.values()),
        "top_mentioned":  [{"username": u, "count": c} for u, c in mention_counts.most_common(15)],
        "top_mentioners": [{"sender": s, "mention_count": c} for s, c in mentioner_counts.most_common(10)],
    }
    cache_set(_key, result)
    return result


# ─── Analytics: Keyword alerts ───────────────────────────────────────────────
@app.get("/analytics/keyword-alerts")
def keyword_alerts_endpoint(
    date: str,
    chat_id: Optional[str] = None,
    db: Session = Depends(get_db),
    cu=Depends(require_analytic),
):
    # DB dan aktiv keywordlarni olamiz
    active_keywords = get_active_keywords(db)

    q = db.query(MessageEvent).filter(
        func.date(MessageEvent.created_at) == date,
        MessageEvent.event_type == "new_message",
    )
    if chat_id:
        q = q.filter(MessageEvent.chat_id == chat_id)
    rows = q.all()

    alert_messages: list    = []
    keyword_counts: Counter = Counter()

    for r in rows:
        matched = check_keyword_alert(r.text or "", active_keywords)
        if matched:
            for kw in matched:
                keyword_counts[kw] += 1
            alert_messages.append({
                "id": r.id, "message_id": r.message_id,
                "chat_id": r.chat_id, "chat_title": r.chat_title,
                "sender_name": r.sender_name, "sender_username": r.sender_username,
                "text": r.text, "matched_keywords": matched,
                "created_at": str(r.created_at), "telegram_link": r.telegram_link,
            })

    alert_messages.sort(key=lambda x: x["created_at"], reverse=True)
    return {
        "configured_keywords": active_keywords,
        "total_alerts":        len(alert_messages),
        "keyword_counts":      dict(keyword_counts.most_common()),
        "messages":            alert_messages[:100],
    }


# ─── Analytics: Phrases ──────────────────────────────────────────────────────
@app.get("/analytics/phrase-analytics")
def phrase_analytics(
    date: str,
    chat_id: Optional[str] = None,
    db: Session = Depends(get_db),
    cu=Depends(require_analytic),
):
    _key = ("phrase", date, chat_id)
    if (cached := cache_get(_key)) is not None:
        return cached
    q = db.query(MessageEvent).filter(
        func.date(MessageEvent.created_at) == date,
        MessageEvent.event_type == "new_message",
        MessageEvent.text.isnot(None),
    )
    if chat_id:
        q = q.filter(MessageEvent.chat_id == chat_id)
    rows = q.order_by(MessageEvent.created_at.asc()).all()

    phrase_counter: Counter = Counter()
    word_counter:   Counter = Counter()
    half = len(rows) // 2
    first_half:  Counter = Counter()
    second_half: Counter = Counter()

    for i, r in enumerate(rows):
        phrases = extract_phrases(r.text or "")
        phrase_counter.update(phrases)
        words = [w for w in (r.text or "").lower().split() if len(w) >= 3 and w not in STOPWORDS]
        word_counter.update(words)
        (first_half if i < half else second_half).update(phrases)

    trending = sorted(
        [
            {"phrase": phrase, "count": count, "first_half": first_half.get(phrase, 0)}
            for phrase, count in second_half.most_common(50)
            if count > 1 and (first_half.get(phrase, 0) == 0 or count / max(first_half.get(phrase, 1), 1) > 2)
        ],
        key=lambda x: x["count"],
        reverse=True,
    )[:15]

    result = {
        "most_repeated_phrases": [{"phrase": p, "count": c} for p, c in phrase_counter.most_common(20)],
        "most_repeated_words":   [{"word": w,   "count": c} for w, c in word_counter.most_common(20)],
        "trending_today":        trending,
    }
    cache_set(_key, result)
    return result


# ─── Analytics: Timeline ─────────────────────────────────────────────────────
@app.get("/analytics/timeline")
def timeline(
    date: str,
    chat_id: str,
    db: Session = Depends(get_db),
    cu=Depends(require_analytic),
):
    if cu["role"] == "user" and USER_ALLOWED_CHATS and chat_id not in USER_ALLOWED_CHATS:
        raise HTTPException(status_code=403)

    rows = (
        db.query(MessageEvent)
        .filter(func.date(MessageEvent.created_at) == date, MessageEvent.chat_id == chat_id)
        .order_by(MessageEvent.created_at.asc())
        .all()
    )
    events = [
        {
            "id": e.id, "event_type": e.event_type, "message_id": e.message_id,
            "sender_name": e.sender_name, "sender_username": e.sender_username,
            "text": e.text, "old_text": e.old_text, "new_text": e.new_text,
            "media_type": e.media_type, "media_path": e.media_path,
            "severity": e.severity, "created_at": str(e.created_at),
            "time_label": str(e.created_at)[11:16] if e.created_at else "?",
            "telegram_link": e.telegram_link,
            "keyword_alerts": check_keyword_alert(" ".join(filter(None, [e.text, e.new_text]))),
            "is_forwarded": bool(e.is_forwarded),
            "forward_from_chat_title": e.forward_from_chat_title,
        }
        for e in rows
        if e.event_type != "media_download"
    ]
    return {"chat_id": chat_id, "date": date, "total": len(events), "events": events}


# ─── Analytics: Suspicious behavior ─────────────────────────────────────────
@app.get("/analytics/suspicious")
def suspicious_behavior(
    date: str,
    chat_id: Optional[str] = None,
    db: Session = Depends(get_db),
    cu=Depends(require_analytic),
):
    _key = ("suspicious", date, chat_id)
    if (cached := cache_get(_key)) is not None:
        return cached
    q = db.query(MessageEvent).filter(func.date(MessageEvent.created_at) == date)
    if chat_id:
        q = q.filter(MessageEvent.chat_id == chat_id)
    rows = q.order_by(MessageEvent.created_at.asc()).all()

    user_stats: dict = defaultdict(lambda: {
        "sent": 0, "deleted": 0, "edited": 0, "forwarded": 0, "timestamps": [], "texts": [],
    })

    for r in rows:
        ukey = r.sender_username or r.sender_name or str(r.sender_id) or "unknown"
        if r.event_type == "new_message":
            user_stats[ukey]["sent"] += 1
            if r.created_at:
                user_stats[ukey]["timestamps"].append(r.created_at)
            if r.text:
                user_stats[ukey]["texts"].append(r.text.lower().strip())
            if r.is_forwarded:
                user_stats[ukey]["forwarded"] += 1
        elif r.event_type == "deleted_message":
            user_stats[ukey]["deleted"] += 1
        elif r.event_type == "edited_message":
            user_stats[ukey]["edited"] += 1

    suspicious_users = []
    for ukey, stats in user_stats.items():
        flags, score = [], 0

        # High delete rate
        if stats["sent"] > 0:
            del_rate = stats["deleted"] / stats["sent"]
            if del_rate > 0.5 and stats["deleted"] >= 3:
                flags.append(f"High delete rate: {round(del_rate * 100)}%")
                score += 30

        # Spam burst: 10+ msgs in 60s
        ts_list = sorted(stats["timestamps"])
        if len(ts_list) >= 10:
            for i in range(len(ts_list) - 9):
                window = (ts_list[i + 9] - ts_list[i]).total_seconds()
                if window <= 60:
                    flags.append(f"Spam burst: 10+ msgs in {round(window)}s")
                    score += 40
                    break

        # Mass forwarding
        if stats["forwarded"] > 10:
            flags.append(f"Mass forwarding: {stats['forwarded']} fwds")
            score += 20

        # Repeated same message
        if stats["texts"]:
            mc_text, mc_count = Counter(stats["texts"]).most_common(1)[0]
            if mc_count >= 5:
                flags.append(f"Repeated msg x{mc_count}: \"{mc_text[:40]}\"")
                score += 35

        # High edit rate
        if stats["sent"] > 0:
            edit_rate = stats["edited"] / stats["sent"]
            if edit_rate > 0.7 and stats["edited"] >= 5:
                flags.append(f"High edit rate: {round(edit_rate * 100)}%")
                score += 15

        if flags:
            suspicious_users.append({
                "user": ukey, "score": score, "flags": flags,
                "stats": {
                    "sent": stats["sent"], "deleted": stats["deleted"],
                    "edited": stats["edited"], "forwarded": stats["forwarded"],
                },
            })

    suspicious_users.sort(key=lambda x: x["score"], reverse=True)
    result = {
        "date": date, "chat_id": chat_id,
        "total_suspicious_users": len(suspicious_users),
        "suspicious_users": suspicious_users[:20],
    }
    cache_set(_key, result)
    return result


# ─── Analytics: Conversation clusters ───────────────────────────────────────
@app.get("/analytics/conversation-clusters")
def conversation_clusters(
    date: str,
    chat_id: str,
    db: Session = Depends(get_db),
    cu=Depends(require_analytic),
):
    rows = (
        db.query(MessageEvent)
        .filter(
            func.date(MessageEvent.created_at) == date,
            MessageEvent.chat_id == chat_id,
            MessageEvent.event_type == "new_message",
            MessageEvent.text.isnot(None),
        )
        .all()
    )

    nodes: set    = set()
    edges: Counter = Counter()

    for r in rows:
        sender = r.sender_username or r.sender_name or "unknown"
        nodes.add(sender)
        for m in MENTION_RE.findall(r.text or ""):
            nodes.add(m.lower())
            edges[tuple(sorted([sender.lower(), m.lower()]))] += 1

    return {
        "nodes": list(nodes),
        "edges": [{"source": e[0], "target": e[1], "weight": w} for e, w in edges.most_common(50)],
    }