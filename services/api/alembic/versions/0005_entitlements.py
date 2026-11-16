"""game entitlements (who owns what)

Revision ID: 0005_entitlements
Revises: 0004_builds
Create Date: 2026-10-26
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0005_entitlements"
down_revision: str | None = "0004_builds"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

SOURCE_VALUES = "'purchase', 'free', 'gift', 'developer'"
STATUS_VALUES = "'active', 'revoked'"


def upgrade() -> None:
    op.create_table(
        "game_entitlements",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("game_id", sa.Uuid(), nullable=False),
        sa.Column("source", sa.String(length=12), nullable=False),
        sa.Column("order_item_id", sa.Uuid(), nullable=True),
        sa.Column("status", sa.String(length=8), server_default="active", nullable=False),
        sa.Column("granted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_reason", sa.String(length=500), nullable=True),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_game_entitlements_user_id_users",
            ondelete="RESTRICT",
        ),
        sa.ForeignKeyConstraint(
            ["game_id"],
            ["games.id"],
            name="fk_game_entitlements_game_id_games",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_game_entitlements"),
        sa.UniqueConstraint("user_id", "game_id", name="uq_game_entitlements_user_game"),
        sa.CheckConstraint(
            f"source IN ({SOURCE_VALUES})", name="ck_game_entitlements_source_valid"
        ),
        sa.CheckConstraint(
            f"status IN ({STATUS_VALUES})", name="ck_game_entitlements_status_valid"
        ),
        sa.CheckConstraint(
            "(status = 'revoked' AND revoked_at IS NOT NULL) "
            "OR (status = 'active' AND revoked_at IS NULL)",
            name="ck_game_entitlements_revoked_consistent",
        ),
    )
    op.create_index("ix_game_entitlements_game_id", "game_entitlements", ["game_id"])


def downgrade() -> None:
    op.drop_index("ix_game_entitlements_game_id", table_name="game_entitlements")
    op.drop_table("game_entitlements")
