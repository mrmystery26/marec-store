import uuid
from datetime import datetime

from pydantic import BaseModel, ConfigDict, Field

_ID = r"^[A-Za-z0-9_-]+$"


class LaunchRequest(BaseModel):
    """Asked for by the launcher when the player presses PLAY."""

    model_config = ConfigDict(extra="forbid")

    game_id: uuid.UUID
    build_id: uuid.UUID
    # Random secret the launcher keeps on this PC. Only its SHA-256 is stored.
    device_id: str = Field(min_length=16, max_length=128, pattern=_ID)
    device_label: str | None = Field(None, max_length=80)
    nonce: str = Field(min_length=8, max_length=64, pattern=_ID)


class LeaseRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    game_id: uuid.UUID
    build_id: uuid.UUID
    device_id: str = Field(min_length=16, max_length=128, pattern=_ID)
    device_label: str | None = Field(None, max_length=80)


class RedeemRequest(BaseModel):
    """Sent by the game (through the SDK) to the backend, which marks the token as used."""

    model_config = ConfigDict(extra="forbid")

    token: str = Field(min_length=20, max_length=4096)
    device_id: str | None = Field(None, min_length=16, max_length=128, pattern=_ID)


class TokenOut(BaseModel):
    token: str
    kind: str
    kid: str
    expires_at: datetime
    expires_in: int


class RedeemOut(BaseModel):
    ok: bool
    game_id: uuid.UUID
    build_id: uuid.UUID
    kind: str
    session_id: uuid.UUID
    server_time: datetime


class DeviceOut(BaseModel):
    id: uuid.UUID
    label: str | None
    first_seen_at: datetime
    last_seen_at: datetime
