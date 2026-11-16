from logging.config import fileConfig

from alembic import context
from sqlalchemy import create_engine, pool

import app.modules.audit.models  # noqa: F401  (registers tables on Base.metadata)
import app.modules.auth.models  # noqa: F401
import app.modules.builds.models  # noqa: F401
import app.modules.catalog.models  # noqa: F401
import app.modules.launch.models  # noqa: F401
import app.modules.library.models  # noqa: F401
import app.modules.rbac.models  # noqa: F401
import app.modules.studios.models  # noqa: F401
from app.core.config import get_settings
from app.core.db import Base

config = context.config
if config.config_file_name is not None:
    fileConfig(config.config_file_name, disable_existing_loggers=False)

target_metadata = Base.metadata


def run_migrations_offline() -> None:
    context.configure(
        url=get_settings().database_url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
        compare_type=True,
    )
    with context.begin_transaction():
        context.run_migrations()


def run_migrations_online() -> None:
    connectable = create_engine(get_settings().database_url, poolclass=pool.NullPool)
    with connectable.connect() as connection:
        context.configure(connection=connection, target_metadata=target_metadata, compare_type=True)
        with context.begin_transaction():
            context.run_migrations()


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
