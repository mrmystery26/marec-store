import hashlib
import uuid

from sqlalchemy import select

from app.modules.auth.models import User
from app.modules.rbac.models import UserRole

EMAIL = "player@example.com"
PASSWORD = "correct-horse-battery"


def register(client, email=EMAIL, password=PASSWORD, name="Player One"):
    return client.post(
        "/v1/auth/register",
        json={"email": email, "password": password, "display_name": name},
    )


def login(client, email=EMAIL, password=PASSWORD):
    return client.post("/v1/auth/login", json={"email": email, "password": password})


def bearer(tokens):
    return {"Authorization": f"Bearer {tokens['access_token']}"}


def code(response):
    return response.json()["error"]["code"]


def create_account(client, db_session, email, roles=()):
    """Registers a user, optionally gives them roles directly in the database, logs in.
    Returns (user, tokens)."""
    assert register(client, email=email).status_code == 201
    user = db_session.scalar(select(User).where(User.email == email))
    for role in roles:
        db_session.add(UserRole(user_id=user.id, role=role.value))
    db_session.commit()
    login_response = login(client, email=email)
    assert login_response.status_code == 200
    return user, login_response.json()


# ---- direct-to-database builders (fast setup for catalog tests) ----

from datetime import timedelta  # noqa: E402

from app.core.db import utcnow  # noqa: E402
from app.core.slugs import slugify, unique_slug  # noqa: E402
from app.modules.builds.models import GameBuild  # noqa: E402
from app.modules.catalog.models import (  # noqa: E402
    Category,
    Game,
    GameCategory,
    SystemRequirement,
)
from app.modules.studios.models import Studio, StudioMembership  # noqa: E402


def make_category(db_session, name, sort_order=0):
    category = Category(id=uuid.uuid4(), slug=slugify(name), name=name, sort_order=sort_order)
    db_session.add(category)
    db_session.commit()
    return category


def make_studio(db_session, owner, name="Test Studio", status="verified", role="owner"):
    studio = Studio(
        id=uuid.uuid4(), name=name, slug=unique_slug(db_session, Studio, name), status=status
    )
    db_session.add(studio)
    db_session.flush()
    db_session.add(StudioMembership(studio_id=studio.id, user_id=owner.id, role=role))
    db_session.commit()
    return studio


def add_member(db_session, studio, user, role):
    db_session.add(StudioMembership(studio_id=studio.id, user_id=user.id, role=role))
    db_session.commit()


def make_game(
    db_session,
    studio,
    title="Test Game",
    status="draft",
    price=100000,
    category=None,
    age_minutes=0,
    release_at=None,
    with_build=True,
):
    """A complete game (ready to submit) in the given status."""
    game = Game(
        id=uuid.uuid4(),
        studio_id=studio.id,
        slug=unique_slug(db_session, Game, title),
        title=title,
        summary=f"{title} summary.",
        description=f"{title} full description.",
        status=status,
        price_minor=price,
        age_rating="12+",
        release_at=release_at,
        published_at=utcnow() - timedelta(minutes=age_minutes) if status == "published" else None,
    )
    db_session.add(game)
    db_session.flush()
    if category is not None:
        db_session.add(GameCategory(game_id=game.id, category_id=category.id))
    db_session.add(
        SystemRequirement(
            id=uuid.uuid4(),
            game_id=game.id,
            tier="minimum",
            os="Windows 10",
            cpu="Intel Core i3",
            ram_mb=4096,
            storage_mb=2000,
        )
    )
    db_session.commit()
    if with_build:
        make_build(db_session, game.id)
    return game


def make_build(db_session, game_id, version="1.0.0", status="ready"):
    build = GameBuild(
        id=uuid.uuid4(),
        game_id=game_id,
        version=version,
        platform="windows-x64",
        status=status,
        ready_at=utcnow() if status == "ready" else None,
    )
    db_session.add(build)
    db_session.commit()
    return build


def upload_ready_build(client, tokens, game_id, files, version="1.0.0"):
    """Runs the real upload flow (declare, upload, complete) and returns the ready build."""
    body = {
        "version": version,
        "platform": "windows-x64",
        "files": [
            {"path": p, "size_bytes": len(d), "sha256": hashlib.sha256(d).hexdigest()}
            for p, d in files.items()
        ],
    }
    created = client.post(
        f"/v1/developer/games/{game_id}/builds", json=body, headers=bearer(tokens)
    )
    assert created.status_code == 201, created.text
    for target in created.json()["uploads"]:
        assert client.put(target["upload_url"], content=files[target["path"]]).status_code == 204
    url = f"/v1/developer/builds/{created.json()['id']}/complete"
    done = client.post(url, headers=bearer(tokens))
    assert done.status_code == 200 and done.json()["problems"] == [], done.text
    return done.json()["build"]
