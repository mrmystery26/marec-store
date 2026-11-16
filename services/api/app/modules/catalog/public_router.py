from typing import Literal

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.modules.catalog import schemas, service

router = APIRouter(tags=["store"])


@router.get("/categories", response_model=list[schemas.CategoryOut])
def categories(db: Session = Depends(get_db)) -> list[schemas.CategoryOut]:
    return service.list_categories(db)


@router.get("/games", response_model=schemas.GamePage)
def games(
    q: str | None = Query(None, max_length=80),
    category: str | None = Query(None, max_length=60),
    free: bool | None = None,
    min_price_minor: int | None = Query(None, ge=0),
    max_price_minor: int | None = Query(None, ge=0),
    sort: Literal["newest", "price_asc", "price_desc", "title"] = "newest",
    limit: int = Query(24, ge=1, le=50),
    offset: int = Query(0, ge=0, le=10000),
    db: Session = Depends(get_db),
) -> schemas.GamePage:
    return service.public_list(
        db,
        q=q,
        category=category,
        free=free,
        min_price_minor=min_price_minor,
        max_price_minor=max_price_minor,
        sort=sort,
        limit=limit,
        offset=offset,
    )


@router.get("/games/{slug}", response_model=schemas.GameDetail)
def game_detail(slug: str, db: Session = Depends(get_db)) -> schemas.GameDetail:
    return service.public_detail(db, slug)
