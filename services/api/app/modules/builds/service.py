import hashlib
import json
import uuid

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.db import utcnow
from app.core.errors import ApiError
from app.core.signing import Signer
from app.modules.audit import service as audit
from app.modules.builds import schemas
from app.modules.builds.hashing import CHUNK_SIZE, hash_stream
from app.modules.builds.models import BuildFile, GameBuild
from app.modules.catalog.models import Game
from app.modules.catalog.states import EDITABLE_STATUSES, GameStatus
from app.modules.studios.models import Studio, StudioStatus

MAX_ACTIVE_BUILDS = 3  # per game and platform, revoked builds not counted
UPLOAD_URL_SECONDS = 3600
MAX_PROBLEMS = 50


def to_out(build: GameBuild) -> schemas.BuildOut:
    return schemas.BuildOut(
        id=build.id,
        game_id=build.game_id,
        version=build.version,
        platform=build.platform,
        status=build.status,
        scan_status=build.scan_status,
        total_size_bytes=build.total_size_bytes,
        file_count=build.file_count,
        release_notes=build.release_notes,
        entry_point=build.entry_point,
        manifest_sha256=build.manifest_sha256,
        manifest_signature=build.manifest_signature,
        signing_kid=build.signing_kid,
        created_at=build.created_at,
        ready_at=build.ready_at,
        revoked_at=build.revoked_at,
        revoked_reason=build.revoked_reason,
    )


def get_build(db: Session, build_id: uuid.UUID) -> GameBuild:
    build = db.get(GameBuild, build_id)
    if build is None:
        raise ApiError(404, "BUILD_NOT_FOUND", "Build not found.")
    return build


def list_builds(db: Session, game_id: uuid.UUID) -> list[GameBuild]:
    stmt = (
        select(GameBuild)
        .where(GameBuild.game_id == game_id)
        .order_by(GameBuild.created_at.desc())
    )
    return list(db.scalars(stmt))


