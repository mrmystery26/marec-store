import uuid
from datetime import datetime

from sqlalchemy import select

from app.modules.audit.models import AuditLog
from app.modules.rbac.permissions import Role
from tests.helpers import bearer, code, create_account, login


def audit_rows(db_session, action):
    db_session.expire_all()
    return list(db_session.scalars(select(AuditLog).where(AuditLog.action == action)))


def test_admin_endpoints_require_a_staff_role(client, db_session):
    user, tokens = create_account(client, db_session, "plain@example.com")
    url = f"/v1/admin/users/{user.id}"
    assert client.get(url).status_code == 401
    response = client.get(url, headers=bearer(tokens))
    assert response.status_code == 403
    assert code(response) == "FORBIDDEN"


def test_support_can_read_users_but_not_suspend_them(client, db_session):
    support_roles = [Role.CUSTOMER_SUPPORT]
    _, support = create_account(client, db_session, "support@example.com", support_roles)
    target, _ = create_account(client, db_session, "target@example.com")

    read = client.get(f"/v1/admin/users/{target.id}", headers=bearer(support))
    assert read.status_code == 200
    assert read.json()["email"] == "target@example.com"
    assert read.json()["roles"] == []

    suspend = client.post(
        f"/v1/admin/users/{target.id}/suspend",
        json={"reason": "abuse report"},
        headers=bearer(support),
    )
    assert suspend.status_code == 403

    missing = client.get(f"/v1/admin/users/{uuid.uuid4()}", headers=bearer(support))
    assert missing.status_code == 404
    assert code(missing) == "USER_NOT_FOUND"


def test_suspend_and_reinstate_flow_is_audited(client, db_session):
    admin_roles = [Role.SUPER_ADMIN]
    admin, admin_tokens = create_account(client, db_session, "admin@example.com", admin_roles)
    target, target_tokens = create_account(client, db_session, "target@example.com")
    base = f"/v1/admin/users/{target.id}"

    suspended = client.post(
        f"{base}/suspend", json={"reason": "abuse report"}, headers=bearer(admin_tokens)
    )
    assert suspended.status_code == 200
    assert suspended.json()["status"] == "suspended"

    # Existing sessions end immediately and a new login is refused.
    assert client.get("/v1/me", headers=bearer(target_tokens)).status_code == 401
    refused = login(client, email="target@example.com")
    assert refused.status_code == 403
    assert code(refused) == "ACCOUNT_SUSPENDED"

    rows = audit_rows(db_session, "user.suspended")
    assert len(rows) == 1
    assert rows[0].actor_user_id == admin.id
    assert rows[0].entity_id == str(target.id)
    assert rows[0].reason == "abuse report"
    assert rows[0].before == {"status": "active"}
    assert rows[0].after == {"status": "suspended"}
    assert rows[0].actor_roles == "super_admin"

    again = client.post(
        f"{base}/suspend", json={"reason": "second try"}, headers=bearer(admin_tokens)
    )
    assert again.status_code == 409
    assert code(again) == "INVALID_STATE"

    reinstated = client.post(
        f"{base}/reinstate", json={"reason": "appeal accepted"}, headers=bearer(admin_tokens)
    )
    assert reinstated.status_code == 200
    assert reinstated.json()["status"] == "active"
    assert login(client, email="target@example.com").status_code == 200
    assert len(audit_rows(db_session, "user.reinstated")) == 1

    nothing_to_reinstate = client.post(
        f"{base}/reinstate", json={"reason": "no need"}, headers=bearer(admin_tokens)
    )
    assert nothing_to_reinstate.status_code == 409


def test_reason_is_required_and_self_suspension_is_blocked(client, db_session):
    admin, tokens = create_account(client, db_session, "admin@example.com", [Role.SUPER_ADMIN])
    target, _ = create_account(client, db_session, "target@example.com")

    too_short = client.post(
        f"/v1/admin/users/{target.id}/suspend", json={"reason": "x"}, headers=bearer(tokens)
    )
    assert too_short.status_code == 422

    own = client.post(
        f"/v1/admin/users/{admin.id}/suspend", json={"reason": "testing"}, headers=bearer(tokens)
    )
    assert own.status_code == 409
    assert code(own) == "CANNOT_MODIFY_SELF"


