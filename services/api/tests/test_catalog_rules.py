import importlib.util
from datetime import datetime, timedelta, timezone
from pathlib import Path

from app.core.slugs import slugify
from app.modules.catalog.models import AGE_RATINGS, REQUIREMENT_TIERS
from app.modules.catalog.states import (
    ALLOWED_FROM,
    EDITABLE_STATUSES,
    REASON_REQUIRED,
    GameStatus,
    ReviewAction,
    target_status,
)
from app.modules.studios.models import StudioRole, StudioStatus


def load_migration():
    path = Path(__file__).resolve().parents[1] / "alembic" / "versions" / "0003_studios_catalog.py"
    spec = importlib.util.spec_from_file_location("migration_0003", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def values(text):
    return {part.strip().strip("'") for part in text.split(",")}


def test_migration_value_lists_match_the_code():
    module = load_migration()
    assert values(module.GAME_STATUS_VALUES) == {s.value for s in GameStatus}
    assert values(module.STUDIO_STATUS_VALUES) == {s.value for s in StudioStatus}
    assert values(module.STUDIO_ROLE_VALUES) == {r.value for r in StudioRole}
    assert values(module.AGE_RATING_VALUES) == set(AGE_RATINGS)
    assert values(module.TIER_VALUES) == set(REQUIREMENT_TIERS)


def test_every_review_action_has_rules():
    assert set(ALLOWED_FROM) == set(ReviewAction)
    assert REASON_REQUIRED <= set(ReviewAction)


def test_remove_is_not_allowed_from_draft_or_removed():
    allowed = ALLOWED_FROM[ReviewAction.REMOVE]
    assert GameStatus.DRAFT not in allowed
    assert GameStatus.REMOVED not in allowed
    assert GameStatus.PUBLISHED in allowed


def test_only_draft_and_changes_requested_are_editable():
    assert EDITABLE_STATUSES == {GameStatus.DRAFT, GameStatus.CHANGES_REQUESTED}


def test_publish_schedules_future_releases_only():
    now = datetime.now(timezone.utc)
    future = now + timedelta(days=5)
    past = now - timedelta(days=5)
    publish = ReviewAction.PUBLISH
    assert target_status(publish, GameStatus.APPROVED, future, now) == GameStatus.SCHEDULED
    assert target_status(publish, GameStatus.APPROVED, past, now) == GameStatus.PUBLISHED
    assert target_status(publish, GameStatus.APPROVED, None, now) == GameStatus.PUBLISHED
    assert target_status(publish, GameStatus.SCHEDULED, future, now) == GameStatus.PUBLISHED


def test_slugify():
    assert slugify("Zomba Games!") == "zomba-games"
    assert slugify("  --Hello   World--  ") == "hello-world"
    assert slugify("!!!") == "item"
    assert len(slugify("a" * 200)) <= 60
