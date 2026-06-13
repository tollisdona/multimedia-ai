from __future__ import annotations

from datetime import datetime, timedelta, timezone
from sqlite3 import IntegrityError
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from jose import JWTError, jwt
from passlib.context import CryptContext
from pydantic import BaseModel, Field

from .config import settings
from .db import create_user, get_user_by_id, get_user_by_username, normalize_username


router = APIRouter(prefix="/api/auth", tags=["auth"])
me_router = APIRouter(prefix="/api", tags=["auth"])
pwd_context = CryptContext(schemes=["bcrypt"], deprecated="auto")


class AuthCredentials(BaseModel):
    username: str = Field(min_length=3, max_length=40)
    password: str = Field(min_length=6, max_length=128)


class UserOut(BaseModel):
    id: str
    username: str
    createdAt: int


class TokenResponse(BaseModel):
    accessToken: str
    tokenType: str = "bearer"
    user: UserOut


def public_user(user: dict[str, Any]) -> UserOut:
    return UserOut(id=str(user["id"]), username=str(user["username"]), createdAt=int(user["created_at"]))


def hash_password(password: str) -> str:
    return pwd_context.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    return pwd_context.verify(password, password_hash)


def create_access_token(user_id: str) -> str:
    expires_at = datetime.now(timezone.utc) + timedelta(minutes=settings.access_token_minutes)
    payload = {"sub": user_id, "exp": expires_at}
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def authenticate_token(token: str | None) -> dict[str, Any] | None:
    if not token:
        return None
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
    except JWTError:
        return None
    user_id = str(payload.get("sub", ""))
    return get_user_by_id(user_id) if user_id else None


def bearer_token(request: Request) -> str:
    authorization = request.headers.get("authorization", "")
    scheme, _, token = authorization.partition(" ")
    if scheme.lower() != "bearer" or not token:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Missing bearer token")
    return token


def current_user(token: str = Depends(bearer_token)) -> dict[str, Any]:
    user = authenticate_token(token)
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")
    return user


@router.post("/register", response_model=TokenResponse)
async def register(credentials: AuthCredentials) -> TokenResponse:
    username = normalize_username(credentials.username)
    if not username.replace("_", "").replace("-", "").isalnum():
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="Username can only contain letters, numbers, _ or -")
    try:
        user = create_user(username, hash_password(credentials.password))
    except IntegrityError as exc:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Username already exists") from exc
    return TokenResponse(accessToken=create_access_token(str(user["id"])), user=public_user(user))


@router.post("/login", response_model=TokenResponse)
async def login(credentials: AuthCredentials) -> TokenResponse:
    user = get_user_by_username(credentials.username)
    if not user or not verify_password(credentials.password, str(user["password_hash"])):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid username or password")
    return TokenResponse(accessToken=create_access_token(str(user["id"])), user=public_user(user))


@me_router.get("/me", response_model=UserOut)
async def me(user: dict[str, Any] = Depends(current_user)) -> UserOut:
    return public_user(user)
