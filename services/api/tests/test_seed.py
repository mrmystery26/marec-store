import uuid

from sqlalchemy import select

from app.core.db import utcnow
from app.modules.auth.models import User
from app.modules.catalog.models import Category, Game
from app.modules.library.models import GameEntitlement
from app.modules.studios.models import Studio, StudioMembership
from app.seed import PLACEHOLDER_EMAIL, PLACEHOLDER_STUDIO_SLUG, main
from tests.helpers import create_account, make_game, make_studio


def make_old_placeholders(db_session):
    """What older versions of the project loaded: a made-up user, studio and games."""
    user = User(id=uuid.uuid4(), email=PLACEHOLDER_EMAIL, password_hash=None, display_name="Demo")
    db_session.add(user)
    studio = Studio(
        id=uuid.uuid4(),
        name="MAREC Demo Studio",
        slug=PLACEHOLDER_STUDIO_SLUG,
        status="verified",
        verified_at=utcnow(),
    )
    db_session.add(studio)
    db_session.flush()
    db_session.add(StudioMembership(studio_id=studio.id, user_id=user.id, role="owner"))
    db_session.commit()
    games = [
        make_game(db_session, studio, "Demo: Kwacha Kingdom", "published", with_build=False),
        make_game(db_session, studio, "Demo: Lake Malawi Racer", "published", with_build=False),
    ]
    return studio, games


def test_seed_adds_only_categories(client, session_factory, db_session):
    assert main([], session_factory) == 0
    names = [c["name"] for c in client.get("/v1/categories").json()]
    assert names[:3] == ["Action", "Adventure", "Puzzle"] and len(names) == 8
    assert client.get("/v1/games").json()["total"] == 0
    assert db_session.scalar(select(User.id)) is None  # no made-up accounts either


def test_seed_is_safe_to_repeat(client, session_factory, db_session):
    main([], session_factory)
    main([], session_factory)
    assert len(list(db_session.scalars(select(Category)))) == 8


def test_placeholders_left_by_older_versions_can_be_removed(
    client, session_factory, db_session, capsys
):
    _, games = make_old_placeholders(db_session)
    player, _ = create_account(client, db_session, "player@example.com")
    db_session.add(GameEntitlement(user_id=player.id, game_id=games[0].id, source="free"))
    db_session.commit()
    assert client.get("/v1/games").json()["total"] == 2

    assert main(["--remove-placeholders"], session_factory) == 0
    assert "Removed 2 placeholder games" in capsys.readouterr().out
    db_session.expire_all()
    assert client.get("/v1/games").json()["total"] == 0
    assert db_session.scalar(select(User).where(User.email == PLACEHOLDER_EMAIL)) is None
    assert db_session.scalar(select(Studio).where(Studio.slug == PLACEHOLDER_STUDIO_SLUG)) is None
    assert db_session.scalar(select(GameEntitlement.id)) is None
    assert db_session.scalar(select(User).where(User.email == "player@example.com"))


def test_removing_placeholders_twice_does_nothing_more(session_factory, db_session, capsys):
    make_old_placeholders(db_session)
    main(["--remove-placeholders"], session_factory)
    capsys.readouterr()
    assert main(["--remove-placeholders"], session_factory) == 0
    assert "No placeholders found" in capsys.readouterr().out


def test_a_real_studio_with_the_same_name_is_never_removed(
    client, session_factory, db_session, capsys
):
    """After the cleanup, a real developer may pick the name 'MAREC Demo Studio'. Running the
    cleanup again (it runs on every start-up) must leave their studio and games alone."""
    owner, _ = create_account(client, db_session, "real@example.com")
    studio = make_studio(db_session, owner, "MAREC Demo Studio")
    make_game(db_session, studio, "Real Game", "published")
    assert studio.slug == PLACEHOLDER_STUDIO_SLUG

    assert main(["--remove-placeholders"], session_factory) == 0
    assert "No placeholders found" in capsys.readouterr().out
    db_session.expire_all()
    assert db_session.get(Studio, studio.id) is not None
    assert db_session.scalar(select(Game).where(Game.title == "Real Game")) is not None


def test_a_real_studio_survives_even_when_placeholders_exist_beside_it(
    client, session_factory, db_session
):
    placeholder, _ = make_old_placeholders(db_session)
    placeholder_id = placeholder.id
    owner, _ = create_account(client, db_session, "real@example.com")
    other = make_studio(db_session, owner, "Zomba Games")
    other_id = other.id
    make_game(db_session, other, "Real Game", "published")
    main(["--remove-placeholders"], session_factory)
    db_session.expire_all()
    assert db_session.get(Studio, other_id) is not None
    assert db_session.get(Studio, placeholder_id) is None
