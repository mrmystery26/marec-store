from collections.abc import Iterable
from enum import StrEnum


class Role(StrEnum):
    SUPER_ADMIN = "super_admin"
    STORE_ADMIN = "store_admin"
    GAME_MODERATOR = "game_moderator"
    CUSTOMER_SUPPORT = "customer_support"
    FINANCE_ADMIN = "finance_admin"
    DEVELOPER = "developer"


class Permission(StrEnum):
    USERS_READ = "users.read"
    USERS_SUSPEND = "users.suspend"
    ROLES_MANAGE = "roles.manage"
    AUDIT_READ = "audit.read"
    CATALOG_MANAGE = "catalog.manage"
    GAMES_REVIEW = "games.review"
    STUDIOS_VERIFY = "studios.verify"


# Starting point only. Permissions are added here as features arrive (catalog, orders, payouts).
# DEVELOPER has no platform-wide permissions: developer access will be scoped to a studio.
ROLE_PERMISSIONS: dict[Role, frozenset[Permission]] = {
    Role.SUPER_ADMIN: frozenset(Permission),
    Role.STORE_ADMIN: frozenset(
        {Permission.USERS_READ, Permission.CATALOG_MANAGE, Permission.STUDIOS_VERIFY}
    ),
    Role.GAME_MODERATOR: frozenset({Permission.USERS_READ, Permission.GAMES_REVIEW}),
    Role.CUSTOMER_SUPPORT: frozenset({Permission.USERS_READ}),
    Role.FINANCE_ADMIN: frozenset({Permission.USERS_READ, Permission.AUDIT_READ}),
    Role.DEVELOPER: frozenset(),
}


def permissions_for(roles: Iterable[Role]) -> frozenset[Permission]:
    granted: set[Permission] = set()
    for role in roles:
        granted |= ROLE_PERMISSIONS[role]
    return frozenset(granted)
