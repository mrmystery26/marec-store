import base64
import hashlib
import json

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from sqlalchemy import select

from app.core.db import utcnow
from app.modules.builds.models import GameBuild
from app.modules.catalog.models import Game
from app.modules.rbac.permissions import Role
from tests.helpers import (
    bearer,
    code,
    create_account,
    make_category,
    make_game,
    make_studio,
    upload_ready_build,
)

FILES = {"game.exe": bytes(range(256)) * 4, "data/level.pck": b"level-data-" * 100}


def publish_game_with_builds(client, db_session, versions=("1.0.0",)):
    owner, owner_tokens = create_account(client, db_session, "owner@example.com")
    studio = make_studio(db_session, owner, "Install Studio")
    category = make_category(db_session, "Adventure")
    game = make_game(db_session, studio, "Installable", "draft", 0, category, with_build=False)
    builds = [upload_ready_build(client, owner_tokens, game.id, FILES, v) for v in versions]
    stored = db_session.get(Game, game.id)
    stored.status = "published"
    stored.published_at = utcnow()
    db_session.commit()
    return game, builds


def player_with_game(client, db_session, game):
    _, player = create_account(client, db_session, "player@example.com")
    assert client.post(f"/v1/me/library/{game.id}", headers=bearer(player)).status_code == 201
    return player


def plan(client, tokens, game_id, **params):
    return client.post(f"/v1/games/{game_id}/install-plan", params=params, headers=bearer(tokens))


def test_install_plan_is_verifiable_and_downloadable(client, db_session):
    game, _ = publish_game_with_builds(client, db_session)
    player = player_with_game(client, db_session, game)

    response = plan(client, player, game.id)
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    body = response.json()
    assert body["version"] == "1.0.0"
    assert body["file_count"] == 2
    assert body["expires_in"] == 6 * 3600

    manifest_bytes = base64.b64decode(body["manifest_b64"])
    assert hashlib.sha256(manifest_bytes).hexdigest() == body["manifest_sha256"]
    key = client.get("/v1/launch/public-keys").json()["keys"][0]
    assert key["kid"] == body["kid"]
    public = Ed25519PublicKey.from_public_bytes(base64.b64decode(key["public_key"]))
    public.verify(base64.b64decode(body["manifest_signature"]), manifest_bytes)

    manifest = json.loads(manifest_bytes)
    assert {f["path"] for f in manifest["files"]} == set(FILES)
    assert len(body["downloads"]) == 2
    for link in body["downloads"]:
        download = client.get(link["url"])
        assert download.status_code == 200
        assert download.content == FILES[link["path"]]
        assert download.headers["Accept-Ranges"] == "bytes"


def test_downloads_support_byte_ranges_for_resuming(client, db_session):
    game, _ = publish_game_with_builds(client, db_session)
    player = player_with_game(client, db_session, game)
    links = {d["path"]: d["url"] for d in plan(client, player, game.id).json()["downloads"]}
    url, data = links["game.exe"], FILES["game.exe"]
    size = len(data)

    part = client.get(url, headers={"Range": "bytes=2-5"})
    assert part.status_code == 206
    assert part.content == data[2:6]
    assert part.headers["Content-Range"] == f"bytes 2-5/{size}"

    assert client.get(url, headers={"Range": "bytes=-4"}).content == data[-4:]
    assert client.get(url, headers={"Range": f"bytes={size - 4}-"}).content == data[-4:]
    assert client.get(url, headers={"Range": "bytes=0-999999"}).content == data

    outside = client.get(url, headers={"Range": f"bytes={size + 10}-"})
    assert outside.status_code == 416
    assert outside.headers["Content-Range"] == f"bytes */{size}"

    # Headers that cannot be understood are ignored and the whole file is sent.
    assert client.get(url, headers={"Range": "bytes=abc"}).content == data
    assert client.get(url, headers={"Range": "bytes=0-1,5-6"}).content == data


def test_only_owners_get_an_install_plan(client, db_session):
    game, _ = publish_game_with_builds(client, db_session)
    _, stranger = create_account(client, db_session, "stranger@example.com")

    refused = plan(client, stranger, game.id)
    assert refused.status_code == 403
    assert code(refused) == "NOT_OWNED"
    assert plan(client, stranger, "00000000-0000-0000-0000-000000000000").status_code == 403
    assert client.post(f"/v1/games/{game.id}/install-plan").status_code == 401
    assert plan(client, stranger, game.id, platform="linux").status_code == 422


def test_newest_ready_build_is_used_and_revoked_builds_are_skipped(client, db_session):
    game, builds = publish_game_with_builds(client, db_session, versions=("1.0.0", "1.1.0"))
    player = player_with_game(client, db_session, game)
    assert plan(client, player, game.id).json()["version"] == "1.1.0"

    _, mod = create_account(client, db_session, "mod@example.com", [Role.GAME_MODERATOR])
    revoke = client.post(
        f"/v1/admin/builds/{builds[1]['id']}/revoke",
        json={"reason": "Broken update"},
        headers=bearer(mod),
    )
    assert revoke.status_code == 200
    assert plan(client, player, game.id).json()["version"] == "1.0.0"


def test_plan_is_refused_when_the_game_is_unavailable_or_has_no_build(client, db_session):
    game, _ = publish_game_with_builds(client, db_session)
    player = player_with_game(client, db_session, game)

    stored = db_session.get(Game, game.id)
    stored.status = "suspended"
    db_session.commit()
    unavailable = plan(client, player, game.id)
    assert unavailable.status_code == 409
    assert code(unavailable) == "GAME_UNAVAILABLE"

    second_owner, _ = create_account(client, db_session, "second@example.com")
    studio = make_studio(db_session, second_owner, "No Build Studio")
    empty = make_game(db_session, studio, "No Build Game", "published", 0, with_build=False)
    assert client.post(f"/v1/me/library/{empty.id}", headers=bearer(player)).status_code == 201
    missing = plan(client, player, empty.id)
    assert missing.status_code == 409
    assert code(missing) == "NO_BUILD_AVAILABLE"


def test_a_corrupted_manifest_is_never_served(client, db_session, storage):
    game, _ = publish_game_with_builds(client, db_session)
    player = player_with_game(client, db_session, game)

    build = db_session.scalar(select(GameBuild).where(GameBuild.game_id == game.id))
    storage.put_bytes(build.manifest_key, b"tampered")
    broken = plan(client, player, game.id)
    assert broken.status_code == 500
    assert code(broken) == "MANIFEST_CORRUPT"
