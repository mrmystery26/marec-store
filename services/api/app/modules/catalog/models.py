import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime, utcnow
from app.modules.catalog.states import GameStatus

AGE_RATINGS = ("3+", "7+", "12+", "16+", "18+")
REQUIREMENT_TIERS = ("minimum", "recommended")

_STATUS_LIST = ", ".join(f"'{s.value}'" for s in GameStatus)
_AGE_LIST = ", ".join(f"'{a}'" for a in AGE_RATINGS)
_TIER_LIST = ", ".join(f"'{t}'" for t in REQUIREMENT_TIERS)


class Category(Base):
    __tablename__ = "categories"

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    slug: Mapped[str] = mapped_column(String(60), unique=True)
    name: Mapped[str] = mapped_column(String(60), unique=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, server_default="0")


class Game(Base):
    __tablename__ = "games"
    __table_args__ = (
        CheckConstraint(f"status IN ({_STATUS_LIST})", name="status_valid"),
        CheckConstraint("price_minor IS NULL OR price_minor >= 0", name="price_non_negative"),
        CheckConstraint("protection_level BETWEEN 0 AND 3", name="protection_level_range"),
        CheckConstraint("offline_days BETWEEN 0 AND 30", name="offline_days_range"),
        CheckConstraint(
            f"age_rating IS NULL OR age_rating IN ({_AGE_LIST})", name="age_rating_valid"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    studio_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("studios.id", ondelete="RESTRICT"), index=True
    )
    slug: Mapped[str] = mapped_column(String(60), unique=True)
    title: Mapped[str] = mapped_column(String(80))
    summary: Mapped[str | None] = mapped_column(String(280), nullable=True)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[str] = mapped_column(
        String(20), default="draft", server_default="draft", index=True
    )
    status_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # Money is stored in tambala (1 kwacha = 100 tambala). NULL means "not set yet".
    price_minor: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    currency: Mapped[str] = mapped_column(String(3), default="MWK", server_default="MWK")
    age_rating: Mapped[str | None] = mapped_column(String(4), nullable=True)
    protection_level: Mapped[int] = mapped_column(Integer, default=1, server_default="1")
    offline_days: Mapped[int] = mapped_column(Integer, default=7, server_default="7")
    release_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    updated_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow, onupdate=utcnow)


class GameCategory(Base):
    __tablename__ = "game_categories"

    game_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("games.id", ondelete="CASCADE"), primary_key=True
    )
    category_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("categories.id", ondelete="RESTRICT"), primary_key=True, index=True
    )


class SystemRequirement(Base):
    __tablename__ = "system_requirements"
    __table_args__ = (
        CheckConstraint(f"tier IN ({_TIER_LIST})", name="tier_valid"),
        UniqueConstraint("game_id", "tier", name="uq_system_requirements_game_id_tier"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    game_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("games.id", ondelete="CASCADE"))
    tier: Mapped[str] = mapped_column(String(12))
    os: Mapped[str] = mapped_column(String(80))
    cpu: Mapped[str] = mapped_column(String(120))
    ram_mb: Mapped[int] = mapped_column(Integer)
    gpu: Mapped[str] = mapped_column(String(120), default="", server_default="")
    storage_mb: Mapped[int] = mapped_column(Integer)
