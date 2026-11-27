import base64
import hashlib
import re
import secrets
from datetime import timedelta
from urllib.parse import parse_qs, urlparse

import jwt
import pytest
from pydantic import SecretStr
from sqlalchemy import select

from app.core.db import utcnow
from app.core.security import create_access_token, create_state_token
from app.modules.auth.models import AuthIdentity, LoginTicket, User, UserSession
from tests.helpers import EMAIL, PASSWORD, bearer, code, login, register


def new_pkce():
    verifier = secrets.token_urlsafe(48)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return verifier, base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def start(client, challenge):
    return client.post("/v1/auth/google/start", json={"code_challenge": challenge})


def begin(client, challenge=None):
    """Starts a sign-in and returns (verifier, state)."""
    verifier, computed = new_pkce()
    response = start(client, challenge or computed)
    assert response.status_code == 200, response.text
    query = parse_qs(urlparse(response.json()["auth_url"]).query)
    return verifier, query["state"][0]


def callback(client, state, code_value="auth-code", **extra):
    params = {"state": state, **extra}
    if code_value is not None:
        params["code"] = code_value
    return client.get("/v1/auth/google/callback", params=params)


def ticket_from(page):
    found = re.search(r"marecstore://auth\?ticket=([A-Za-z0-9_-]+)", page.text)
    assert found, page.text
    return found.group(1)


def error_from(page):
    found = re.search(r"marecstore://auth\?error=([A-Z_]+)", page.text)
    assert found, page.text
    return found.group(1)


def exchange(client, ticket, verifier):
    return client.post(
        "/v1/auth/google/exchange", json={"ticket": ticket, "code_verifier": verifier}
    )


def sign_in(client):
    verifier, state = begin(client)
    page = callback(client, state)
    return exchange(client, ticket_from(page), verifier)


# ---------------------------------------------------------------- configuration


def test_providers_say_what_is_set_up(client, settings):
    assert client.get("/v1/auth/providers").json() == {"google": False, "email_codes": False}
    settings.google_client_id = "id"
    settings.google_client_secret = SecretStr("secret")
    assert client.get("/v1/auth/providers").json()["google"] is True


def test_start_refuses_when_google_is_not_set_up(client):
    response = start(client, new_pkce()[1])
    assert response.status_code == 503
    assert code(response) == "GOOGLE_NOT_CONFIGURED"


def test_start_rejects_a_malformed_challenge(client, google_on):
    assert start(client, "short").status_code == 422
    assert code(start(client, "!" * 43)) == "BAD_CODE_CHALLENGE"


def test_start_builds_the_google_address(client, google_on):
    response = start(client, new_pkce()[1])
    url = urlparse(response.json()["auth_url"])
    query = parse_qs(url.query)
    assert url.netloc == "accounts.google.com"
    assert query["client_id"] == [google_on.google_client_id]
    assert query["redirect_uri"] == ["https://api.test/v1/auth/google/callback"]
    assert query["response_type"] == ["code"]
    assert "openid" in query["scope"][0] and "email" in query["scope"][0]
    assert query["prompt"] == ["select_account"]
    assert query["state"][0] and query["nonce"][0]
    assert "client-secret" not in response.text


def test_the_secret_and_id_must_be_set_together(settings):
    from app.core.config import Settings

    with pytest.raises(ValueError, match="together"):
        Settings(
            database_url="sqlite+pysqlite:///:memory:",
            jwt_secret="x" * 40,
            google_client_id="only-the-id",
        )


# ---------------------------------------------------------------- the happy path


def test_new_player_signs_up_and_in_with_google(client, google_on, db_session):
    verifier, state = begin(client)
    page = callback(client, state)
    assert page.status_code == 200
    assert "Open MAREC Store" in page.text
    assert "default-src 'none'" in page.headers["content-security-policy"]
    assert page.headers["cache-control"] == "no-store"

    tokens = exchange(client, ticket_from(page), verifier)
    assert tokens.status_code == 200
    me = client.get("/v1/me", headers=bearer(tokens.json())).json()
    assert me["email"] == "gina@gmail.com"
    assert me["display_name"] == "Gina Banda"
    assert me["email_verified"] is True

    user = db_session.scalar(select(User).where(User.email == "gina@gmail.com"))
    assert user.password_hash is None
    identity = db_session.scalar(select(AuthIdentity))
    assert (identity.provider, identity.subject) == ("google", "google-sub-1")


def test_signing_in_again_reuses_the_same_account(client, google_on, db_session):
    first = sign_in(client)
    second = sign_in(client)
    assert first.status_code == second.status_code == 200
    assert len(list(db_session.scalars(select(User)))) == 1
    assert len(list(db_session.scalars(select(AuthIdentity)))) == 1


