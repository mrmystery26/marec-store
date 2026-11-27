import base64
import os

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

# Force a throwaway test configuration BEFORE the app is imported, so a developer's real
# DATABASE_URL can never be used (the fixtures create and drop all tables).
TEST_DATABASE_URL = os.environ.get("TEST_DATABASE_URL", "sqlite+pysqlite:///:memory:")
os.environ["ENVIRONMENT"] = "test"
# The older tests exercise full (priced) games; the demo-only rules have their own tests.
os.environ["DEMO_ONLY"] = "false"
# Never let a developer's real keys leak into tests.
for _name in ("GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET", "RESEND_API_KEY", "EMAIL_FROM"):
    os.environ.pop(_name, None)
os.environ["DATABASE_URL"] = TEST_DATABASE_URL
os.environ["JWT_SECRET"] = "test-only-secret-test-only-secret-1234"
os.environ["MANIFEST_SIGNING_KEY"] = base64.b64encode(bytes(range(32))).decode()
_launch_key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
os.environ["LAUNCH_SIGNING_KEY"] = base64.b64encode(
    _launch_key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
).decode()

import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine  # noqa: E402
from sqlalchemy.engine import make_url  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402
from sqlalchemy.pool import StaticPool  # noqa: E402

from app.modules.auth import models as _auth_models  # noqa: E402,F401
from app.core.config import get_settings  # noqa: E402
from app.core.db import Base, get_db  # noqa: E402
from app.core.email import MemorySender, get_email_sender  # noqa: E402
from app.core.google import get_google_client  # noqa: E402
from app.core.storage import LocalStorage, get_storage  # noqa: E402
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
def session_factory(engine):
    return sessionmaker(bind=engine, autoflush=False, expire_on_commit=False)


@pytest.fixture()
def db_session(session_factory):
    with session_factory() as session:
        yield session


@pytest.fixture()
def storage(tmp_path):
    return LocalStorage(tmp_path / "storage", b"test-secret", "http://testserver")


@pytest.fixture()
def email_sender():
    """Collects every email the API would send. Nothing leaves the test."""
    return MemorySender()


@pytest.fixture()
def google_client():
    """A stand-in for Google, filled in by the tests that need it."""
    from tests.fake_google import FakeGoogle

    return FakeGoogle()


@pytest.fixture()
def settings():
    """The live settings object. Changes made by a test are undone afterwards."""
    live = get_settings()
    saved = live.model_dump()
    yield live
    for name, value in saved.items():
        setattr(live, name, value)


@pytest.fixture()
def google_on(settings):
    """Sign in with Google switched on, with test credentials."""
    from pydantic import SecretStr

    settings.google_client_id = "client-id.apps.googleusercontent.com"
    settings.google_client_secret = SecretStr("client-secret")
    settings.public_api_base_url = "https://api.test"
    return settings


@pytest.fixture()
def client(session_factory, storage, email_sender, google_client):
    def override_get_db():
        with session_factory() as session:
            yield session

    app.dependency_overrides[get_db] = override_get_db
    app.dependency_overrides[get_storage] = lambda: storage
    app.dependency_overrides[get_email_sender] = lambda: email_sender
    app.dependency_overrides[get_google_client] = lambda: google_client
    with TestClient(app) as test_client:
        yield test_client
    app.dependency_overrides.clear()
