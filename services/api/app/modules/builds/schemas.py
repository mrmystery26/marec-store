import re
import uuid
from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

from app.modules.builds.paths import validate_path

VERSION_PATTERN = re.compile(r"^\d{1,4}\.\d{1,4}\.\d{1,4}(-[0-9A-Za-z.-]{1,20})?$")
MAX_FILES = 5000
MAX_FILE_BYTES = 5 * 1024**3
MAX_BUILD_BYTES = 10 * 1024**3


class BuildFileIn(BaseModel):
    model_config = ConfigDict(extra="forbid")

    path: str = Field(min_length=1, max_length=240)
    size_bytes: int = Field(ge=0, le=MAX_FILE_BYTES)
    sha256: str = Field(pattern=r"^[0-9a-f]{64}$")

    @field_validator("path")
    @classmethod
    def path_must_be_safe(cls, value: str) -> str:
        problem = validate_path(value)
        if problem:
            raise ValueError(problem)
        return value


class BuildCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: str = Field(max_length=32)
    platform: Literal["windows-x64"]
    release_notes: str | None = Field(None, max_length=2000)
    # The .exe the launcher starts. Optional when exactly one .exe sits at the top level.
    entry_point: str | None = Field(None, max_length=240)
    files: list[BuildFileIn] = Field(min_length=1, max_length=MAX_FILES)

    @field_validator("version")
    @classmethod
    def version_format(cls, value: str) -> str:
        if not VERSION_PATTERN.match(value):
            raise ValueError("Version must look like 1.2.3 or 1.2.3-beta1.")
        return value

    @model_validator(mode="after")
    def files_are_consistent(self) -> "BuildCreate":
        # Windows paths are case-insensitive, so Game.exe and game.exe would collide.
        lowered = [item.path.lower() for item in self.files]
        if len(lowered) != len(set(lowered)):
            raise ValueError("Duplicate file paths (paths are compared ignoring case).")
        if sum(item.size_bytes for item in self.files) > MAX_BUILD_BYTES:
            raise ValueError("The build is larger than 10 GB.")

        paths = [item.path for item in self.files]
        if self.entry_point is None:
            top_level = [p for p in paths if "/" not in p and p.lower().endswith(".exe")]
            if len(top_level) != 1:
                raise ValueError("Say which .exe starts the game with entry_point.")
            self.entry_point = top_level[0]
        elif self.entry_point not in paths:
            raise ValueError("entry_point must be one of the build's files.")
        elif not self.entry_point.lower().endswith(".exe"):
            raise ValueError("entry_point must be an .exe file.")
        return self


class BuildOut(BaseModel):
    id: uuid.UUID
    game_id: uuid.UUID
    version: str
    platform: str
    status: str
    scan_status: str
    total_size_bytes: int
    file_count: int
    release_notes: str | None
    entry_point: str | None
    manifest_sha256: str | None
    manifest_signature: str | None
    signing_kid: str | None
    created_at: datetime
    ready_at: datetime | None
    revoked_at: datetime | None
    revoked_reason: str | None


class UploadTarget(BaseModel):
    path: str
    size_bytes: int
    upload_url: str


class BuildCreated(BuildOut):
    uploads: list[UploadTarget]


class BuildCompleteOut(BaseModel):
    build: BuildOut
    problems: list[str]


class RevokeBody(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


class PublicKeyOut(BaseModel):
    kid: str
    alg: str
    use: str  # "manifest" (Ed25519, base64 raw key) or "launch" (RS256, PEM)
    public_key: str


class PublicKeys(BaseModel):
    keys: list[PublicKeyOut]