def test_roles_can_be_granted_and_revoked_with_audit(client, db_session):
    _, admin_tokens = create_account(
        client, db_session, "admin@example.com", [Role.SUPER_ADMIN]
    )
    _, support_tokens = create_account(
        client, db_session, "support@example.com", [Role.CUSTOMER_SUPPORT]
    )
    target, _ = create_account(client, db_session, "target@example.com")
    url = f"/v1/admin/users/{target.id}/roles"

    granted = client.put(f"{url}/store_admin", headers=bearer(admin_tokens))
    assert granted.status_code == 200
    assert granted.json()["roles"] == ["store_admin"]

    again = client.put(f"{url}/store_admin", headers=bearer(admin_tokens))
    assert again.json()["roles"] == ["store_admin"]
    assert len(audit_rows(db_session, "role.granted")) == 1  # the repeat changed nothing

    assert client.put(f"{url}/not_a_role", headers=bearer(admin_tokens)).status_code == 422
    assert client.put(f"{url}/developer", headers=bearer(support_tokens)).status_code == 403

    revoked = client.delete(f"{url}/store_admin", headers=bearer(admin_tokens))
    assert revoked.status_code == 200
    assert revoked.json()["roles"] == []
    assert len(audit_rows(db_session, "role.revoked")) == 1


def test_last_super_admin_cannot_be_removed(client, db_session):
    admin, admin_tokens = create_account(
        client, db_session, "admin@example.com", [Role.SUPER_ADMIN]
    )
    other, _ = create_account(client, db_session, "other@example.com")
    own_role_url = f"/v1/admin/users/{admin.id}/roles/super_admin"

    blocked = client.delete(own_role_url, headers=bearer(admin_tokens))
    assert blocked.status_code == 409
    assert code(blocked) == "LAST_SUPER_ADMIN"

    assert client.put(
        f"/v1/admin/users/{other.id}/roles/super_admin", headers=bearer(admin_tokens)
    ).status_code == 200
    allowed = client.delete(own_role_url, headers=bearer(admin_tokens))
    assert allowed.status_code == 200

    # Removing a role takes effect on the very next request.
    assert client.get("/v1/admin/audit-logs", headers=bearer(admin_tokens)).status_code == 403


def test_audit_log_list_is_paginated_and_filterable(client, db_session):
    _, admin_tokens = create_account(client, db_session, "admin@example.com", [Role.SUPER_ADMIN])
    for name in ("a", "b", "c"):
        create_account(client, db_session, f"{name}@example.com")

    params = {"action": "user.registered", "limit": 3}
    first = client.get("/v1/admin/audit-logs", params=params, headers=bearer(admin_tokens))
    assert first.status_code == 200
    page_one = first.json()
    assert len(page_one["items"]) == 3
    assert page_one["next_cursor"]

    stamps = [datetime.fromisoformat(item["created_at"]) for item in page_one["items"]]
    assert stamps == sorted(stamps, reverse=True)

    params["cursor"] = page_one["next_cursor"]
    second = client.get("/v1/admin/audit-logs", params=params, headers=bearer(admin_tokens))
    page_two = second.json()
    assert len(page_two["items"]) == 1
    assert page_two["next_cursor"] is None

    ids = {item["id"] for item in page_one["items"] + page_two["items"]}
    assert len(ids) == 4
    assert all(item["action"] == "user.registered" for item in page_one["items"])


def test_audit_log_access_and_bad_cursor(client, db_session):
    _, support = create_account(
        client, db_session, "support@example.com", [Role.CUSTOMER_SUPPORT]
    )
    _, finance = create_account(
        client, db_session, "finance@example.com", [Role.FINANCE_ADMIN]
    )

    assert client.get("/v1/admin/audit-logs", headers=bearer(support)).status_code == 403
    assert client.get("/v1/admin/audit-logs", headers=bearer(finance)).status_code == 200

    bad = client.get(
        "/v1/admin/audit-logs", params={"cursor": "not-a-cursor!!"}, headers=bearer(finance)
    )
    assert bad.status_code == 422
    assert code(bad) == "INVALID_CURSOR"
