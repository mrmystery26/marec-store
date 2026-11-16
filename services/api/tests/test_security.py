import base64
import hashlib

import pytest
from pydantic import ValidationError

from app.core.config import Settings
from app.core.security import (
    hash_password,
    hash_token,
    new_refresh_token,
    verify_password,
)


def test_password_hash_is_argon2id_and_verifies():
    password_hash = hash_password("a-long-password")
    assert password_hash.startswith("$argon2id$")
    assert verify_password("a-long-password", password_hash)
    assert not verify_password("wrong-password", password_hash)


def test_verify_password_rejects_garbage_hash():
    assert not verify_password("anything", "not-a-real-hash")


def test_hash_token_is_sha256_hex():
    assert hash_token("abc") == hashlib.sha256(b"abc").hexdigest()


def test_refresh_tokens_are_unique_and_long():
    first, second = new_refresh_token(), new_refresh_token()
    assert first != second
    assert len(first) >= 60


def test_production_rejects_weak_jwt_secret():
    with pytest.raises(ValidationError):
        Settings(
            _env_file=None,
            environment="production",
            database_url="postgresql+psycopg://user:pw@host/db",
            jwt_secret="change-me-short",
        )


PRODUCTION = {
    "_env_file": None,
    "environment": "production",
    "database_url": "postgresql+psycopg://user:pw@host/db",
    "jwt_secret": "x" * 40,
    "manifest_signing_key": "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8=",
    "launch_signing_key": base64.b64encode(b"-----BEGIN PRIVATE KEY-----\nabc").decode(),
    "storage_backend": "s3",
    "s3_endpoint_url": "https://example.r2.cloudflarestorage.com",
    "s3_bucket": "builds",
    "s3_access_key_id": "key",
    "s3_secret_access_key": "secret",
}


def test_production_accepts_a_complete_configuration():
    assert Settings(**PRODUCTION).environment == "production"


def test_production_requires_a_signing_key():
    with pytest.raises(ValidationError):
        Settings(**{**PRODUCTION, "manifest_signing_key": None})


def test_production_requires_a_launch_signing_key():
    with pytest.raises(ValidationError):
        Settings(**{**PRODUCTION, "launch_signing_key": None})


def test_launch_signing_key_must_be_a_base64_pem():
    for bad in ("not base64!!", base64.b64encode(b"just text").decode()):
        with pytest.raises(ValidationError):
            Settings(**{**PRODUCTION, "launch_signing_key": bad})


def test_production_requires_s3_storage():
    with pytest.raises(ValidationError):
        Settings(**{**PRODUCTION, "storage_backend": "local"})


def test_s3_backend_needs_its_settings():
    with pytest.raises(ValidationError):
        Settings(**{**PRODUCTION, "s3_bucket": None})


def test_signing_key_must_be_32_bytes_of_base64():
    for bad in ("not base64!!", "AAEC"):
        with pytest.raises(ValidationError):
            Settings(**{**PRODUCTION, "manifest_signing_key": bad})
