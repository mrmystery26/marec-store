def test_health_ok(client):
    response = client.get("/v1/health")
    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    assert response.headers["X-Request-ID"]
    assert response.headers["X-Content-Type-Options"] == "nosniff"


def test_health_db_ok(client):
    response = client.get("/v1/health/db")
    assert response.status_code == 200
    assert response.json() == {"database": "ok"}


def test_request_id_is_echoed_when_valid(client):
    response = client.get("/v1/health", headers={"X-Request-ID": "abc12345-test"})
    assert response.headers["X-Request-ID"] == "abc12345-test"


def test_invalid_request_id_is_replaced(client):
    response = client.get("/v1/health", headers={"X-Request-ID": "bad id!"})
    assert response.headers["X-Request-ID"] != "bad id!"


def test_unknown_route_uses_error_format(client):
    response = client.get("/v1/does-not-exist")
    assert response.status_code == 404
    body = response.json()["error"]
    assert body["code"] == "NOT_FOUND"
    assert body["request_id"]
