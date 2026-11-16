"""studios, categories, games, requirements

Revision ID: 0003_studios_catalog
Revises: 0002_roles_audit
Create Date: 2026-10-25
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0003_studios_catalog"
down_revision: str | None = "0002_roles_audit"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

STUDIO_STATUS_VALUES = "'pending', 'verified', 'suspended'"
STUDIO_ROLE_VALUES = "'owner', 'manager', 'developer', 'finance'"
GAME_STATUS_VALUES = (
    "'draft', 'submitted', 'under_review', 'changes_requested', 'approved', "
    "'scheduled', 'published', 'suspended', 'removed'"
)
AGE_RATING_VALUES = "'3+', '7+', '12+', '16+', '18+'"
TIER_VALUES = "'minimum', 'recommended'"


def upgrade() -> None:
    op.create_table(
        "studios",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("slug", sa.String(length=60), nullable=False),
        sa.Column("status", sa.String(length=12), server_default="pending", nullable=False),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_studios"),
        sa.UniqueConstraint("slug", name="uq_studios_slug"),
        sa.CheckConstraint(f"status IN ({STUDIO_STATUS_VALUES})", name="ck_studios_status_valid"),
    )

    op.create_table(
        "studio_memberships",
        sa.Column("studio_id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.String(length=12), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["studio_id"],
            ["studios.id"],
            name="fk_studio_memberships_studio_id_studios",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_studio_memberships_user_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("studio_id", "user_id", name="pk_studio_memberships"),
        sa.CheckConstraint(
            f"role IN ({STUDIO_ROLE_VALUES})", name="ck_studio_memberships_role_valid"
        ),
    )
    op.create_index("ix_studio_memberships_user_id", "studio_memberships", ["user_id"])

    op.create_table(
        "categories",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("slug", sa.String(length=60), nullable=False),
        sa.Column("name", sa.String(length=60), nullable=False),
        sa.Column("sort_order", sa.Integer(), server_default="0", nullable=False),
        sa.PrimaryKeyConstraint("id", name="pk_categories"),
        sa.UniqueConstraint("slug", name="uq_categories_slug"),
        sa.UniqueConstraint("name", name="uq_categories_name"),
    )

    op.create_table(
        "games",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("studio_id", sa.Uuid(), nullable=False),
        sa.Column("slug", sa.String(length=60), nullable=False),
        sa.Column("title", sa.String(length=80), nullable=False),
        sa.Column("summary", sa.String(length=280), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("status", sa.String(length=20), server_default="draft", nullable=False),
        sa.Column("status_reason", sa.String(length=500), nullable=True),
        sa.Column("price_minor", sa.BigInteger(), nullable=True),
        sa.Column("currency", sa.String(length=3), server_default="MWK", nullable=False),
        sa.Column("age_rating", sa.String(length=4), nullable=True),
        sa.Column("protection_level", sa.Integer(), server_default="1", nullable=False),
        sa.Column("offline_days", sa.Integer(), server_default="7", nullable=False),
        sa.Column("release_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["studio_id"], ["studios.id"], name="fk_games_studio_id_studios", ondelete="RESTRICT"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_games"),
        sa.UniqueConstraint("slug", name="uq_games_slug"),
        sa.CheckConstraint(f"status IN ({GAME_STATUS_VALUES})", name="ck_games_status_valid"),
        sa.CheckConstraint(
            "price_minor IS NULL OR price_minor >= 0", name="ck_games_price_non_negative"
        ),
        sa.CheckConstraint(
            "protection_level BETWEEN 0 AND 3", name="ck_games_protection_level_range"
        ),
        sa.CheckConstraint("offline_days BETWEEN 0 AND 30", name="ck_games_offline_days_range"),
        sa.CheckConstraint(
            f"age_rating IS NULL OR age_rating IN ({AGE_RATING_VALUES})",
            name="ck_games_age_rating_valid",
        ),
    )
    op.create_index("ix_games_studio_id", "games", ["studio_id"])
    op.create_index("ix_games_status", "games", ["status"])

    op.create_table(
        "game_categories",
        sa.Column("game_id", sa.Uuid(), nullable=False),
        sa.Column("category_id", sa.Uuid(), nullable=False),
        sa.ForeignKeyConstraint(
            ["game_id"], ["games.id"], name="fk_game_categories_game_id_games", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["category_id"],
            ["categories.id"],
            name="fk_game_categories_category_id_categories",
            ondelete="RESTRICT",
        ),
        sa.PrimaryKeyConstraint("game_id", "category_id", name="pk_game_categories"),
    )
    op.create_index("ix_game_categories_category_id", "game_categories", ["category_id"])

    op.create_table(
        "system_requirements",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("game_id", sa.Uuid(), nullable=False),
        sa.Column("tier", sa.String(length=12), nullable=False),
        sa.Column("os", sa.String(length=80), nullable=False),
        sa.Column("cpu", sa.String(length=120), nullable=False),
        sa.Column("ram_mb", sa.Integer(), nullable=False),
        sa.Column("gpu", sa.String(length=120), server_default="", nullable=False),
        sa.Column("storage_mb", sa.Integer(), nullable=False),
        sa.ForeignKeyConstraint(
            ["game_id"],
            ["games.id"],
            name="fk_system_requirements_game_id_games",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("id", name="pk_system_requirements"),
        sa.UniqueConstraint("game_id", "tier", name="uq_system_requirements_game_id_tier"),
        sa.CheckConstraint(f"tier IN ({TIER_VALUES})", name="ck_system_requirements_tier_valid"),
    )


def downgrade() -> None:
    op.drop_table("system_requirements")
    op.drop_index("ix_game_categories_category_id", table_name="game_categories")
    op.drop_table("game_categories")
    op.drop_index("ix_games_status", table_name="games")
    op.drop_index("ix_games_studio_id", table_name="games")
    op.drop_table("games")
    op.drop_table("categories")
    op.drop_index("ix_studio_memberships_user_id", table_name="studio_memberships")
    op.drop_table("studio_memberships")
    op.drop_table("studios")
