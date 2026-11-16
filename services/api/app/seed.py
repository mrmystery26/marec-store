"""Fills the database with clearly labelled DEMO data so the store has something to show.

    python -m app.seed            add demo data (safe to repeat)
    python -m app.seed --remove   remove the demo studio, games and demo user

To try the launcher with a real build of your own (the account must already exist):

    python -m app.seed --test-game you@example.com   makes you an owner of the demo studio and
                                                     creates an empty draft "Launcher Test Game"
    (upload a build to it, then)
    python -m app.seed --publish launcher-test-game  publishes it so it shows in the store

Refuses to run when ENVIRONMENT=production. The demo games are placeholders, not real products.
"""
import argparse
import secrets
import sys
import uuid
from datetime import timedelta

from sqlalchemy import delete, select

from app.core.config import get_settings
from app.core.db import get_sessionmaker, utcnow
from app.core.security import hash_password
from app.core.slugs import slugify
from app.modules.audit import service as audit
from app.modules.auth.models import User
from app.modules.auth.service import normalize_email
from app.modules.builds.models import GameBuild
from app.modules.catalog.models import Category, Game, GameCategory, SystemRequirement
from app.modules.studios.models import Studio, StudioMembership

DEMO_EMAIL = "demo-studio@marec-store.invalid"  # cannot receive mail; the account cannot log in
DEMO_STUDIO_NAME = "MAREC Demo Studio"
PLACEHOLDER = "Placeholder game used to preview the store. Not a real product."

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

# price_minor is in tambala: 250000 = MK 2,500.
DEMO_GAMES = [
    {
        "title": "Demo: Kwacha Kingdom",
        "summary": "Build a trading town and grow it into a kingdom.",
        "price_minor": 350000,
        "age_rating": "12+",
        "categories": ["strategy"],
        "ram_mb": 4096,
        "storage_mb": 1800,
    },
    {
        "title": "Demo: Lake Malawi Racer",
        "summary": "Race wooden boats across the lake. Free to play.",
        "price_minor": 0,
        "age_rating": "3+",
        "categories": ["racing", "family"],
        "ram_mb": 2048,
        "storage_mb": 900,
    },
    {
        "title": "Demo: Mzuzu Puzzle Box",
        "summary": "A relaxing collection of sliding and matching puzzles.",
        "price_minor": 150000,
        "age_rating": "3+",
        "categories": ["puzzle", "family"],
        "ram_mb": 2048,
        "storage_mb": 400,
    },
    {
        "title": "Demo: Zomba Plateau Trek",
        "summary": "Explore forests and cliffs on a story-driven hike.",
        "price_minor": 450000,
        "age_rating": "12+",
        "categories": ["adventure"],
        "ram_mb": 8192,
        "storage_mb": 6500,
    },
    {
        "title": "Demo: Football Legends MW",
        "summary": "Fast five-a-side matches with friends.",
        "price_minor": 200000,
        "age_rating": "7+",
        "categories": ["sports", "action"],
        "ram_mb": 4096,
        "storage_mb": 2500,
    },
    {
        "title": "Demo: Mathematics Safari",
        "summary": "Learn numbers on a wildlife adventure. Free to play.",
        "price_minor": 0,
        "age_rating": "3+",
        "categories": ["educational", "family"],
        "ram_mb": 2048,
        "storage_mb": 600,
    },
]


def _add_demo_data(db) -> int:
    for name, order in CATEGORIES:
        if db.scalar(select(Category.id).where(Category.slug == slugify(name))) is None:
            db.add(Category(id=uuid.uuid4(), slug=slugify(name), name=name, sort_order=order))
    db.commit()

    user = db.scalar(select(User).where(User.email == DEMO_EMAIL))
    if user is None:
        user = User(
            id=uuid.uuid4(),
            email=DEMO_EMAIL,
            password_hash=hash_password(secrets.token_urlsafe(32)),  # nobody knows this password
            display_name="Demo Studio",
        )
        db.add(user)

    studio = db.scalar(select(Studio).where(Studio.slug == slugify(DEMO_STUDIO_NAME)))
    if studio is None:
        studio = Studio(
            id=uuid.uuid4(),
            name=DEMO_STUDIO_NAME,
            slug=slugify(DEMO_STUDIO_NAME),
            status="verified",
            verified_at=utcnow(),
        )
        db.add(studio)
        db.flush()
        db.add(StudioMembership(studio_id=studio.id, user_id=user.id, role="owner"))

    categories = {c.slug: c for c in db.scalars(select(Category))}
    created = 0
    for index, item in enumerate(DEMO_GAMES):
        slug = slugify(item["title"])
        if db.scalar(select(Game.id).where(Game.slug == slug)) is not None:
            continue
        game = Game(
            id=uuid.uuid4(),
            studio_id=studio.id,
            slug=slug,
            title=item["title"],
            summary=item["summary"],
            description=f"{item['summary']} {PLACEHOLDER}",
            status="published",
            price_minor=item["price_minor"],
            age_rating=item["age_rating"],
            published_at=utcnow() - timedelta(hours=index),
        )
        db.add(game)
        db.flush()
        for category_slug in item["categories"]:
            db.add(GameCategory(game_id=game.id, category_id=categories[category_slug].id))
        for tier, ram, storage in (
            ("minimum", item["ram_mb"], item["storage_mb"]),
            ("recommended", item["ram_mb"] * 2, item["storage_mb"]),
        ):
            db.add(
                SystemRequirement(
                    id=uuid.uuid4(),
                    game_id=game.id,
                    tier=tier,
                    os="Windows 10 or later",
                    cpu="Intel Core i3 or equivalent",
                    ram_mb=ram,
                    gpu="Integrated graphics" if tier == "minimum" else "Dedicated GPU",
                    storage_mb=storage,
                )
            )
        created += 1

    if created:
        audit.record(
            db,
            action="seed.demo_created",
            entity_type="studio",
            entity_id=str(studio.id),
            actor_roles="cli",
            after={"games": created},
        )
    db.commit()
    return created


