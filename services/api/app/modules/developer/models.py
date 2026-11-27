import uuid
from datetime import datetime

from sqlalchemy import ForeignKey, String
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime, utcnow


class DeveloperProfile(Base):
    """Marks a user as a developer. It exists only after the person accepted the developer terms,
    and it needs a verified email address, so every uploader can be reached."""

    __tablename__ = "developer_profiles"

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    terms_version: Mapped[str] = mapped_column(String(16))
    terms_accepted_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
    created_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
