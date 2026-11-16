import uuid
from collections import defaultdict

from sqlalchemy import delete, func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.db import utcnow
from app.core.errors import ApiError
from app.core.slugs import slugify, unique_slug
from app.modules.audit import service as audit
from app.modules.builds.models import GameBuild
from app.modules.catalog import schemas
from app.modules.catalog.models import Category, Game, GameCategory, SystemRequirement
from app.modules.catalog.states import (
    ALLOWED_FROM,
    EDITABLE_STATUSES,
    REASON_REQUIRED,
    GameStatus,
    ReviewAction,
    target_status,
)
from app.modules.studios.models import Studio, StudioMembership, StudioRole, StudioStatus

CONTENT_FIELDS = frozenset(
    {
        "title",
        "summary",
        "description",
        "age_rating",
        "protection_level",
        "offline_days",
        "release_at",
        "category_slugs",
        "requirements",
    }
)
PRICE_FIELDS = frozenset({"price_minor"})
CONTENT_ROLES = frozenset({StudioRole.OWNER, StudioRole.MANAGER, StudioRole.DEVELOPER})
PRICE_ROLES = frozenset({StudioRole.OWNER, StudioRole.MANAGER, StudioRole.FINANCE})
SUBMIT_ROLES = frozenset({StudioRole.OWNER, StudioRole.MANAGER})
SIMPLE_FIELDS = (
    "title",
    "summary",
    "description",
    "price_minor",
    "age_rating",
    "protection_level",
    "offline_days",
    "release_at",
)


# ---------------------------------------------------------------- presenting


def _category_out(category: Category) -> schemas.CategoryOut:
    return schemas.CategoryOut(id=category.id, slug=category.slug, name=category.name)


def load_categories(db: Session, game_ids: list[uuid.UUID]) -> dict:
    result: dict[uuid.UUID, list[schemas.CategoryOut]] = defaultdict(list)
    if not game_ids:
        return result
    stmt = (
        select(GameCategory.game_id, Category)
        .join(Category, Category.id == GameCategory.category_id)
        .where(GameCategory.game_id.in_(game_ids))
        .order_by(Category.sort_order, Category.name)
    )
    for game_id, category in db.execute(stmt).all():
        result[game_id].append(_category_out(category))
    return result


def load_requirements(db: Session, game_id: uuid.UUID) -> list[schemas.RequirementOut]:
    stmt = (
        select(SystemRequirement)
        .where(SystemRequirement.game_id == game_id)
        .order_by(SystemRequirement.tier)
    )
    return [
        schemas.RequirementOut(
            tier=r.tier, os=r.os, cpu=r.cpu, ram_mb=r.ram_mb, gpu=r.gpu, storage_mb=r.storage_mb
        )
        for r in db.scalars(stmt)
    ]


def to_card(game: Game, studio: Studio, categories: list) -> schemas.GameCard:
    return schemas.GameCard(
        id=game.id,
        slug=game.slug,
        title=game.title,
        summary=game.summary,
        price_minor=game.price_minor,
        currency=game.currency,
        is_free=game.price_minor == 0,
        age_rating=game.age_rating,
        studio=schemas.StudioBrief(name=studio.name, slug=studio.slug),
        categories=categories,
        published_at=game.published_at,
    )


def to_full(db: Session, game: Game, studio: Studio) -> schemas.GameFull:
    return schemas.GameFull(
        id=game.id,
        studio_id=game.studio_id,
        studio=schemas.StudioBrief(name=studio.name, slug=studio.slug),
        studio_status=studio.status,
        slug=game.slug,
        title=game.title,
        summary=game.summary,
        description=game.description,
        status=game.status,
        status_reason=game.status_reason,
        price_minor=game.price_minor,
        currency=game.currency,
        is_free=game.price_minor == 0,
        age_rating=game.age_rating,
        protection_level=game.protection_level,
        offline_days=game.offline_days,
        release_at=game.release_at,
        published_at=game.published_at,
        categories=load_categories(db, [game.id])[game.id],
        requirements=load_requirements(db, game.id),
        created_at=game.created_at,
        updated_at=game.updated_at,
    )


