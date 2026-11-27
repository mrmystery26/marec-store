"""A pretend Google for tests. It signs real RS256 ID tokens with a throwaway key and answers the
token and key requests through httpx's MockTransport, so the production code that checks the
signature, audience, issuer and nonce is exercised for real."""

import time

import httpx
import jwt
from cryptography.hazmat.primitives.asymmetric import rsa

from app.core.config import get_settings
from app.core.google import GoogleClient

KID = "test-key-1"


class FakeGoogle(GoogleClient):
    def __init__(self) -> None:
        self.key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
        self.calls = 0
        self.token_status = 200
        # What the next ID token will say (tests change these).
        self.subject = "google-sub-1"
        self.email = "gina@gmail.com"
        self.email_verified = True
        self.name = "Gina Banda"
        self.audience = None  # None = the configured client id
        self.nonce = None  # None = the nonce the app sent
        self.issuer = "https://accounts.google.com"
        self.sign_with = None  # a different key, to simulate a forged token
        super().__init__(transport=httpx.MockTransport(self._handle))
        self._pending_nonce = None

    def authorization_url(self, state: str, nonce: str) -> str:
        self._pending_nonce = nonce
        return super().authorization_url(state, nonce)

    def exchange(self, code: str, nonce: str):
        self._pending_nonce = nonce
        return super().exchange(code, nonce)

    def _jwk(self) -> dict:
        jwk = jwt.algorithms.RSAAlgorithm.to_jwk(self.key.public_key(), as_dict=True)
        return {**jwk, "kid": KID, "alg": "RS256", "use": "sig"}

    def _id_token(self) -> str:
        now = int(time.time())
        claims = {
            "iss": self.issuer,
            "aud": self.audience or get_settings().google_client_id,
            "sub": self.subject,
            "email": self.email,
            "email_verified": self.email_verified,
            "name": self.name,
            "nonce": self.nonce or self._pending_nonce,
            "iat": now,
            "exp": now + 600,
        }
        return jwt.encode(
            claims, self.sign_with or self.key, algorithm="RS256", headers={"kid": KID}
        )

    def _handle(self, request: httpx.Request) -> httpx.Response:
        self.calls += 1
        if request.url.host == "oauth2.googleapis.com":
            if self.token_status != 200:
                return httpx.Response(self.token_status, json={"error": "invalid_grant"})
            return httpx.Response(200, json={"id_token": self._id_token()})
        if request.url.host == "www.googleapis.com":
            return httpx.Response(200, json={"keys": [self._jwk()]})
        return httpx.Response(404)
