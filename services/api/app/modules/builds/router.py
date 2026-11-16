import uuid

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.errors import ApiError
from app.core.signing import get_signer
from app.core.storage import get_storage
from app.modules.audit import service as audit
from app.modules.auth.deps import AuthContext, get_auth_context
from app.modules.builds import schemas, service
from app.modules.builds.models import GameBuild
from app.modules.catalog import service as catalog

router = APIRouter(prefix="/developer", tags=["builds"])


def _load_build(db: Session, build_id: uuid.UUID, user_id: uuid.UUID):
    """Build plus its game, studio and the caller's studio role. Non-members get 404."""
    build = db.get(GameBuild, build_id)
    if build is None:
        raise ApiError(404, "BUILD_NOT_FOUND", "Build not found.")
    try:
        game, studio, role = catalog.game_for_member(db, build.game_id, user_id)
    except ApiError:
        raise ApiError(404, "BUILD_NOT_FOUND", "Build not found.") from None
    return build, game, studio, role


@router.post("/games/{game_id}/builds", status_code=201, response_model=schemas.BuildCreated)
def create_build(
    game_id: uuid.UUID,
    body: schemas.BuildCreate,
    request: Request,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
    storage=Depends(get_storage),
) -> schemas.BuildCreated:
    game, studio, role = catalog.game_for_member(db, game_id, ctx.user.id)
    if role not in catalog.CONTENT_ROLES:
        raise ApiError(403, "FORBIDDEN", "Your studio role cannot upload builds.")
    build, files = service.create_build(
        db, game, studio, body, ctx.user.id, audit.context_from_request(request)
    )
    return schemas.BuildCreated(
        **service.to_out(build).model_dump(), uploads=service.upload_targets(storage, files)
    )


@router.get("/games/{game_id}/builds", response_model=list[schemas.BuildOut])
def list_builds(
    game_id: uuid.UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> list[schemas.BuildOut]:
    catalog.game_for_member(db, game_id, ctx.user.id)
    return [service.to_out(b) for b in service.list_builds(db, game_id)]


@router.get("/builds/{build_id}", response_model=schemas.BuildOut)
def get_build(
    build_id: uuid.UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> schemas.BuildOut:
    build, _, _, _ = _load_build(db, build_id, ctx.user.id)
    return service.to_out(build)


@router.post("/builds/{build_id}/complete", response_model=schemas.BuildCompleteOut)
def complete_build(
    build_id: uuid.UUID,
    request: Request,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
    storage=Depends(get_storage),
) -> schemas.BuildCompleteOut:
    build, _, _, role = _load_build(db, build_id, ctx.user.id)
    if role not in catalog.CONTENT_ROLES:
        raise ApiError(403, "FORBIDDEN", "Your studio role cannot upload builds.")
    problems = service.complete_build(
        db, storage, get_signer(), build, ctx.user.id, audit.context_from_request(request)
    )
    return schemas.BuildCompleteOut(build=service.to_out(build), problems=problems)
