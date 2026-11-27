import json
import re
from datetime import timedelta

import httpx
import pytest
from pydantic import SecretStr
from sqlalchemy import select

from app.core.db import utcnow
from app.core.email import Email, ResendSender, get_email_sender
from app.main import app
from app.modules.auth.models import EmailCode, User
from tests.helpers import bearer, code, create_account


@pytest.fixture()
def email_on(settings):
    settings.resend_api_key = SecretStr("re_test_key")
    settings.email_from = "MAREC Store <no-reply@example.com>"
    return settings


def last_code(email_sender):
    found = re.search(r"Code: (\d{6})", email_sender.sent[-1].text)
    assert found
    return found.group(1)


def send(client, tokens):
    return client.post("/v1/auth/email/send-code", headers=bearer(tokens))


def verify(client, tokens, value):
    return client.post("/v1/auth/email/verify", json={"code": value}, headers=bearer(tokens))


# ---------------------------------------------------------------- the code flow


def test_sending_needs_email_to_be_set_up(client, db_session):
    _, tokens = create_account(client, db_session, "a@example.com")
    response = send(client, tokens)
    assert response.status_code == 503 and code(response) == "EMAIL_NOT_CONFIGURED"


def test_a_code_is_emailed_and_confirms_the_address(client, db_session, email_on, email_sender):
    _, tokens = create_account(client, db_session, "a@example.com")
    assert send(client, tokens).json() == {"expires_in_minutes": 15}
    assert len(email_sender.sent) == 1
    mail = email_sender.sent[0]
    assert mail.to == "a@example.com" and "MAREC" in mail.subject

    assert client.get("/v1/me", headers=bearer(tokens)).json()["email_verified"] is False
    confirmed = verify(client, tokens, last_code(email_sender))
    assert confirmed.status_code == 200 and confirmed.json()["email_verified"] is True
    assert send(client, tokens).status_code == 409  # nothing left to verify


def test_only_a_hash_of_the_code_is_stored(client, db_session, email_on, email_sender):
    _, tokens = create_account(client, db_session, "a@example.com")
    send(client, tokens)
    row = db_session.scalar(select(EmailCode))
    assert last_code(email_sender) not in row.code_hash


def test_a_wrong_code_is_refused_and_counts_attempts(client, db_session, email_on, email_sender):
    _, tokens = create_account(client, db_session, "a@example.com")
    send(client, tokens)
    real = last_code(email_sender)
    wrong = "000000" if real != "000000" else "111111"
    assert code(verify(client, tokens, wrong)) == "WRONG_CODE"
    assert verify(client, tokens, real).status_code == 200


def test_too_many_wrong_codes_kill_the_code(client, db_session, email_on, email_sender):
    _, tokens = create_account(client, db_session, "a@example.com")
    send(client, tokens)
    real = last_code(email_sender)
    wrong = "000000" if real != "000000" else "111111"
    for _ in range(email_on.email_code_max_attempts):
        assert code(verify(client, tokens, wrong)) == "WRONG_CODE"
    blocked = verify(client, tokens, wrong)
    assert blocked.status_code == 429 and code(blocked) == "TOO_MANY_ATTEMPTS"
    # Even the right code no longer works: the person must ask for a new one.
    assert code(verify(client, tokens, real)) == "WRONG_CODE"


def test_an_expired_code_is_refused(client, db_session, email_on, email_sender):
    _, tokens = create_account(client, db_session, "a@example.com")
    send(client, tokens)
    row = db_session.scalar(select(EmailCode))
    row.expires_at = utcnow() - timedelta(seconds=1)
    db_session.commit()
    assert code(verify(client, tokens, last_code(email_sender))) == "WRONG_CODE"


def test_asking_again_too_soon_is_refused(client, db_session, email_on, email_sender):
    _, tokens = create_account(client, db_session, "a@example.com")
    assert send(client, tokens).status_code == 200
    again = send(client, tokens)
    assert again.status_code == 429 and code(again) == "TOO_SOON"
    assert len(email_sender.sent) == 1


