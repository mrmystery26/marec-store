import uuid

from sqlalchemy import select

from app.modules.audit.models import AuditLog
from app.modules.catalog.models import Game
from tests.helpers import (
    add_member,
    bearer,
    code,
    create_account,
    make_category,
    make_build,
    make_game,
    make_studio,
)

FULL_DETAILS = {
    "summary": "A short pitch.",
    "description": "A longer description of the game.",
    "price_minor": 250000,
    "age_rating": "12+",
    "category_slugs": ["adventure"],
    "requirements": [
        {
            "tier": "minimum",
            "os": "Windows 10",
            "cpu": "Intel i3",
            "ram_mb": 4096,
            "storage_mb": 2000,
        }
    ],
}


def create_studio(client, tokens, name="Zomba Games"):
    return client.post("/v1/developer/studios", json={"name": name}, headers=bearer(tokens))


def create_game(client, tokens, studio_id, title="My First Game"):
    return client.post(
        f"/v1/developer/studios/{studio_id}/games", json={"title": title}, headers=bearer(tokens)
    )


def patch(client, tokens, game_id, body):
    return client.patch(f"/v1/developer/games/{game_id}", json=body, headers=bearer(tokens))


def test_create_and_list_studios(client, db_session):
    _, tokens = create_account(client, db_session, "dev@example.com")
    first = create_studio(client, tokens)
    assert first.status_code == 201
    assert first.json()["slug"] == "zomba-games"
    assert first.json()["status"] == "pending"
    assert first.json()["my_role"] == "owner"

    assert create_studio(client, tokens).json()["slug"] == "zomba-games-2"
    listing = client.get("/v1/developer/studios", headers=bearer(tokens))
    assert len(listing.json()) == 2
    assert client.get("/v1/developer/studios").status_code == 401


def test_a_user_can_own_at_most_three_studios(client, db_session):
    _, tokens = create_account(client, db_session, "dev@example.com")
    for number in range(3):
        assert create_studio(client, tokens, f"Studio {number}").status_code == 201
    fourth = create_studio(client, tokens, "Studio 4")
    assert fourth.status_code == 409
    assert code(fourth) == "STUDIO_LIMIT"


def test_game_lifecycle_in_draft(client, db_session):
    owner, tokens = create_account(client, db_session, "dev@example.com")
    studio = make_studio(db_session, owner, "Draft Studio", status="pending")
    make_category(db_session, "Adventure")

    created = create_game(client, tokens, studio.id)
    assert created.status_code == 201
    game = created.json()
    assert game["slug"] == "my-first-game"
    assert game["status"] == "draft"
    assert game["price_minor"] is None
    assert game["is_free"] is False

    updated = patch(client, tokens, game["id"], FULL_DETAILS)
    assert updated.status_code == 200
    body = updated.json()
    assert body["price_minor"] == 250000
    assert [c["slug"] for c in body["categories"]] == ["adventure"]
    assert body["requirements"][0]["gpu"] == ""

    fetched = client.get(f"/v1/developer/games/{game['id']}", headers=bearer(tokens))
    assert fetched.json()["summary"] == "A short pitch."
    listing = client.get(f"/v1/developer/studios/{studio.id}/games", headers=bearer(tokens))
    assert listing.json()["total"] == 1


def test_invalid_updates_are_rejected(client, db_session):
    owner, tokens = create_account(client, db_session, "dev@example.com")
    studio = make_studio(db_session, owner)
    game = make_game(db_session, studio)
    url_id = str(game.id)

    assert patch(client, tokens, url_id, {"age_rating": "99+"}).status_code == 422
    assert patch(client, tokens, url_id, {"price_minor": -5}).status_code == 422
    assert patch(client, tokens, url_id, {"colour": "red"}).status_code == 422  # unknown field
    assert patch(client, tokens, url_id, {"title": None}).status_code == 422  # cannot be cleared
    unknown = patch(client, tokens, url_id, {"category_slugs": ["does-not-exist"]})
    assert unknown.status_code == 422
    assert code(unknown) == "UNKNOWN_CATEGORY"
    duplicate_tiers = {
        "requirements": [FULL_DETAILS["requirements"][0], FULL_DETAILS["requirements"][0]]
    }
    assert patch(client, tokens, url_id, duplicate_tiers).status_code == 422


