import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query, Request
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app.core.db import get_db, utcnow
from app.core.errors import ApiError
from app.modules.audit import service as audit
from app.modules.builds import schemas as build_schemas
from app.modules.builds import service as build_service
from app.modules.catalog import schemas, service
from app.modules.catalog.states import GameStatus, ReviewAction
from app.modules.rbac.deps import StaffContext, require_permission
from app.modules.rbac.permissions import Permission
from app.modules.studios.models import Studio, StudioStatus

router = APIRouter(prefix="/admin", tags=["admin"])

catalog_manage = require_permission(Permission.CATALOG_MANAGE)
games_review = require_permission(Permission.GAMES_REVIEW)
studios_verify = require_permission(Permission.STUDIOS_VERIFY)


class TransitionBody(BaseModel):
    action: ReviewAction
    reason: str | None = Field(None, max_length=500)


class StudioReasonBody(BaseModel):
    reason: str = Field(min_length=3, max_length=500)


class AdminStudioOut(BaseModel):
    id: uuid.UUID
    name: str
    slug: str
    status: str
    created_at: datetime
    verified_at: datetime | None


class AdminStudioPage(BaseModel):
    items: list[AdminStudioOut]
    total: int


def _studio_out(studio: Studio) -> AdminStudioOut:
    return AdminStudioOut(
        id=studio.id,
        name=studio.name,
        slug=studio.slug,
        status=studio.status,
        created_at=studio.created_at,
        verified_at=studio.verified_at,
    )


def _get_studio(db: Session, studio_id: uuid.UUID) -> Studio:
    studio = db.get(Studio, studio_id)
    if studio is None:
        raise ApiError(404, "STUDIO_NOT_FOUND", "Studio not found.")
    return studio


@router.post("/categories", status_code=201, response_model=schemas.CategoryOut)
def create_category(
    body: schemas.CategoryCreate,
    request: Request,
    staff: StaffContext = Depends(catalog_manage),
    db: Session = Depends(get_db),
) -> schemas.CategoryOut:
    category = service.create_category(
        db, body, staff.user.id, staff.roles_label, audit.context_from_request(request)
    )
    return schemas.CategoryOut(id=category.id, slug=category.slug, name=category.name)


@router.get("/studios", response_model=AdminStudioPage)
def list_studios(
    status: StudioStatus | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0, le=10000),
    staff: StaffContext = Depends(studios_verify),
    db: Session = Depends(get_db),
) -> AdminStudioPage:
    stmt = select(Studio)
    count = select(func.count(Studio.id))
    if status is not None:
        stmt = stmt.where(Studio.status == status.value)
        count = count.where(Studio.status == status.value)
    rows = db.scalars(stmt.order_by(Studio.created_at, Studio.id).limit(limit).offset(offset))
    return AdminStudioPage(items=[_studio_out(s) for s in rows], total=db.scalar(count) or 0)


@router.post("/studios/{studio_id}/verify", response_model=AdminStudioOut)
def verify_studio(
    studio_id: uuid.UUID,
    request: Request,
    staff: StaffContext = Depends(studios_verify),
    db: Session = Depends(get_db),
) -> AdminStudioOut:
    studio = _get_studio(db, studio_id)
    if studio.status == StudioStatus.VERIFIED.value:
        raise ApiError(409, "INVALID_STATE", "This studio is already verified.")
    before = studio.status
    studio.status = StudioStatus.VERIFIED.value
    studio.verified_at = utcnow()
    audit.record(
        db,
        action="studio.verified",
        entity_type="studio",
        entity_id=str(studio.id),
        actor_user_id=staff.user.id,
        actor_roles=staff.roles_label,
        before={"status": before},
        after={"status": studio.status},
        **audit.context_from_request(request),
    )
    db.commit()
    return _studio_out(studio)


@router.post("/studios/{studio_id}/suspend", response_model=AdminStudioOut)
def suspend_studio(
    studio_id: uuid.UUID,
    body: StudioReasonBody,
    request: Request,
    staff: StaffContext = Depends(studios_verify),
    db: Session = Depends(get_db),
) -> AdminStudioOut:
    studio = _get_studio(db, studio_id)
    if studio.status == StudioStatus.SUSPENDED.value:
        raise ApiError(409, "INVALID_STATE", "This studio is already suspended.")
    before = studio.status
    studio.status = StudioStatus.SUSPENDED.value
    audit.record(
        db,
        action="studio.suspended",
        entity_type="studio",
        entity_id=str(studio.id),
        actor_user_id=staff.user.id,
        actor_roles=staff.roles_label,
        before={"status": before},
        after={"status": studio.status},
        reason=body.reason,
        **audit.context_from_request(request),
    )
    db.commit()
    return _studio_out(studio)


@router.get("/games", response_model=schemas.GameFullPage)
def list_games(
    status: GameStatus | None = None,
    limit: int = Query(50, ge=1, le=200),
    offset: int = Query(0, ge=0, le=10000),
    staff: StaffContext = Depends(games_review),
    db: Session = Depends(get_db),
) -> schemas.GameFullPage:
    return service.admin_list_games(db, status.value if status else None, limit, offset)


@router.get("/games/{game_id}", response_model=schemas.GameFull)
def get_game(
    game_id: uuid.UUID,
    staff: StaffContext = Depends(games_review),
    db: Session = Depends(get_db),
) -> schemas.GameFull:
    game, studio = service.get_game_and_studio(db, game_id)
    return service.to_full(db, game, studio)


@router.post("/games/{game_id}/transition", response_model=schemas.GameFull)
def transition_game(
    game_id: uuid.UUID,
    body: TransitionBody,
    request: Request,
    staff: StaffContext = Depends(games_review),
    db: Session = Depends(get_db),
) -> schemas.GameFull:
    game, studio = service.get_game_and_studio(db, game_id)
    service.review_game(
        db,
        game,
        studio,
        body.action,
        body.reason,
        staff.user.id,
        staff.roles_label,
        audit.context_from_request(request),
    )
    return service.to_full(db, game, studio)


@router.post("/builds/{build_id}/revoke", response_model=build_schemas.BuildOut)
def revoke_build(
    build_id: uuid.UUID,
    body: build_schemas.RevokeBody,
    request: Request,
    staff: StaffContext = Depends(games_review),
    db: Session = Depends(get_db),
) -> build_schemas.BuildOut:
    build = build_service.get_build(db, build_id)
    build_service.revoke_build(
        db,
        build,
        body.reason,
        staff.user.id,
        staff.roles_label,
        audit.context_from_request(request),
    )
    return build_service.to_out(build)
