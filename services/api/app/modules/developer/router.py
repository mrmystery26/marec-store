import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, Query, Request
from fastapi.responses import PlainTextResponse
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db
from app.core.email import EmailSender, get_email_sender, studio_pending_email
from app.core.errors import ApiError
from app.core.launch_signing import get_launch_signer
from app.modules.audit import service as audit
from app.modules.auth.deps import AuthContext, get_auth_context
from app.modules.catalog import schemas, service
from app.modules.developer import sdk_config
from app.modules.developer import service as developer
from app.modules.developer.schemas import (
    DeveloperAccountOut,
    DeveloperLimits,
    DeveloperRegister,
    StudioCreate,
    StudioOut,
)
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


@router.get("/account", response_model=DeveloperAccountOut)
def developer_account(
    ctx: AuthContext = Depends(get_auth_context), db: Session = Depends(get_db)
) -> DeveloperAccountOut:
    """Where the person stands: can they register as a developer, and what are the limits?"""
    profile = developer.get_profile(db, ctx.user.id)
    mine = studios.list_user_studios(db, ctx.user.id) if profile else []
    return DeveloperAccountOut(
        is_developer=profile is not None,
        email_verified=ctx.user.email_verified_at is not None,
        terms_version=developer.TERMS_VERSION,
        limits=DeveloperLimits(**developer.limits()),
        studios=[_studio_out(studio, role) for studio, role in mine],
    )


@router.post("/account", status_code=201, response_model=StudioOut)
def register_developer(
    body: DeveloperRegister,
    request: Request,
    background: BackgroundTasks,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
    sender: EmailSender = Depends(get_email_sender),
) -> StudioOut:
    """Creates the developer account and the first studio. The studio stays pending until MAREC
    verifies it, and nothing can be uploaded before then."""
    studio = developer.register(
        db,
        ctx.user,
        body.studio_name,
        body.accept_terms,
        body.terms_version,
        audit.context_from_request(request),
    )
    notify = get_settings().admin_notify_email
    if notify:
        background.add_task(
            sender.send, studio_pending_email(notify, studio.name, ctx.user.display_name)
        )
    return _studio_out(studio, StudioRole.OWNER.value)


@router.post("/studios", status_code=201, response_model=StudioOut)
def create_studio(
    body: StudioCreate,
    request: Request,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> StudioOut:
    developer.require_developer(db, ctx.user.id)
    studio = studios.create_studio(db, ctx.user.id, body.name, audit.context_from_request(request))
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
    service.update_game(db, game, role, changes, ctx.user.id, audit.context_from_request(request))
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


@router.get("/games/{game_id}/sdk-config", response_class=PlainTextResponse)
def download_sdk_config(
    game_id: uuid.UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> PlainTextResponse:
    """marec_config.gd for the MAREC SDK, already filled in for this game: the game's id, this
    store's address and the launch public key. Replaces the file in addons/marec_sdk."""
    game, _, _ = _game_for_member(db, game_id, ctx.user.id)
    base = get_settings().public_api_base_url.rstrip("/")
    text = sdk_config.render(str(game.id), base, get_launch_signer().public_pem)
    disposition = 'attachment; filename="marec_config.gd"'
    return PlainTextResponse(text, headers={"Content-Disposition": disposition})
