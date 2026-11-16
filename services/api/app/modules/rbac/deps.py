from dataclasses import dataclass

from fastapi import Depends
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.errors import ApiError
from app.modules.auth.deps import AuthContext, get_auth_context
from app.modules.rbac import service
from app.modules.rbac.permissions import Permission, Role, permissions_for


@dataclass
class StaffContext(AuthContext):
    roles: list[Role]

    @property
    def roles_label(self) -> str:
        return ",".join(role.value for role in self.roles)


def require_permission(permission: Permission):
    """Dependency factory. Roles are read from the database on every request, so removing a
    role takes effect immediately."""

    def dependency(
        ctx: AuthContext = Depends(get_auth_context), db: Session = Depends(get_db)
    ) -> StaffContext:
        roles = service.get_roles(db, ctx.user.id)
        if permission not in permissions_for(roles):
            raise ApiError(403, "FORBIDDEN", "You do not have permission to do this.")
        return StaffContext(user=ctx.user, session=ctx.session, roles=roles)

    return dependency