def get_game_and_studio(db: Session, game_id: uuid.UUID) -> tuple[Game, Studio]:
    game = db.get(Game, game_id)
    if game is None:
        raise ApiError(404, "GAME_NOT_FOUND", "Game not found.")
    studio = db.get(Studio, game.studio_id)
    return game, studio


def game_for_member(db: Session, game_id: uuid.UUID, user_id: uuid.UUID) -> tuple:
    """Game, studio and the caller's studio role. Non-members get 404 so IDs cannot be probed."""
    game, studio = get_game_and_studio(db, game_id)
    membership = db.get(StudioMembership, (studio.id, user_id))
    if membership is None:
        raise ApiError(404, "GAME_NOT_FOUND", "Game not found.")
    return game, studio, StudioRole(membership.role)


# ---------------------------------------------------------------- public store


def _escape_like(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _visible(stmt):
    """Only published games from verified studios are public."""
    return (
        stmt.select_from(Game)
        .join(Studio, Studio.id == Game.studio_id)
        .where(
            Game.status == GameStatus.PUBLISHED.value,
            Studio.status == StudioStatus.VERIFIED.value,
        )
    )


def list_categories(db: Session) -> list[schemas.CategoryOut]:
    stmt = select(Category).order_by(Category.sort_order, Category.name)
    return [_category_out(c) for c in db.scalars(stmt)]


def public_list(
    db: Session,
    *,
    q: str | None,
    category: str | None,
    free: bool | None,
    min_price_minor: int | None,
    max_price_minor: int | None,
    sort: str,
    limit: int,
    offset: int,
) -> schemas.GamePage:
    def filtered(stmt):
        stmt = _visible(stmt)
        if q:
            stmt = stmt.where(Game.title.ilike(f"%{_escape_like(q)}%", escape="\\"))
        if category:
            stmt = (
                stmt.join(GameCategory, GameCategory.game_id == Game.id)
                .join(Category, Category.id == GameCategory.category_id)
                .where(Category.slug == category)
            )
        if free is True:
            stmt = stmt.where(Game.price_minor == 0)
        if free is False:
            stmt = stmt.where(Game.price_minor > 0)
        if min_price_minor is not None:
            stmt = stmt.where(Game.price_minor >= min_price_minor)
        if max_price_minor is not None:
            stmt = stmt.where(Game.price_minor <= max_price_minor)
        return stmt

    orders = {
        "newest": (Game.published_at.desc(), Game.id.desc()),
        "price_asc": (Game.price_minor.asc(), Game.id.asc()),
        "price_desc": (Game.price_minor.desc(), Game.id.desc()),
        "title": (func.lower(Game.title).asc(), Game.id.asc()),
    }
    total = db.scalar(filtered(select(func.count(Game.id)))) or 0
    rows = db.execute(
        filtered(select(Game, Studio)).order_by(*orders[sort]).limit(limit).offset(offset)
    ).all()
    categories = load_categories(db, [game.id for game, _ in rows])
    items = [to_card(game, studio, categories[game.id]) for game, studio in rows]
    return schemas.GamePage(items=items, total=total, limit=limit, offset=offset)


def public_detail(db: Session, slug: str) -> schemas.GameDetail:
    row = db.execute(_visible(select(Game, Studio)).where(Game.slug == slug)).first()
    if row is None:
        raise ApiError(404, "GAME_NOT_FOUND", "Game not found.")
    game, studio = row
    card = to_card(game, studio, load_categories(db, [game.id])[game.id])
    return schemas.GameDetail(
        **card.model_dump(),
        description=game.description,
        offline_days=game.offline_days,
        requirements=load_requirements(db, game.id),
    )


# ---------------------------------------------------------------- categories (staff)


def create_category(
    db: Session, body: schemas.CategoryCreate, actor_id: uuid.UUID, roles_label: str, ctx: dict
) -> Category:
    slug = slugify(body.name)
    exists = db.scalar(
        select(Category.id).where((Category.slug == slug) | (Category.name == body.name))
    )
    if exists is not None:
        raise ApiError(409, "CATEGORY_EXISTS", "A category with this name already exists.")
    category = Category(id=uuid.uuid4(), slug=slug, name=body.name, sort_order=body.sort_order)
    db.add(category)
    audit.record(
        db,
        action="category.created",
        entity_type="category",
        entity_id=str(category.id),
        actor_user_id=actor_id,
        actor_roles=roles_label,
        after={"slug": slug, "name": body.name},
        **ctx,
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ApiError(
            409, "CATEGORY_EXISTS", "A category with this name already exists."
        ) from None
    return category


# ---------------------------------------------------------------- developer side


def create_game(
    db: Session, studio: Studio, title: str, actor_id: uuid.UUID, ctx: dict
) -> Game:
    game = Game(
        id=uuid.uuid4(), studio_id=studio.id, title=title, slug=unique_slug(db, Game, title)
    )
    db.add(game)
    audit.record(
        db,
        action="game.created",
        entity_type="game",
        entity_id=str(game.id),
        actor_user_id=actor_id,
        after={"title": title, "studio_id": str(studio.id)},
        **ctx,
    )
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        raise ApiError(409, "SLUG_CONFLICT", "Please try again.") from None
    return game


def update_game(
    db: Session, game: Game, role: StudioRole, changes: dict, actor_id: uuid.UUID, ctx: dict
) -> None:
    if GameStatus(game.status) not in EDITABLE_STATUSES:
        raise ApiError(
            409, "GAME_NOT_EDITABLE", "This game cannot be edited in its current state."
        )
    keys = set(changes)
    if keys & CONTENT_FIELDS and role not in CONTENT_ROLES:
        raise ApiError(403, "FORBIDDEN", "Your studio role cannot edit game content.")
    if keys & PRICE_FIELDS and role not in PRICE_ROLES:
        raise ApiError(403, "FORBIDDEN", "Your studio role cannot change the price.")

    after: dict = {"fields": sorted(keys)}
    if "price_minor" in changes and changes["price_minor"] != game.price_minor:
        after["price_minor"] = {"from": game.price_minor, "to": changes["price_minor"]}

    for field in SIMPLE_FIELDS:
        if field in changes:
            setattr(game, field, changes[field])

    if "category_slugs" in changes:
        slugs = list(dict.fromkeys(changes["category_slugs"]))
        found = list(db.scalars(select(Category).where(Category.slug.in_(slugs))))
        if len(found) != len(slugs):
            raise ApiError(422, "UNKNOWN_CATEGORY", "One or more categories do not exist.")
        db.execute(delete(GameCategory).where(GameCategory.game_id == game.id))
        for category in found:
            db.add(GameCategory(game_id=game.id, category_id=category.id))

    if "requirements" in changes:
        db.execute(delete(SystemRequirement).where(SystemRequirement.game_id == game.id))
        for item in changes["requirements"]:
            db.add(SystemRequirement(id=uuid.uuid4(), game_id=game.id, **item))

    audit.record(
        db,
        action="game.updated",
        entity_type="game",
        entity_id=str(game.id),
        actor_user_id=actor_id,
        after=after,
        **ctx,
    )
    db.commit()


def missing_for_submission(db: Session, game: Game) -> list[str]:
    missing = []
    if not game.summary:
        missing.append("summary")
    if not game.description:
        missing.append("description")
    if game.price_minor is None:
        missing.append("price_minor")
    if not game.age_rating:
        missing.append("age_rating")
    has_category = db.scalar(select(GameCategory.game_id).where(GameCategory.game_id == game.id))
    if has_category is None:
        missing.append("category_slugs")
    has_minimum = db.scalar(
        select(SystemRequirement.id).where(
            SystemRequirement.game_id == game.id, SystemRequirement.tier == "minimum"
        )
    )
    if has_minimum is None:
        missing.append("requirements (minimum)")
    has_build = db.scalar(
        select(GameBuild.id).where(GameBuild.game_id == game.id, GameBuild.status == "ready")
    )
    if has_build is None:
        missing.append("a ready build")
    return missing


def submit_game(db: Session, game: Game, studio: Studio, actor_id: uuid.UUID, ctx: dict) -> None:
    if GameStatus(game.status) not in EDITABLE_STATUSES:
        raise ApiError(
            409, "INVALID_STATE", "Only drafts and games needing changes can be submitted."
        )
    if studio.status != StudioStatus.VERIFIED.value:
        raise ApiError(
            403, "STUDIO_NOT_VERIFIED", "Your studio must be verified before submitting."
        )
    missing = missing_for_submission(db, game)
    if missing:
        raise ApiError(422, "SUBMISSION_INCOMPLETE", "Missing: " + ", ".join(missing) + ".")

    before = game.status
    game.status = GameStatus.SUBMITTED.value
    game.status_reason = None
    audit.record(
        db,
        action="game.submitted",
        entity_type="game",
        entity_id=str(game.id),
        actor_user_id=actor_id,
        before={"status": before},
        after={"status": game.status},
        **ctx,
    )
    db.commit()


def list_studio_games(
    db: Session, studio: Studio, limit: int, offset: int
) -> schemas.GameFullPage:
    where = Game.studio_id == studio.id
    total = db.scalar(select(func.count(Game.id)).where(where)) or 0
    games = db.scalars(
        select(Game)
        .where(where)
        .order_by(Game.created_at.desc(), Game.id)
        .limit(limit)
        .offset(offset)
    )
    items = [to_full(db, game, studio) for game in games]
    return schemas.GameFullPage(items=items, total=total, limit=limit, offset=offset)


# ---------------------------------------------------------------- review (staff)


def review_game(
    db: Session,
    game: Game,
    studio: Studio,
    action: ReviewAction,
    reason: str | None,
    actor_id: uuid.UUID,
    roles_label: str,
    ctx: dict,
) -> None:
    current = GameStatus(game.status)
    if current not in ALLOWED_FROM[action]:
        raise ApiError(
            409, "INVALID_STATE", f"Cannot {action.value} a game that is {current.value}."
        )
    if action in REASON_REQUIRED and not (reason and reason.strip()):
        raise ApiError(422, "REASON_REQUIRED", f"A reason is required to {action.value}.")
    if action in (ReviewAction.PUBLISH, ReviewAction.REINSTATE):
        if studio.status != StudioStatus.VERIFIED.value:
            raise ApiError(409, "STUDIO_NOT_VERIFIED", "The studio is not verified.")

    now = utcnow()
    new_status = target_status(action, current, game.release_at, now)
    if new_status == GameStatus.PUBLISHED and game.published_at is None:
        game.published_at = now
    game.status = new_status.value
    game.status_reason = reason.strip() if reason and reason.strip() else None
    audit.record(
        db,
        action=f"game.{action.value}",
        entity_type="game",
        entity_id=str(game.id),
        actor_user_id=actor_id,
        actor_roles=roles_label,
        before={"status": current.value},
        after={"status": new_status.value},
        reason=game.status_reason,
        **ctx,
    )
    db.commit()


def admin_list_games(
    db: Session, status: str | None, limit: int, offset: int
) -> schemas.GameFullPage:
    stmt = select(Game, Studio).select_from(Game).join(Studio, Studio.id == Game.studio_id)
    count_stmt = select(func.count(Game.id))
    if status:
        stmt = stmt.where(Game.status == status)
        count_stmt = count_stmt.where(Game.status == status)
    total = db.scalar(count_stmt) or 0
    rows = db.execute(
        stmt.order_by(Game.updated_at.desc(), Game.id).limit(limit).offset(offset)
    ).all()
    items = [to_full(db, game, studio) for game, studio in rows]
    return schemas.GameFullPage(items=items, total=total, limit=limit, offset=offset)
