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

    # Sign in with Google. Create an OAuth client of type "Web application" in Google Cloud and add
    # {PUBLIC_API_BASE_URL}/v1/auth/google/callback as an authorized redirect URI.
    google_client_id: str | None = None
    google_client_secret: SecretStr | None = None
    # Where the browser sends the player back to the app after Google. Never taken from a request.
    app_redirect_uri: str = "marecstore://auth"
    login_ticket_seconds: int = 120

    # Email through Resend (https://resend.com). Without a key no email is sent.
    resend_api_key: SecretStr | None = None
    # The sender must be on a domain verified in Resend, e.g. "MAREC Store <no-reply@example.com>".
    email_from: str | None = None
    # Comma-separated emails that become super administrators the first time they sign in with a
    # verified address. This exists because free hosting has no shell to run app.cli in.
    bootstrap_admin_emails: str = ""
    # Where "a new developer is waiting for verification" notices go (optional).
    admin_notify_email: str | None = None
    email_code_minutes: int = 15
    email_code_max_attempts: int = 5

    # Demo phase: developers may only upload free demos. Turn off when full releases open.
    demo_only: bool = True
    demo_max_build_mb: int = 1024
    demo_max_games_per_studio: int = 5

    # Ed25519 seed (base64, 32 bytes) used to sign build manifests.
    manifest_signing_key: SecretStr | None = None

    # RSA private key (PEM, then base64 so it fits on one line) that signs launch tokens.
    # RSA, not Ed25519, because Godot can verify RSA signatures natively.
    launch_signing_key: SecretStr | None = None
    launch_token_seconds: int = 120
    max_devices_per_account: int = 5

    @field_validator(
        "google_client_id",
        "google_client_secret",
        "resend_api_key",
        "email_from",
        "admin_notify_email",
        mode="before",
    )
    @classmethod
    def _blank_means_unset(cls, value):
        # Hosting dashboards often keep an empty variable instead of removing it.
        if isinstance(value, str) and not value.strip():
            return None
        return value

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
    def bootstrap_admin_list(self) -> list[str]:
        return [e.strip().lower() for e in self.bootstrap_admin_emails.split(",") if e.strip()]

    @property
    def google_enabled(self) -> bool:
        return bool(self.google_client_id and self.google_client_secret)

    @property
    def email_enabled(self) -> bool:
        return bool(self.resend_api_key and self.email_from)

    @property
    def google_redirect_uri(self) -> str:
        return self.public_api_base_url.rstrip("/") + "/v1/auth/google/callback"

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
        if (self.google_client_id is None) != (self.google_client_secret is None):
            raise ValueError("GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET must be set together.")
        if self.resend_api_key is not None and not self.email_from:
            raise ValueError("EMAIL_FROM is required when RESEND_API_KEY is set.")
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