def _remove_demo_data(db) -> int:
    studio = db.scalar(select(Studio).where(Studio.slug == slugify(DEMO_STUDIO_NAME)))
    user = db.scalar(select(User).where(User.email == DEMO_EMAIL))
    removed = 0
    if studio is not None:
        game_ids = list(db.scalars(select(Game.id).where(Game.studio_id == studio.id)))
        removed = len(game_ids)
        db.execute(delete(GameCategory).where(GameCategory.game_id.in_(game_ids)))
        db.execute(delete(SystemRequirement).where(SystemRequirement.game_id.in_(game_ids)))
        db.execute(delete(Game).where(Game.studio_id == studio.id))
        db.execute(delete(StudioMembership).where(StudioMembership.studio_id == studio.id))
        db.execute(delete(Studio).where(Studio.id == studio.id))
    if user is not None:
        db.execute(delete(User).where(User.id == user.id))
    if studio is not None or user is not None:
        audit.record(
            db,
            action="seed.demo_removed",
            entity_type="studio",
            entity_id=str(studio.id) if studio is not None else None,
            actor_roles="cli",
            after={"games": removed},
        )
    db.commit()
    return removed


TEST_GAME_TITLE = "Launcher Test Game"


def _add_test_game(db, email: str) -> Game | None:
    user = db.scalar(select(User).where(User.email == normalize_email(email)))
    if user is None:
        return None
    studio = db.scalar(select(Studio).where(Studio.slug == slugify(DEMO_STUDIO_NAME)))
    if db.get(StudioMembership, (studio.id, user.id)) is None:
        db.add(StudioMembership(studio_id=studio.id, user_id=user.id, role="owner"))
    slug = slugify(TEST_GAME_TITLE)
    game = db.scalar(select(Game).where(Game.slug == slug))
    if game is None:
        game = Game(
            id=uuid.uuid4(),
            studio_id=studio.id,
            slug=slug,
            title=TEST_GAME_TITLE,
            summary="Your own build, used to try the launcher.",
            description=f"Your own build, used to try the launcher. {PLACEHOLDER}",
            status="draft",
            price_minor=0,
            age_rating="3+",
        )
        db.add(game)
    db.commit()
    return game


def _publish_test_game(db, slug: str) -> str | None:
    """Returns an error message, or None when the game is now published."""
    game = db.scalar(select(Game).where(Game.slug == slug))
    if game is None:
        return "There is no game with that slug."
    has_build = db.scalar(
        select(GameBuild.id).where(GameBuild.game_id == game.id, GameBuild.status == "ready")
    )
    if has_build is None:
        return "Upload a build first (it must be ready)."
    game.status = "published"
    if game.published_at is None:
        game.published_at = utcnow()
    db.commit()
    return None


def main(argv: list[str] | None = None, session_factory=None) -> int:
    parser = argparse.ArgumentParser(prog="python -m app.seed")
    parser.add_argument("--remove", action="store_true", help="remove the demo data instead")
    parser.add_argument("--test-game", metavar="EMAIL", help="make a draft game you can upload to")
    parser.add_argument("--publish", metavar="SLUG", help="publish a demo game that has a build")
    args = parser.parse_args(argv)

    if get_settings().environment == "production":
        print("Refusing to run: demo data must never be added to production.", file=sys.stderr)
        return 2

    factory = session_factory or get_sessionmaker()
    with factory() as db:
        if args.remove:
            removed = _remove_demo_data(db)
            print(f"Removed the demo studio and {removed} demo games.")
        elif args.publish:
            problem = _publish_test_game(db, args.publish)
            if problem:
                print(problem, file=sys.stderr)
                return 1
            print(f"{args.publish} is published.")
        else:
            created = _add_demo_data(db)
            print(f"Demo data ready. Added {created} new games (existing ones were kept).")
            if args.test_game:
                game = _add_test_game(db, args.test_game)
                if game is None:
                    print(f"No user with email {args.test_game}. Register first.", file=sys.stderr)
                    return 1
                print(f"Test game ready. Game id: {game.id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
