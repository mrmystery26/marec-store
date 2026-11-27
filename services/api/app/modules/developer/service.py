import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.errors import ApiError
from app.modules.audit import service as audit
from app.modules.auth.models import User
from app.modules.developer.models import DeveloperProfile
from app.modules.rbac import service as rbac
from app.modules.rbac.permissions import Role
from app.modules.studios import service as studios
from app.modules.studios.models import Studio, StudioMembership, StudioRole

# Bump this when the developer rules change. Everyone is asked to accept the new version.
TERMS_VERSION = "2026-11"


def get_profile(db: Session, user_id: uuid.UUID) -> DeveloperProfile | None:
    return db.get(DeveloperProfile, user_id)


def require_developer(db: Session, user_id: uuid.UUID) -> DeveloperProfile:
    profile = get_profile(db, user_id)
    if profile is None:
        raise ApiError(
            403,
            "DEVELOPER_ACCOUNT_REQUIRED",
            "Create a developer account first.",
        )
    return profile


def register(
    db: Session,
    user: User,
    studio_name: str,
    accept_terms: bool,
    terms_version: str,
    ctx: dict,
) -> Studio:
    """Creates the developer profile, grants the developer role and registers the first studio,
    all in one transaction (studios.create_studio commits it)."""
    if user.email_verified_at is None:
        raise ApiError(
            403,
            "EMAIL_NOT_VERIFIED",
            "Confirm your email address before creating a developer account.",
        )
    if not accept_terms:
        raise ApiError(422, "TERMS_NOT_ACCEPTED", "You must accept the developer rules.")
    if terms_version != TERMS_VERSION:
        raise ApiError(409, "TERMS_CHANGED", "The developer rules changed. Please read them again.")
    if get_profile(db, user.id) is not None:
        raise ApiError(409, "ALREADY_DEVELOPER", "You already have a developer account.")

    db.add(DeveloperProfile(user_id=user.id, terms_version=terms_version))
    rbac.grant_role(db, user.id, Role.DEVELOPER, granted_by=user.id)
    audit.record(
        db,
        action="developer.registered",
        entity_type="user",
        entity_id=str(user.id),
        actor_user_id=user.id,
        after={"terms_version": terms_version},
        **ctx,
    )
    return studios.create_studio(db, user.id, studio_name, ctx)


def studio_owner_emails(db: Session, studio_id: uuid.UUID) -> list[str]:
    stmt = (
        select(User.email)
        .join(StudioMembership, StudioMembership.user_id == User.id)
        .where(
            StudioMembership.studio_id == studio_id,
            StudioMembership.role == StudioRole.OWNER.value,
        )
    )
    return list(db.scalars(stmt))


def limits() -> dict:
    settings = get_settings()
    return {
        "demo_only": settings.demo_only,
        "max_demo_build_mb": settings.demo_max_build_mb,
        "max_games_per_studio": settings.demo_max_games_per_studio,
    }
