import uuid
from datetime import datetime

from sqlalchemy import CheckConstraint, ForeignKey, String, Uuid
from sqlalchemy.orm import Mapped, mapped_column

from app.core.db import Base, UTCDateTime, utcnow
from app.modules.rbac.permissions import Role

_ROLE_LIST = ", ".join(f"'{role.value}'" for role in Role)


class UserRole(Base):
    __tablename__ = "user_roles"
    __table_args__ = (CheckConstraint(f"role IN ({_ROLE_LIST})", name="role_valid"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), primary_key=True
    )
    role: Mapped[str] = mapped_column(String(32), primary_key=True)
    granted_by: Mapped[uuid.UUID | None] = mapped_column(Uuid, nullable=True)
    granted_at: Mapped[datetime] = mapped_column(UTCDateTime, default=utcnow)
