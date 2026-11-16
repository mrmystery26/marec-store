import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import CheckConstraint, ForeignKey, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime, utcnow


class EntitlementSource(StrEnum):
    PURCHASE = "purchase"
    FREE = "free"
    GIFT = "gift"
    DEVELOPER = "developer"


class EntitlementStatus(StrEnum):
    ACTIVE = "active"
    REVOKED = "revoked"


_SOURCE_LIST = ", ".join(f"'{s.value}'" for s in EntitlementSource)
_STATUS_LIST = ", ".join(f"'{s.value}'" for s in EntitlementStatus)


class GameEntitlement(Base):
    """The record that a user owns a game. Backend-authoritative: launchers and games never
    decide ownership. One row per user and game."""

    __tablename__ = "game_entitlements"
    __table_args__ = (
        UniqueConstraint("user_id", "game_id", name="uq_game_entitlements_user_game"),
        CheckConstraint(f"source IN ({_SOURCE_LIST})", name="source_valid"),
        CheckConstraint(f"status IN ({_STATUS_LIST})", name="status_valid"),
        CheckConstraint(
            "(status = 'revoked' AND revoked_at IS NOT NULL) "
            "OR (status = 'active' AND revoked_at IS NULL)",
            name="revoked_consistent",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    game_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("games.id", ondelete="RESTRICT"), index=True
    )
    source: Mapped[str] = mapped_column(String(12))
    # Filled in once orders exist (purchases and refunds point back here).
    order_item_id: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    status: Mapped[str] = mapped_column(String(8), default="active", server_default="active")
    granted_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    revoked_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
