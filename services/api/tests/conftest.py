import os

# Force a throwaway test configuration BEFORE the app is imported, so a developer's real
# DATABASE_URL can never be used (the fixtures create and drop all tables).
TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ["ENVIRONMENT"] = "test"
os.environ["DATABASE_URL"] = TEST_DATABASE_URL
os.environ["JWT_SECRET"] = "test-only-secret-test-only-secret-1234"

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from app.modules.auth import models as _auth_models  # noqa: E402,F401
from app.core.db import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402

_url = make_url(TEST_DATABASE_URL)
if _url.get_backend_name() != "sqlite" and "test" not in (_url.database or ""):
    raise RuntimeError("Refusing to run tests: the database name must contain 'test'.")


@pytest.fixture()
def engine():
    if _url.get_backend_name() == "sqlite":
        eng = create_engine(
            TEST_DATABASE_URL, connect_args={"check_same_thread": False}, poolclass=StaticPool
        )
    else:
        eng = create_engine(TEST_DATABASE_URL)
    Base.metadata.drop_all(eng)
    Base.metadata.create_all(eng)
    yield eng
    Base.metadata.drop_all(eng)
    eng.dispose()


@pytest.fixture()
def db_session(engine):
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)
    with factory() as session:
        yield session


@pytest.fixture()
def client(engine):
    factory = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)

    def override_get_db():
        with factory() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
