import uuid
from datetime import timedelta

import jwt
from sqlalchemy import select

from app.core.security import create_access_token
from app.modules.audit.models import AuditLog
from app.modules.auth.models import User
from tests.helpers import EMAIL, PASSWORD, bearer, code, login, register


def test_register_success_and_password_is_hashed(client, db_session):
    response = register(client)
    assert response.status_code == 201
    body = response.json()
    assert body["email"] == EMAIL
    assert body["email_verified"] is False
    assert "password" not in response.text and "password_hash" not in response.text

    user = db_session.scalar(select(User).where(User.email == EMAIL))
    assert user.password_hash.startswith("$argon2id$")
    assert PASSWORD not in user.password_hash


def test_register_normalizes_email_case(client):
    response = register(client, email="Player@Example.COM")
    assert response.status_code == 201
    assert response.json()["email"] == EMAIL
    assert login(client).status_code == 200


def test_register_duplicate_email_is_rejected_case_insensitively(client):
    assert register(client).status_code == 201
    response = register(client, email="PLAYER@example.com")
    assert response.status_code == 409
    assert code(response) == "EMAIL_TAKEN"


def test_register_short_password_is_rejected_and_not_echoed(client):
    response = register(client, password="Sh0rt-pw9")
    assert response.status_code == 422
    assert code(response) == "VALIDATION_ERROR"
    assert "Sh0rt-pw9" not in response.text


def test_register_password_equal_to_email_is_rejected(client):
    same = "longer.address@example.com"
    response = register(client, email=same, password=same)
    assert response.status_code == 422


def test_login_returns_tokens_and_me_works(client):
    register(client)
    response = login(client)
    assert response.status_code == 200
    tokens = response.json()
    assert tokens["token_type"] == "bearer"
    assert tokens["expires_in"] == 900

    me = client.get("/v1/me", headers=bearer(tokens))
    assert me.status_code == 200
    assert me.json()["email"] == EMAIL


def test_login_wrong_password_and_unknown_email_look_the_same(client):
    register(client)
    wrong = login(client, password="not-the-password")
    unknown = login(client, email="nobody@example.com")
    assert wrong.status_code == unknown.status_code == 401
    assert code(wrong) == code(unknown) == "INVALID_CREDENTIALS"
    assert wrong.json()["error"]["message"] == unknown.json()["error"]["message"]


def test_account_locks_after_repeated_failures(client):
    register(client)
    for _ in range(5):
        assert login(client, password="not-the-password").status_code == 401
    locked = login(client)  # correct password, but the account is locked
    assert locked.status_code == 429
    assert code(locked) == "TOO_MANY_ATTEMPTS"


def test_suspended_user_cannot_log_in(client, db_session):
    register(client)
    user = db_session.scalar(select(User).where(User.email == EMAIL))
    user.status = "suspended"
    db_session.commit()
    response = login(client)
    assert response.status_code == 403
    assert code(response) == "ACCOUNT_SUSPENDED"


def test_me_requires_authentication(client):
    missing = client.get("/v1/me")
    assert missing.status_code == 401
    assert code(missing) == "NOT_AUTHENTICATED"
    garbage = client.get("/v1/me", headers={"Authorization": "Bearer not-a-token"})
    assert garbage.status_code == 401
    assert code(garbage) == "INVALID_TOKEN"


def test_expired_access_token_is_rejected(client):
    register(client)
    tokens = login(client).json()
    claims = jwt.decode(tokens["access_token"], options={"verify_signature": False})
    expired = create_access_token(
        uuid.UUID(claims["sub"]), uuid.UUID(claims["sid"]), expires_delta=timedelta(minutes=-1)
    )
    response = client.get("/v1/me", headers={"Authorization": f"Bearer {expired}"})
    assert response.status_code == 401
    assert code(response) == "INVALID_TOKEN"


def test_refresh_rotates_and_replay_revokes_the_session(client):
    register(client)
    first = login(client).json()

    rotated = client.post("/v1/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert rotated.status_code == 200
    second = rotated.json()
    assert second["refresh_token"] != first["refresh_token"]
    assert client.get("/v1/me", headers=bearer(second)).status_code == 200

    # Replaying the old refresh token is treated as theft and ends the session.
    replay = client.post("/v1/auth/refresh", json={"refresh_token": first["refresh_token"]})
    assert replay.status_code == 401
    assert code(replay) == "INVALID_REFRESH_TOKEN"

    assert client.post(
        "/v1/auth/refresh", json={"refresh_token": second["refresh_token"]}
    ).status_code == 401
    assert client.get("/v1/me", headers=bearer(second)).status_code == 401


def test_refresh_with_unknown_token_fails(client):
    response = client.post("/v1/auth/refresh", json={"refresh_token": "x" * 40})
    assert response.status_code == 401
    assert code(response) == "INVALID_REFRESH_TOKEN"


def test_logout_revokes_the_session(client):
    register(client)
    tokens = login(client).json()
    assert client.post("/v1/auth/logout", headers=bearer(tokens)).status_code == 204
    assert client.get("/v1/me", headers=bearer(tokens)).status_code == 401
    refresh = client.post("/v1/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert refresh.status_code == 401


def test_sessions_can_be_listed_and_revoked(client):
    register(client)
    first = login(client).json()
    second = login(client).json()

    listing = client.get("/v1/me/sessions", headers=bearer(first))
    assert listing.status_code == 200
    items = listing.json()
    assert len(items) == 2
    assert sum(1 for item in items if item["current"]) == 1

    other = next(item for item in items if not item["current"])
    deleted = client.delete(f"/v1/me/sessions/{other['id']}", headers=bearer(first))
    assert deleted.status_code == 204

    assert client.get("/v1/me", headers=bearer(second)).status_code == 401
    refresh = client.post("/v1/auth/refresh", json={"refresh_token": second["refresh_token"]})
    assert refresh.status_code == 401
    assert len(client.get("/v1/me/sessions", headers=bearer(first)).json()) == 1


def test_cannot_revoke_another_users_session(client):
    register(client)
    register(client, email="other@example.com")
    first = login(client).json()
    other = login(client, email="other@example.com").json()

    other_session = client.get("/v1/me/sessions", headers=bearer(other)).json()[0]["id"]
    response = client.delete(f"/v1/me/sessions/{other_session}", headers=bearer(first))
    assert response.status_code == 404
    assert code(response) == "SESSION_NOT_FOUND"
    assert client.get("/v1/me", headers=bearer(other)).status_code == 200


def test_register_writes_an_audit_record(client, db_session):
    register(client)
    user = db_session.scalar(select(User).where(User.email == EMAIL))
    rows = list(db_session.scalars(select(AuditLog).where(AuditLog.action == "user.registered")))
    assert len(rows) == 1
    assert rows[0].actor_user_id == user.id
    assert rows[0].entity_id == str(user.id)
    assert rows[0].request_id
    assert rows[0].ip
