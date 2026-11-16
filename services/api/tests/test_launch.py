import base64
import hashlib
import uuid
from datetime import datetime, timedelta, timezone

import jwt
from sqlalchemy import select

from app.core.launch_signing import LaunchSigner, get_launch_signer, new_private_key_b64
from app.modules.audit.models import AuditLog
from app.modules.builds.models import GameBuild
from app.modules.catalog.models import Game
from app.modules.launch.models import LaunchAuthorization
from app.modules.library.models import GameEntitlement
from tests.helpers import (
    add_member,
    bearer,
    code,
    create_account,
    make_build,
    make_game,
    make_studio,
)

DEVICE = "device-secret-0000000000"


def world(client, db_session, status="published"):
    owner, owner_tokens = create_account(client, db_session, "owner@example.com")
    studio = make_studio(db_session, owner, "Launch Studio")
    game = make_game(db_session, studio, "Launch Game", status, 0)
    build = db_session.scalar(select(GameBuild).where(GameBuild.game_id == game.id))
    player_user, player = create_account(client, db_session, "player@example.com")
    if status == "published":
        client.post(f"/v1/me/library/{game.id}", headers=bearer(player))
    return {
        "owner": owner,
        "owner_tokens": owner_tokens,
        "studio": studio,
        "game": game,
        "build": build,
        "player_user": player_user,
        "player": player,
    }


def body(w, device=DEVICE, nonce="nonce-0001", **extra):
    return {
        "game_id": str(w["game"].id),
        "build_id": str(w["build"].id),
        "device_id": device,
        "nonce": nonce,
        **extra,
    }


def authorize(client, w, tokens=None, **kwargs):
    return client.post(
        "/v1/launch/authorizations", json=body(w, **kwargs), headers=bearer(tokens or w["player"])
    )


def redeem(client, token, device=None):
    payload = {"token": token}
    if device:
        payload["device_id"] = device
    return client.post("/v1/launch/redeem", json=payload)


def sdk_view(client, token):
    """Verify a token the way the game's SDK does: with only the published public key."""
    keys = client.get("/v1/launch/public-keys").json()["keys"]
    launch_key = next(k for k in keys if k["use"] == "launch")
    claims = jwt.decode(
        token, launch_key["public_key"], algorithms=["RS256"], options={"verify_aud": False}
    )
    return claims, jwt.get_unverified_header(token), launch_key


def test_public_keys_publish_both_signing_keys(client):
    keys = client.get("/v1/launch/public-keys").json()["keys"]
    assert [(k["use"], k["alg"]) for k in keys] == [("manifest", "EdDSA"), ("launch", "RS256")]
    assert "BEGIN PUBLIC KEY" in keys[1]["public_key"]


def test_authorization_token_carries_the_expected_claims(client, db_session):
    w = world(client, db_session)
    response = authorize(client, w)
    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "no-store"
    out = response.json()
    assert out["kind"] == "online"
    assert out["expires_in"] == 120

    claims, header, key = sdk_view(client, out["token"])
    assert header["kid"] == key["kid"] == out["kid"]
    assert claims["aud"] == str(w["game"].id)
    assert claims["sub"] == str(w["player_user"].id)
    assert claims["bid"] == str(w["build"].id)
    assert claims["dh"] == hashlib.sha256(DEVICE.encode()).hexdigest()
    assert claims["nonce"] == "nonce-0001"
    assert claims["kind"] == "online"
    assert claims["lvl"] == 1
    assert claims["exp"] - claims["iat"] == 120
    uuid.UUID(claims["jti"])


def test_a_token_can_be_redeemed_only_once(client, db_session):
    w = world(client, db_session)
    token = authorize(client, w).json()["token"]

    first = redeem(client, token, DEVICE)
    assert first.status_code == 200
    assert first.json()["ok"] is True
    assert first.json()["kind"] == "online"
    assert first.json()["game_id"] == str(w["game"].id)

    replay = redeem(client, token, DEVICE)
    assert replay.status_code == 409
    assert code(replay) == "TOKEN_ALREADY_USED"


