import base64
import uuid
from datetime import datetime

from fastapi import Request
from sqlalchemy import and_, or_, select
from sqlalchemy.orm import Session

from app.core.errors import ApiError
from app.modules.audit.models import AuditLog


def context_from_request(request: Request) -> dict:
    """Network details to store with an audit record."""
    return {
        "ip": request.client.host if request.client else None,
        "request_id": getattr(request.state, "request_id", None),
    }


def record(
    db: Session,
    *,
    action: str,
    entity_type: str,
    entity_id: str | None = None,
    actor_user_id: uuid.UUID | None = None,
    actor_roles: str | None = None,
    before: dict | None = None,
    after: dict | None = None,
    reason: str | None = None,
    ip: str | None = None,
    request_id: str | None = None,
) -> AuditLog:
    """Adds an audit row to the CURRENT transaction. The caller commits, so the action and
    its audit record succeed or fail together. Never put secrets or passwords in before/after."""
    entry = AuditLog(
        id=uuid.uuid4(),
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        actor_user_id=actor_user_id,
        actor_roles=actor_roles,
        before=before,
        after=after,
        reason=reason,
        ip=ip,
        request_id=request_id,
    )
    db.add(entry)
    return entry


def encode_cursor(entry: AuditLog) -> str:
    raw = f"{entry.created_at.isoformat()}|{entry.id}"
    return base64.urlsafe_b64encode(raw.encode("utf-8")).decode("ascii").rstrip("=")


def decode_cursor(cursor: str) -> tuple[datetime, uuid.UUID]:
    try:
        padded = cursor + "=" * (-len(cursor) % 4)
        raw = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
        timestamp, entry_id = raw.split("|", 1)
        return datetime.fromisoformat(timestamp), uuid.UUID(entry_id)
    except (ValueError, UnicodeError):
        raise ApiError(422, "INVALID_CURSOR", "The pagination cursor is not valid.") from None


def list_logs(
    db: Session,
    *,
    action: str | None,
    entity_type: str | None,
    entity_id: str | None,
    actor_user_id: uuid.UUID | None,
    limit: int,
    cursor: str | None,
) -> tuple[list[AuditLog], str | None]:
    """Newest first, keyset pagination on (created_at, id)."""
    stmt = select(AuditLog).order_by(AuditLog.created_at.desc(), AuditLog.id.desc())
    if action:
        stmt = stmt.where(AuditLog.action == action)
    if entity_type:
        stmt = stmt.where(AuditLog.entity_type == entity_type)
    if entity_id:
        stmt = stmt.where(AuditLog.entity_id == entity_id)
    if actor_user_id:
        stmt = stmt.where(AuditLog.actor_user_id == actor_user_id)
    if cursor:
        created_at, entry_id = decode_cursor(cursor)
        stmt = stmt.where(
            or_(
                AuditLog.created_at < created_at,
                and_(AuditLog.created_at == created_at, AuditLog.id < entry_id),
            )
        )
    rows = list(db.scalars(stmt.limit(limit + 1)))
    page = rows[:limit]
    next_cursor = encode_cursor(page[-1]) if len(rows) > limit else None
    return page, next_cursor
