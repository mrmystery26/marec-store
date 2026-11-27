"""Sign in with Google: start, callback, one-time ticket, and account matching."""

import base64
import hashlib
import hmac
import re
import secrets
import uuid
from datetime import timedelta

import jwt
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import utcnow
from app.core.errors import ApiError
from app.core.google import GoogleClient, GoogleError, GoogleProfile
from app.core.security import create_state_token, decode_state_token, hash_token
from app.modules.audit import service as audit
from app.modules.auth import service as auth
from app.modules.auth.models import AuthIdentity, LoginTicket, User, UserSession

# base64url(SHA-256(verifier)) is always 43 characters.
CODE_CHALLENGE = re.compile(r"^[A-Za-z0-9_-]{43}$")
CODE_VERIFIER = re.compile(r"^[A-Za-z0-9._~-]{43,128}$")


def _not_configured() -> ApiError:
    return ApiError(
        503, "GOOGLE_NOT_CONFIGURED", "Sign in with Google is not set up on this server."
    )


def start(code_challenge: str, google: GoogleClient) -> str:
    """Returns the Google address the app opens in the system browser."""
    if not get_settings().google_enabled:
        raise _not_configured()
    if not CODE_CHALLENGE.fullmatch(code_challenge):
        raise ApiError(422, "BAD_CODE_CHALLENGE", "The sign-in request is malformed.")
    nonce = secrets.token_urlsafe(24)
    return google.authorization_url(create_state_token(nonce, code_challenge), nonce)


def _display_name(profile: GoogleProfile) -> str:
    name = " ".join((profile.name or "").split())[:40].strip()
    if len(name) >= 2:
        return name
    local = profile.email.split("@", 1)[0][:40]
    return local if len(local) >= 2 else "Player"


def _revoke_all_sessions(db: Session, user_id: uuid.UUID) -> None:
    db.execute(
        update(UserSession)
        .where(UserSession.user_id == user_id, UserSession.revoked_at.is_(None))
        .values(revoked_at=utcnow())
    )


def user_for_profile(
    db: Session, profile: GoogleProfile, ip: str | None, request_id: str | None
) -> User:
    """Finds or creates the user for a verified Google account. Caller commits."""
    now = utcnow()
    identity = db.scalar(
        select(AuthIdentity).where(
            AuthIdentity.provider == "google", AuthIdentity.subject == profile.subject
        )
    )
    if identity is not None:
        user = db.get(User, identity.user_id)
        if user is None or user.status == "deleted":
            raise ApiError(403, "ACCOUNT_UNAVAILABLE", "This account cannot sign in.")
        identity.email = profile.email.strip().lower()
        return user

    if not profile.email_verified:
        raise ApiError(403, "GOOGLE_EMAIL_UNVERIFIED", "Your Google email address is not verified.")

    email = auth.normalize_email(profile.email)
    user = db.scalar(select(User).where(User.email == email))
    if user is None:
        user = User(
            id=uuid.uuid4(),
            email=email,
            password_hash=None,
            display_name=_display_name(profile),
            email_verified_at=now,
        )
        db.add(user)
        db.flush()
        audit.record(
            db,
            action="user.registered",
            entity_type="user",
            entity_id=str(user.id),
            actor_user_id=user.id,
            after={"provider": "google"},
            ip=ip,
            request_id=request_id,
        )
    else:
        if user.status == "deleted":
            raise ApiError(403, "ACCOUNT_UNAVAILABLE", "This account cannot sign in.")
        if user.email_verified_at is None:
            # Someone may have registered this address with a password before its real owner
            # arrived. Google has now proven who owns it, so the old password must stop working.
            user.password_hash = None
            _revoke_all_sessions(db, user.id)
            user.email_verified_at = now
        audit.record(
            db,
            action="user.google_linked",
            entity_type="user",
            entity_id=str(user.id),
            actor_user_id=user.id,
            ip=ip,
            request_id=request_id,
        )
    db.add(
        AuthIdentity(
            id=uuid.uuid4(),
            user_id=user.id,
            provider="google",
            subject=profile.subject,
            email=email,
        )
    )
    return user


def finish(
    db: Session,
    google: GoogleClient,
    code: str | None,
    state: str | None,
    provider_error: str | None,
    ip: str | None,
    request_id: str | None,
) -> str:
    """Handles Google's redirect. Returns the app address to send the browser to:
    <APP_REDIRECT_URI>?ticket=... on success, ?error=... otherwise."""
    settings = get_settings()
    base = settings.app_redirect_uri

    def failure(code_name: str) -> str:
        return f"{base}?error={code_name}"

    if not settings.google_enabled:
        return failure("GOOGLE_NOT_CONFIGURED")
    if provider_error:
        # The person pressed Cancel, or Google refused for its own reasons.
        cancelled = provider_error == "access_denied"
        return failure("GOOGLE_CANCELLED" if cancelled else "GOOGLE_REJECTED")
    if not code or not state:
        return failure("GOOGLE_BAD_RESPONSE")
    try:
        claims = decode_state_token(state)
    except jwt.PyJWTError:
        return failure("SIGNIN_EXPIRED")

    try:
        profile = google.exchange(code, claims["n"])
        user = user_for_profile(db, profile, ip, request_id)
        if user.status == "suspended":
            db.rollback()
            return failure("ACCOUNT_SUSPENDED")
        ticket = secrets.token_urlsafe(32)
        db.add(
            LoginTicket(
                id=uuid.uuid4(),
                ticket_hash=hash_token(ticket),
                user_id=user.id,
                code_challenge=claims["cc"],
                expires_at=utcnow() + timedelta(seconds=settings.login_ticket_seconds),
            )
        )
        db.commit()
    except GoogleError as error:
        db.rollback()
        return failure(error.code)
    except ApiError as error:
        db.rollback()
        return failure(error.code)
    except IntegrityError:
        db.rollback()
        return failure("TRY_AGAIN")
    return f"{base}?ticket={ticket}"


def exchange_ticket(
    db: Session, ticket: str, code_verifier: str, ip: str | None, user_agent: str | None
) -> auth.TokenPair:
    invalid = ApiError(401, "INVALID_TICKET", "This sign-in expired. Please try again.")
    if not CODE_VERIFIER.fullmatch(code_verifier):
        raise invalid
    row = db.scalar(select(LoginTicket).where(LoginTicket.ticket_hash == hash_token(ticket)))
    if row is None or row.used_at is not None or row.expires_at <= utcnow():
        raise invalid
    # A ticket is spent by the first attempt, right or wrong, so it cannot be guessed at.
    row.used_at = utcnow()
    db.commit()

    digest = hashlib.sha256(code_verifier.encode("ascii")).digest()
    expected = base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")
    if not hmac.compare_digest(expected, row.code_challenge):
        raise invalid
    user = db.get(User, row.user_id)
    if user is None or user.status == "deleted":
        raise invalid
    if user.status == "suspended":
        raise ApiError(403, "ACCOUNT_SUSPENDED", "This account is suspended.")
    tokens = auth._start_session(db, user, ip, user_agent)
    db.commit()
    return tokens
