import pytest
from sqlalchemy import create_engine
from sqlalchemy.engine import make_url

from app.core.config import Settings


def settings_for(url: str) -> Settings:
    return Settings(
        _env_file=None,
        environment="test",
        database_url=url,
        jwt_secret="x" * 40,
    )


@pytest.mark.parametrize(
    "given",
    [
        "postgres://user:pw@db.example.com:5432/marec",
        "postgresql://user:pw@db.example.com:5432/marec",
        "postgresql+psycopg://user:pw@db.example.com:5432/marec",
    ],
)
def test_hosted_postgres_urls_use_the_psycopg_driver(given):
    url = make_url(settings_for(given).database_url)
    assert url.drivername == "postgresql+psycopg"
    expected = ("db.example.com", 5432, "marec", "user")
    assert (url.host, url.port, url.database, url.username) == expected


def test_password_and_query_string_survive_the_rewrite():
    given = "postgres://user:p%40ss@db.example.com/marec?sslmode=require"
    url = make_url(settings_for(given).database_url)
    assert url.password == "p@ss"
    assert dict(url.query) == {"sslmode": "require"}


def test_the_rewritten_url_builds_an_engine_with_the_installed_driver():
    engine = create_engine(settings_for("postgres://user:pw@db.example.com/marec").database_url)
    assert engine.dialect.driver == "psycopg"


def test_other_urls_are_left_alone():
    assert settings_for("sqlite:///./local.db").database_url == "sqlite:///./local.db"