def test_bad_tokens_are_rejected_at_redeem(client, db_session):
    w = world(client, db_session)
    token = authorize(client, w).json()["token"]
    now = datetime.now(timezone.utc)
    base = {
        "jti": str(uuid.uuid4()),
        "aud": str(w["game"].id),
        "sub": str(w["player_user"].id),
        "kind": "online",
        "iat": now,
        "exp": now + timedelta(minutes=2),
    }

    garbage = redeem(client, "this-is-not-a-valid-token")
    assert garbage.status_code == 401
    assert code(garbage) == "INVALID_TOKEN"

    head, payload, signature = token.split(".")
    flipped = signature[:-1] + ("A" if signature[-1] != "A" else "B")
    tampered = f"{head}.{payload}.{flipped}"
    assert code(redeem(client, tampered)) == "INVALID_TOKEN"

    forged = LaunchSigner(base64.b64decode(new_private_key_b64())).issue(base)
    assert code(redeem(client, forged)) == "INVALID_TOKEN"

    unknown = get_launch_signer().issue(base)  # correctly signed but never issued
    assert code(redeem(client, unknown)) == "INVALID_TOKEN"

    past = now - timedelta(minutes=10)
    expired = get_launch_signer().issue({**base, "iat": past, "exp": past + timedelta(minutes=2)})
    stale = redeem(client, expired)
    assert stale.status_code == 401
    assert code(stale) == "TOKEN_EXPIRED"

    wrong_pc = redeem(client, token, "some-other-device-0000")
    assert wrong_pc.status_code == 403
    assert code(wrong_pc) == "DEVICE_MISMATCH"


def test_authorization_is_refused_when_not_allowed(client, db_session):
    w = world(client, db_session)
    _, stranger = create_account(client, db_session, "stranger@example.com")
    refused = authorize(client, w, stranger)
    assert refused.status_code == 403
    assert code(refused) == "NOT_OWNED"

    unknown = {**body(w), "game_id": str(uuid.uuid4()), "build_id": str(uuid.uuid4())}
    response = client.post("/v1/launch/authorizations", json=unknown, headers=bearer(w["player"]))
    assert response.status_code == 403

    anonymous = client.post("/v1/launch/authorizations", json=body(w))
    assert anonymous.status_code == 401
    assert authorize(client, w, device="short").status_code == 422
    assert authorize(client, w, nonce="bad nonce!").status_code == 422
    assert client.post(
        "/v1/launch/authorizations",
        json={**body(w), "surprise": 1},
        headers=bearer(w["player"]),
    ).status_code == 422


def test_unavailable_games_and_builds_cannot_be_launched(client, db_session):
    w = world(client, db_session)
    other = make_game(db_session, w["studio"], "Other Game", "published", 0)
    other_build = db_session.scalar(select(GameBuild).where(GameBuild.game_id == other.id))
    wrong_build = {**body(w), "build_id": str(other_build.id)}
    wrong = client.post("/v1/launch/authorizations", json=wrong_build, headers=bearer(w["player"]))
    assert code(wrong) == "BUILD_UNAVAILABLE"

    build = db_session.get(GameBuild, w["build"].id)
    build.status = "revoked"
    db_session.commit()
    revoked = authorize(client, w)
    assert revoked.status_code == 409
    assert code(revoked) == "BUILD_UNAVAILABLE"
    build.status = "ready"
    db_session.commit()

    game = db_session.get(Game, w["game"].id)
    game.status = "suspended"
    db_session.commit()
    suspended = authorize(client, w)
    assert suspended.status_code == 409
    assert code(suspended) == "GAME_UNAVAILABLE"


def test_things_that_change_between_issuing_and_redeeming(client, db_session):
    w = world(client, db_session)
    token = authorize(client, w).json()["token"]
    entitlement = db_session.scalar(select(GameEntitlement))
    entitlement.status = "revoked"
    entitlement.revoked_at = datetime.now(timezone.utc)
    db_session.commit()
    lost = redeem(client, token)
    assert lost.status_code == 403
    assert code(lost) == "NOT_OWNED"

    entitlement.status = "active"
    entitlement.revoked_at = None
    db_session.commit()
    second = authorize(client, w, nonce="nonce-0002").json()["token"]
    build = db_session.get(GameBuild, w["build"].id)
    build.status = "revoked"
    db_session.commit()
    pulled = redeem(client, second)
    assert pulled.status_code == 409
    assert code(pulled) == "BUILD_UNAVAILABLE"


