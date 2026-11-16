"""user_roles and audit_logs (append-only on PostgreSQL)

Revision ID: 0002_roles_audit
Revises: 0001_users_sessions
Create Date: 2026-10-24
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision: str = "0002_roles_audit"
down_revision: str | None = "0001_users_sessions"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None

JSON_TYPE = sa.JSON().with_variant(postgresql.JSONB(), "postgresql")

ROLE_VALUES = (
    "'super_admin', 'store_admin', 'game_moderator', "
    "'customer_support', 'finance_admin', 'developer'"
)


def upgrade() -> None:
    op.create_table(
        "user_roles",
        sa.Column("user_id", sa.Uuid(), nullable=False),
        sa.Column("role", sa.String(length=32), nullable=False),
        sa.Column("granted_by", sa.Uuid(), nullable=True),
        sa.Column("granted_at", sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="fk_user_roles_user_id_users", ondelete="CASCADE"
        ),
        sa.PrimaryKeyConstraint("user_id", "role", name="pk_user_roles"),
        sa.CheckConstraint(f"role IN ({ROLE_VALUES})", name="ck_user_roles_role_valid"),
    )

    op.create_table(
        "audit_logs",
        sa.Column("id", sa.Uuid(), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False
        ),
        sa.Column("actor_user_id", sa.Uuid(), nullable=True),
        sa.Column("actor_roles", sa.String(length=200), nullable=True),
        sa.Column("action", sa.String(length=64), nullable=False),
        sa.Column("entity_type", sa.String(length=32), nullable=False),
        sa.Column("entity_id", sa.String(length=64), nullable=True),
        sa.Column("reason", sa.String(length=500), nullable=True),
        sa.Column("before", JSON_TYPE, nullable=True),
        sa.Column("after", JSON_TYPE, nullable=True),
        sa.Column("ip", sa.String(length=45), nullable=True),
        sa.Column("request_id", sa.String(length=64), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_audit_logs"),
    )
    op.create_index("ix_audit_logs_created_at", "audit_logs", ["created_at"])
    op.create_index("ix_audit_logs_actor_user_id", "audit_logs", ["actor_user_id"])
    op.create_index("ix_audit_logs_action", "audit_logs", ["action"])
    op.create_index("ix_audit_logs_entity", "audit_logs", ["entity_type", "entity_id"])

    if op.get_bind().dialect.name == "postgresql":
        op.execute(
            """
            CREATE FUNCTION audit_logs_block_mutation() RETURNS trigger AS $$
            BEGIN
                RAISE EXCEPTION 'audit_logs is append-only';
            END;
            $$ LANGUAGE plpgsql
            """
        )
        op.execute(
            """
            CREATE TRIGGER audit_logs_no_update_delete
            BEFORE UPDATE OR DELETE ON audit_logs
            FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation()
            """
        )
        op.execute(
            """
            CREATE TRIGGER audit_logs_no_truncate
            BEFORE TRUNCATE ON audit_logs
            FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_block_mutation()
            """
        )


def downgrade() -> None:
    # Dropping the table also drops its triggers; the function is dropped afterwards.
    op.drop_index("ix_audit_logs_entity", table_name="audit_logs")
    op.drop_index("ix_audit_logs_action", table_name="audit_logs")
    op.drop_index("ix_audit_logs_actor_user_id", table_name="audit_logs")
    op.drop_index("ix_audit_logs_created_at", table_name="audit_logs")
    op.drop_table("audit_logs")
    if op.get_bind().dialect.name == "postgresql":
        op.execute("DROP FUNCTION audit_logs_block_mutation()")
    op.drop_table("user_roles")
