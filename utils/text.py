import re
from typing import List

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
    if not text:
        return []
    kws = keywords or []
    low = text.lower()
    return [kw for kw in kws if kw in low]
