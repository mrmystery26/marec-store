import uuid
from typing import Literal

from fastapi import APIRouter, Depends, Query, Request, Response
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.storage import get_storage
from app.modules.audit import service as audit
from app.modules.auth.deps import AuthContext, get_auth_context
from app.modules.library import schemas, service

router = APIRouter(tags=["library"])


@router.get("/me/library", response_model=schemas.LibraryPage)
def my_library(
    limit: int = Query(24, ge=1, le=50),
    offset: int = Query(0, ge=0, le=10000),
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> schemas.LibraryPage:
    return service.list_library(db, ctx.user.id, limit, offset)


@router.post("/me/library/{game_id}", response_model=schemas.EntitlementOut)
def add_to_library(
    game_id: uuid.UUID,
    request: Request,
    response: Response,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> schemas.EntitlementOut:
    """Adds a FREE game. Paid games are added by completing a purchase."""
    entitlement, created = service.add_free_game(
        db, ctx.user.id, game_id, audit.context_from_request(request)
    )
    response.status_code = 201 if created else 200
    return schemas.EntitlementOut(
        id=entitlement.id,
        game_id=entitlement.game_id,
        source=entitlement.source,
        status=entitlement.status,
        granted_at=entitlement.granted_at,
    )


@router.post("/games/{game_id}/install-plan", response_model=schemas.InstallPlan)
def install_plan(
    game_id: uuid.UUID,
    platform: Literal["windows-x64"] = "windows-x64",
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
    storage=Depends(get_storage),
) -> schemas.InstallPlan:
    return service.build_install_plan(db, storage, ctx.user.id, game_id, platform)
