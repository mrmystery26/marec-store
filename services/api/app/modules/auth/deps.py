import uuid
from dataclasses import dataclass

import jwt
from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.orm import Session

from app.core.db import get_db, utcnow
from app.core.errors import ApiError
from app.core.security import decode_access_token
from app.modules.auth.models import User, UserSession

_bearer = HTTPBearer(auto_error=False)
_CHALLENGE = {"WWW-Authenticate": "Bearer"}


@dataclass
class AuthContext:
    user: User
    session: UserSession


def _invalid_token() -> ApiError:
    return ApiError(401, "INVALID_TOKEN", "Token is invalid or expired.", headers=_CHALLENGE)


def get_auth_context(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: Session = Depends(get_db),
) -> AuthContext:
    if credentials is None:
        raise ApiError(401, "NOT_AUTHENTICATED", "Authentication required.", headers=_CHALLENGE)
    try:
        payload = decode_access_token(credentials.credentials)
        user_id = uuid.UUID(payload["sub"])
        session_id = uuid.UUID(payload["sid"])
    except (jwt.PyJWTError, ValueError, KeyError):
        raise _invalid_token() from None

    # The session is looked up on every request, so revoking it takes effect immediately.
    session = db.get(UserSession, session_id)
    if (
        session is None
        or session.user_id != user_id
        or session.revoked_at is not None
        or session.expires_at <= utcnow()
    ):
        raise _invalid_token()
    user = db.get(User, user_id)
    if user is None or user.status == "deleted":
        raise _invalid_token()
    if user.status == "suspended":
        raise ApiError(403, "ACCOUNT_SUSPENDED", "This account is suspended.")
    return AuthContext(user=user, session=session)
