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


def test_production_accepts_strong_jwt_secret():
    settings = Settings(
        _env_file=None,
        environment="production",
        database_url="postgresql+psycopg://user:pw@host/db",
        jwt_secret="x" * 40,
    )
    assert settings.environment == "production"
