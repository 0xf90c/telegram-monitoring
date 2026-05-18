from collections import Counter, defaultdict
from datetime import datetime
from typing import Optional

from fastapi import APIRouter, Depends
from sqlalchemy import func, case
from sqlalchemy.orm import Session

from auth import require_analytic
from database import MessageEvent
from deps import get_db, get_active_keywords, cache_get, cache_set
from utils.text import check_keyword_alert, extract_links, extract_phrases, MENTION_RE, STOPWORDS

router = APIRouter(prefix="/analytics", tags=["analytics"])


@router.get("/hourly")
def analytics_hourly(date: str, db: Session = Depends(get_db), cu: dict = Depends(require_analytic)):
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


@router.get("/weekly-trend")
def analytics_weekly_trend(db: Session = Depends(get_db), cu: dict = Depends(require_analytic)):
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


@router.get("/event-distribution")
def analytics_event_distribution(date: str, db: Session = Depends(get_db), cu: dict = Depends(require_analytic)):
    rows = (
        db.query(MessageEvent.event_type, func.count(MessageEvent.id).label("count"))
        .filter(func.date(MessageEvent.created_at) == date)
        .group_by(MessageEvent.event_type)
        .all()
    )
    return [{"event_type": r.event_type, "count": r.count} for r in rows]


