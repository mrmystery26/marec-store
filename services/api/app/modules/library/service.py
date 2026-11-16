import base64
import hashlib
import uuid

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import ApiError
from app.modules.audit import service as audit
from app.modules.builds.models import BuildFile, GameBuild
from app.modules.catalog.models import Game
from app.modules.catalog.schemas import StudioBrief
from app.modules.library import schemas
from app.modules.library.models import EntitlementSource, EntitlementStatus, GameEntitlement
from app.modules.studios.models import Studio, StudioStatus

DOWNLOAD_URL_SECONDS = 6 * 3600
UNAVAILABLE = "This game is not currently available."


def unavailable_reason(game: Game, studio: Studio) -> str | None:
    """Owners can install only while the game is published and its studio is in good standing."""
    if game.status != "published" or studio.status != StudioStatus.VERIFIED.value:
        return UNAVAILABLE
    return None


def add_free_game(
    db: Session, user_id: uuid.UUID, game_id: uuid.UUID, ctx: dict
) -> tuple[GameEntitlement, bool]:
    """Adds a free game to the user's library. Returns (entitlement, created)."""
    row = db.execute(
        select(Game, Studio).join(Studio, Studio.id == Game.studio_id).where(Game.id == game_id)
    ).first()
    # Hidden games look exactly like missing ones.
    if row is None or unavailable_reason(*row) is not None:
        raise ApiError(404, "GAME_NOT_FOUND", "Game not found.")
    game = row[0]

    existing = db.scalar(
        select(GameEntitlement).where(
            GameEntitlement.user_id == user_id, GameEntitlement.game_id == game_id
        )
    )
    if existing is not None:
        if existing.status == EntitlementStatus.REVOKED.value:
            raise ApiError(409, "ENTITLEMENT_REVOKED", "Access to this game was removed.")
        return existing, False
    if game.price_minor != 0:
        raise ApiError(402, "PAYMENT_REQUIRED", "This game is not free.")

    entitlement = GameEntitlement(
        id=uuid.uuid4(), user_id=user_id, game_id=game_id, source=EntitlementSource.FREE.value
    )
    db.add(entitlement)
    audit.record(
        db,
        action="entitlement.granted",
        entity_type="game",
        entity_id=str(game_id),
        actor_user_id=user_id,
        after={"source": "free"},
        **ctx,
    )
    try:
        db.commit()
    except IntegrityError:  # two taps at once: the other request won
        db.rollback()
        existing = db.scalar(
            select(GameEntitlement).where(
                GameEntitlement.user_id == user_id, GameEntitlement.game_id == game_id
            )
        )
        return existing, False
    return entitlement, True


def list_library(db: Session, user_id: uuid.UUID, limit: int, offset: int) -> schemas.LibraryPage:
    active = (
        GameEntitlement.user_id == user_id,
        GameEntitlement.status == EntitlementStatus.ACTIVE.value,
    )
    total = db.scalar(select(func.count(GameEntitlement.id)).where(*active)) or 0
    rows = db.execute(
        select(GameEntitlement, Game, Studio)
        .join(Game, Game.id == GameEntitlement.game_id)
        .join(Studio, Studio.id == Game.studio_id)
        .where(*active)
        .order_by(GameEntitlement.granted_at.desc(), GameEntitlement.id)
        .limit(limit)
        .offset(offset)
    ).all()

    game_ids = [game.id for _, game, _ in rows]
    latest: dict[uuid.UUID, str] = {}
    builds = db.execute(
        select(GameBuild.game_id, GameBuild.version)
        .where(GameBuild.game_id.in_(game_ids), GameBuild.status == "ready")
        .order_by(GameBuild.ready_at)
    ).all()
    for build_game_id, version in builds:  # ordered oldest to newest, so the last one wins
        latest[build_game_id] = version

    items = []
    for entitlement, game, studio in rows:
        reason = unavailable_reason(game, studio)
        items.append(
            schemas.LibraryItem(
                game_id=game.id,
                slug=game.slug,
                title=game.title,
                studio=StudioBrief(name=studio.name, slug=studio.slug),
                source=entitlement.source,
                granted_at=entitlement.granted_at,
                available=reason is None,
                unavailable_reason=reason,
                latest_version=latest.get(game.id),
            )
        )
    return schemas.LibraryPage(items=items, total=total, limit=limit, offset=offset)


def require_active_entitlement(db: Session, user_id: uuid.UUID, game_id: uuid.UUID):
    """Used before anything that depends on ownership (installing now, launching later)."""
    entitlement = db.scalar(
        select(GameEntitlement).where(
            GameEntitlement.user_id == user_id,
            GameEntitlement.game_id == game_id,
            GameEntitlement.status == EntitlementStatus.ACTIVE.value,
        )
    )
    if entitlement is None:
        raise ApiError(403, "NOT_OWNED", "You do not own this game.")
    return entitlement


def build_install_plan(
    db: Session, storage, user_id: uuid.UUID, game_id: uuid.UUID, platform: str
) -> schemas.InstallPlan:
    # Ownership first, so nobody can use this endpoint to find out which games exist.
    require_active_entitlement(db, user_id, game_id)
    game = db.get(Game, game_id)
    studio = db.get(Studio, game.studio_id)
    if unavailable_reason(game, studio) is not None:
        raise ApiError(409, "GAME_UNAVAILABLE", UNAVAILABLE)

    build = db.scalar(
        select(GameBuild)
        .where(
            GameBuild.game_id == game_id,
            GameBuild.platform == platform,
            GameBuild.status == "ready",
        )
        .order_by(GameBuild.ready_at.desc())
        .limit(1)
    )
    if build is None:
        raise ApiError(409, "NO_BUILD_AVAILABLE", "No downloadable build exists for this platform.")

    manifest = b"".join(storage.iter_bytes(build.manifest_key))
    if hashlib.sha256(manifest).hexdigest() != build.manifest_sha256:
        raise ApiError(500, "MANIFEST_CORRUPT", "The stored manifest failed its integrity check.")

    files = db.scalars(
        select(BuildFile).where(BuildFile.build_id == build.id).order_by(BuildFile.path)
    )
    downloads = [
        schemas.DownloadLink(
            path=item.path, url=storage.presign_get(item.object_key, DOWNLOAD_URL_SECONDS)
        )
        for item in files
    ]
    return schemas.InstallPlan(
        game_id=game_id,
        build_id=build.id,
        version=build.version,
        platform=build.platform,
        total_size_bytes=build.total_size_bytes,
        file_count=build.file_count,
        kid=build.signing_kid,
        manifest_sha256=build.manifest_sha256,
        manifest_signature=build.manifest_signature,
        manifest_b64=base64.b64encode(manifest).decode("ascii"),
        downloads=downloads,
        expires_in=DOWNLOAD_URL_SECONDS,
    )
