from types import SimpleNamespace

from sqlalchemy import select

from app.modules.audit.models import AuditLog
from app.modules.catalog.models import Game
from app.seed import main
from tests.helpers import create_account, upload_ready_build


def totals(client):
    everything = client.get("/v1/games", params={"limit": 50}).json()["total"]
    free = client.get("/v1/games", params={"free": "true"}).json()["total"]
    return everything, free


def test_seed_makes_the_store_browsable(client, session_factory):
    assert main([], session_factory) == 0
    assert totals(client) == (6, 2)

    categories = client.get("/v1/categories").json()
    assert [c["name"] for c in categories][:3] == ["Action", "Adventure", "Puzzle"]

    detail = client.get("/v1/games/demo-lake-malawi-racer").json()
    assert detail["is_free"] is True
    assert detail["studio"]["slug"] == "marec-demo-studio"
    assert "Not a real product" in detail["description"]
    assert len(detail["requirements"]) == 2


def test_seed_is_safe_to_repeat(client, session_factory, db_session):
    main([], session_factory)
    main([], session_factory)
    assert totals(client)[0] == 6
    db_session.expire_all()
    stmt = select(AuditLog).where(AuditLog.action == "seed.demo_created")
    assert len(list(db_session.scalars(stmt))) == 1


def test_seed_can_be_removed(client, session_factory):
    main([], session_factory)
    assert main(["--remove"], session_factory) == 0
    assert totals(client) == (0, 0)
    assert client.get("/v1/games/demo-lake-malawi-racer").status_code == 404
    assert len(client.get("/v1/categories").json()) == 8  # categories are kept


def test_seed_refuses_to_run_in_production(client, session_factory, monkeypatch):
    monkeypatch.setattr("app.seed.get_settings", lambda: SimpleNamespace(environment="production"))
    assert main([], session_factory) == 2
    assert totals(client) == (0, 0)


def test_test_game_can_be_uploaded_to_and_published(client, session_factory, db_session):
    _, tokens = create_account(client, db_session, "dev@example.com")
    assert main(["--test-game", "dev@example.com"], session_factory) == 0
    game = db_session.scalar(select(Game).where(Game.slug == "launcher-test-game"))
    assert game.status == "draft"
    assert client.get("/v1/games/launcher-test-game").status_code == 404  # not public yet

    files = {"Game.exe": b"MZ" + bytes(50), "data/x.pck": b"abc"}
    upload_ready_build(client, tokens, game.id, files)
    assert main(["--publish", "launcher-test-game"], session_factory) == 0
    assert client.get("/v1/games/launcher-test-game").status_code == 200


def test_test_game_needs_an_account_and_publishing_needs_a_build(
    client, session_factory, db_session
):
    assert main(["--test-game", "nobody@example.com"], session_factory) == 1
    create_account(client, db_session, "dev@example.com")
    assert main(["--test-game", "dev@example.com"], session_factory) == 0
    assert main(["--publish", "launcher-test-game"], session_factory) == 1
    assert main(["--publish", "no-such-game"], session_factory) == 1