def test_device_limit_and_device_management(client, db_session):
    w = world(client, db_session)
    for number in range(5):
        response = authorize(
            client, w, device=f"device-number-{number:012d}", device_label=f"PC {number}"
        )
        assert response.status_code == 200
    sixth = authorize(client, w, device="device-number-000000000099")
    assert sixth.status_code == 409
    assert code(sixth) == "DEVICE_LIMIT"
    assert authorize(client, w, device="device-number-000000000002").status_code == 200

    devices = client.get("/v1/me/devices", headers=bearer(w["player"])).json()
    assert [d["label"] for d in devices] == [f"PC {n}" for n in range(5)]

    removed = client.delete(f"/v1/me/devices/{devices[0]['id']}", headers=bearer(w["player"]))
    assert removed.status_code == 204
    assert authorize(client, w, device="device-number-000000000099").status_code == 200

    _, stranger = create_account(client, db_session, "stranger@example.com")
    foreign = client.delete(f"/v1/me/devices/{devices[1]['id']}", headers=bearer(stranger))
    assert foreign.status_code == 404
    assert code(foreign) == "DEVICE_NOT_FOUND"


def test_removing_a_device_cancels_its_unused_tokens(client, db_session):
    w = world(client, db_session)
    token = authorize(client, w).json()["token"]
    device = client.get("/v1/me/devices", headers=bearer(w["player"])).json()[0]
    client.delete(f"/v1/me/devices/{device['id']}", headers=bearer(w["player"]))

    cancelled = redeem(client, token)
    assert cancelled.status_code == 403
    assert code(cancelled) == "TOKEN_REVOKED"


def test_offline_leases(client, db_session):
    w = world(client, db_session)
    url = "/v1/launch/leases"
    request = {k: v for k, v in body(w).items() if k != "nonce"}

    first = client.post(url, json=request, headers=bearer(w["player"]))
    assert first.status_code == 200
    out = first.json()
    assert out["kind"] == "lease"
    claims, _, _ = sdk_view(client, out["token"])
    assert claims["kind"] == "lease"
    assert claims["od"] == 7
    assert claims["exp"] - claims["iat"] == 7 * 86400
    assert claims["dh"] == hashlib.sha256(DEVICE.encode()).hexdigest()

    # A leased token is for offline checks only and cannot be redeemed.
    assert code(redeem(client, out["token"])) == "WRONG_TOKEN_KIND"

    second = client.post(url, json=request, headers=bearer(w["player"]))
    assert second.status_code == 200
    db_session.expire_all()
    statuses = sorted(r.status for r in db_session.scalars(select(LaunchAuthorization)))
    assert statuses == ["issued", "revoked"]

    _, stranger = create_account(client, db_session, "stranger@example.com")
    assert client.post(url, json=request, headers=bearer(stranger)).status_code == 403

    game = db_session.get(Game, w["game"].id)
    game.offline_days = 0
    db_session.commit()
    online_only = client.post(url, json=request, headers=bearer(w["player"]))
    assert online_only.status_code == 409
    assert code(online_only) == "OFFLINE_NOT_ALLOWED"


def test_developers_can_test_launch_their_own_builds(client, db_session):
    w = world(client, db_session, status="draft")  # not published, nobody owns it
    url = "/v1/launch/dev-authorizations"

    response = client.post(url, json=body(w), headers=bearer(w["owner_tokens"]))
    assert response.status_code == 200
    assert response.json()["kind"] == "dev"
    claims, _, _ = sdk_view(client, response.json()["token"])
    assert claims["dev"] is True
    assert redeem(client, response.json()["token"]).status_code == 200

    db_session.expire_all()
    entry = db_session.scalar(select(AuditLog).where(AuditLog.action == "launch.dev_authorized"))
    assert entry.entity_id == str(w["game"].id)

    outsider = client.post(url, json=body(w), headers=bearer(w["player"]))
    assert outsider.status_code == 404
    assert code(outsider) == "GAME_NOT_FOUND"

    accountant, accountant_tokens = create_account(client, db_session, "money@example.com")
    add_member(db_session, w["studio"], accountant, "finance")
    assert client.post(url, json=body(w), headers=bearer(accountant_tokens)).status_code == 403

    pending = make_build(db_session, w["game"].id, "2.0.0", status="uploading")
    not_ready = {**body(w), "build_id": str(pending.id)}
    refused = client.post(url, json=not_ready, headers=bearer(w["owner_tokens"]))
    assert refused.status_code == 409
    assert code(refused) == "BUILD_UNAVAILABLE"

    # Ordinary authorization still needs ownership, even for the studio's own game.
    assert authorize(client, w, w["owner_tokens"]).status_code == 403
