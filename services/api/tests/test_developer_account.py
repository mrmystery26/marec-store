from sqlalchemy import select

from app.core.db import utcnow
from app.modules.developer.models import DeveloperProfile
from app.modules.rbac.permissions import Role
from app.modules.rbac.service import get_roles
from tests.helpers import (
    add_member,
    bearer,
    code,
    create_account,
    make_category,
    make_studio,
    upload_ready_build,
)

TERMS = "2026-11"


def register_developer(client, tokens, name="Zomba Games", accept=True, version=TERMS):
    return client.post(
        "/v1/developer/account",
        json={"studio_name": name, "accept_terms": accept, "terms_version": version},
        headers=bearer(tokens),
    )


def make_verified_account(client, db_session, email="dev@example.com", roles=()):
    user, tokens = create_account(client, db_session, email, roles)
    user.email_verified_at = utcnow()
    db_session.merge(user)
    db_session.commit()
    return user, tokens


# ---------------------------------------------------------------- becoming a developer


def test_account_status_before_registering(client, db_session):
    _, tokens = create_account(client, db_session, "dev@example.com")
    info = client.get("/v1/developer/account", headers=bearer(tokens)).json()
    assert info["is_developer"] is False
    assert info["email_verified"] is False
    assert info["terms_version"] == TERMS
    assert info["studios"] == []
    assert client.get("/v1/developer/account").status_code == 401


def test_an_unverified_email_cannot_register(client, db_session):
    _, tokens = create_account(client, db_session, "dev@example.com")
    response = register_developer(client, tokens)
    assert response.status_code == 403 and code(response) == "EMAIL_NOT_VERIFIED"
    assert db_session.scalar(select(DeveloperProfile)) is None


def test_the_rules_must_be_accepted(client, db_session):
    _, tokens = make_verified_account(client, db_session)
    refused = register_developer(client, tokens, accept=False)
    assert refused.status_code == 422 and code(refused) == "TERMS_NOT_ACCEPTED"
    old = register_developer(client, tokens, version="2020-01")
    assert old.status_code == 409 and code(old) == "TERMS_CHANGED"
    assert db_session.scalar(select(DeveloperProfile)) is None


def test_registering_creates_the_profile_role_and_a_pending_studio(client, db_session):
    user, tokens = make_verified_account(client, db_session)
    response = register_developer(client, tokens)
    assert response.status_code == 201
    assert response.json()["name"] == "Zomba Games"
    assert response.json()["status"] == "pending"
    assert response.json()["my_role"] == "owner"

    profile = db_session.get(DeveloperProfile, user.id)
    assert profile.terms_version == TERMS and profile.terms_accepted_at is not None
    assert Role.DEVELOPER in get_roles(db_session, user.id)

    info = client.get("/v1/developer/account", headers=bearer(tokens)).json()
    assert info["is_developer"] is True and len(info["studios"]) == 1


def test_registering_twice_is_refused(client, db_session):
    _, tokens = make_verified_account(client, db_session)
    assert register_developer(client, tokens).status_code == 201
    again = register_developer(client, tokens, name="Another")
    assert again.status_code == 409 and code(again) == "ALREADY_DEVELOPER"


def test_a_failed_registration_leaves_nothing_half_done(client, db_session):
    user, tokens = make_verified_account(client, db_session)
    # A one-letter name is rejected before anything is written.
    assert register_developer(client, tokens, name="x").status_code == 422
    assert db_session.get(DeveloperProfile, user.id) is None
    assert Role.DEVELOPER not in get_roles(db_session, user.id)


def test_more_studios_need_a_developer_account(client, db_session):
    user, tokens = make_verified_account(client, db_session)
    blocked = client.post(
        "/v1/developer/studios", json={"name": "Side Studio"}, headers=bearer(tokens)
    )
    assert blocked.status_code == 403 and code(blocked) == "DEVELOPER_ACCOUNT_REQUIRED"
    assert register_developer(client, tokens).status_code == 201
    allowed = client.post(
        "/v1/developer/studios", json={"name": "Side Studio"}, headers=bearer(tokens)
    )
    assert allowed.status_code == 201


def test_the_owner_is_told_when_a_developer_is_waiting(client, db_session, settings, email_sender):
    settings.admin_notify_email = "boss@example.com"
    _, tokens = make_verified_account(client, db_session)
    register_developer(client, tokens)
    assert [m.to for m in email_sender.sent] == ["boss@example.com"]
    assert "Zomba Games" in email_sender.sent[0].subject


def test_nobody_is_emailed_when_no_notice_address_is_set(client, db_session, email_sender):
    _, tokens = make_verified_account(client, db_session)
    register_developer(client, tokens)
    assert email_sender.sent == []


