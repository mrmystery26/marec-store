from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from app.modules.audit.models import AuditLog
from app.modules.rbac.permissions import Role
from tests.helpers import (
    bearer,
    code,
    create_account,
    make_category,
    make_game,
    make_studio,
)


def transition(client, tokens, game_id, action, reason=None):
    body = {"action": action}
    if reason:
        body["reason"] = reason
    return client.post(
        f"/v1/admin/games/{game_id}/transition", json=body, headers=bearer(tokens)
    )


def setup(client, db_session, status="draft", **game_options):
    owner, owner_tokens = create_account(client, db_session, "owner@example.com")
    _, mod_tokens = create_account(client, db_session, "mod@example.com", [Role.GAME_MODERATOR])
    studio = make_studio(db_session, owner, "Review Studio")
    category = make_category(db_session, "Adventure")
    game = make_game(db_session, studio, "Review Me", status, category=category, **game_options)
    return owner_tokens, mod_tokens, game, studio


def public_status(client, slug="review-me"):
    return client.get(f"/v1/games/{slug}").status_code


def test_full_review_cycle(client, db_session):
    owner, mod, game, _ = setup(client, db_session)
    game_id = str(game.id)

    submitted = client.post(f"/v1/developer/games/{game_id}/submit", headers=bearer(owner))
    assert submitted.json()["status"] == "submitted"

    queue = client.get("/v1/admin/games", params={"status": "submitted"}, headers=bearer(mod))
    assert queue.status_code == 200
    assert queue.json()["total"] == 1

    assert transition(client, mod, game_id, "start_review").json()["status"] == "under_review"

    no_reason = transition(client, mod, game_id, "request_changes")
    assert no_reason.status_code == 422
    assert code(no_reason) == "REASON_REQUIRED"

    sent_back = transition(client, mod, game_id, "request_changes", "Needs screenshots")
    assert sent_back.json()["status"] == "changes_requested"
    seen = client.get(f"/v1/developer/games/{game_id}", headers=bearer(owner)).json()
    assert seen["status_reason"] == "Needs screenshots"

    fixed = client.patch(
        f"/v1/developer/games/{game_id}",
        json={"summary": "Now with screenshots."},
        headers=bearer(owner),
    )
    assert fixed.status_code == 200
    resubmitted = client.post(f"/v1/developer/games/{game_id}/submit", headers=bearer(owner))
    assert resubmitted.json()["status"] == "submitted"
    assert resubmitted.json()["status_reason"] is None

    transition(client, mod, game_id, "start_review")
    assert transition(client, mod, game_id, "approve").json()["status"] == "approved"
    assert public_status(client) == 404
    published = transition(client, mod, game_id, "publish").json()
    assert published["status"] == "published"
    assert published["published_at"]
    assert public_status(client) == 200

    assert transition(client, mod, game_id, "suspend").status_code == 422
    suspended = transition(client, mod, game_id, "suspend", "Policy issue")
    assert suspended.json()["status"] == "suspended"
    assert public_status(client) == 404
    reinstated = transition(client, mod, game_id, "reinstate", "Resolved")
    assert reinstated.json()["status"] == "published"
    assert public_status(client) == 200

    removed = transition(client, mod, game_id, "remove", "Takedown request")
    assert removed.json()["status"] == "removed"
    assert public_status(client) == 404
    after_removal = transition(client, mod, game_id, "reinstate", "Oops")
    assert after_removal.status_code == 409
    assert code(after_removal) == "INVALID_STATE"

    db_session.expire_all()
    entry = db_session.scalar(select(AuditLog).where(AuditLog.action == "game.request_changes"))
    assert entry.reason == "Needs screenshots"
    assert entry.actor_roles == "game_moderator"
    assert entry.before == {"status": "under_review"}
    assert entry.after == {"status": "changes_requested"}


def test_invalid_transitions_are_refused(client, db_session):
    owner, mod, game, _ = setup(client, db_session, status="submitted")
    refused = transition(client, mod, str(game.id), "approve")
    assert refused.status_code == 409
    assert code(refused) == "INVALID_STATE"


