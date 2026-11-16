import base64
import hashlib
import json
import uuid

import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey
from sqlalchemy import select

from app.modules.audit.models import AuditLog
from app.modules.builds.models import GameBuild
from app.modules.rbac.permissions import Role
from tests.helpers import (
    add_member,
    bearer,
    code,
    create_account,
    make_build,
    make_category,
    make_game,
    make_studio,
)

FILES = {"game.exe": b"MZ" + bytes(100), "data/level1.pck": b"level data " * 50}


def declare(files):
    return [
        {"path": p, "size_bytes": len(d), "sha256": hashlib.sha256(d).hexdigest()}
        for p, d in files.items()
    ]


def world(client, db_session, studio_status="verified"):
    owner, tokens = create_account(client, db_session, "owner@example.com")
    studio = make_studio(db_session, owner, "Build Studio", status=studio_status)
    category = make_category(db_session, "Adventure")
    game = make_game(db_session, studio, "Build Me", category=category, with_build=False)
    return owner, tokens, studio, game


def post_build(client, tokens, game_id, files=FILES, version="1.0.0", **extra):
    body = {"version": version, "platform": "windows-x64", "files": declare(files), **extra}
    return client.post(f"/v1/developer/games/{game_id}/builds", json=body, headers=bearer(tokens))


def upload(client, uploads, files, only=None):
    for target in uploads:
        if only is None or target["path"] in only:
            response = client.put(target["upload_url"], content=files[target["path"]])
            assert response.status_code == 204


def complete(client, tokens, build_id):
    return client.post(f"/v1/developer/builds/{build_id}/complete", headers=bearer(tokens))


def test_full_upload_flow_produces_a_signed_manifest(client, db_session, storage):
    _, tokens, _, game = world(client, db_session)

    created = post_build(client, tokens, game.id, release_notes="First release")
    assert created.status_code == 201
    build = created.json()
    assert build["status"] == "uploading"
    assert len(build["uploads"]) == 2
    assert build["uploads"][0]["upload_url"].startswith("http://testserver/v1/dev-storage/")

    first = complete(client, tokens, build["id"]).json()
    assert len(first["problems"]) == 2
    assert all("not uploaded yet" in p for p in first["problems"])
    assert first["build"]["status"] == "uploading"

    upload(client, build["uploads"], FILES, only={"game.exe"})
    second = complete(client, tokens, build["id"]).json()
    assert len(second["problems"]) == 1
    assert second["problems"][0].startswith("data/level1.pck")

    wrong = {**FILES, "data/level1.pck": b"X" * len(FILES["data/level1.pck"])}
    upload(client, build["uploads"], wrong, only={"data/level1.pck"})
    mismatch = complete(client, tokens, build["id"]).json()
    assert "do not match" in mismatch["problems"][0]

    upload(client, build["uploads"], FILES, only={"data/level1.pck"})
    done = complete(client, tokens, build["id"]).json()
    assert done["problems"] == []
    assert done["build"]["status"] == "ready"
    assert done["build"]["file_count"] == 2
    assert done["build"]["total_size_bytes"] == sum(len(d) for d in FILES.values())
    assert done["build"]["scan_status"] == "not_scanned"

    row = db_session.scalar(select(GameBuild).where(GameBuild.id == uuid.UUID(build["id"])))
    data = b"".join(storage.iter_bytes(row.manifest_key))
    assert hashlib.sha256(data).hexdigest() == row.manifest_sha256
    key = client.get("/v1/launch/public-keys").json()["keys"][0]
    assert key["kid"] == row.signing_kid
    public = Ed25519PublicKey.from_public_bytes(base64.b64decode(key["public_key"]))
    signature = base64.b64decode(row.manifest_signature)
    public.verify(signature, data)
    with pytest.raises(InvalidSignature):
        public.verify(signature, data + b" ")

    manifest = json.loads(data)
    assert [f["path"] for f in manifest["files"]] == ["data/level1.pck", "game.exe"]
    assert manifest["chunk_size"] == 8 * 1024 * 1024
    assert all(len(f["chunks"]) == 1 for f in manifest["files"])
    assert manifest["version"] == "1.0.0"
    assert manifest["entry"] == "game.exe"

    assert complete(client, tokens, build["id"]).status_code == 409
    listing = client.get(f"/v1/developer/games/{game.id}/builds", headers=bearer(tokens))
    assert [b["id"] for b in listing.json()] == [build["id"]]
    one = client.get(f"/v1/developer/builds/{build['id']}", headers=bearer(tokens))
    assert one.status_code == 200

    # A ready build is what allows the game to be submitted for review.
    submitted = client.post(f"/v1/developer/games/{game.id}/submit", headers=bearer(tokens))
    assert submitted.status_code == 200

    db_session.expire_all()
    actions = {row.action for row in db_session.scalars(select(AuditLog))}
    assert {"build.created", "build.ready"} <= actions


