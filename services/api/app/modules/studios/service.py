import uuid

from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.errors import ApiError
from app.core.slugs import unique_slug
from app.modules.audit import service as audit
from app.modules.studios.models import Studio, StudioMembership, StudioRole

MAX_OWNED_STUDIOS = 3


def create_studio(db: Session, user_id: uuid.UUID, name: str, ctx: dict) -> Studio:
    owned = db.scalar(
        select(func.count())
        .select_from(StudioMembership)
        .where(
            StudioMembership.user_id == user_id,
            StudioMembership.role == StudioRole.OWNER.value,
        )
    )
    if (owned or 0) >= MAX_OWNED_STUDIOS:
        raise ApiError(409, "STUDIO_LIMIT", f"You can own at most {MAX_OWNED_STUDIOS} studios.")

    studio = Studio(id=uuid.uuid4(), name=name, slug=unique_slug(db, Studio, name))
    db.add(studio)
    db.flush()
    db.add(StudioMembership(studio_id=studio.id, user_id=user_id, role=StudioRole.OWNER.value))
    audit.record(
        db,
        action="studio.created",
        entity_type="studio",
        entity_id=str(studio.id),
        actor_user_id=user_id,
        after={"name": name, "slug": studio.slug},
        **ctx,
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ApiError(409, "SLUG_CONFLICT", "Please try again.") from None
    return studio


def list_user_studios(db: Session, user_id: uuid.UUID) -> list[tuple[Studio, str]]:
    stmt = (
        select(Studio, StudioMembership.role)
        .join(StudioMembership, StudioMembership.studio_id == Studio.id)
        .where(StudioMembership.user_id == user_id)
        .order_by(Studio.created_at)
    )
    return [(studio, role) for studio, role in db.execute(stmt).all()]


def require_membership(
    db: Session, studio_id: uuid.UUID, user_id: uuid.UUID, allowed: frozenset[StudioRole]
) -> StudioMembership:
    """404 for non-members (existence is not revealed), 403 for members without the right role."""
    membership = db.get(StudioMembership, (studio_id, user_id))
    if membership is None:
        raise ApiError(404, "STUDIO_NOT_FOUND", "Studio not found.")
    if StudioRole(membership.role) not in allowed:
        raise ApiError(403, "FORBIDDEN", "Your studio role does not allow this action.")
    return membership
