import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import CheckConstraint, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime, utcnow


class StudioStatus(StrEnum):
    PENDING = "pending"
    VERIFIED = "verified"
    SUSPENDED = "suspended"


class StudioRole(StrEnum):
    OWNER = "owner"
    MANAGER = "manager"
    DEVELOPER = "developer"
    FINANCE = "finance"


_STATUS_LIST = ", ".join(f"'{s.value}'" for s in StudioStatus)
_ROLE_LIST = ", ".join(f"'{r.value}'" for r in StudioRole)


class Studio(Base):
    __tablename__ = "studios"
    __table_args__ = (CheckConstraint(f"status IN ({_STATUS_LIST})", name="status_valid"),)

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(60))
    slug: Mapped[str] = mapped_column(String(60), unique=True)
    status: Mapped[str] = mapped_column(String(12), default="pending", server_default="pending")
    verified_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class StudioMembership(Base):
    __tablename__ = "studio_memberships"
    __table_args__ = (CheckConstraint(f"role IN ({_ROLE_LIST})", name="role_valid"),)

    studio_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("studios.id", ondelete="CASCADE"), primary_key=True
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True
    )
    role: Mapped[str] = mapped_column(String(12))
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