def test_a_new_code_replaces_the_old_one(client, db_session, email_on, email_sender):
    _, tokens = create_account(client, db_session, "a@example.com")
    send(client, tokens)
    first = last_code(email_sender)
    for row in db_session.scalars(select(EmailCode)):
        row.created_at = utcnow() - timedelta(minutes=5)
    db_session.commit()
    send(client, tokens)
    second = last_code(email_sender)
    if first != second:
        assert code(verify(client, tokens, first)) == "WRONG_CODE"
    assert verify(client, tokens, second).status_code == 200


def test_there_is_a_daily_limit(client, db_session, email_on, email_sender):
    _, tokens = create_account(client, db_session, "a@example.com")
    for _ in range(5):
        assert send(client, tokens).status_code == 200
        for row in db_session.scalars(select(EmailCode)):
            row.created_at = utcnow() - timedelta(minutes=5)
        db_session.commit()
    blocked = send(client, tokens)
    assert blocked.status_code == 429 and code(blocked) == "TOO_MANY_CODES"


def test_a_failed_send_leaves_nothing_behind(client, db_session, email_on):
    class Refusing:
        def send(self, email):
            return False

    app.dependency_overrides[get_email_sender] = lambda: Refusing()
    _, tokens = create_account(client, db_session, "a@example.com")
    response = send(client, tokens)
    assert response.status_code == 502 and code(response) == "EMAIL_SEND_FAILED"
    assert db_session.scalar(select(EmailCode)) is None
    # No cool-down is triggered by a failure, so the person can try again right away.
    assert send(client, tokens).status_code == 502


def test_codes_are_per_account(client, db_session, email_on, email_sender):
    _, mine = create_account(client, db_session, "me@example.com")
    _, other = create_account(client, db_session, "other@example.com")
    send(client, mine)
    assert code(verify(client, other, last_code(email_sender))) == "WRONG_CODE"
    user = db_session.scalar(select(User).where(User.email == "other@example.com"))
    assert user.email_verified_at is None


def test_the_code_must_be_six_digits_and_login_is_required(client, db_session, email_on):
    _, tokens = create_account(client, db_session, "a@example.com")
    assert verify(client, tokens, "12345").status_code == 422
    assert verify(client, tokens, "abcdef").status_code == 422
    assert client.post("/v1/auth/email/send-code").status_code == 401


# ---------------------------------------------------------------- the Resend client


def test_resend_gets_the_right_request():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["auth"] = request.headers["authorization"]
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"id": "abc"})

    sender = ResendSender("re_secret", "MAREC <no-reply@example.com>", httpx.MockTransport(handler))
    ok = sender.send(Email(to="a@example.com", subject="Hi", text="Body", html="<p>Body</p>"))
    assert ok is True
    assert seen["url"] == "https://api.resend.com/emails"
    assert seen["auth"] == "Bearer re_secret"
    assert seen["body"] == {
        "from": "MAREC <no-reply@example.com>",
        "to": ["a@example.com"],
        "subject": "Hi",
        "text": "Body",
        "html": "<p>Body</p>",
    }


def test_resend_failures_return_false_and_never_log_the_key(caplog):
    def refuse(request):
        return httpx.Response(403, json={"message": "domain not verified"})

    def down(request):
        raise httpx.ConnectError("no network")

    for handler in (refuse, down):
        sender = ResendSender("re_super_secret", "x@example.com", httpx.MockTransport(handler))
        assert sender.send(Email(to="a@example.com", subject="s", text="t")) is False
    assert "re_super_secret" not in caplog.text


def test_email_html_escapes_what_it_is_given():
    from app.core.email import game_decision_email

    mail = game_decision_email("a@example.com", "<b>Evil</b>", "removed", "<script>x</script>")
    assert "<b>Evil</b>" not in mail.html and "<script>" not in mail.html


def test_from_address_is_required_with_a_key():
    from app.core.config import Settings

    with pytest.raises(ValueError, match="EMAIL_FROM"):
        Settings(
            database_url="sqlite+pysqlite:///:memory:",
            jwt_secret="x" * 40,
            resend_api_key="re_x",
        )
