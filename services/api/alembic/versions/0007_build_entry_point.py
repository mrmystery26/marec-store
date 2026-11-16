"""build entry point (the .exe the launcher starts)

Revision ID: 0007_build_entry_point
Revises: 0006_launch
Create Date: 2026-10-27
"""
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0007_build_entry_point"
down_revision: str | None = "0006_launch"
branch_labels: str | Sequence[str] | None = None
depends_on: str | Sequence[str] | None = None


def upgrade() -> None:
    op.add_column("game_builds", sa.Column("entry_point", sa.String(length=240), nullable=True))


def downgrade() -> None:
    op.drop_column("game_builds", "entry_point")
