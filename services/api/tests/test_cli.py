import base64

import pytest
from sqlalchemy import select

from app.cli import main
from app.modules.audit.models import AuditLog
from app.modules.auth.models import User
from app.modules.rbac import service as rbac
from app.modules.rbac.permissions import Role
from tests.helpers import EMAIL, register


def count_audit(db_session, action):
    db_session.expire_all()
    return len(list(db_session.scalars(select(AuditLog).where(AuditLog.action == action))))


def test_cli_grants_and_revokes_a_role(client, db_session, session_factory, capsys):
    register(client)
    user = db_session.scalar(select(User).where(User.email == EMAIL))
    grant = ["grant-role", "--email", EMAIL, "--role", "super_admin"]
    revoke = ["revoke-role", "--email", EMAIL, "--role", "super_admin"]

    assert main(grant, session_factory) == 0
    db_session.expire_all()
    assert rbac.get_roles(db_session, user.id) == [Role.SUPER_ADMIN]
    entry = db_session.scalar(select(AuditLog).where(AuditLog.action == "role.granted"))
    assert entry.actor_roles == "cli"
    assert entry.actor_user_id is None

    # Running it again changes nothing and adds no audit row.
    assert main(grant, session_factory) == 0
    assert "Nothing to change" in capsys.readouterr().out
    assert count_audit(db_session, "role.granted") == 1

    assert main(revoke, session_factory) == 0
    db_session.expire_all()
    assert rbac.get_roles(db_session, user.id) == []
    assert count_audit(db_session, "role.revoked") == 1


def test_cli_reports_unknown_email(session_factory, capsys):
    args = ["grant-role", "--email", "nobody@example.com", "--role", "developer"]
    assert main(args, session_factory) == 1
    assert "No user" in capsys.readouterr().err


def test_cli_rejects_unknown_role(session_factory):
    with pytest.raises(SystemExit):
        main(["grant-role", "--email", EMAIL, "--role", "emperor"], session_factory)


def test_cli_generates_a_signing_key(capsys):
    assert main(["gen-signing-key"]) == 0
    assert len(base64.b64decode(capsys.readouterr().out.strip())) == 32


def test_cli_generates_a_launch_key(capsys):
    assert main(["gen-launch-key"]) == 0
    pem = base64.b64decode(capsys.readouterr().out.strip())
    assert pem.startswith(b"-----BEGIN PRIVATE KEY-----")
