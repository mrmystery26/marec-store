import uuid
from dataclasses import dataclass
from datetime import timedelta

from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import utcnow
from app.core.errors import ApiError
from app.core.security import (
    DUMMY_HASH,
    create_access_token,
    hash_password,
    hash_token,
    new_refresh_token,
    password_needs_rehash,
    verify_password,
)
from app.modules.audit import service as audit
from app.modules.auth.models import User, UserSession

INVALID_CREDENTIALS = ApiError(401, "INVALID_CREDENTIALS", "Email or password is incorrect.")


@dataclass
class TokenPair:
    access_token: str
    refresh_token: str
    expires_in: int


def normalize_email(email: str) -> str:
    return email.strip().lower()


def _invalid_refresh() -> ApiError:
    return ApiError(401, "INVALID_REFRESH_TOKEN", "Refresh token is invalid or expired.")


def register_user(
    db: Session,
    email: str,
    password: str,
    display_name: str,
    ip: str | None = None,
    request_id: str | None = None,
) -> User:
    email = normalize_email(email)
    taken = ApiError(409, "EMAIL_TAKEN", "An account with this email already exists.")
    if db.scalar(select(User.id).where(User.email == email)) is not None:
        raise taken
    user = User(
        id=uuid.uuid4(),
        email=email,
        password_hash=hash_password(password),
        display_name=display_name,
    )
    db.add(user)
    audit.record(
        db,
        action="user.registered",
        entity_type="user",
        entity_id=str(user.id),
        actor_user_id=user.id,
        ip=ip,
        request_id=request_id,
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise taken from None
    return user


def _start_session(db: Session, user: User, ip: str | None, user_agent: str | None) -> TokenPair:
    settings = get_settings()
    now = utcnow()
    refresh_token = new_refresh_token()
    session = UserSession(
        id=uuid.uuid4(),
        user_id=user.id,
        refresh_token_hash=hash_token(refresh_token),
        user_agent=(user_agent or "")[:256] or None,
        ip=ip,
        created_at=now,
        last_seen_at=now,
        expires_at=now + timedelta(days=settings.refresh_token_days),
    )
    db.add(session)
    db.flush()
    access_token = create_access_token(user.id, session.id)
    return TokenPair(access_token, refresh_token, settings.access_token_minutes * 60)


def login(
    db: Session, email: str, password: str, ip: str | None, user_agent: str | None
) -> TokenPair:
    settings = get_settings()
    now = utcnow()
    user = db.scalar(select(User).where(User.email == normalize_email(email)))

    if user is None:
        verify_password(password, DUMMY_HASH)  # keep timing similar to a real check
        raise INVALID_CREDENTIALS

    if user.locked_until is not None and user.locked_until > now:
        raise ApiError(429, "TOO_MANY_ATTEMPTS", "Too many failed attempts. Try again later.")

    if not verify_password(password, user.password_hash):
        user.failed_login_count += 1
        if user.failed_login_count >= settings.max_failed_logins:
            user.locked_until = now + timedelta(minutes=settings.lockout_minutes)
            user.failed_login_count = 0
        db.commit()
        raise INVALID_CREDENTIALS

    # Status is checked only after the password is proven, so it cannot be probed anonymously.
    if user.status == "suspended":
        raise ApiError(403, "ACCOUNT_SUSPENDED", "This account is suspended.")
    if user.status != "active":
        raise INVALID_CREDENTIALS

    user.failed_login_count = 0
    user.locked_until = None
    if password_needs_rehash(user.password_hash):
        user.password_hash = hash_password(password)
    tokens = _start_session(db, user, ip, user_agent)
    db.commit()
    return tokens


def refresh_session(db: Session, refresh_token: str) -> TokenPair:
    settings = get_settings()
    now = utcnow()
    token_hash = hash_token(refresh_token)

    session = db.scalar(select(UserSession).where(UserSession.refresh_token_hash == token_hash))
    if session is None:
        # A token that was already rotated away is being replayed: assume theft, end the session.
        stale = db.scalar(
            select(UserSession).where(UserSession.prev_refresh_token_hash == token_hash)
        )
        if stale is not None and stale.revoked_at is None:
            stale.revoked_at = now
            db.commit()
        raise _invalid_refresh()

    if session.revoked_at is not None or session.expires_at <= now:
        raise _invalid_refresh()
    user = db.get(User, session.user_id)
    if user is None or user.status != "active":
        raise _invalid_refresh()

    new_token = new_refresh_token()
    session.prev_refresh_token_hash = session.refresh_token_hash
    session.refresh_token_hash = hash_token(new_token)
    session.last_seen_at = now
    session.expires_at = now + timedelta(days=settings.refresh_token_days)
    db.commit()
    access_token = create_access_token(user.id, session.id)
    return TokenPair(access_token, new_token, settings.access_token_minutes * 60)


def revoke_session(db: Session, user_id: uuid.UUID, session_id: uuid.UUID) -> None:
    session = db.get(UserSession, session_id)
    if session is None or session.user_id != user_id:
        raise ApiError(404, "SESSION_NOT_FOUND", "Session not found.")
    if session.revoked_at is None:
        session.revoked_at = utcnow()
        db.commit()


def list_active_sessions(db: Session, user_id: uuid.UUID) -> list[UserSession]:
    stmt = (
        select(UserSession)
        .where(
            UserSession.user_id == user_id,
            UserSession.revoked_at.is_(None),
            UserSession.expires_at > utcnow(),
        )
        .order_by(UserSession.created_at.desc())
    )
    return list(db.scalars(stmt))
