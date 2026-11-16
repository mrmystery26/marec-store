from sqlalchemy import select

from app.core.db import utcnow
from app.modules.audit.models import AuditLog
from app.modules.catalog.models import Game
from app.modules.library.models import GameEntitlement
from tests.helpers import bearer, code, create_account, make_game, make_studio


def setup_store(client, db_session):
    owner, _ = create_account(client, db_session, "owner@example.com")
    studio = make_studio(db_session, owner, "Lib Studio")
    _, player = create_account(client, db_session, "player@example.com")
    return studio, player


def add(client, tokens, game_id):
    return client.post(f"/v1/me/library/{game_id}", headers=bearer(tokens))


def library(client, tokens, **params):
    return client.get("/v1/me/library", params=params, headers=bearer(tokens))


def test_free_game_can_be_added_once_and_shows_in_the_library(client, db_session):
    studio, player = setup_store(client, db_session)
    game = make_game(db_session, studio, "Library Game", "published", 0)

    first = add(client, player, game.id)
    assert first.status_code == 201
    assert first.json()["source"] == "free"
    assert first.json()["status"] == "active"

    second = add(client, player, game.id)
    assert second.status_code == 200
    assert second.json()["id"] == first.json()["id"]

    page = library(client, player).json()
    assert page["total"] == 1
    item = page["items"][0]
    assert item["title"] == "Library Game"
    assert item["studio"]["slug"] == "lib-studio"
    assert item["available"] is True
    assert item["unavailable_reason"] is None
    assert item["latest_version"] == "1.0.0"

    db_session.expire_all()
    stmt = select(AuditLog).where(AuditLog.action == "entitlement.granted")
    assert len(list(db_session.scalars(stmt))) == 1


def test_paid_games_cannot_be_added_for_free(client, db_session):
    studio, player = setup_store(client, db_session)
    game = make_game(db_session, studio, "Paid Game", "published", 250000)
    refused = add(client, player, game.id)
    assert refused.status_code == 402
    assert code(refused) == "PAYMENT_REQUIRED"
    assert library(client, player).json()["total"] == 0


def test_hidden_games_look_like_missing_games(client, db_session):
    studio, player = setup_store(client, db_session)
    ids = [
        make_game(db_session, studio, f"Game {status}", status, 0).id
        for status in ("draft", "submitted", "suspended", "removed")
    ]
    other_owner, _ = create_account(client, db_session, "other@example.com")
    pending = make_studio(db_session, other_owner, "Pending", "pending")
    ids.append(make_game(db_session, pending, "Pending Studio Game", "published", 0).id)

    for game_id in ids:
        response = add(client, player, game_id)
        assert response.status_code == 404
        assert code(response) == "GAME_NOT_FOUND"
    assert add(client, player, "00000000-0000-0000-0000-000000000000").status_code == 404
    assert client.post(f"/v1/me/library/{ids[0]}").status_code == 401
    assert client.get("/v1/me/library").status_code == 401


def test_revoked_access_cannot_be_re_added(client, db_session):
    studio, player = setup_store(client, db_session)
    game = make_game(db_session, studio, "Revoked Game", "published", 0)
    add(client, player, game.id)

    entitlement = db_session.scalar(select(GameEntitlement))
    entitlement.status = "revoked"
    entitlement.revoked_at = utcnow()
    db_session.commit()

    again = add(client, player, game.id)
    assert again.status_code == 409
    assert code(again) == "ENTITLEMENT_REVOKED"
    assert library(client, player).json()["total"] == 0


def test_owned_games_become_unavailable_when_suspended(client, db_session):
    studio, player = setup_store(client, db_session)
    game = make_game(db_session, studio, "Soon Suspended", "published", 0)
    add(client, player, game.id)

    stored = db_session.get(Game, game.id)
    stored.status = "suspended"
    db_session.commit()

    item = library(client, player).json()["items"][0]
    assert item["available"] is False
    assert item["unavailable_reason"]


def test_library_is_paginated_newest_first_and_private(client, db_session):
    studio, player = setup_store(client, db_session)
    _, other = create_account(client, db_session, "other-player@example.com")
    for title in ("One", "Two", "Three"):
        add(client, player, make_game(db_session, studio, title, "published", 0).id)

    first = library(client, player, limit=2).json()
    assert [i["title"] for i in first["items"]] == ["Three", "Two"]
    assert first["total"] == 3
    second = library(client, player, limit=2, offset=2).json()
    assert [i["title"] for i in second["items"]] == ["One"]
    assert library(client, other).json()["total"] == 0
    assert library(client, player, limit=100).status_code == 422
