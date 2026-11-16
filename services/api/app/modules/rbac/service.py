import uuid

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.modules.rbac.models import UserRole
from app.modules.rbac.permissions import Role


def get_roles(db: Session, user_id: uuid.UUID) -> list[Role]:
    names = db.scalars(select(UserRole.role).where(UserRole.user_id == user_id))
    return sorted((Role(name) for name in names), key=lambda role: role.value)


def grant_role(db: Session, user_id: uuid.UUID, role: Role, granted_by: uuid.UUID | None) -> bool:
    """Adds the role to the session. Returns False if the user already had it. Caller commits."""
    if db.get(UserRole, (user_id, role.value)) is not None:
        return False
    db.add(UserRole(user_id=user_id, role=role.value, granted_by=granted_by))
    return True


def revoke_role(db: Session, user_id: uuid.UUID, role: Role) -> bool:
    """Returns False if the user did not have the role. Caller commits."""
    row = db.get(UserRole, (user_id, role.value))
    if row is None:
        return False
    db.delete(row)
    return True


def count_holders(db: Session, role: Role) -> int:
    stmt = select(func.count()).select_from(UserRole).where(UserRole.role == role.value)
    return db.scalar(stmt) or 0
