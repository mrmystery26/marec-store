import hashlib
import secrets
import uuid
from datetime import datetime, timedelta, timezone

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import InvalidHashError, VerificationError

from app.core.config import get_settings

ISSUER = "marec-store-api"
ACCESS_TOKEN_TYPE = "access"

# argon2id with the library's current recommended parameters.
_hasher = PasswordHasher()

# Verified against when an email is unknown, so unknown and known accounts take similar time.
DUMMY_HASH = _hasher.hash("marec-store-dummy-password")


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (VerificationError, InvalidHashError):
        return False


def password_needs_rehash(password_hash: str) -> bool:
    return _hasher.check_needs_rehash(password_hash)


def new_refresh_token() -> str:
    return secrets.token_urlsafe(48)


def hash_token(token: str) -> str:
    """Refresh tokens are high-entropy random values, so a plain SHA-256 is enough."""
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def create_access_token(
    user_id: uuid.UUID, session_id: uuid.UUID, expires_delta: timedelta | None = None
) -> str:
    settings = get_settings()
    now = datetime.now(timezone.utc)
    lifetime = expires_delta if expires_delta is not None else timedelta(
        minutes=settings.access_token_minutes
    )
    payload = {
        "iss": ISSUER,
        "typ": ACCESS_TOKEN_TYPE,
        "sub": str(user_id),
        "sid": str(session_id),
        "iat": now,
        "exp": now + lifetime,
    }
    return jwt.encode(payload, settings.jwt_secret.get_secret_value(), algorithm="HS256")


def decode_access_token(token: str) -> dict:
    """Raises jwt.PyJWTError if the token is invalid, expired or of the wrong type."""
    payload = jwt.decode(
        token,
        get_settings().jwt_secret.get_secret_value(),
        algorithms=["HS256"],
        issuer=ISSUER,
        options={"require": ["exp", "iat", "sub", "sid"]},
    )
    if payload.get("typ") != ACCESS_TOKEN_TYPE:
        raise jwt.InvalidTokenError("Wrong token type.")
    return payload
