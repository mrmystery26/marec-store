import uuid

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.errors import ApiError
from app.modules.audit import service as audit
from app.modules.auth.deps import AuthContext, get_auth_context
from app.modules.catalog import schemas, service
from app.modules.developer.schemas import StudioCreate, StudioOut
from app.modules.studios import service as studios
from app.modules.studios.models import Studio, StudioRole

router = APIRouter(prefix="/developer", tags=["developer"])

ANY_ROLE = frozenset(StudioRole)


def _studio_out(studio: Studio, role: str) -> StudioOut:
    return StudioOut(
        id=studio.id, name=studio.name, slug=studio.slug, status=studio.status, my_role=role
    )


def _game_for_member(db: Session, game_id: uuid.UUID, user_id: uuid.UUID) -> tuple:
    return service.game_for_member(db, game_id, user_id)


@router.post("/studios", status_code=201, response_model=StudioOut)
def create_studio(
    body: StudioCreate,
    request: Request,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> StudioOut:
    studio = studios.create_studio(
        db, ctx.user.id, body.name, audit.context_from_request(request)
    )
    return _studio_out(studio, StudioRole.OWNER.value)


@router.get("/studios", response_model=list[StudioOut])
def my_studios(
    ctx: AuthContext = Depends(get_auth_context), db: Session = Depends(get_db)
) -> list[StudioOut]:
    mine = studios.list_user_studios(db, ctx.user.id)
    return [_studio_out(studio, role) for studio, role in mine]


@router.get("/studios/{studio_id}/games", response_model=schemas.GameFullPage)
def studio_games(
    studio_id: uuid.UUID,
    limit: int = Query(24, ge=1, le=50),
    offset: int = Query(0, ge=0, le=10000),
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> schemas.GameFullPage:
    studios.require_membership(db, studio_id, ctx.user.id, ANY_ROLE)
    studio = db.get(Studio, studio_id)
    return service.list_studio_games(db, studio, limit, offset)


@router.post("/studios/{studio_id}/games", status_code=201, response_model=schemas.GameFull)
def create_game(
    studio_id: uuid.UUID,
    body: schemas.GameCreate,
    request: Request,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> schemas.GameFull:
    studios.require_membership(db, studio_id, ctx.user.id, service.CONTENT_ROLES)
    studio = db.get(Studio, studio_id)
    game = service.create_game(
        db, studio, body.title, ctx.user.id, audit.context_from_request(request)
    )
    return service.to_full(db, game, studio)


@router.get("/games/{game_id}", response_model=schemas.GameFull)
def get_game(
    game_id: uuid.UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> schemas.GameFull:
    game, studio, _ = _game_for_member(db, game_id, ctx.user.id)
    return service.to_full(db, game, studio)


@router.patch("/games/{game_id}", response_model=schemas.GameFull)
def update_game(
    game_id: uuid.UUID,
    body: schemas.GameUpdate,
    request: Request,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> schemas.GameFull:
    game, studio, role = _game_for_member(db, game_id, ctx.user.id)
    changes = body.model_dump(exclude_unset=True)
    service.update_game(
        db, game, role, changes, ctx.user.id, audit.context_from_request(request)
    )
    return service.to_full(db, game, studio)


@router.post("/games/{game_id}/submit", response_model=schemas.GameFull)
def submit_game(
    game_id: uuid.UUID,
    request: Request,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> schemas.GameFull:
    game, studio, role = _game_for_member(db, game_id, ctx.user.id)
    if role not in service.SUBMIT_ROLES:
        raise ApiError(403, "FORBIDDEN", "Only studio owners and managers can submit.")
    service.submit_game(db, game, studio, ctx.user.id, audit.context_from_request(request))
    return service.to_full(db, game, studio)
