import uuid
from datetime import datetime
from enum import StrEnum

from sqlalchemy import CheckConstraint, ForeignKey, String, UniqueConstraint, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime, utcnow


class FriendshipStatus(StrEnum):
    PENDING = "pending"
    ACCEPTED = "accepted"
    DECLINED = "declined"


_STATUS_LIST = ", ".join(f"'{s.value}'" for s in FriendshipStatus)


class FriendCode(Base):
    """The code a player gives to others so they can send a friend request. One per player.
    Adding by code (not by email or name) means nobody can look up who has an account."""

    __tablename__ = "friend_codes"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), unique=True
    )
    code: Mapped[str] = mapped_column(String(8), unique=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)


class Friendship(Base):
    """One row per pair of players, whichever of them asked first. The two ids are stored in
    sorted order (user_low_id < user_high_id) so the unique constraint stops a pair from ever
    having two rows. `requested_by` says who asked."""

    __tablename__ = "friendships"
    __table_args__ = (
        UniqueConstraint("user_low_id", "user_high_id", name="uq_friendships_pair"),
        CheckConstraint("user_low_id < user_high_id", name="pair_ordered"),
        CheckConstraint(
            "requested_by = user_low_id OR requested_by = user_high_id", name="requester_in_pair"
        ),
        CheckConstraint(f"status IN ({_STATUS_LIST})", name="status_valid"),
        CheckConstraint(
            "(status = 'pending' AND responded_at IS NULL) "
            "OR (status <> 'pending' AND responded_at IS NOT NULL)",
            name="responded_consistent",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    user_low_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    user_high_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True
    )
    requested_by: Mapped[uuid.UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    status: Mapped[str] = mapped_column(String(8), default="pending", server_default="pending")
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    responded_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
