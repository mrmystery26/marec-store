from datetime import datetime
from enum import StrEnum


class GameStatus(StrEnum):
    DRAFT = "draft"
    SUBMITTED = "submitted"
    UNDER_REVIEW = "under_review"
    CHANGES_REQUESTED = "changes_requested"
    APPROVED = "approved"
    SCHEDULED = "scheduled"
    PUBLISHED = "published"
    SUSPENDED = "suspended"
    REMOVED = "removed"


class ReviewAction(StrEnum):
    START_REVIEW = "start_review"
    REQUEST_CHANGES = "request_changes"
    APPROVE = "approve"
    PUBLISH = "publish"
    SUSPEND = "suspend"
    REINSTATE = "reinstate"
    REMOVE = "remove"


# A developer may edit and (re)submit only in these states.
EDITABLE_STATUSES = frozenset({GameStatus.DRAFT, GameStatus.CHANGES_REQUESTED})

ALLOWED_FROM: dict[ReviewAction, frozenset[GameStatus]] = {
    ReviewAction.START_REVIEW: frozenset({GameStatus.SUBMITTED}),
    ReviewAction.REQUEST_CHANGES: frozenset({GameStatus.UNDER_REVIEW}),
    ReviewAction.APPROVE: frozenset({GameStatus.UNDER_REVIEW}),
    ReviewAction.PUBLISH: frozenset({GameStatus.APPROVED, GameStatus.SCHEDULED}),
    ReviewAction.SUSPEND: frozenset({GameStatus.PUBLISHED}),
    ReviewAction.REINSTATE: frozenset({GameStatus.SUSPENDED}),
    ReviewAction.REMOVE: frozenset(GameStatus) - {GameStatus.DRAFT, GameStatus.REMOVED},
}

# A written reason is mandatory for these (shown to the developer, kept in the audit log).
REASON_REQUIRED = frozenset(
    {
        ReviewAction.REQUEST_CHANGES,
        ReviewAction.SUSPEND,
        ReviewAction.REINSTATE,
        ReviewAction.REMOVE,
    }
)

_SIMPLE_TARGETS = {
    ReviewAction.START_REVIEW: GameStatus.UNDER_REVIEW,
    ReviewAction.REQUEST_CHANGES: GameStatus.CHANGES_REQUESTED,
    ReviewAction.APPROVE: GameStatus.APPROVED,
    ReviewAction.SUSPEND: GameStatus.SUSPENDED,
    ReviewAction.REINSTATE: GameStatus.PUBLISHED,
    ReviewAction.REMOVE: GameStatus.REMOVED,
}


def target_status(
    action: ReviewAction, current: GameStatus, release_at: datetime | None, now: datetime
) -> GameStatus:
    """Publishing an approved game with a future release date schedules it; publishing a
    scheduled game releases it immediately. (An automatic scheduled to published job comes
    later.)"""
    if action == ReviewAction.PUBLISH:
        if current == GameStatus.APPROVED and release_at is not None and release_at > now:
            return GameStatus.SCHEDULED
        return GameStatus.PUBLISHED
    return _SIMPLE_TARGETS[action]
