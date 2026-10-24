from functools import lru_cache
from typing import Literal

from pydantic import SecretStr, model_validator
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


@lru_cache
def get_settings() -> Settings:
    return Settings()
