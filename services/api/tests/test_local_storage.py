import pytest

from app.core.storage import get_storage


def token_of(url):
    return url.rsplit("/", 1)[1]


def test_signed_upload_round_trip(client, storage):
    url = storage.presign_put("things/one", 100)
    assert client.put(url, content=b"hello world").status_code == 204
    assert storage.head("things/one") == 11
    assert b"".join(storage.iter_bytes("things/one")) == b"hello world"
    assert storage.head("things/missing") is None


def test_uploads_can_be_overwritten(client, storage):
    url = storage.presign_put("things/two", 100)
    client.put(url, content=b"first")
    client.put(url, content=b"second!")
    assert b"".join(storage.iter_bytes("things/two")) == b"second!"


def test_tampered_or_garbage_tokens_are_refused(client, storage):
    token = token_of(storage.presign_put("things/three", 100))
    flipped = token[:-1] + ("0" if token[-1] != "0" else "1")
    for bad in (flipped, "garbage", "a.b", token.split(".")[0]):
        response = client.put(f"/v1/dev-storage/{bad}", content=b"x")
        assert response.status_code == 403
    assert storage.head("things/three") is None


def test_expired_links_are_refused(client, storage):
    url = storage.presign_put("things/four", 100, expires_s=-5)
    response = client.put(url, content=b"x")
    assert response.status_code == 403
    assert response.json()["error"]["code"] == "UPLOAD_URL_EXPIRED"


def test_oversized_uploads_are_refused_and_leave_nothing_behind(client, storage):
    url = storage.presign_put("things/five", 3)
    response = client.put(url, content=b"four")
    assert response.status_code == 413
    assert storage.head("things/five") is None


def test_storage_keys_cannot_escape_the_storage_folder(storage):
    for key in ("../outside", "a/../../outside", "/etc/passwd"):
        with pytest.raises(ValueError):
            storage.head(key)


def test_dev_storage_endpoints_are_off_for_other_backends(client):
    client.app.dependency_overrides[get_storage] = lambda: object()
    assert client.put("/v1/dev-storage/anything.anything", content=b"x").status_code == 404
    assert client.get("/v1/dev-storage/anything.anything").status_code == 404


def test_download_links_work_only_for_downloads(client, storage):
    storage.put_bytes("things/file", b"payload")
    get_url = storage.presign_get("things/file")
    put_url = storage.presign_put("things/file", 100)

    assert client.get(get_url).content == b"payload"
    assert client.get(put_url).status_code == 403  # an upload link cannot download
    assert client.put(get_url, content=b"evil").status_code == 403  # nor the reverse
    assert b"".join(storage.iter_bytes("things/file")) == b"payload"


def test_download_edge_cases(client, storage):
    storage.put_bytes("things/empty", b"")
    assert client.get(storage.presign_get("things/empty")).content == b""

    missing = client.get(storage.presign_get("things/missing"))
    assert missing.status_code == 404
    expired = client.get(storage.presign_get("things/empty", expires_s=-5))
    assert expired.status_code == 403
    token = token_of(storage.presign_get("things/empty"))
    assert client.get(f"/v1/dev-storage/{token[:-1]}x").status_code == 403


def test_public_keys_endpoint(client):
    response = client.get("/v1/launch/public-keys")
    assert response.status_code == 200
    key = response.json()["keys"][0]
    assert key["alg"] == "EdDSA"
    assert len(key["kid"]) == 16
