from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, case
from sqlalchemy.orm import Session

from auth import get_current_user, USER_ALLOWED_CHATS
from database import MessageEvent
from deps import get_db, get_active_keywords
from utils.text import check_keyword_alert

router = APIRouter(tags=["events"])


@router.get("/days")
def get_days(db: Session = Depends(get_db), cu: dict = Depends(get_current_user)):
    days = (
        db.query(func.date(MessageEvent.created_at))
        .distinct()
        .order_by(func.date(MessageEvent.created_at).desc())
        .all()
    )
    return {"days": [d[0] for d in days]}


@router.get("/day-summary")
def day_summary(date: str, db: Session = Depends(get_db), cu: dict = Depends(get_current_user)):
    q = db.query(MessageEvent).filter(func.date(MessageEvent.created_at) == date)
    if cu["role"] == "user" and USER_ALLOWED_CHATS:
        q = q.filter(MessageEvent.chat_id.in_(USER_ALLOWED_CHATS))
    total   = q.count()
    edited  = q.filter(MessageEvent.event_type == "edited_message").count()
    deleted = q.filter(MessageEvent.event_type == "deleted_message").count()
    missing = q.filter(MessageEvent.event_type == "missing_ids").count()
    return {"date": date, "total": total, "edited": edited, "deleted": deleted, "missing": missing}


@router.get("/groups-summary")
def groups_summary(date: str, db: Session = Depends(get_db), cu: dict = Depends(get_current_user)):
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


@router.get("/events")
def get_events(date: str, chat_id: str, db: Session = Depends(get_db), cu: dict = Depends(get_current_user)):
    if cu["role"] == "user" and USER_ALLOWED_CHATS and chat_id not in USER_ALLOWED_CHATS:
        raise HTTPException(status_code=403, detail="Bu chatga ruxsat yo'q")

    active_kws = get_active_keywords(db)
    rows = (
        db.query(MessageEvent)
        .filter(func.date(MessageEvent.created_at) == date, MessageEvent.chat_id == chat_id)
        .order_by(MessageEvent.created_at.desc())
        .all()
    )

    result = []
    for e in rows:
        original = None
        if e.event_type == "deleted_message" and e.message_id and not e.original_text:
            original = (
                db.query(MessageEvent)
                .filter(
                    MessageEvent.chat_id    == e.chat_id,
                    MessageEvent.message_id == e.message_id,
                    MessageEvent.event_type == "new_message",
                )
                .order_by(MessageEvent.created_at.asc())
                .first()
            )

        orig_text     = e.original_text     or (original.text        if original else None)
        orig_mtype    = e.original_media_type or (original.media_type  if original else None)
        orig_mpath    = e.original_media_path or (original.media_path  if original else None)
        orig_sender   = e.original_sender_name or (original.sender_name if original else None)
        orig_username = e.original_sender_username or (original.sender_username if original else None)

        all_text = " ".join(filter(None, [e.text, e.new_text, e.old_text, e.original_text]))
        result.append({
            "id": e.id, "event_type": e.event_type, "message_id": e.message_id,
            "sender_name": e.sender_name, "sender_username": e.sender_username,
            "text": e.text, "old_text": e.old_text, "new_text": e.new_text,
            "deleted_original_text":            orig_text,
            "deleted_original_media_type":      orig_mtype,
            "deleted_original_media_path":      orig_mpath,
            "deleted_original_sender_name":     orig_sender,
            "deleted_original_sender_username": orig_username,
            "deleted_original_created_at":      e.original_created_at,
            "time_to_delete":                   e.time_to_delete,
            "media_type": e.media_type, "media_path": e.media_path,
            "deleted_ids": e.deleted_ids, "missing_ids": e.missing_ids,
            "telegram_link": e.telegram_link, "severity": e.severity,
            "created_at": e.created_at,
            "is_forwarded": bool(e.is_forwarded),
            "forward_from_name": e.forward_from_name,
            "forward_from_chat_id": e.forward_from_chat_id,
            "forward_from_chat_title": e.forward_from_chat_title,
            "keyword_alerts": check_keyword_alert(all_text, active_kws),
        })
    return result


@router.get("/deleted-feed")
def deleted_feed(
    date: str,
    chat_id: Optional[str] = None,
    speed: Optional[str] = None,
    sender: Optional[str] = None,
    limit: int = 100,
    db: Session = Depends(get_db),
    cu: dict = Depends(get_current_user),
):
    active_kws = get_active_keywords(db)

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
    if speed == "quick":
        q = q.filter(MessageEvent.time_to_delete < 10)
    elif speed == "fast":
        q = q.filter(MessageEvent.time_to_delete < 60)
    elif speed == "slow":
        q = q.filter(MessageEvent.time_to_delete >= 60)

    rows = q.order_by(MessageEvent.created_at.desc()).limit(limit).all()

    result = []
    for e in rows:
        ttd = e.time_to_delete
        orig_text     = e.original_text
        orig_mtype    = e.original_media_type
        orig_mpath    = e.original_media_path
        orig_sender_name  = e.original_sender_name
        orig_sender_uname = e.original_sender_username
        orig_created_at   = e.original_created_at

        if not orig_text and not orig_mtype:
            original = db.query(MessageEvent).filter(
                MessageEvent.chat_id    == e.chat_id,
                MessageEvent.message_id == e.message_id,
                MessageEvent.event_type == "new_message",
            ).first()
            if original:
                orig_text         = original.text
                orig_mtype        = original.media_type
                orig_mpath        = original.media_path
                orig_sender_name  = original.sender_name
                orig_sender_uname = original.sender_username
                orig_created_at   = original.created_at

        result.append({
            "id": e.id, "message_id": e.message_id,
            "chat_id": e.chat_id, "chat_title": e.chat_title,
            "deleted_at": str(e.created_at),
            "deleted_by_name": e.sender_name, "deleted_by_username": e.sender_username,
            "original_text": orig_text,
            "original_sender_name": orig_sender_name,
            "original_sender_username": orig_sender_uname,
            "original_media_type": orig_mtype,
            "original_media_path": orig_mpath,
            "original_created_at": str(orig_created_at) if orig_created_at else None,
            "time_to_delete": ttd,
            "speed_label": (
                "quick (<10s)"   if ttd is not None and ttd < 10  else
                "fast (<1min)"   if ttd is not None and ttd < 60  else
                "normal (<5min)" if ttd is not None and ttd < 300 else
                "slow (>5min)"   if ttd is not None               else
                "unknown"
            ),
            "telegram_link": e.telegram_link,
            "keyword_alerts": check_keyword_alert(orig_text or "", active_kws),
        })

    total      = len(result)
    quick      = sum(1 for r in result if r["time_to_delete"] is not None and r["time_to_delete"] < 10)
    fast       = sum(1 for r in result if r["time_to_delete"] is not None and 10 <= r["time_to_delete"] < 60)
    with_text  = sum(1 for r in result if r["original_text"])
    with_media = sum(1 for r in result if r["original_media_type"])
    no_info    = sum(1 for r in result if not r["original_text"] and not r["original_media_type"])

    return {
        "date": date, "total": total,
        "stats": {
            "quick_deletes": quick, "fast_deletes": fast,
            "with_text": with_text, "with_media": with_media, "no_info": no_info,
        },
        "events": result,
    }