# ---------------------------------------------------------------- notices from MAREC


def test_verifying_a_studio_emails_its_owner(client, db_session, email_sender):
    _, dev = make_verified_account(client, db_session)
    studio_id = register_developer(client, dev).json()["id"]
    _, admin = create_account(client, db_session, "admin@example.com", [Role.STORE_ADMIN])
    assert (
        client.post(f"/v1/admin/studios/{studio_id}/verify", headers=bearer(admin)).status_code
        == 200
    )
    assert [m.to for m in email_sender.sent] == ["dev@example.com"]
    assert "verified" in email_sender.sent[0].subject


def test_review_decisions_email_the_owner(client, db_session, email_sender):
    from tests.helpers import make_game

    owner, _ = create_account(client, db_session, "owner@example.com")
    studio = make_studio(db_session, owner)
    game = make_game(db_session, studio, status="under_review")
    _, mod = create_account(client, db_session, "mod@example.com", [Role.GAME_MODERATOR])

    def decide(action, reason=None):
        body = {"action": action, **({"reason": reason} if reason else {})}
        response = client.post(
            f"/v1/admin/games/{game.id}/transition", json=body, headers=bearer(mod)
        )
        assert response.status_code == 200, response.text

    decide("request_changes", "Add a clearer description.")
    assert len(email_sender.sent) == 1
    assert "Add a clearer description." in email_sender.sent[0].text
    assert email_sender.sent[0].to == "owner@example.com"


def test_steps_that_are_not_decisions_send_no_email(client, db_session, email_sender):
    from tests.helpers import make_game

    owner, _ = create_account(client, db_session, "owner@example.com")
    studio = make_studio(db_session, owner)
    game = make_game(db_session, studio, status="submitted")
    _, mod = create_account(client, db_session, "mod@example.com", [Role.GAME_MODERATOR])
    started = client.post(
        f"/v1/admin/games/{game.id}/transition",
        json={"action": "start_review"},
        headers=bearer(mod),
    )
    assert started.status_code == 200 and email_sender.sent == []


# ---------------------------------------------------------------- demos only


def demo_setup(client, db_session, settings):
    settings.demo_only = True
    user, tokens = make_verified_account(client, db_session)
    studio_id = register_developer(client, tokens).json()["id"]
    _, admin = create_account(client, db_session, "admin@example.com", [Role.STORE_ADMIN])
    client.post(f"/v1/admin/studios/{studio_id}/verify", headers=bearer(admin))
    return user, tokens, studio_id


def new_game(client, tokens, studio_id, title="Maize Run"):
    return client.post(
        f"/v1/developer/studios/{studio_id}/games", json={"title": title}, headers=bearer(tokens)
    )


def test_new_games_are_free_demos(client, db_session, settings):
    _, tokens, studio_id = demo_setup(client, db_session, settings)
    game = new_game(client, tokens, studio_id).json()
    assert game["release_kind"] == "demo"
    assert game["price_minor"] == 0 and game["is_free"] is True


def test_a_demo_cannot_be_given_a_price(client, db_session, settings):
    _, tokens, studio_id = demo_setup(client, db_session, settings)
    game_id = new_game(client, tokens, studio_id).json()["id"]
    url = f"/v1/developer/games/{game_id}"
    refused = client.patch(url, json={"price_minor": 5000}, headers=bearer(tokens))
    assert refused.status_code == 422 and code(refused) == "DEMO_MUST_BE_FREE"
    assert client.patch(url, json={"price_minor": 0}, headers=bearer(tokens)).status_code == 200
    assert client.patch(url, json={"summary": "Run!"}, headers=bearer(tokens)).status_code == 200


def test_there_is_a_demo_limit_per_studio(client, db_session, settings):
    _, tokens, studio_id = demo_setup(client, db_session, settings)
    settings.demo_max_games_per_studio = 2
    assert new_game(client, tokens, studio_id, "One").status_code == 201
    assert new_game(client, tokens, studio_id, "Two").status_code == 201
    third = new_game(client, tokens, studio_id, "Three")
    assert third.status_code == 409 and code(third) == "DEMO_LIMIT"