def test_wrong_sized_uploads_are_caught(client, db_session):
    _, tokens, _, game = world(client, db_session)
    files = {"game.exe": b"0123456789"}
    build = post_build(client, tokens, game.id, files).json()
    target = build["uploads"][0]

    too_big = client.put(target["upload_url"], content=b"0123456789!")
    assert too_big.status_code == 413

    assert client.put(target["upload_url"], content=b"012345678").status_code == 204
    result = complete(client, tokens, build["id"]).json()
    assert "9 bytes but 10 were declared" in result["problems"][0]


@pytest.mark.parametrize(
    "path",
    ["../evil.dll", "/abs/x.dll", "C:/x.dll", "a\\b.dll", "setup.bat", "CON", "a//b", "name?.png"],
)
def test_unsafe_file_paths_are_rejected(client, db_session, path):
    _, tokens, _, game = world(client, db_session)
    response = post_build(client, tokens, game.id, {path: b"x"})
    assert response.status_code == 422
    assert code(response) == "VALIDATION_ERROR"


def test_invalid_build_requests_are_rejected(client, db_session):
    _, tokens, _, game = world(client, db_session)
    url = f"/v1/developer/games/{game.id}/builds"
    good = {"version": "1.0.0", "platform": "windows-x64", "files": declare({"a.exe": b"x"})}

    def attempt(**changes):
        return client.post(url, json={**good, **changes}, headers=bearer(tokens)).status_code

    assert attempt(version="v1") == 422
    assert attempt(version="1.0") == 422
    assert attempt(platform="linux") == 422
    assert attempt(files=[]) == 422
    assert attempt(unknown_field=1) == 422
    bad_hash = [{"path": "a.exe", "size_bytes": 1, "sha256": "ABC"}]
    assert attempt(files=bad_hash) == 422
    same_ignoring_case = declare({"Game.exe": b"1", "game.exe": b"2"})
    assert attempt(files=same_ignoring_case) == 422
    assert attempt(version="1.0.0-beta1") == 201


def test_version_and_count_limits(client, db_session):
    _, tokens, _, game = world(client, db_session)
    assert post_build(client, tokens, game.id, version="1.0.0").status_code == 201
    again = post_build(client, tokens, game.id, version="1.0.0")
    assert again.status_code == 409
    assert code(again) == "BUILD_EXISTS"

    make_build(db_session, game.id, "1.0.1")
    make_build(db_session, game.id, "1.0.2")
    over = post_build(client, tokens, game.id, version="1.0.3")
    assert over.status_code == 409
    assert code(over) == "BUILD_LIMIT"


