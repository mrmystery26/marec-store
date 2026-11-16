"""devices and launch authorizations

Revision ID: 0006_launch
Revises: 0005_entitlements
Create Date: 2026-10-26
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0006_launch"
down_revision: str | None = "0005_entitlements"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

KIND_VALUES = "'online', 'lease', 'dev'"
STATUS_VALUES = "'issued', 'redeemed', 'revoked'"


def upgrade() -> None:
    op.create_table(
        "devices",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("device_key_hash", sa.String(length=64), nullable=False),
        sa.Column("label", sa.String(length=80), nullable=True),
        sa.Column("first_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="fk_devices_user_id_users", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_devices"),
        sa.UniqueConstraint("user_id", "device_key_hash", name="uq_devices_user_device"),
    )
    op.create_index("ix_devices_user_id", "devices", ["user_id"])

    op.create_table(
        "launch_authorizations",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("game_id", sa.Uuid(), nullable=False),
        sa.Column("build_id", sa.Uuid(), nullable=False),
        sa.Column("device_id", sa.Uuid(), nullable=False),
        sa.Column("kind", sa.String(length=8), nullable=False),
        sa.Column("nonce", sa.String(length=64), nullable=True),
        sa.Column("status", sa.String(length=8), server_default="issued", nullable=False),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("redeemed_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_launch_authorizations_user_id_users",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["game_id"],
            ["games.id"],
            name="fk_launch_authorizations_game_id_games",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["build_id"],
            ["game_builds.id"],
            name="fk_launch_authorizations_build_id_game_builds",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["device_id"],
            ["devices.id"],
            name="fk_launch_authorizations_device_id_devices",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_launch_authorizations"),
        sa.CheckConstraint(
            f"kind IN ({KIND_VALUES})", name="ck_launch_authorizations_kind_valid"
        ),
        sa.CheckConstraint(
            f"status IN ({STATUS_VALUES})", name="ck_launch_authorizations_status_valid"
        ),
    )
    op.create_index("ix_launch_authorizations_user_id", "launch_authorizations", ["user_id"])
    op.create_index("ix_launch_authorizations_device_id", "launch_authorizations", ["device_id"])


def downgrade() -> None:
    op.drop_index("ix_launch_authorizations_device_id", table_name="launch_authorizations")
    op.drop_index("ix_launch_authorizations_user_id", table_name="launch_authorizations")
    op.drop_table("launch_authorizations")
    op.drop_index("ix_devices_user_id", table_name="devices")
    op.drop_table("devices")
