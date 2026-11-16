import importlib.util
from pathlib import Path

from app.modules.rbac.permissions import ROLE_PERMISSIONS, Permission, Role, permissions_for


def test_every_role_has_a_permission_entry():
    assert set(ROLE_PERMISSIONS) == set(Role)


def test_super_admin_has_every_permission():
    assert ROLE_PERMISSIONS[Role.SUPER_ADMIN] == frozenset(Permission)


def test_developer_has_no_platform_permissions():
    assert ROLE_PERMISSIONS[Role.DEVELOPER] == frozenset()


def test_permissions_are_combined_across_roles():
    granted = permissions_for([Role.CUSTOMER_SUPPORT, Role.FINANCE_ADMIN])
    assert Permission.USERS_READ in granted
    assert Permission.AUDIT_READ in granted
    assert Permission.ROLES_MANAGE not in granted


def test_catalog_permissions_are_split_between_roles():
    assert Permission.CATALOG_MANAGE in ROLE_PERMISSIONS[Role.STORE_ADMIN]
    assert Permission.STUDIOS_VERIFY in ROLE_PERMISSIONS[Role.STORE_ADMIN]
    assert Permission.GAMES_REVIEW in ROLE_PERMISSIONS[Role.GAME_MODERATOR]
    assert Permission.CATALOG_MANAGE not in ROLE_PERMISSIONS[Role.GAME_MODERATOR]
    assert Permission.GAMES_REVIEW not in ROLE_PERMISSIONS[Role.STORE_ADMIN]


def test_no_roles_means_no_permissions():
    assert permissions_for([]) == frozenset()


def test_migration_role_list_matches_the_enum():
    path = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0002_roles_audit.py"
    spec = importlib.util.spec_from_file_location("migration_0002", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    in_migration = {part.strip().strip("'") for part in module.ROLE_VALUES.split(",")}
    assert in_migration == {role.value for role in Role}
