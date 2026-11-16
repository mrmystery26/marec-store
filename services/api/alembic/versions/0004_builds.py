"""game builds and build files

Revision ID: 0004_builds
Revises: 0003_studios_catalog
Create Date: 2026-10-25
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004_builds"
down_revision: str | None = "0003_studios_catalog"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

BUILD_STATUS_VALUES = "'uploading', 'ready', 'revoked'"
SCAN_STATUS_VALUES = "'not_scanned', 'clean', 'infected', 'error'"
PLATFORM_VALUES = "'windows-x64'"


def upgrade() -> None:
    op.create_table(
        "game_builds",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("game_id", sa.Uuid(), nullable=False),
        sa.Column("version", sa.String(length=32), nullable=False),
        sa.Column("platform", sa.String(length=16), nullable=False),
        sa.Column("release_notes", sa.String(length=2000), nullable=True),
        sa.Column("status", sa.String(length=12), server_default="uploading", nullable=False),
        sa.Column(
            "scan_status", sa.String(length=12), server_default="not_scanned", nullable=False
        ),
        sa.Column("total_size_bytes", sa.BigInteger(), server_default="0", nullable=False),
        sa.Column("file_count", sa.Integer(), server_default="0", nullable=False),
        sa.Column("manifest_key", sa.String(length=200), nullable=True),
        sa.Column("manifest_sha256", sa.String(length=64), nullable=True),
        sa.Column("manifest_signature", sa.String(length=128), nullable=True),
        sa.Column("signing_kid", sa.String(length=16), nullable=True),
        sa.Column("created_by", sa.Uuid(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("ready_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_reason", sa.String(length=500), nullable=True),
        sa.ForeignKeyConstraint(
            ["game_id"], ["games.id"], name="fk_game_builds_game_id_games", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_game_builds"),
        sa.UniqueConstraint("game_id", "version", "platform", name="uq_game_builds_game_version"),
        sa.CheckConstraint(
            f"status IN ({BUILD_STATUS_VALUES})", name="ck_game_builds_status_valid"
        ),
        sa.CheckConstraint(
            f"scan_status IN ({SCAN_STATUS_VALUES})", name="ck_game_builds_scan_status_valid"
        ),
        sa.CheckConstraint(
            f"platform IN ({PLATFORM_VALUES})", name="ck_game_builds_platform_valid"
        ),
        sa.CheckConstraint("total_size_bytes >= 0", name="ck_game_builds_total_size_non_negative"),
    )
    op.create_index("ix_game_builds_game_id", "game_builds", ["game_id"])

    op.create_table(
        "build_files",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("build_id", sa.Uuid(), nullable=False),
        sa.Column("path", sa.String(length=240), nullable=False),
        sa.Column("size_bytes", sa.BigInteger(), nullable=False),
        sa.Column("sha256", sa.String(length=64), nullable=False),
        sa.Column("object_key", sa.String(length=200), nullable=False),
        sa.ForeignKeyConstraint(
            ["build_id"],
            ["game_builds.id"],
            name="fk_build_files_build_id_game_builds",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_build_files"),
        sa.UniqueConstraint("build_id", "path", name="uq_build_files_build_id_path"),
        sa.CheckConstraint("size_bytes >= 0", name="ck_build_files_size_non_negative"),
    )


def downgrade() -> None:
    op.drop_table("build_files")
    op.drop_index("ix_game_builds_game_id", table_name="game_builds")
    op.drop_table("game_builds")
