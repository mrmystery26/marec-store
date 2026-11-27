import uuid

from pydantic import BaseModel, Field, field_validator


class StudioCreate(BaseModel):
    name: str = Field(min_length=2, max_length=60)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if len(value) < 2:
            raise ValueError("Studio name is too short.")
        return value


class StudioOut(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    status: str
    my_role: str


class DeveloperRegister(BaseModel):
    """Becoming a developer: name your first studio and accept the developer rules."""

    studio_name: str = Field(min_length=2, max_length=60)
    accept_terms: bool
    terms_version: str = Field(min_length=1, max_length=16)

    @field_validator("studio_name")
    @classmethod
    def clean_studio_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if len(value) < 2:
            raise ValueError("Studio name is too short.")
        return value


class DeveloperLimits(BaseModel):
    demo_only: bool
    max_demo_build_mb: int
    max_games_per_studio: int


class DeveloperAccountOut(BaseModel):
    is_developer: bool
    email_verified: bool
    terms_version: str
    limits: DeveloperLimits
    studios: list[StudioOut]