def test_only_reviewers_can_transition_games(client, db_session):
    owner, mod, game, _ = setup(client, db_session, status="submitted")
    assert transition(client, owner, str(game.id), "start_review").status_code == 403
    _, support = create_account(client, db_session, "support@example.com", [Role.CUSTOMER_SUPPORT])
    assert transition(client, support, str(game.id), "start_review").status_code == 403
    assert client.get("/v1/admin/games", headers=bearer(support)).status_code == 403


def test_future_release_dates_are_scheduled_then_released(client, db_session):
    future = datetime.now(timezone.utc) + timedelta(days=30)
    _, mod, game, _ = setup(client, db_session, status="approved", release_at=future)
    game_id = str(game.id)

    assert transition(client, mod, game_id, "publish").json()["status"] == "scheduled"
    assert public_status(client) == 404
    assert transition(client, mod, game_id, "publish").json()["status"] == "published"
    assert public_status(client) == 200


def test_studio_verification_and_suspension(client, db_session):
    owner, owner_tokens = create_account(client, db_session, "owner@example.com")
    _, store_admin = create_account(client, db_session, "store@example.com", [Role.STORE_ADMIN])
    _, mod = create_account(client, db_session, "mod@example.com", [Role.GAME_MODERATOR])
    studio_id = client.post(
        "/v1/developer/studios", json={"name": "Fresh Studio"}, headers=bearer(owner_tokens)
    ).json()["id"]

    pending = client.get(
        "/v1/admin/studios", params={"status": "pending"}, headers=bearer(store_admin)
    )
    assert pending.json()["total"] == 1
    verify_url = f"/v1/admin/studios/{studio_id}/verify"
    assert client.post(verify_url, headers=bearer(mod)).status_code == 403

    verified = client.post(verify_url, headers=bearer(store_admin))
    assert verified.status_code == 200
    assert verified.json()["status"] == "verified"
    assert verified.json()["verified_at"]
    again = client.post(verify_url, headers=bearer(store_admin))
    assert again.status_code == 409

    no_reason = client.post(
        f"/v1/admin/studios/{studio_id}/suspend", json={"reason": "x"}, headers=bearer(store_admin)
    )
    assert no_reason.status_code == 422
    suspended = client.post(
        f"/v1/admin/studios/{studio_id}/suspend",
        json={"reason": "Fraud report"},
        headers=bearer(store_admin),
    )
    assert suspended.json()["status"] == "suspended"


def test_suspended_studio_games_disappear_from_the_store(client, db_session):
    _, mod, game, studio = setup(client, db_session, status="published")
    _, store_admin = create_account(client, db_session, "store@example.com", [Role.STORE_ADMIN])
    assert public_status(client) == 200

    client.post(
        f"/v1/admin/studios/{studio.id}/suspend",
        json={"reason": "Fraud report"},
        headers=bearer(store_admin),
    )
    assert public_status(client) == 404


def test_categories_are_managed_by_store_admins(client, db_session):
    _, store_admin = create_account(client, db_session, "store@example.com", [Role.STORE_ADMIN])
    _, mod = create_account(client, db_session, "mod@example.com", [Role.GAME_MODERATOR])

    created = client.post(
        "/v1/admin/categories", json={"name": "Role Playing"}, headers=bearer(store_admin)
    )
    assert created.status_code == 201
    assert created.json()["slug"] == "role-playing"

    duplicate = client.post(
        "/v1/admin/categories", json={"name": "role playing"}, headers=bearer(store_admin)
    )
    assert duplicate.status_code == 409
    assert code(duplicate) == "CATEGORY_EXISTS"

    denied = client.post("/v1/admin/categories", json={"name": "Sports"}, headers=bearer(mod))
    assert denied.status_code == 403
    assert [c["name"] for c in client.get("/v1/categories").json()] == ["Role Playing"]
