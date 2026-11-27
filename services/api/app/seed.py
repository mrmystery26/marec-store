"""Prepares the database for the store.

    python -m app.seed                       add the store's categories (safe to repeat)
    python -m app.seed --remove-placeholders delete the made-up demo studio, games and user that
                                             older versions of this project loaded

Nothing fictional is ever added. Real games come from developers: they sign in, create a developer
account, upload a demo and submit it for review.
"""

import argparse
import sys
import uuid

from sqlalchemy import delete, select

from app.core.db import get_sessionmaker
from app.core.slugs import slugify
from app.modules.audit import service as audit
from app.modules.auth.models import User
from app.modules.catalog.models import Category, Game, GameCategory, SystemRequirement
from app.modules.library.models import GameEntitlement
from app.modules.studios.models import Studio, StudioMembership

# The made-up account that older versions created. It is how the placeholder data is recognised:
# a studio is only removed if THIS account owns it, so a real developer who later picks the name
# "MAREC Demo Studio" can never be touched by the cleanup.
PLACEHOLDER_EMAIL = "demo-studio@marec-store.invalid"
PLACEHOLDER_STUDIO_SLUG = slugify("MAREC Demo Studio")

CATEGORIES = [
    ("Action", 1),
    ("Adventure", 2),
    ("Puzzle", 3),
    ("Racing", 4),
    ("Sports", 5),
    ("Strategy", 6),
    ("Educational", 7),
    ("Family", 8),
]


def add_categories(db) -> int:
    added = 0
    for name, order in CATEGORIES:
        if db.scalar(select(Category.id).where(Category.slug == slugify(name))) is None:
            db.add(Category(id=uuid.uuid4(), slug=slugify(name), name=name, sort_order=order))
            added += 1
    db.commit()
    return added


def remove_placeholders(db) -> int:
    """Deletes the placeholder user, their studio and its games. Returns the number of games."""
    user = db.scalar(select(User).where(User.email == PLACEHOLDER_EMAIL))
    if user is None:
        return 0
    studio = db.scalar(
        select(Studio)
        .join(StudioMembership, StudioMembership.studio_id == Studio.id)
        .where(Studio.slug == PLACEHOLDER_STUDIO_SLUG, StudioMembership.user_id == user.id)
    )
    removed = 0
    if studio is not None:
        game_ids = list(db.scalars(select(Game.id).where(Game.studio_id == studio.id)))
        removed = len(game_ids)
        if game_ids:
            # Players who added a placeholder game to their library lose that entry with it.
            db.execute(delete(GameEntitlement).where(GameEntitlement.game_id.in_(game_ids)))
            db.execute(delete(GameCategory).where(GameCategory.game_id.in_(game_ids)))
            db.execute(delete(SystemRequirement).where(SystemRequirement.game_id.in_(game_ids)))
            db.execute(delete(Game).where(Game.id.in_(game_ids)))
        db.execute(delete(StudioMembership).where(StudioMembership.studio_id == studio.id))
        db.execute(delete(Studio).where(Studio.id == studio.id))
    db.execute(delete(StudioMembership).where(StudioMembership.user_id == user.id))
    db.execute(delete(User).where(User.id == user.id))
    audit.record(
        db,
        action="seed.placeholders_removed",
        entity_type="studio",
        entity_id=str(studio.id) if studio is not None else None,
        actor_roles="cli",
        after={"games": removed},
    )
    db.commit()
    return removed


def main(argv: list[str] | None = None, session_factory=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.seed")
    parser.add_argument(
        "--remove-placeholders",
        action="store_true",
        help="delete the made-up demo studio, games and user left by older versions",
    )
    args = parser.parse_args(argv)

    factory = session_factory or get_sessionmaker()
    with factory() as db:
        if args.remove_placeholders:
            removed = remove_placeholders(db)
            print(f"Removed {removed} placeholder games." if removed else "No placeholders found.")
        else:
            added = add_categories(db)
            print(f"Categories ready. Added {added} new ones.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
