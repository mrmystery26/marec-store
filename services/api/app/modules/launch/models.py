import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime, utcnow

LAUNCH_KINDS = ("online", "lease", "dev")
LAUNCH_STATUSES = ("issued", "redeemed", "revoked")

_KIND_LIST = ", ".join(f"'{v}'" for v in LAUNCH_KINDS)
_STATUS_LIST = ", ".join(f"'{v}'" for v in LAUNCH_STATUSES)


class Device(Base):
    """A PC a player has launched games on. The launcher keeps a random secret on the PC; only
    its SHA-256 is stored here."""

    __tablename__ = "devices"
    __table_args__ = (
        UniqueConstraint("user_id", "device_key_hash", name="uq_devices_user_device"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    device_key_hash: Mapped[str] = mapped_column(String(64))
    label: Mapped[str | None] = mapped_column(String(80), nullable=True)
    first_seen_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    last_seen_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)


class LaunchAuthorization(Base):
    """Every launch token and offline lease the backend has issued. The row id is the token's
    jti. Online and dev tokens are single use; leases are checked offline until they expire."""

    __tablename__ = "launch_authorizations"
    __table_args__ = (
        CheckConstraint(f"kind IN ({_KIND_LIST})", name="kind_valid"),
        CheckConstraint(f"status IN ({_STATUS_LIST})", name="status_valid"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    game_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"))
    build_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("game_builds.id", ondelete="CASCADE"))
    device_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("devices.id", ondelete="CASCADE"), index=True
    )
    kind: Mapped[str] = mapped_column(String(8))
    nonce: Mapped[str | None] = mapped_column(String(64), nullable=True)
    status: Mapped[str] = mapped_column(String(8), default="issued", server_default="issued")
    issued_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(UTCDateTime)
    redeemed_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
