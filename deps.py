import os
import threading
from typing import Any, Generator, Tuple

from cachetools import TTLCache
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, Session

from database import DB_PATH, KeywordAlert

engine = create_engine(
    f"sqlite:///{DB_PATH}",
    connect_args={"check_same_thread": False},
    pool_pre_ping=True,
)
SessionLocal = sessionmaker(bind=engine, autocommit=False, autoflush=False)


def get_db() -> Generator:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ── TTL cache (thread-safe) ───────────────────────────────────────────────────
_cache: TTLCache = TTLCache(maxsize=256, ttl=int(os.getenv("CACHE_TTL_SECONDS", "120")))
_cache_lock = threading.Lock()


def cache_get(key: Tuple) -> Any:
    with _cache_lock:
        return _cache.get(key)


def cache_set(key: Tuple, value: Any) -> None:
    with _cache_lock:
        _cache[key] = value


def cache_invalidate_prefix(first_element: str) -> None:
    with _cache_lock:
        keys_to_del = [k for k in list(_cache.keys()) if isinstance(k, tuple) and k[0] == first_element]
        for k in keys_to_del:
            _cache.pop(k, None)


def cache_invalidate_date(date: str) -> None:
    with _cache_lock:
        keys_to_del = [k for k in list(_cache.keys()) if isinstance(k, tuple) and date in k]
        for k in keys_to_del:
            _cache.pop(k, None)


def cache_snapshot() -> dict:
    with _cache_lock:
        return {
            "current_size": len(_cache),
            "maxsize": _cache.maxsize,
            "ttl_seconds": _cache.ttl,
            "keys": [str(k) for k in list(_cache.keys())[:20]],
        }


# ── Keyword helpers ───────────────────────────────────────────────────────────
_KW_ENV_FALLBACK: list[str] = [
    k.strip().lower()
    for k in os.getenv("KEYWORD_ALERTS", "scam,spam,btc,warning,raid,drop,hack,fraud,ban").split(",")
    if k.strip()
]

KEYWORD_ALERTS: list[str] = _KW_ENV_FALLBACK


def get_active_keywords(db: Session) -> list[str]:
    rows = db.query(KeywordAlert).filter(KeywordAlert.is_active == 1).all()
    if rows:
        return [r.keyword for r in rows]
    return _KW_ENV_FALLBACK
