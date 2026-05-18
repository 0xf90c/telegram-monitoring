from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from auth import get_current_user, require_analytic
from database import KeywordAlert
from deps import get_db, cache_invalidate_prefix, _KW_ENV_FALLBACK

router = APIRouter(tags=["keywords"])


@router.get("/keywords")
def list_keywords(db: Session = Depends(get_db), cu: dict = Depends(get_current_user)):
    rows = db.query(KeywordAlert).order_by(KeywordAlert.created_at.desc()).all()
    if not rows:
        return {
            "source": "env_fallback",
            "keywords": [
                {"id": None, "keyword": kw, "is_active": 1, "created_by": "env", "created_at": None}
                for kw in _KW_ENV_FALLBACK
            ],
        }
    return {
        "source": "database",
        "keywords": [
            {
                "id": r.id, "keyword": r.keyword, "is_active": r.is_active,
                "created_by": r.created_by,
                "created_at": r.created_at.isoformat() if r.created_at else None,
            }
            for r in rows
        ],
    }


@router.post("/keywords")
def add_keyword(keyword: str, db: Session = Depends(get_db), cu: dict = Depends(require_analytic)):
    kw = keyword.strip().lower()
    if not kw or len(kw) < 2:
        raise HTTPException(status_code=400, detail="Keyword kamida 2 ta harf bo'lishi kerak")
    if len(kw) > 50:
        raise HTTPException(status_code=400, detail="Keyword 50 ta harfdan oshmasin")

    existing = db.query(KeywordAlert).filter(KeywordAlert.keyword == kw).first()
    if existing:
        if existing.is_active:
            raise HTTPException(status_code=409, detail=f"'{kw}' allaqachon mavjud")
        existing.is_active = 1
        existing.created_by = cu["username"]
        db.commit()
        cache_invalidate_prefix("keyword_alerts")
        return {"action": "reactivated", "keyword": kw, "id": existing.id}

    row = KeywordAlert(keyword=kw, created_by=cu["username"])
    db.add(row)
    db.commit()
    db.refresh(row)
    cache_invalidate_prefix("keyword_alerts")
    return {"action": "created", "keyword": kw, "id": row.id}


@router.delete("/keywords/{keyword_id}")
def delete_keyword(keyword_id: int, db: Session = Depends(get_db), cu: dict = Depends(require_analytic)):
    row = db.query(KeywordAlert).filter(KeywordAlert.id == keyword_id).first()
    if not row:
        raise HTTPException(status_code=404, detail="Keyword topilmadi")
    row.is_active = 0
    db.commit()
    cache_invalidate_prefix("keyword_alerts")
    return {"action": "deleted", "keyword": row.keyword}


@router.post("/keywords/seed-from-env")
def seed_keywords_from_env(db: Session = Depends(get_db), cu: dict = Depends(require_analytic)):
    added = []
    for kw in _KW_ENV_FALLBACK:
        if not db.query(KeywordAlert).filter(KeywordAlert.keyword == kw).first():
            db.add(KeywordAlert(keyword=kw, created_by=cu["username"]))
            added.append(kw)
    db.commit()
    return {"seeded": added, "total": len(added)}