def create_build(
    db: Session,
    game: Game,
    studio: Studio,
    body: schemas.BuildCreate,
    actor_id: uuid.UUID,
    ctx: dict,
) -> tuple[GameBuild, list[BuildFile]]:
    if GameStatus(game.status) not in EDITABLE_STATUSES:
        raise ApiError(
            409, "GAME_NOT_EDITABLE", "Builds cannot be added in the game's current state."
        )
    if studio.status != StudioStatus.VERIFIED.value:
        raise ApiError(
            403, "STUDIO_NOT_VERIFIED", "Your studio must be verified before uploading."
        )
    active = db.scalar(
        select(func.count(GameBuild.id)).where(
            GameBuild.game_id == game.id,
            GameBuild.platform == body.platform,
            GameBuild.status != "revoked",
        )
    )
    if (active or 0) >= MAX_ACTIVE_BUILDS:
        raise ApiError(409, "BUILD_LIMIT", f"A game can keep at most {MAX_ACTIVE_BUILDS} builds.")
    taken = db.scalar(
        select(GameBuild.id).where(
            GameBuild.game_id == game.id,
            GameBuild.version == body.version,
            GameBuild.platform == body.platform,
        )
    )
    if taken is not None:
        raise ApiError(409, "BUILD_EXISTS", "This version already exists for this platform.")

    build = GameBuild(
        id=uuid.uuid4(),
        game_id=game.id,
        version=body.version,
        platform=body.platform,
        release_notes=body.release_notes,
        entry_point=body.entry_point,
        total_size_bytes=sum(item.size_bytes for item in body.files),
        file_count=len(body.files),
        created_by=actor_id,
    )
    db.add(build)
    db.flush()
    files = []
    for item in body.files:
        file_id = uuid.uuid4()
        files.append(
            BuildFile(
                id=file_id,
                build_id=build.id,
                path=item.path,
                size_bytes=item.size_bytes,
                sha256=item.sha256,
                object_key=f"builds/{game.id}/{build.id}/files/{file_id}",
            )
        )
    db.add_all(files)
    audit.record(
        db,
        action="build.created",
        entity_type="build",
        entity_id=str(build.id),
        actor_user_id=actor_id,
        after={"game_id": str(game.id), "version": build.version, "files": len(files)},
        **ctx,
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ApiError(
            409, "BUILD_EXISTS", "This version already exists for this platform."
        ) from None
    return build, files


def get_files(db: Session, build_id: uuid.UUID) -> list[BuildFile]:
    stmt = select(BuildFile).where(BuildFile.build_id == build_id).order_by(BuildFile.path)
    return list(db.scalars(stmt))


def upload_targets(storage, files: list[BuildFile]) -> list[schemas.UploadTarget]:
    return [
        schemas.UploadTarget(
            path=f.path,
            size_bytes=f.size_bytes,
            upload_url=storage.presign_put(f.object_key, f.size_bytes, UPLOAD_URL_SECONDS),
        )
        for f in files
    ]


def complete_build(
    db: Session,
    storage,
    signer: Signer,
    build: GameBuild,
    actor_id: uuid.UUID,
    ctx: dict,
) -> list[str]:
    """Checks every uploaded file against what the developer declared, then writes and signs
    the manifest. Returns a list of problems; the build only becomes ready when it is empty.
    (Runs inside the request for now. Move to a background worker before large games.)"""
    if build.status != "uploading":
        raise ApiError(409, "INVALID_STATE", "Only builds that are uploading can be completed.")

    problems: list[str] = []
    entries = []
    for item in get_files(db, build.id):
        size = storage.head(item.object_key)
        if size is None:
            problems.append(f"{item.path}: not uploaded yet.")
            continue
        if size != item.size_bytes:
            problems.append(f"{item.path}: is {size} bytes but {item.size_bytes} were declared.")
            continue
        actual_size, digest, chunks = hash_stream(storage.iter_bytes(item.object_key))
        if digest != item.sha256:
            problems.append(f"{item.path}: contents do not match the declared SHA-256.")
            continue
        entries.append({"path": item.path, "size": actual_size, "sha256": digest, "chunks": chunks})
    if problems:
        return problems[:MAX_PROBLEMS]

    manifest = {
        "format": 1,
        "game_id": str(build.game_id),
        "build_id": str(build.id),
        "version": build.version,
        "platform": build.platform,
        "chunk_size": CHUNK_SIZE,
        "entry": build.entry_point,
        "created_at": utcnow().isoformat(),
        "files": entries,
    }
    data = json.dumps(manifest, sort_keys=True, separators=(",", ":")).encode("utf-8")
    manifest_key = f"builds/{build.game_id}/{build.id}/manifest.json"
    storage.put_bytes(manifest_key, data)

    build.manifest_key = manifest_key
    build.manifest_sha256 = hashlib.sha256(data).hexdigest()
    build.manifest_signature = signer.sign(data)
    build.signing_kid = signer.kid
    build.total_size_bytes = sum(entry["size"] for entry in entries)
    build.file_count = len(entries)
    build.status = "ready"
    build.ready_at = utcnow()
    audit.record(
        db,
        action="build.ready",
        entity_type="build",
        entity_id=str(build.id),
        actor_user_id=actor_id,
        after={"manifest_sha256": build.manifest_sha256, "kid": signer.kid},
        **ctx,
    )
    db.commit()
    return []


def revoke_build(
    db: Session,
    build: GameBuild,
    reason: str,
    actor_id: uuid.UUID,
    roles_label: str,
    ctx: dict,
) -> None:
    if build.status != "ready":
        raise ApiError(409, "INVALID_STATE", "Only ready builds can be revoked.")
    build.status = "revoked"
    build.revoked_at = utcnow()
    build.revoked_reason = reason
    audit.record(
        db,
        action="build.revoked",
        entity_type="build",
        entity_id=str(build.id),
        actor_user_id=actor_id,
        actor_roles=roles_label,
        before={"status": "ready"},
        after={"status": "revoked"},
        reason=reason,
        **ctx,
    )
    db.commit()
