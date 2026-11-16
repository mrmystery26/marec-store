import hashlib
import uuid
from datetime import timedelta

import jwt
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import utcnow
from app.core.errors import ApiError
from app.core.launch_signing import LaunchSigner
from app.modules.audit import service as audit
from app.modules.builds.models import GameBuild
from app.modules.catalog import service as catalog
from app.modules.catalog.models import Game
from app.modules.launch import schemas
from app.modules.launch.models import Device, LaunchAuthorization
from app.modules.library import service as library
from app.modules.studios.models import Studio


def device_hash(device_id: str) -> str:
    return hashlib.sha256(device_id.encode("utf-8")).hexdigest()


# ------------------------------------------------------------------ devices


def register_device(db: Session, user_id: uuid.UUID, device_id: str, label: str | None) -> Device:
    """Finds or adds this PC for the player, enforcing the per-account device limit."""
    now = utcnow()
    key_hash = device_hash(device_id)
    device = db.scalar(
        select(Device).where(Device.user_id == user_id, Device.device_key_hash == key_hash)
    )
    if device is not None and device.revoked_at is None:
        device.last_seen_at = now
        return device

    active = db.scalars(
        select(Device.id).where(Device.user_id == user_id, Device.revoked_at.is_(None))
    ).all()
    if len(active) >= get_settings().max_devices_per_account:
        raise ApiError(
            409, "DEVICE_LIMIT", "This account is already using the maximum number of PCs."
        )
    if device is None:
        device = Device(
            id=uuid.uuid4(), user_id=user_id, device_key_hash=key_hash, label=label
        )
        db.add(device)
    else:  # a PC the player removed earlier is being used again
        device.revoked_at = None
        device.last_seen_at = now
    db.flush()
    return device


def list_devices(db: Session, user_id: uuid.UUID) -> list[Device]:
    stmt = (
        select(Device)
        .where(Device.user_id == user_id, Device.revoked_at.is_(None))
        .order_by(Device.first_seen_at)
    )
    return list(db.scalars(stmt))


def revoke_device(db: Session, user_id: uuid.UUID, device_id: uuid.UUID) -> None:
    device = db.get(Device, device_id)
    if device is None or device.user_id != user_id:
        raise ApiError(404, "DEVICE_NOT_FOUND", "Device not found.")
    if device.revoked_at is None:
        device.revoked_at = utcnow()
        # Tokens and leases already issued for this PC stop being honoured by the backend.
        db.execute(
            update(LaunchAuthorization)
            .where(
                LaunchAuthorization.device_id == device.id,
                LaunchAuthorization.status == "issued",
            )
            .values(status="revoked")
        )
        db.commit()


# ------------------------------------------------------------------ issuing


def _check_build(db: Session, game: Game, build_id: uuid.UUID) -> GameBuild:
    build = db.get(GameBuild, build_id)
    if build is None or build.game_id != game.id or build.status != "ready":
        raise ApiError(409, "BUILD_UNAVAILABLE", "This build cannot be launched.")
    return build


def _claims(
    row_id: uuid.UUID,
    game: Game,
    build: GameBuild,
    user_id: uuid.UUID,
    device_key_hash: str,
    kind: str,
    now,
    expires,
    nonce: str | None,
) -> dict:
    claims = {
        "jti": str(row_id),
        "aud": str(game.id),
        "sub": str(user_id),
        "kind": kind,
        "bid": str(build.id),
        "dh": device_key_hash,
        "lvl": game.protection_level,
        "iat": now,
        "exp": expires,
    }
    if nonce:
        claims["nonce"] = nonce
    if kind == "lease":
        claims["od"] = game.offline_days
    if kind == "dev":
        claims["dev"] = True
    return claims


def _issue(
    db: Session,
    signer: LaunchSigner,
    user_id: uuid.UUID,
    game: Game,
    build: GameBuild,
    device: Device,
    kind: str,
    lifetime: timedelta,
    nonce: str | None,
) -> schemas.TokenOut:
    now = utcnow()
    expires = now + lifetime
    row = LaunchAuthorization(
        id=uuid.uuid4(),
        user_id=user_id,
        game_id=game.id,
        build_id=build.id,
        device_id=device.id,
        kind=kind,
        nonce=nonce,
        issued_at=now,
        expires_at=expires,
    )
    db.add(row)
    token = signer.issue(
        _claims(row.id, game, build, user_id, device.device_key_hash, kind, now, expires, nonce)
    )
    return schemas.TokenOut(
        token=token,
        kind=kind,
        kid=signer.kid,
        expires_at=expires,
        expires_in=int(lifetime.total_seconds()),
    )


def authorize(
    db: Session, signer: LaunchSigner, user_id: uuid.UUID, body: schemas.LaunchRequest
) -> schemas.TokenOut:
    """Short-lived, single-use token proving this player may start this build right now."""
    library.require_active_entitlement(db, user_id, body.game_id)
    game, studio = catalog.get_game_and_studio(db, body.game_id)
    if library.unavailable_reason(game, studio) is not None:
        raise ApiError(409, "GAME_UNAVAILABLE", library.UNAVAILABLE)
    build = _check_build(db, game, body.build_id)
    device = register_device(db, user_id, body.device_id, body.device_label)
    out = _issue(
        db,
        signer,
        user_id,
        game,
        build,
        device,
        "online",
        timedelta(seconds=get_settings().launch_token_seconds),
        body.nonce,
    )
    db.commit()
    return out