def test_non_members_cannot_see_or_change_a_game(client, db_session):
    owner, _ = create_account(client, db_session, "owner@example.com")
    _, stranger = create_account(client, db_session, "stranger@example.com")
    game = make_game(db_session, make_studio(db_session, owner))

    url = f"/v1/developer/games/{game.id}"
    assert client.get(url, headers=bearer(stranger)).status_code == 404
    assert patch(client, stranger, str(game.id), {"title": "Stolen"}).status_code == 404
    submit = client.post(f"{url}/submit", headers=bearer(stranger))
    assert submit.status_code == 404


def test_studio_roles_limit_what_members_can_change(client, db_session):
    owner, _ = create_account(client, db_session, "owner@example.com")
    coder, coder_tokens = create_account(client, db_session, "coder@example.com")
    accountant, accountant_tokens = create_account(client, db_session, "money@example.com")
    studio = make_studio(db_session, owner)
    add_member(db_session, studio, coder, "developer")
    add_member(db_session, studio, accountant, "finance")
    game_id = str(make_game(db_session, studio).id)

    assert patch(client, coder_tokens, game_id, {"title": "Better Title"}).status_code == 200
    price_by_coder = patch(client, coder_tokens, game_id, {"price_minor": 1})
    assert price_by_coder.status_code == 403
    assert client.post(
        f"/v1/developer/games/{game_id}/submit", headers=bearer(coder_tokens)
    ).status_code == 403

    assert patch(client, accountant_tokens, game_id, {"price_minor": 300000}).status_code == 200
    assert patch(client, accountant_tokens, game_id, {"title": "Nope"}).status_code == 403

    only_members = create_account(client, db_session, "late@example.com")[1]
    assert create_game(client, only_members, studio.id).status_code == 404
    assert create_game(client, accountant_tokens, studio.id).status_code == 403


def test_submission_rules(client, db_session):
    owner, tokens = create_account(client, db_session, "dev@example.com")
    unverified = make_studio(db_session, owner, "New Studio", status="pending")
    created = create_game(client, tokens, unverified.id).json()
    submit_url = f"/v1/developer/games/{created['id']}/submit"

    refused = client.post(submit_url, headers=bearer(tokens))
    assert refused.status_code == 403
    assert code(refused) == "STUDIO_NOT_VERIFIED"

    verified = make_studio(db_session, owner, "Verified Studio")
    incomplete = create_game(client, tokens, verified.id).json()
    incomplete_url = f"/v1/developer/games/{incomplete['id']}/submit"
    response = client.post(incomplete_url, headers=bearer(tokens))
    assert response.status_code == 422
    assert code(response) == "SUBMISSION_INCOMPLETE"
    assert "price_minor" in response.json()["error"]["message"]

    make_category(db_session, "Adventure")
    assert patch(client, tokens, incomplete["id"], FULL_DETAILS).status_code == 200

    no_build = client.post(incomplete_url, headers=bearer(tokens))
    assert no_build.status_code == 422
    assert "a ready build" in no_build.json()["error"]["message"]

    make_build(db_session, db_session.get(Game, uuid.UUID(incomplete["id"])).id)
    submitted = client.post(incomplete_url, headers=bearer(tokens))
    assert submitted.status_code == 200
    assert submitted.json()["status"] == "submitted"

    # Locked while it is waiting for review.
    locked = patch(client, tokens, incomplete["id"], {"title": "Sneaky Edit"})
    assert locked.status_code == 409
    assert code(locked) == "GAME_NOT_EDITABLE"
    again = client.post(incomplete_url, headers=bearer(tokens))
    assert again.status_code == 409


def test_changes_are_audited_including_price_history(client, db_session):
    owner, tokens = create_account(client, db_session, "dev@example.com")
    studio = make_studio(db_session, owner)
    game_id = create_game(client, tokens, studio.id).json()["id"]
    patch(client, tokens, game_id, {"price_minor": 250000})
    patch(client, tokens, game_id, {"price_minor": 300000})

    db_session.expire_all()
    created = list(db_session.scalars(select(AuditLog).where(AuditLog.action == "game.created")))
    assert len(created) == 1
    updates = list(db_session.scalars(select(AuditLog).where(AuditLog.action == "game.updated")))
    changes = [row.after["price_minor"] for row in updates]
    assert {"from": None, "to": 250000} in changes
    assert {"from": 250000, "to": 300000} in changes
