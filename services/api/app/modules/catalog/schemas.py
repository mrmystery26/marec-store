import uuid
from datetime import datetime
from typing import Literal

from pydantic import AwareDatetime, BaseModel, ConfigDict, Field, field_validator, model_validator

AgeRating = Literal["3+", "7+", "12+", "16+", "18+"]
Tier = Literal["minimum", "recommended"]


class CategoryOut(BaseModel):
    id: uuid.UUID
    slug: str
    name: str


class CategoryCreate(BaseModel):
    name: str = Field(min_length=2, max_length=60)
    sort_order: int = Field(0, ge=0, le=1000)

    @field_validator("name")
    @classmethod
    def clean_name(cls, value: str) -> str:
        return " ".join(value.split())


class StudioBrief(BaseModel):
    name: str
    slug: str


class RequirementIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    tier: Tier
    os: str = Field(min_length=1, max_length=80)
    cpu: str = Field(min_length=1, max_length=120)
    ram_mb: int = Field(ge=256, le=262144)
    gpu: str = Field("", max_length=120)
    storage_mb: int = Field(ge=1, le=2_000_000)


class RequirementOut(BaseModel):
    tier: str
    os: str
    cpu: str
    ram_mb: int
    gpu: str
    storage_mb: int


class GameCard(BaseModel):
    id: uuid.UUID
    slug: str
    title: str
    summary: str | None
    price_minor: int | None
    currency: str
    is_free: bool
    # "demo" (a free sample) or "full". While the store is demo-only, everything is a demo.
    release_kind: str
    age_rating: str | None
    studio: StudioBrief
    categories: list[CategoryOut]
    published_at: datetime | None


class GameDetail(GameCard):
    description: str | None
    offline_days: int
    requirements: list[RequirementOut]


class GamePage(BaseModel):
    items: list[GameCard]
    total: int
    limit: int
    offset: int


class GameFull(BaseModel):
    """Everything the studio team and reviewers see, in any status."""

    id: uuid.UUID
    studio_id: uuid.UUID
    studio: StudioBrief
    studio_status: str
    slug: str
    title: str
    summary: str | None
    description: str | None
    status: str
    status_reason: str | None
    price_minor: int | None
    currency: str
    is_free: bool
    release_kind: str
    age_rating: str | None
    protection_level: int
    offline_days: int
    release_at: datetime | None
    published_at: datetime | None
    categories: list[CategoryOut]
    requirements: list[RequirementOut]
    created_at: datetime
    updated_at: datetime


class GameFullPage(BaseModel):
    items: list[GameFull]
    total: int
    limit: int
    offset: int


class GameCreate(BaseModel):
    title: str = Field(min_length=2, max_length=80)

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str) -> str:
        value = " ".join(value.split())
        if len(value) < 2:
            raise ValueError("Title is too short.")
        return value


class GameUpdate(BaseModel):
    """Send only the fields to change. Fields that are not sent stay as they are."""

    model_config = ConfigDict(extra="forbid")

    title: str | None = Field(None, min_length=2, max_length=80)
    summary: str | None = Field(None, max_length=280)
    description: str | None = Field(None, max_length=10000)
    price_minor: int | None = Field(None, ge=0, le=100_000_000)
    age_rating: AgeRating | None = None
    protection_level: int | None = Field(None, ge=0, le=3)
    offline_days: int | None = Field(None, ge=0, le=30)
    release_at: AwareDatetime | None = None
    category_slugs: list[str] | None = Field(None, max_length=5)
    requirements: list[RequirementIn] | None = Field(None, max_length=2)

    @model_validator(mode="after")
    def required_fields_cannot_be_cleared(self) -> "GameUpdate":
        for name in ("title", "protection_level", "offline_days", "category_slugs", "requirements"):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"{name} cannot be cleared.")
        tiers = [item.tier for item in self.requirements or []]
        if len(tiers) != len(set(tiers)):
            raise ValueError("Each requirements tier can appear only once.")
        return self
