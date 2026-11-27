"""Google sign-in, emailed codes, developer profiles and demo games

Revision ID: 0009_google_signin_developers
Revises: 0008_friends
Create Date: 2026-11-25
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0009_google_signin_developers"
down_revision: str | None = "0008_friends"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    # Accounts that only use Google have no password.
    with op.batch_alter_table("users") as batch:
        batch.alter_column("password_hash", existing_type=sa.String(length=255), nullable=True)

    op.create_table(
        "auth_identities",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("provider", sa.String(length=16), nullable=False),
        sa.Column("subject", sa.String(length=255), nullable=False),
        sa.Column("email", sa.String(length=320), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.CheckConstraint("provider IN ('google')", name="ck_auth_identities_provider_valid"),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="fk_auth_identities_user_id_users", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_auth_identities"),
        sa.UniqueConstraint("provider", "subject", name="uq_auth_identities_provider_subject"),
    )
    op.create_index("ix_auth_identities_user_id", "auth_identities", ["user_id"])

    op.create_table(
        "login_tickets",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("ticket_hash", sa.String(length=64), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("code_challenge", sa.String(length=64), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="fk_login_tickets_user_id_users", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_login_tickets"),
        sa.UniqueConstraint("ticket_hash", name="uq_login_tickets_ticket_hash"),
    )
    op.create_index("ix_login_tickets_user_id", "login_tickets", ["user_id"])

    op.create_table(
        "email_codes",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("purpose", sa.String(length=16), nullable=False),
        sa.Column("code_hash", sa.String(length=64), nullable=False),
        sa.Column("attempts", sa.Integer(), server_default="0", nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="fk_email_codes_user_id_users", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("id", name="pk_email_codes"),
    )
    op.create_index("ix_email_codes_user_id", "email_codes", ["user_id"])

    op.create_table(
        "developer_profiles",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("terms_version", sa.String(length=16), nullable=False),
        sa.Column("terms_accepted_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_developer_profiles_user_id_users",
            ondelete="CASCADE",
        ),
        sa.PrimaryKeyConstraint("user_id", name="pk_developer_profiles"),
    )

    # Games that already exist were not created as demos, so they stay "full". New games default
    # to "demo" while the store only accepts demos.
    with op.batch_alter_table("games") as batch:
        batch.add_column(
            sa.Column("release_kind", sa.String(length=8), server_default="full", nullable=False)
        )
        batch.create_check_constraint(
            "ck_games_release_kind_valid", "release_kind IN ('demo', 'full')"
        )
    with op.batch_alter_table("games") as batch:
        batch.alter_column(
            "release_kind",
            existing_type=sa.String(length=8),
            server_default="demo",
            existing_nullable=False,
        )


def downgrade() -> None:
    with op.batch_alter_table("games") as batch:
        batch.drop_constraint("ck_games_release_kind_valid", type_="check")
        batch.drop_column("release_kind")
    op.drop_table("developer_profiles")
    op.drop_index("ix_email_codes_user_id", table_name="email_codes")
    op.drop_table("email_codes")
    op.drop_index("ix_login_tickets_user_id", table_name="login_tickets")
    op.drop_table("login_tickets")
    op.drop_index("ix_auth_identities_user_id", table_name="auth_identities")
    op.drop_table("auth_identities")
    # Google-only accounts have no password, so put an unusable one back before restoring NOT NULL.
    op.execute("UPDATE users SET password_hash = '!' WHERE password_hash IS NULL")
    with op.batch_alter_table("users") as batch:
        batch.alter_column("password_hash", existing_type=sa.String(length=255), nullable=False)
