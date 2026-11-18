"""friend codes and friendships

Revision ID: 0008_friends
Revises: 0007_build_entry_point
Create Date: 2026-11-17
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008_friends"
down_revision: str | None = "0007_build_entry_point"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

STATUS_VALUES = "'pending', 'accepted', 'declined'"


def upgrade() -> None:
    op.create_table(
        "friend_codes",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("code", sa.String(length=8), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="fk_friend_codes_user_id_users", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_friend_codes"),
        sa.UniqueConstraint("user_id", name="uq_friend_codes_user_id"),
        sa.UniqueConstraint("code", name="uq_friend_codes_code"),
    )
    op.create_table(
        "friendships",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_low_id", sa.Uuid(), nullable=False),
        sa.Column("user_high_id", sa.Uuid(), nullable=False),
        sa.Column("requested_by", sa.Uuid(), nullable=False),
        sa.Column("status", sa.String(length=8), server_default="pending", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("responded_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["user_low_id"],
            ["users.id"],
            name="fk_friendships_user_low_id_users",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_high_id"],
            ["users.id"],
            name="fk_friendships_user_high_id_users",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["requested_by"],
            ["users.id"],
            name="fk_friendships_requested_by_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_friendships"),
        sa.UniqueConstraint("user_low_id", "user_high_id", name="uq_friendships_pair"),
        sa.CheckConstraint("user_low_id < user_high_id", name="ck_friendships_pair_ordered"),
        sa.CheckConstraint(
            "requested_by = user_low_id OR requested_by = user_high_id",
            name="ck_friendships_requester_in_pair",
        ),
        sa.CheckConstraint(f"status IN ({STATUS_VALUES})", name="ck_friendships_status_valid"),
        sa.CheckConstraint(
            "(status = 'pending' AND responded_at IS NULL) "
            "OR (status <> 'pending' AND responded_at IS NOT NULL)",
            name="ck_friendships_responded_consistent",
        ),
    )
    op.create_index("ix_friendships_user_high_id", "friendships", ["user_high_id"])


def downgrade() -> None:
    op.drop_index("ix_friendships_user_high_id", table_name="friendships")
    op.drop_table("friendships")
    op.drop_table("friend_codes")