def test_a_changed_google_email_does_not_change_the_account_email(
    client, google_on, google_client, db_session
):
    sign_in(client)
    google_client.email = "gina.new@gmail.com"
    assert sign_in(client).status_code == 200
    users = list(db_session.scalars(select(User)))
    assert [u.email for u in users] == ["gina@gmail.com"]
    assert db_session.scalar(select(AuthIdentity)).email == "gina.new@gmail.com"


def test_a_missing_name_falls_back_to_the_email_name(client, google_on, google_client):
    google_client.name = None
    tokens = sign_in(client).json()
    assert client.get("/v1/me", headers=bearer(tokens)).json()["display_name"] == "gina"


def test_google_only_accounts_cannot_log_in_with_a_password(client, google_on):
    sign_in(client)
    google_only = login(client, email="gina@gmail.com", password="whatever-password")
    unknown = login(client, email="nobody@example.com", password="whatever-password")
    assert google_only.status_code == unknown.status_code == 401
    assert google_only.json()["error"]["code"] == unknown.json()["error"]["code"]
    assert google_only.json()["error"]["message"] == unknown.json()["error"]["message"]


# ---------------------------------------------------------------- one-time tickets


def test_a_ticket_works_once(client, google_on):
    verifier, state = begin(client)
    ticket = ticket_from(callback(client, state))
    assert exchange(client, ticket, verifier).status_code == 200
    again = exchange(client, ticket, verifier)
    assert again.status_code == 401 and code(again) == "INVALID_TICKET"


def test_a_stolen_ticket_is_useless_without_the_apps_verifier(client, google_on):
    verifier, state = begin(client)
    ticket = ticket_from(callback(client, state))
    thief = exchange(client, ticket, secrets.token_urlsafe(48))
    assert thief.status_code == 401 and code(thief) == "INVALID_TICKET"
    # The wrong attempt spent the ticket, so even the real app cannot use it afterwards.
    assert exchange(client, ticket, verifier).status_code == 401


def test_an_expired_ticket_is_refused(client, google_on, db_session):
    verifier, state = begin(client)
    ticket = ticket_from(callback(client, state))
    row = db_session.scalar(select(LoginTicket))
    row.expires_at = utcnow() - timedelta(seconds=1)
    db_session.commit()
    assert exchange(client, ticket, verifier).status_code == 401


def test_unknown_tickets_and_bad_verifiers_are_refused(client, google_on):
    verifier = new_pkce()[0]
    assert exchange(client, "x" * 40, verifier).status_code == 401
    assert (
        client.post(
            "/v1/auth/google/exchange", json={"ticket": "x" * 40, "code_verifier": "short"}
        ).status_code
        == 422
    )


def test_only_a_hash_of_the_ticket_is_stored(client, google_on, db_session):
    _, state = begin(client)
    ticket = ticket_from(callback(client, state))
    assert db_session.scalar(select(LoginTicket)).ticket_hash != ticket


# ---------------------------------------------------------------- linking to existing accounts


def test_a_verified_password_account_is_linked_and_keeps_its_password(
    client, google_on, db_session
):
    from tests.helpers import make_developer  # marks the email verified

    register(client, email="gina@gmail.com")
    user = db_session.scalar(select(User).where(User.email == "gina@gmail.com"))
    make_developer(db_session, user)

    assert sign_in(client).status_code == 200
    assert len(list(db_session.scalars(select(User)))) == 1
    assert login(client, email="gina@gmail.com").status_code == 200


def test_an_unverified_password_account_is_taken_back_by_its_real_owner(
    client, google_on, db_session
):
    """Someone registers gina@gmail.com with a password they know before Gina arrives. When Gina
    signs in with Google, that password must stop working and its sessions must end."""
    register(client, email="gina@gmail.com", password="attackers-password")
    attacker_tokens = login(client, email="gina@gmail.com", password="attackers-password").json()
    assert client.get("/v1/me", headers=bearer(attacker_tokens)).status_code == 200

    assert sign_in(client).status_code == 200

    assert login(client, email="gina@gmail.com", password="attackers-password").status_code == 401
    assert client.get("/v1/me", headers=bearer(attacker_tokens)).status_code == 401
    user = db_session.scalar(select(User).where(User.email == "gina@gmail.com"))
    assert user.password_hash is None and user.email_verified_at is not None
    sessions = list(db_session.scalars(select(UserSession).where(UserSession.user_id == user.id)))
    # The attacker's session is revoked; only the new Google session is still alive.
    assert len(sessions) == 2
    assert sum(1 for session in sessions if session.revoked_at is None) == 1


