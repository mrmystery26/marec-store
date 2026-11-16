import uuid
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.exc import DBAPIError

from app.core.db import Base


def test_audit_logs_reject_update_delete_and_truncate(engine):
    if engine.dialect.name != "postgresql":
        pytest.skip("The append-only trigger exists on PostgreSQL only.")

    # Build the schema with the real migrations (the fixtures used create_all instead).
    Base.metadata.drop_all(engine)
    root = Path(__file__).resolve().parents[1]
    config = Config(str(root / "alembic.ini"))
    config.set_main_option("script_location", str(root / "alembic"))
    command.upgrade(config, "head")
    try:
        insert = text(
            "INSERT INTO audit_logs (id, action, entity_type) VALUES (:id, 'test.event', 'test')"
        )
        with engine.begin() as connection:
            connection.execute(insert, {"id": uuid.uuid4()})

        for statement in (
            "UPDATE audit_logs SET action = 'tampered'",
            "DELETE FROM audit_logs",
            "TRUNCATE audit_logs",
        ):
            with pytest.raises(DBAPIError):
                with engine.begin() as connection:
                    connection.execute(text(statement))

        with engine.connect() as connection:
            assert connection.execute(text("SELECT count(*) FROM audit_logs")).scalar() == 1
    finally:
        command.downgrade(config, "base")
