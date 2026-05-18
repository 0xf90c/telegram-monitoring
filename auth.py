import os
import secrets
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer, OAuth2PasswordRequestForm
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel

SECRET_KEY = os.getenv("JWT_SECRET_KEY", secrets.token_hex(32))
ALGORITHM  = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = int(os.getenv("JWT_EXPIRE_MINUTES", "60"))

pwd_context   = CryptContext(schemes=["sha256_crypt"], deprecated="auto")
oauth2_scheme = OAuth2PasswordBearer(tokenUrl="/auth/login")


def _make_user(username_env: str, password_env: str, default_user: str, default_pass: str, role: str) -> dict:
    username = os.getenv(username_env, default_user)
    raw_pass = os.getenv(password_env, default_pass)
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

USER_ALLOWED_CHATS: set[str] = set(
    c.strip() for c in os.getenv("USER_ALLOWED_CHATS", "").split(",") if c.strip()
)


class Token(BaseModel):
    access_token: str
    token_type: str
    expires_in: int
    role: str
    username: str


def create_access_token(data: dict) -> str:
    payload = data.copy()
    payload["exp"] = datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    payload["iat"] = datetime.utcnow()
    return jwt.encode(payload, SECRET_KEY, algorithm=ALGORITHM)


def verify_password(plain: str, hashed: str) -> bool:
    return pwd_context.verify(plain, hashed)


def get_current_user(token: str = Depends(oauth2_scheme)) -> dict:
    exc = HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Token noto'g'ri yoki muddati tugagan",
        headers={"WWW-Authenticate": "Bearer"},
    )
    try:
        payload = jwt.decode(token, SECRET_KEY, algorithms=[ALGORITHM])
        username: str = payload.get("sub")
        if not username:
            raise exc
    except JWTError:
        raise exc

    user = USERS.get(username)
    if not user:
        raise exc
    return {"username": username, "role": user["role"]}


def require_analytic(cu: dict = Depends(get_current_user)) -> dict:
    if cu["role"] not in ("admin", "analytic"):
        raise HTTPException(status_code=403, detail="Analytic/Admin roli talab qilinadi")
    return cu


# ── Router ────────────────────────────────────────────────────────────────────
router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/login", response_model=Token)
def login(form_data: OAuth2PasswordRequestForm = Depends()):
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


@router.post("/refresh", response_model=Token)
def refresh_token(cu: dict = Depends(get_current_user)):
    token = create_access_token({"sub": cu["username"], "role": cu["role"]})
    return Token(
        access_token=token,
        token_type="bearer",
        expires_in=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        role=cu["role"],
        username=cu["username"],
    )
