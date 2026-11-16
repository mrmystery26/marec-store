import uuid
from datetime import datetime

from pydantic import BaseModel

from app.modules.catalog.schemas import StudioBrief


class EntitlementOut(BaseModel):
    id: uuid.UUID
    game_id: uuid.UUID
    source: str
    status: str
    granted_at: datetime


class LibraryItem(BaseModel):
    game_id: uuid.UUID
    slug: str
    title: str
    studio: StudioBrief
    source: str
    granted_at: datetime
    available: bool
    unavailable_reason: str | None
    latest_version: str | None


class LibraryPage(BaseModel):
    items: list[LibraryItem]
    total: int
    limit: int
    offset: int


class DownloadLink(BaseModel):
    path: str
    url: str


class InstallPlan(BaseModel):
    """Everything a launcher needs to install a build. The launcher must verify
    `manifest_signature` over the exact bytes of `manifest_b64` using the public key `kid`
    from /v1/launch/public-keys before trusting any of it."""

    game_id: uuid.UUID
    build_id: uuid.UUID
    version: str
    platform: str
    total_size_bytes: int
    file_count: int
    kid: str
    manifest_sha256: str
    manifest_signature: str
    manifest_b64: str
    downloads: list[DownloadLink]
    expires_in: int