def test_an_unverified_google_email_cannot_sign_in(client, google_on, google_client):
    google_client.email_verified = False
    _, state = begin(client)
    assert error_from(callback(client, state)) == "GOOGLE_EMAIL_UNVERIFIED"


# ---------------------------------------------------------------- things that must fail


def test_a_cancelled_sign_in_goes_back_to_the_app(client, google_on):
    _, state = begin(client)
    page = callback(client, state, code_value=None, error="access_denied")
    assert error_from(page) == "GOOGLE_CANCELLED"
    assert "cancelled" in page.text.lower()


def test_a_missing_code_is_a_bad_response(client, google_on):
    _, state = begin(client)
    assert error_from(callback(client, state, code_value=None)) == "GOOGLE_BAD_RESPONSE"


def test_a_forged_state_is_refused(client, google_on):
    _, state = begin(client)
    assert error_from(callback(client, state + "tampered")) == "SIGNIN_EXPIRED"
    assert error_from(callback(client, "not-a-token")) == "SIGNIN_EXPIRED"


def test_an_expired_state_is_refused(client, google_on):
    expired = create_state_token("nonce", new_pkce()[1], timedelta(seconds=-5))
    assert error_from(callback(client, expired)) == "SIGNIN_EXPIRED"


def test_an_access_token_is_not_a_valid_state_and_a_state_is_not_an_access_token(client, google_on):
    import uuid

    access = create_access_token(uuid.uuid4(), uuid.uuid4())
    assert error_from(callback(client, access)) == "SIGNIN_EXPIRED"
    state = create_state_token("nonce", new_pkce()[1])
    assert client.get("/v1/me", headers={"Authorization": f"Bearer {state}"}).status_code == 401


def test_a_token_signed_with_the_wrong_key_is_refused(client, google_on, google_client):
    from cryptography.hazmat.primitives.asymmetric import rsa

    google_client.sign_with = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    _, state = begin(client)
    assert error_from(callback(client, state)) == "GOOGLE_BAD_TOKEN"


def test_a_token_for_another_app_is_refused(client, google_on, google_client):
    google_client.audience = "someone-elses-client-id"
    _, state = begin(client)
    assert error_from(callback(client, state)) == "GOOGLE_BAD_TOKEN"


def test_a_token_from_another_issuer_is_refused(client, google_on, google_client):
    google_client.issuer = "https://evil.example.com"
    _, state = begin(client)
    assert error_from(callback(client, state)) == "GOOGLE_BAD_TOKEN"


def test_a_replayed_token_with_the_wrong_nonce_is_refused(client, google_on, google_client):
    google_client.nonce = "a-nonce-from-another-sign-in"
    _, state = begin(client)
    assert error_from(callback(client, state)) == "GOOGLE_BAD_TOKEN"


def test_an_unsigned_token_is_refused(client, google_on, google_client, monkeypatch):
    monkeypatch.setattr(
        type(google_client),
        "_id_token",
        lambda self: jwt.encode(
            {"sub": "x", "email": "a@b.co", "aud": google_on.google_client_id},
            key="",
            algorithm="none",
        ),
    )
    _, state = begin(client)
    assert error_from(callback(client, state)) == "GOOGLE_BAD_TOKEN"


def test_google_refusing_the_code_is_reported(client, google_on, google_client):
    google_client.token_status = 400
    _, state = begin(client)
    assert error_from(callback(client, state)) == "GOOGLE_REJECTED"


def test_a_suspended_account_cannot_sign_in(client, google_on, db_session):
    sign_in(client)
    user = db_session.scalar(select(User))
    user.status = "suspended"
    db_session.commit()
    _, state = begin(client)
    assert error_from(callback(client, state)) == "ACCOUNT_SUSPENDED"


def test_the_callback_works_without_google_configured(client):
    page = client.get("/v1/auth/google/callback", params={"code": "x", "state": "y"})
    assert error_from(page) == "GOOGLE_NOT_CONFIGURED"


def test_the_landing_page_cannot_be_tricked_into_running_input(client, google_on):
    page = client.get(
        "/v1/auth/google/callback",
        params={"state": "<script>alert(1)</script>", "error": "<img src=x>"},
    )
    assert "<img src=x>" not in page.text
    assert "alert(1)" not in page.text


def test_email_password_sign_up_still_works(client, google_on):
    assert register(client).status_code == 201
    assert login(client, email=EMAIL, password=PASSWORD).status_code == 200