def test_only_studio_members_with_the_right_role_can_upload(client, db_session):
    owner, tokens, studio, game = world(client, db_session)
    _, stranger = create_account(client, db_session, "stranger@example.com")
    accountant, accountant_tokens = create_account(client, db_session, "money@example.com")
    add_member(db_session, studio, accountant, "finance")
    build_id = post_build(client, tokens, game.id).json()["id"]

    build_url = f"/v1/developer/builds/{build_id}"
    list_url = f"/v1/developer/games/{game.id}/builds"
    assert post_build(client, stranger, game.id, version="2.0.0").status_code == 404
    assert client.get(build_url, headers=bearer(stranger)).status_code == 404
    assert complete(client, stranger, build_id).status_code == 404
    assert client.get(list_url, headers=bearer(stranger)).status_code == 404

    assert post_build(client, accountant_tokens, game.id, version="2.0.0").status_code == 403
    assert complete(client, accountant_tokens, build_id).status_code == 403
    assert client.get(build_url, headers=bearer(accountant_tokens)).status_code == 200


def test_uploads_need_a_verified_studio_and_an_editable_game(client, db_session):
    _, tokens, _, game = world(client, db_session, studio_status="pending")
    refused = post_build(client, tokens, game.id)
    assert refused.status_code == 403
    assert code(refused) == "STUDIO_NOT_VERIFIED"

    owner, owner_tokens = create_account(client, db_session, "second@example.com")
    studio = make_studio(db_session, owner, "Second Studio")
    submitted = make_game(db_session, studio, "Locked Game", status="submitted")
    locked = post_build(client, owner_tokens, submitted.id)
    assert locked.status_code == 409
    assert code(locked) == "GAME_NOT_EDITABLE"


def test_staff_can_revoke_a_ready_build(client, db_session):
    owner, owner_tokens, _, game = world(client, db_session)
    _, mod = create_account(client, db_session, "mod@example.com", [Role.GAME_MODERATOR])
    ready = make_build(db_session, game.id, "1.0.0")
    uploading = make_build(db_session, game.id, "1.0.1", status="uploading")
    url = f"/v1/admin/builds/{ready.id}/revoke"

    denied = client.post(url, json={"reason": "Malware found"}, headers=bearer(owner_tokens))
    assert denied.status_code == 403
    assert client.post(url, json={"reason": "x"}, headers=bearer(mod)).status_code == 422
    revoked = client.post(url, json={"reason": "Malware found"}, headers=bearer(mod))
    assert revoked.status_code == 200
    assert revoked.json()["status"] == "revoked"
    assert revoked.json()["revoked_reason"] == "Malware found"
    assert client.post(url, json={"reason": "Again"}, headers=bearer(mod)).status_code == 409

    not_ready = f"/v1/admin/builds/{uploading.id}/revoke"
    refused = client.post(not_ready, json={"reason": "Nope"}, headers=bearer(mod))
    assert refused.status_code == 409

    db_session.expire_all()
    entry = db_session.scalar(select(AuditLog).where(AuditLog.action == "build.revoked"))
    assert entry.reason == "Malware found"
    assert entry.actor_roles == "game_moderator"

    # With its only build revoked the game can no longer be submitted.
    blocked = client.post(f"/v1/developer/games/{game.id}/submit", headers=bearer(owner_tokens))
    assert blocked.status_code == 422
    assert "a ready build" in blocked.json()["error"]["message"]


def test_entry_point_is_inferred_or_must_be_valid(client, db_session):
    _, tokens, _, game = world(client, db_session)
    two_exes = {"a.exe": b"1", "b.exe": b"2"}
    assert post_build(client, tokens, game.id, two_exes).status_code == 422

    chosen = post_build(client, tokens, game.id, two_exes, entry_point="b.exe")
    assert chosen.status_code == 201
    assert chosen.json()["entry_point"] == "b.exe"

    missing = post_build(client, tokens, game.id, two_exes, version="1.0.1", entry_point="c.exe")
    assert missing.status_code == 422
    files = {"game.exe": b"x", "readme.txt": b"y"}
    not_exe = post_build(client, tokens, game.id, files, version="1.0.2", entry_point="readme.txt")
    assert not_exe.status_code == 422

    nested = {"game.exe": b"x", "tools/other.exe": b"y"}
    inferred = post_build(client, tokens, game.id, nested, version="1.0.3")
    assert inferred.status_code == 201
    assert inferred.json()["entry_point"] == "game.exe"
