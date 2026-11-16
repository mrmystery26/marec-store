import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class AdminUserOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    email_verified: bool
    status: str
    created_at: datetime
    roles: list[str]


class ReasonBody(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


class RolesOut(BaseModel):
    roles: list[str]


class AuditLogOut(BaseModel):
    id: uuid.UUID
    created_at: datetime
    actor_user_id: uuid.UUID | None
    actor_roles: str | None
    action: str
    entity_type: str
    entity_id: str | None
    reason: str | None
    before: dict | None
    after: dict | None
    ip: str | None
    request_id: str | None


class AuditLogPage(BaseModel):
    items: list[AuditLogOut]
    next_cursor: str | None
