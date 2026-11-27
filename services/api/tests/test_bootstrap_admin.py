from urllib.parse import parse_qs, urlparse

from sqlalchemy import select

from app.cli import main
from app.core.db import utcnow
from app.modules.audit.models import AuditLog
from app.modules.auth.models import User
from app.modules.rbac import service as rbac
from app.modules.rbac.permissions import Role
from app.modules.studios.models import Studio
from tests.google_flow import new_pkce, sign_in
from tests.helpers import bearer, login, make_studio, register


def test_the_owners_verified_google_account_becomes_super_admin(
    client, settings, db_session, google_on
):
    settings.bootstrap_admin_emails = "Gina@Gmail.com, other@example.com"
    tokens = sign_in(client).json()
    me = client.get("/v1/me", headers=bearer(tokens)).json()
    assert me["roles"] == ["super_admin"]
    entry = db_session.scalar(select(AuditLog).where(AuditLog.action == "role.granted"))
    assert entry.actor_roles == "bootstrap"


def test_other_people_get_no_roles(client, settings, google_on):
    settings.bootstrap_admin_emails = "someone-else@example.com"
    tokens = sign_in(client).json()
    assert client.get("/v1/me", headers=bearer(tokens)).json()["roles"] == []


def test_nothing_is_granted_when_the_list_is_empty(client, google_on):
    tokens = sign_in(client).json()
    assert client.get("/v1/me", headers=bearer(tokens)).json()["roles"] == []


def test_registering_the_owners_email_first_does_not_work(client, settings, db_session):
    """A password account with an unverified address must never receive the admin role."""
    settings.bootstrap_admin_emails = "owner@example.com"
    register(client, email="owner@example.com")
    tokens = login(client, email="owner@example.com").json()
    assert client.get("/v1/me", headers=bearer(tokens)).json()["roles"] == []
    user = db_session.scalar(select(User).where(User.email == "owner@example.com"))
    assert rbac.get_roles(db_session, user.id) == []


def test_a_verified_password_account_can_be_the_owner(client, settings, db_session):
    settings.bootstrap_admin_emails = "owner@example.com"
    register(client, email="owner@example.com")
    user = db_session.scalar(select(User).where(User.email == "owner@example.com"))
    user.email_verified_at = utcnow()
    db_session.commit()
    tokens = login(client, email="owner@example.com").json()
    assert client.get("/v1/me", headers=bearer(tokens)).json()["roles"] == ["super_admin"]


def test_a_suspended_owner_gets_nothing(client, settings, db_session, google_on):
    settings.bootstrap_admin_emails = "gina@gmail.com"
    sign_in(client)
    user = db_session.scalar(select(User))
    rbac.revoke_role(db_session, user.id, Role.SUPER_ADMIN)
    user.status = "suspended"
    db_session.commit()

    _, challenge = new_pkce()
    started = client.post("/v1/auth/google/start", json={"code_challenge": challenge})
    state = parse_qs(urlparse(started.json()["auth_url"]).query)["state"][0]
    page = client.get("/v1/auth/google/callback", params={"code": "c", "state": state})
    assert "error=ACCOUNT_SUSPENDED" in page.text
    db_session.expire_all()
    assert rbac.get_roles(db_session, user.id) == []


def test_staff_roles_show_on_me_and_players_have_none(client, db_session):
    from tests.helpers import create_account

    _, player = create_account(client, db_session, "player@example.com")
    _, mod = create_account(client, db_session, "mod@example.com", [Role.GAME_MODERATOR])
    assert client.get("/v1/me", headers=bearer(player)).json()["roles"] == []
    assert client.get("/v1/me", headers=bearer(mod)).json()["roles"] == ["game_moderator"]


# ---------------------------------------------------------------- command line


def test_cli_lists_and_verifies_studios(client, db_session, session_factory, capsys):
    from tests.helpers import create_account

    owner, _ = create_account(client, db_session, "owner@example.com")
    make_studio(db_session, owner, "Zomba Games", status="pending")
    make_studio(db_session, owner, "Old Studio", status="verified")

    assert main(["list-studios", "--status", "pending"], session_factory) == 0
    out = capsys.readouterr().out
    assert "zomba-games" in out and "old-studio" not in out

    assert main(["verify-studio", "--slug", "zomba-games"], session_factory) == 0
    assert "Verified Zomba Games" in capsys.readouterr().out
    db_session.expire_all()
    studio = db_session.scalar(select(Studio).where(Studio.slug == "zomba-games"))
    assert studio.status == "verified" and studio.verified_at is not None
    entry = db_session.scalar(select(AuditLog).where(AuditLog.action == "studio.verified"))
    assert entry.actor_roles == "cli"

    assert main(["verify-studio", "--slug", "zomba-games"], session_factory) == 0
    assert "already verified" in capsys.readouterr().out


def test_cli_reports_an_unknown_studio(session_factory, capsys):
    assert main(["verify-studio", "--slug", "nope"], session_factory) == 1
    assert "No studio" in capsys.readouterr().err
