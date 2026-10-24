from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.errors import ApiError

router = APIRouter(tags=["health"])


@router.get("/health")
def health() -> dict:
    return {"status": "ok", "service": "marec-store-api", "version": "0.1.0"}


@router.get("/health/db")
def health_db(db: Session = Depends(get_db)) -> dict:
    try:
        db.execute(text("SELECT 1"))
    except SQLAlchemyError:
        raise ApiError(503, "DATABASE_UNAVAILABLE", "Database is not reachable.") from None
    return {"database": "ok"}
