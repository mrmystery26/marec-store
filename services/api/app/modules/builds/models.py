import uuid
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Integer,
    String,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime, utcnow

BUILD_STATUSES = ("uploading", "ready", "revoked")
SCAN_STATUSES = ("not_scanned", "clean", "infected", "error")
PLATFORMS = ("windows-x64",)

_STATUS_LIST = ", ".join(f"'{v}'" for v in BUILD_STATUSES)
_SCAN_LIST = ", ".join(f"'{v}'" for v in SCAN_STATUSES)
_PLATFORM_LIST = ", ".join(f"'{v}'" for v in PLATFORMS)


class GameBuild(Base):
    __tablename__ = "game_builds"
    __table_args__ = (
        UniqueConstraint("game_id", "version", "platform", name="uq_game_builds_game_version"),
        CheckConstraint(f"status IN ({_STATUS_LIST})", name="status_valid"),
        CheckConstraint(f"scan_status IN ({_SCAN_LIST})", name="scan_status_valid"),
        CheckConstraint(f"platform IN ({_PLATFORM_LIST})", name="platform_valid"),
        CheckConstraint("total_size_bytes >= 0", name="total_size_non_negative"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    game_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("games.id", ondelete="CASCADE"), index=True
    )
    version: Mapped[str] = mapped_column(String(32))
    platform: Mapped[str] = mapped_column(String(16))
    release_notes: Mapped[str | None] = mapped_column(String(2000), nullable=True)
    # The file the launcher starts (an .exe inside the build).
    entry_point: Mapped[str | None] = mapped_column(String(240), nullable=True)
    status: Mapped[str] = mapped_column(String(12), default="uploading", server_default="uploading")
    # "not_scanned" until a malware scanner is connected. Never shown as "clean" without a scan.
    scan_status: Mapped[str] = mapped_column(
        String(12), default="not_scanned", server_default="not_scanned"
    )
    total_size_bytes: Mapped[int] = mapped_column(BigInteger, default=0, server_default="0")
    file_count: Mapped[int] = mapped_column(Integer, default=0, server_default="0")
    manifest_key: Mapped[str | None] = mapped_column(String(200), nullable=True)
    manifest_sha256: Mapped[str | None] = mapped_column(String(64), nullable=True)
    manifest_signature: Mapped[str | None] = mapped_column(String(128), nullable=True)
    signing_kid: Mapped[str | None] = mapped_column(String(16), nullable=True)
    created_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    ready_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(UTCDateTime, nullable=True)
    revoked_reason: Mapped[str | None] = mapped_column(String(500), nullable=True)


class BuildFile(Base):
    __tablename__ = "build_files"
    __table_args__ = (
        UniqueConstraint("build_id", "path", name="uq_build_files_build_id_path"),
        CheckConstraint("size_bytes >= 0", name="size_non_negative"),
    )

    id: Mapped[uuid.UUID] = mapped_column(Uuid, primary_key=True, default=uuid.uuid4)
    build_id: Mapped[uuid.UUID] = mapped_column(ForeignKey("game_builds.id", ondelete="CASCADE"))
    path: Mapped[str] = mapped_column(String(240))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    sha256: Mapped[str] = mapped_column(String(64))
    object_key: Mapped[str] = mapped_column(String(200))
