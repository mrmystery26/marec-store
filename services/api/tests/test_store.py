from tests.helpers import create_account, make_category, make_game, make_studio


def seed(client, db_session):
    owner, _ = create_account(client, db_session, "owner@example.com")
    studio = make_studio(db_session, owner, "Lake Studio")
    adventure = make_category(db_session, "Adventure", 1)
    racing = make_category(db_session, "Racing", 2)
    puzzle = make_category(db_session, "Puzzle", 3)
    make_game(db_session, studio, "Chimwemwe Quest", "published", 500000, adventure, 30)
    make_game(db_session, studio, "Lake Racer", "published", 0, racing, 20)
    make_game(db_session, studio, "Zomba Puzzle", "published", 150000, puzzle, 10)
    make_game(db_session, studio, "Secret Draft", "draft", 100, puzzle)
    pending = make_studio(db_session, owner, "Pending Studio", status="pending")
    make_game(db_session, pending, "Hidden Gem", "published", 100, puzzle)


def titles(response):
    assert response.status_code == 200
    return [item["title"] for item in response.json()["items"]]


def test_only_published_games_from_verified_studios_are_listed(client, db_session):
    seed(client, db_session)
    response = client.get("/v1/games")
    assert titles(response) == ["Zomba Puzzle", "Lake Racer", "Chimwemwe Quest"]
    assert response.json()["total"] == 3


def test_search_and_category_filters(client, db_session):
    seed(client, db_session)
    assert titles(client.get("/v1/games", params={"q": "lake"})) == ["Lake Racer"]
    assert titles(client.get("/v1/games", params={"q": "%"})) == []
    assert titles(client.get("/v1/games", params={"category": "puzzle"})) == ["Zomba Puzzle"]
    assert titles(client.get("/v1/games", params={"category": "nope"})) == []


def test_price_filters(client, db_session):
    seed(client, db_session)
    assert titles(client.get("/v1/games", params={"free": "true"})) == ["Lake Racer"]
    assert len(titles(client.get("/v1/games", params={"free": "false"}))) == 2
    assert titles(client.get("/v1/games", params={"min_price_minor": 200000})) == [
        "Chimwemwe Quest"
    ]
    cheap = titles(client.get("/v1/games", params={"max_price_minor": 150000, "sort": "title"}))
    assert cheap == ["Lake Racer", "Zomba Puzzle"]


def test_sorting_and_pagination(client, db_session):
    seed(client, db_session)
    asc = titles(client.get("/v1/games", params={"sort": "price_asc"}))
    assert asc == ["Lake Racer", "Zomba Puzzle", "Chimwemwe Quest"]
    desc = titles(client.get("/v1/games", params={"sort": "price_desc"}))
    assert desc == ["Chimwemwe Quest", "Zomba Puzzle", "Lake Racer"]
    by_title = titles(client.get("/v1/games", params={"sort": "title"}))
    assert by_title == ["Chimwemwe Quest", "Lake Racer", "Zomba Puzzle"]

    page = client.get("/v1/games", params={"sort": "title", "limit": 1, "offset": 1})
    assert titles(page) == ["Lake Racer"]
    assert page.json()["total"] == 3


def test_invalid_listing_parameters_are_rejected(client, db_session):
    seed(client, db_session)
    assert client.get("/v1/games", params={"sort": "random"}).status_code == 422
    assert client.get("/v1/games", params={"limit": 100}).status_code == 422


def test_game_detail_and_hidden_games(client, db_session):
    seed(client, db_session)
    detail = client.get("/v1/games/lake-racer")
    assert detail.status_code == 200
    body = detail.json()
    assert body["is_free"] is True
    assert body["studio"]["slug"] == "lake-studio"
    assert [c["slug"] for c in body["categories"]] == ["racing"]
    assert len(body["requirements"]) == 1
    assert body["description"]

    assert client.get("/v1/games/secret-draft").status_code == 404
    assert client.get("/v1/games/hidden-gem").status_code == 404
    assert client.get("/v1/games/no-such-game").status_code == 404


def test_categories_are_ordered(client, db_session):
    seed(client, db_session)
    response = client.get("/v1/categories")
    assert [c["name"] for c in response.json()] == ["Adventure", "Racing", "Puzzle"]
