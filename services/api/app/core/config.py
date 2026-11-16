import base64
import binascii
from functools import lru_cache
from typing import Literal

from pydantic import SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Configuration read from environment variables (and a local .env file)."""

    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    environment: Literal["local", "test", "staging", "production"] = "local"
    database_url: str
    jwt_secret: SecretStr

    access_token_minutes: int = 15
    refresh_token_days: int = 30
    max_failed_logins: int = 5
    lockout_minutes: int = 15
    cors_origins: str = ""

    # Where game builds are stored. "local" is for development and tests only.
    storage_backend: Literal["local", "s3"] = "local"
    storage_local_dir: str = "./.storage"
    public_api_base_url: str = "http://localhost:8000"
    s3_endpoint_url: str | None = None
    s3_bucket: str | None = None
    s3_access_key_id: str | None = None
    s3_secret_access_key: SecretStr | None = None
    s3_region: str = "auto"

    # Ed25519 seed (base64, 32 bytes) used to sign build manifests.
    manifest_signing_key: SecretStr | None = None

    # RSA private key (PEM, then base64 so it fits on one line) that signs launch tokens.
    # RSA, not Ed25519, because Godot can verify RSA signatures natively.
    launch_signing_key: SecretStr | None = None
    launch_token_seconds: int = 120
    max_devices_per_account: int = 5

    @field_validator("database_url")
    @classmethod
    def _use_psycopg_driver(cls, value: str) -> str:
        # Hosting companies hand out "postgres://..." or "postgresql://..." URLs. SQLAlchemy would
        # pick a different driver for those, but this app ships psycopg 3, so name it explicitly.
        # URLs that already name a driver (postgresql+psycopg://) and SQLite URLs are left alone.
        for prefix in ("postgres://", "postgresql://"):
            if value.startswith(prefix):
                return "postgresql+psycopg://" + value[len(prefix):]
        return value

    @property
    def cors_origin_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @model_validator(mode="after")
    def _check_secret_strength(self) -> "Settings":
        if self.environment in ("staging", "production"):
            secret = self.jwt_secret.get_secret_value()
            if len(secret) < 32 or secret.lower().startswith("change-me"):
                raise ValueError(
                    "JWT_SECRET must be a random value of at least 32 characters "
                    "in staging and production."
                )
        return self


    @model_validator(mode="after")
    def _check_storage_and_signing(self) -> "Settings":
        if self.storage_backend == "s3":
            needed = (
                self.s3_endpoint_url,
                self.s3_bucket,
                self.s3_access_key_id,
                self.s3_secret_access_key,
            )
            if not all(needed):
                raise ValueError(
                    "S3_ENDPOINT_URL, S3_BUCKET, S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY "
                    "are required when STORAGE_BACKEND=s3."
                )
        if self.manifest_signing_key is not None:
            try:
                seed = base64.b64decode(self.manifest_signing_key.get_secret_value(), validate=True)
            except (binascii.Error, ValueError):
                seed = b""
            if len(seed) != 32:
                raise ValueError("MANIFEST_SIGNING_KEY must be base64 of exactly 32 bytes.")
        if self.launch_signing_key is not None:
            try:
                pem = base64.b64decode(self.launch_signing_key.get_secret_value(), validate=True)
            except (binascii.Error, ValueError):
                pem = b""
            if not pem.startswith(b"-----BEGIN"):
                raise ValueError("LAUNCH_SIGNING_KEY must be a base64-encoded PEM private key.")
        if self.environment in ("staging", "production"):
            if self.launch_signing_key is None:
                raise ValueError("LAUNCH_SIGNING_KEY is required in staging and production.")
            if self.manifest_signing_key is None:
                raise ValueError("MANIFEST_SIGNING_KEY is required in staging and production.")
            if self.storage_backend != "s3":
                raise ValueError("STORAGE_BACKEND must be s3 in staging and production.")
        return self

@lru_cache
def get_settings() -> Settings:
    return Settings()
