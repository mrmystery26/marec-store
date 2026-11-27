"""Helpers that drive a complete "Sign in with Google" round trip in tests."""

import base64
import hashlib
import re
import secrets
from urllib.parse import parse_qs, urlparse


def new_pkce():
    verifier = secrets.token_urlsafe(48)
    digest = hashlib.sha256(verifier.encode("ascii")).digest()
    return verifier, base64.urlsafe_b64encode(digest).rstrip(b"=").decode("ascii")


def sign_in(client):
    """Runs start, callback and exchange. Returns the exchange response (the tokens)."""
    verifier, challenge = new_pkce()
    started = client.post("/v1/auth/google/start", json={"code_challenge": challenge})
    assert started.status_code == 200, started.text
    state = parse_qs(urlparse(started.json()["auth_url"]).query)["state"][0]
    page = client.get("/v1/auth/google/callback", params={"code": "auth-code", "state": state})
    found = re.search(r"marecstore://auth\?ticket=([A-Za-z0-9_-]+)", page.text)
    assert found, page.text
    return client.post(
        "/v1/auth/google/exchange", json={"ticket": found.group(1), "code_verifier": verifier}
    )