@router.get("/top-active")
def analytics_top_active(
    date: str, limit: int = 10,
    db: Session = Depends(get_db), cu: dict = Depends(require_analytic),
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


@router.get("/top-senders")
def analytics_top_senders(
    date: str, limit: int = 10,
    db: Session = Depends(get_db), cu: dict = Depends(require_analytic),
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


@router.get("/edit-analytics")
def edit_analytics(
    date: str, chat_id: Optional[str] = None,
    db: Session = Depends(get_db), cu: dict = Depends(require_analytic),
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


@router.get("/delete-analytics")
def delete_analytics(
    date: str, chat_id: Optional[str] = None,
    db: Session = Depends(get_db), cu: dict = Depends(require_analytic),
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

    def _to_dt(v):
        return v if isinstance(v, datetime) else datetime.fromisoformat(str(v))

    buckets = {"lt_10s": 0, "lt_1min": 0, "lt_5min": 0, "lt_1h": 0, "gt_1h": 0, "unknown": 0}
    user_counts:   Counter = Counter()
    quick_samples: list    = []

    for de in deleted_events:
        ukey = de.sender_username or de.sender_name or "unknown"
        user_counts[ukey] += 1

        ttd = de.time_to_delete
        if ttd is None and de.original_created_at and de.created_at:
            try:
                ttd = int((_to_dt(de.created_at) - _to_dt(de.original_created_at)).total_seconds())
            except Exception:
                pass

        if ttd is None:
            buckets["unknown"] += 1
            continue

        if   ttd < 0:   buckets["unknown"] += 1
        elif ttd < 10:
            buckets["lt_10s"] += 1
            if len(quick_samples) < 15:
                quick_samples.append({
                    "sender_name": de.sender_name, "sender_username": de.sender_username,
                    "message_id": de.message_id, "delta_sec": round(ttd, 1),
                    "text_preview": (de.original_text or "")[:80], "created_at": str(de.created_at),
                })
        elif ttd < 60:   buckets["lt_1min"] += 1
        elif ttd < 300:  buckets["lt_5min"] += 1
        elif ttd < 3600: buckets["lt_1h"]   += 1
        else:            buckets["gt_1h"]   += 1

    result = {
        "total_deleted": len(deleted_events),
        "speed_buckets": buckets,
        "most_deleted_users":   [{"user": u, "count": c} for u, c in user_counts.most_common(10)],
        "quick_delete_samples": quick_samples,
    }
    cache_set(_key, result)
    return result


@router.get("/media-analytics")
def media_analytics(
    date: str, chat_id: Optional[str] = None,
    db: Session = Depends(get_db), cu: dict = Depends(require_analytic),
):
    q = db.query(MessageEvent).filter(
        func.date(MessageEvent.created_at) == date,
        MessageEvent.media_type.isnot(None),
        MessageEvent.media_type != "pending",
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
        counts[mtype] += 1
        if len(gallery) < 60 and mtype in ("photo", "gif", "video", "sticker", "animated_sticker", "video_sticker"):
            gallery.append({
                "message_id": r.message_id, "media_type": mtype, "media_path": r.media_path,
                "sender_name": r.sender_name, "sender_username": r.sender_username,
                "chat_id": r.chat_id, "chat_title": r.chat_title, "created_at": str(r.created_at),
            })

    return {"total_media": sum(counts.values()), "breakdown": dict(counts.most_common()), "gallery": gallery}


@router.get("/forward-analytics")
def forward_analytics(
    date: str, chat_id: Optional[str] = None,
    db: Session = Depends(get_db), cu: dict = Depends(require_analytic),
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
        "total_forwarded":  len(rows),
        "top_sources":      [{"source": s, "count": c} for s, c in source_counts.most_common(15)],
        "top_destinations": [{"chat": d,   "count": c} for d, c in dest_counts.most_common(10)],
    }


@router.get("/link-analytics")
def link_analytics(
    date: str, chat_id: Optional[str] = None,
    db: Session = Depends(get_db), cu: dict = Depends(require_analytic),
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
        "category_counts": dict(category_counts.most_common()),
        "top_links_by_category": {
            cat: [{"url": u, "count": c} for u, c in ctr.most_common(5)]
            for cat, ctr in all_links.items()
        },
    }


@router.get("/mention-analytics")
def mention_analytics(
    date: str, chat_id: Optional[str] = None,
    db: Session = Depends(get_db), cu: dict = Depends(require_analytic),
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


@router.get("/keyword-alerts")
def keyword_alerts_endpoint(
    date: str, chat_id: Optional[str] = None,
    db: Session = Depends(get_db), cu: dict = Depends(require_analytic),
):
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
        "total_alerts":   len(alert_messages),
        "keyword_counts": dict(keyword_counts.most_common()),
        "messages":       alert_messages[:100],
    }


@router.get("/phrase-analytics")
def phrase_analytics(
    date: str, chat_id: Optional[str] = None,
    db: Session = Depends(get_db), cu: dict = Depends(require_analytic),
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


@router.get("/timeline")
def timeline(
    date: str, chat_id: str,
    db: Session = Depends(get_db), cu: dict = Depends(require_analytic),
):
    from auth import USER_ALLOWED_CHATS
    from fastapi import HTTPException
    if cu["role"] == "user" and USER_ALLOWED_CHATS and chat_id not in USER_ALLOWED_CHATS:
        raise HTTPException(status_code=403)

    active_kws = get_active_keywords(db)
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
            "keyword_alerts": check_keyword_alert(" ".join(filter(None, [e.text, e.new_text])), active_kws),
            "is_forwarded": bool(e.is_forwarded),
            "forward_from_chat_title": e.forward_from_chat_title,
        }
        for e in rows
        if e.event_type != "media_download"
    ]
    return {"chat_id": chat_id, "date": date, "total": len(events), "events": events}


@router.get("/suspicious")
def suspicious_behavior(
    date: str, chat_id: Optional[str] = None,
    db: Session = Depends(get_db), cu: dict = Depends(require_analytic),
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

        if stats["sent"] > 0:
            del_rate = stats["deleted"] / stats["sent"]
            if del_rate > 0.5 and stats["deleted"] >= 3:
                flags.append(f"High delete rate: {round(del_rate * 100)}%")
                score += 30

        ts_list = sorted(stats["timestamps"])
        if len(ts_list) >= 10:
            for i in range(len(ts_list) - 9):
                window = (ts_list[i + 9] - ts_list[i]).total_seconds()
                if window <= 60:
                    flags.append(f"Spam burst: 10+ msgs in {round(window)}s")
                    score += 40
                    break

        if stats["forwarded"] > 10:
            flags.append(f"Mass forwarding: {stats['forwarded']} fwds")
            score += 20

        if stats["texts"]:
            mc_text, mc_count = Counter(stats["texts"]).most_common(1)[0]
            if mc_count >= 5:
                flags.append(f"Repeated msg x{mc_count}: \"{mc_text[:40]}\"")
                score += 35

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


@router.get("/conversation-clusters")
def conversation_clusters(
    date: str, chat_id: str,
    db: Session = Depends(get_db), cu: dict = Depends(require_analytic),
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

    nodes: set     = set()
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
