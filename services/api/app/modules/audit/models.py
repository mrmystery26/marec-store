import uuid
from datetime import datetime

from sqlalchemy import JSON, Index, String, Uuid, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime, utcnow

JSON_TYPE = JSON().with_variant(JSONB(), "postgresql")


class AuditLog(Base):
    """Append-only record of sensitive actions. On PostgreSQL a trigger blocks UPDATE,
    DELETE and TRUNCATE (see migration 0002)."""

    __tablename__ = "audit_logs"
    __table_args__ = (Index("ix_audit_logs_entity", "entity_type", "entity_id"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    created_at: Mapped[datetime] = mapped_column(
        UTCDateTime, default=utcnow, server_default=func.now(), index=True
    )
    # No foreign key on purpose: log rows must outlive anything they refer to.
    actor_user_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True, index=True)
    actor_roles: Mapped[str | None] = mapped_column(String(200), nullable=True)
    action: Mapped[str] = mapped_column(String(64), index=True)
    entity_type: Mapped[str] = mapped_column(String(32))
    entity_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
    reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
    before: Mapped[dict | None] = mapped_column(JSON_TYPE, nullable=True)
    after: Mapped[dict | None] = mapped_column(JSON_TYPE, nullable=True)
    ip: Mapped[str | None] = mapped_column(String(45), nullable=True)
    request_id: Mapped[str | None] = mapped_column(String(64), nullable=True)
