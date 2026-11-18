import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class FriendOut(BaseModel):
    user_id: uuid.UUID
    display_name: str
    since: datetime


class FriendList(BaseModel):
    items: list[FriendOut]
    total: int


class RequestOut(BaseModel):
    """A pending request. `user_id` and `display_name` describe the OTHER player."""

    id: uuid.UUID
    user_id: uuid.UUID
    display_name: str
    created_at: datetime


class RequestLists(BaseModel):
    incoming: list[RequestOut]
    outgoing: list[RequestOut]


class FriendCodeOut(BaseModel):
    code: str


class SendRequestIn(BaseModel):
    # Checked in the service (so a wrong code gets a clear INVALID_FRIEND_CODE message).
    friend_code: str = Field(max_length=40)


class SendRequestOut(BaseModel):
    """`status` is "pending" for a new request, or "accepted" when the other player had already
    asked you and the two requests met."""

    id: uuid.UUID
    status: str
    user_id: uuid.UUID
    display_name: str