def test_a_demo_build_has_a_size_limit(client, db_session, settings):
    _, tokens, studio_id = demo_setup(client, db_session, settings)
    settings.demo_max_build_mb = 1
    game_id = new_game(client, tokens, studio_id).json()["id"]
    too_big = {
        "version": "1.0.0",
        "platform": "windows-x64",
        "files": [{"path": "Game.exe", "size_bytes": 2 * 1024 * 1024, "sha256": "a" * 64}],
    }
    response = client.post(
        f"/v1/developer/games/{game_id}/builds", json=too_big, headers=bearer(tokens)
    )
    assert response.status_code == 422 and code(response) == "DEMO_TOO_LARGE"
    small = {**too_big, "files": [{**too_big["files"][0], "size_bytes": 1000}]}
    assert (
        client.post(
            f"/v1/developer/games/{game_id}/builds", json=small, headers=bearer(tokens)
        ).status_code
        == 201
    )


def test_a_demo_goes_from_upload_to_the_store(client, db_session, settings):
    """The whole developer journey: register, get verified, make a demo, upload, submit, review,
    publish, and a player finds it in the store marked as a demo."""
    make_category(db_session, "Action")
    _, tokens, studio_id = demo_setup(client, db_session, settings)
    game_id = new_game(client, tokens, studio_id).json()["id"]
    details = {
        "summary": "Dodge the goats.",
        "description": "A short demo of a larger game.",
        "age_rating": "7+",
        "category_slugs": ["action"],
        "requirements": [
            {
                "tier": "minimum",
                "os": "Windows 10",
                "cpu": "Intel i3",
                "ram_mb": 4096,
                "storage_mb": 500,
            }
        ],
    }
    assert (
        client.patch(
            f"/v1/developer/games/{game_id}", json=details, headers=bearer(tokens)
        ).status_code
        == 200
    )
    upload_ready_build(client, tokens, game_id, {"Game.exe": b"MZ demo build"})
    submitted = client.post(f"/v1/developer/games/{game_id}/submit", headers=bearer(tokens))
    assert submitted.status_code == 200 and submitted.json()["status"] == "submitted"

    _, mod = create_account(
        client, db_session, "mod@example.com", [Role.GAME_MODERATOR, Role.STORE_ADMIN]
    )
    for action in ("start_review", "approve", "publish"):
        step = client.post(
            f"/v1/admin/games/{game_id}/transition", json={"action": action}, headers=bearer(mod)
        )
        assert step.status_code == 200, step.text

    listing = client.get("/v1/games").json()["items"]
    assert [g["title"] for g in listing] == ["Maize Run"]
    assert listing[0]["release_kind"] == "demo" and listing[0]["is_free"] is True
    assert client.get(f"/v1/games/{listing[0]['slug']}").json()["release_kind"] == "demo"


def test_with_demo_only_off_games_are_full_releases(client, db_session, settings):
    settings.demo_only = False
    user, tokens = make_verified_account(client, db_session)
    studio_id = register_developer(client, tokens).json()["id"]
    game = new_game(client, tokens, studio_id).json()
    assert game["release_kind"] == "full" and game["price_minor"] is None


# ---------------------------------------------------------------- the SDK file


def test_the_sdk_config_comes_filled_in(client, db_session, settings):
    settings.public_api_base_url = "https://api.test/"
    owner, tokens = create_account(client, db_session, "owner@example.com")
    studio = make_studio(db_session, owner)
    from tests.helpers import make_game

    game = make_game(db_session, studio, status="draft")
    response = client.get(f"/v1/developer/games/{game.id}/sdk-config", headers=bearer(tokens))
    assert response.status_code == 200
    text = response.text
    assert f'const GAME_ID := "{game.id}"' in text
    assert 'const API_BASE := "https://api.test"' in text
    assert "-----BEGIN PUBLIC KEY-----" in text and "PRIVATE" not in text
    assert "REPLACE" not in text and "example.com" not in text
    assert "marec_config.gd" in response.headers["content-disposition"]


def test_the_sdk_config_is_only_for_studio_members(client, db_session):
    from tests.helpers import make_game

    owner, _ = create_account(client, db_session, "owner@example.com")
    _, stranger = create_account(client, db_session, "stranger@example.com")
    game = make_game(db_session, make_studio(db_session, owner), status="draft")
    url = f"/v1/developer/games/{game.id}/sdk-config"
    assert client.get(url, headers=bearer(stranger)).status_code in (403, 404)
    assert client.get(url).status_code == 401


def test_members_with_any_role_can_download_it(client, db_session):
    from tests.helpers import make_game

    owner, _ = create_account(client, db_session, "owner@example.com")
    coder, coder_tokens = create_account(client, db_session, "coder@example.com")
    studio = make_studio(db_session, owner)
    add_member(db_session, studio, coder, "developer")
    game = make_game(db_session, studio, status="draft")
    assert (
        client.get(
            f"/v1/developer/games/{game.id}/sdk-config", headers=bearer(coder_tokens)
        ).status_code
        == 200
    )
