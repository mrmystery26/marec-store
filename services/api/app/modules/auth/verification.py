"""Proving a person controls their email address with a 6-digit code sent through Resend."""

import hmac
import secrets
import uuid
from datetime import timedelta

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import utcnow
from app.core.email import EmailSender, verification_code_email
from app.core.errors import ApiError
from app.core.security import hash_email_code
from app.modules.audit import service as audit
from app.modules.auth.models import EmailCode, User

PURPOSE = "verify_email"
COOLDOWN_SECONDS = 60
MAX_CODES_PER_DAY = 5


def send_code(db: Session, user: User, sender: EmailSender) -> int:
    """Emails a fresh code. Returns the number of minutes it stays valid."""
    settings = get_settings()
    if user.email_verified_at is not None:
        raise ApiError(409, "ALREADY_VERIFIED", "This email address is already verified.")
    if not settings.email_enabled:
        raise ApiError(503, "EMAIL_NOT_CONFIGURED", "This server cannot send email yet.")

    now = utcnow()
    recent = list(
        db.scalars(
            select(EmailCode.created_at).where(
                EmailCode.user_id == user.id,
                EmailCode.purpose == PURPOSE,
                EmailCode.created_at > now - timedelta(hours=24),
            )
        )
    )
    if len(recent) >= MAX_CODES_PER_DAY:
        raise ApiError(429, "TOO_MANY_CODES", "Too many codes were sent today. Try again tomorrow.")
    if recent and now - max(recent) < timedelta(seconds=COOLDOWN_SECONDS):
        raise ApiError(429, "TOO_SOON", "Wait a minute before asking for another code.")

    code = f"{secrets.randbelow(1_000_000):06d}"
    # Older codes stop working the moment a new one is sent.
    db.execute(
        update(EmailCode)
        .where(EmailCode.user_id == user.id, EmailCode.used_at.is_(None))
        .values(used_at=now)
    )
    row = EmailCode(
        id=uuid.uuid4(),
        user_id=user.id,
        purpose=PURPOSE,
        code_hash=hash_email_code(user.id, code),
        expires_at=now + timedelta(minutes=settings.email_code_minutes),
    )
    db.add(row)
    db.commit()

    if not sender.send(verification_code_email(user.email, code, settings.email_code_minutes)):
        # Nothing was delivered, so the code is useless and the person should be able to retry.
        db.delete(row)
        db.commit()
        raise ApiError(502, "EMAIL_SEND_FAILED", "The email could not be sent. Try again later.")
    return settings.email_code_minutes


def confirm_code(
    db: Session, user: User, code: str, ip: str | None, request_id: str | None
) -> User:
    settings = get_settings()
    if user.email_verified_at is not None:
        return user
    wrong = ApiError(422, "WRONG_CODE", "That code is not right or has expired.")
    row = db.scalar(
        select(EmailCode)
        .where(
            EmailCode.user_id == user.id,
            EmailCode.purpose == PURPOSE,
            EmailCode.used_at.is_(None),
        )
        .order_by(EmailCode.created_at.desc())
        .limit(1)
    )
    now = utcnow()
    if row is None or row.expires_at <= now:
        raise wrong
    row.attempts += 1
    if row.attempts > settings.email_code_max_attempts:
        row.used_at = now  # too many guesses: this code is dead, ask for a new one
        db.commit()
        raise ApiError(429, "TOO_MANY_ATTEMPTS", "Too many wrong codes. Ask for a new code.")
    if not hmac.compare_digest(row.code_hash, hash_email_code(user.id, code)):
        db.commit()
        raise wrong
    row.used_at = now
    user.email_verified_at = now
    audit.record(
        db,
        action="user.email_verified",
        entity_type="user",
        entity_id=str(user.id),
        actor_user_id=user.id,
        ip=ip,
        request_id=request_id,
    )
    db.commit()
    return user