def issue_lease(
    db: Session, signer: LaunchSigner, user_id: uuid.UUID, body: schemas.LeaseRequest
) -> schemas.TokenOut:
    """Signed permission to play offline on this PC until it expires."""
    library.require_active_entitlement(db, user_id, body.game_id)
    game, studio = catalog.get_game_and_studio(db, body.game_id)
    if library.unavailable_reason(game, studio) is not None:
        raise ApiError(409, "GAME_UNAVAILABLE", library.UNAVAILABLE)
    if game.offline_days <= 0:
        raise ApiError(409, "OFFLINE_NOT_ALLOWED", "This game must be played online.")
    build = _check_build(db, game, body.build_id)
    device = register_device(db, user_id, body.device_id, body.device_label)

    # A new lease replaces the old one for the same player, game and PC.
    db.execute(
        update(LaunchAuthorization)
        .where(
            LaunchAuthorization.user_id == user_id,
            LaunchAuthorization.game_id == game.id,
            LaunchAuthorization.device_id == device.id,
            LaunchAuthorization.kind == "lease",
            LaunchAuthorization.status == "issued",
        )
        .values(status="revoked")
    )
    out = _issue(
        db, signer, user_id, game, build, device, "lease", timedelta(days=game.offline_days), None
    )
    db.commit()
    return out


def authorize_dev(
    db: Session,
    signer: LaunchSigner,
    user_id: uuid.UUID,
    body: schemas.LaunchRequest,
    ctx: dict,
) -> schemas.TokenOut:
    """For studio members testing their own game: no purchase and no published listing needed,
    but the build must be ready and the token is marked as a developer token."""
    game, studio, role = catalog.game_for_member(db, body.game_id, user_id)
    if role not in catalog.CONTENT_ROLES:
        raise ApiError(403, "FORBIDDEN", "Your studio role cannot test-launch builds.")
    build = _check_build(db, game, body.build_id)
    device = register_device(db, user_id, body.device_id, body.device_label)
    out = _issue(
        db,
        signer,
        user_id,
        game,
        build,
        device,
        "dev",
        timedelta(seconds=get_settings().launch_token_seconds),
        body.nonce,
    )
    audit.record(
        db,
        action="launch.dev_authorized",
        entity_type="game",
        entity_id=str(game.id),
        actor_user_id=user_id,
        after={"build_id": str(build.id)},
        **ctx,
    )
    db.commit()
    return out


# ------------------------------------------------------------------ redeeming


def redeem(db: Session, signer: LaunchSigner, body: schemas.RedeemRequest) -> schemas.RedeemOut:
    """The game calls this once at start-up. The token is the credential, so no login is needed.
    A token can be redeemed only once, which stops a copied token from being replayed."""
    try:
        claims = signer.verify(body.token)
    except jwt.ExpiredSignatureError:
        raise ApiError(401, "TOKEN_EXPIRED", "This launch token has expired.") from None
    except jwt.PyJWTError:
        raise ApiError(401, "INVALID_TOKEN", "This launch token is not valid.") from None
    if claims.get("kind") not in ("online", "dev"):
        raise ApiError(400, "WRONG_TOKEN_KIND", "Only launch tokens can be redeemed.")
    if body.device_id is not None and device_hash(body.device_id) != claims.get("dh"):
        raise ApiError(403, "DEVICE_MISMATCH", "This token was issued for a different PC.")

    try:
        row = db.get(LaunchAuthorization, uuid.UUID(claims["jti"]))
    except ValueError:
        row = None
    if row is None or str(row.game_id) != claims["aud"] or str(row.user_id) != claims["sub"]:
        raise ApiError(401, "INVALID_TOKEN", "This launch token is not valid.")
    if row.status == "redeemed":
        raise ApiError(409, "TOKEN_ALREADY_USED", "This launch token was already used.")
    if row.status == "revoked":
        raise ApiError(403, "TOKEN_REVOKED", "This launch token was revoked.")

    # Things can change in the seconds between issuing and redeeming.
    build = db.get(GameBuild, row.build_id)
    if build is None or build.status != "ready":
        raise ApiError(409, "BUILD_UNAVAILABLE", "This build cannot be launched.")
    if row.kind == "online":
        library.require_active_entitlement(db, row.user_id, row.game_id)
        game = db.get(Game, row.game_id)
        studio = db.get(Studio, game.studio_id)
        if library.unavailable_reason(game, studio) is not None:
            raise ApiError(409, "GAME_UNAVAILABLE", library.UNAVAILABLE)

    now = utcnow()
    # Only one request can flip issued to redeemed, even if two arrive at the same moment.
    flipped = db.execute(
        update(LaunchAuthorization)
        .where(LaunchAuthorization.id == row.id, LaunchAuthorization.status == "issued")
        .values(status="redeemed", redeemed_at=now)
    )
    if flipped.rowcount != 1:
        db.rollback()
        raise ApiError(409, "TOKEN_ALREADY_USED", "This launch token was already used.")
    db.commit()
    return schemas.RedeemOut(
        ok=True,
        game_id=row.game_id,
        build_id=row.build_id,
        kind=row.kind,
        session_id=row.id,
        server_time=now,
    )
