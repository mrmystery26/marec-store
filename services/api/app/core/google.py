"""Talking to Google for "Sign in with Google" (OAuth 2.0 authorization code flow).

The server is the OAuth client (it holds the client secret). The app never sees Google's tokens:
it only gets a short-lived one-time ticket from this API afterwards.
"""

import time
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx
import jwt

from app.core.config import get_settings

AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
TOKEN_URL = "https://oauth2.googleapis.com/token"
JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs"
ISSUERS = ("https://accounts.google.com", "accounts.google.com")
JWKS_TTL_SECONDS = 3600


class GoogleError(Exception):
    """Google refused, was unreachable, or sent something that does not check out."""

    def __init__(self, code: str, message: str) -> None:
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class GoogleProfile:
    subject: str
    email: str
    email_verified: bool
    name: str | None


class GoogleClient:
    def __init__(self, transport: httpx.BaseTransport | None = None) -> None:
        self._transport = transport
        self._jwks: tuple[float, dict] | None = None

    def authorization_url(self, state: str, nonce: str) -> str:
        settings = get_settings()
        query = {
            "client_id": settings.google_client_id,
            "redirect_uri": settings.google_redirect_uri,
            "response_type": "code",
            "scope": "openid email profile",
            "state": state,
            "nonce": nonce,
            # Always show the account chooser, so a shared PC does not silently reuse an account.
            "prompt": "select_account",
        }
        return f"{AUTH_URL}?{urlencode(query)}"

    def exchange(self, code: str, nonce: str) -> GoogleProfile:
        settings = get_settings()
        try:
            with httpx.Client(timeout=10.0, transport=self._transport) as client:
                response = client.post(
                    TOKEN_URL,
                    data={
                        "code": code,
                        "client_id": settings.google_client_id,
                        "client_secret": settings.google_client_secret.get_secret_value(),
                        "redirect_uri": settings.google_redirect_uri,
                        "grant_type": "authorization_code",
                    },
                )
                if response.status_code != 200:
                    raise GoogleError("GOOGLE_REJECTED", "Google did not accept the sign-in.")
                id_token = response.json().get("id_token")
                if not isinstance(id_token, str):
                    raise GoogleError("GOOGLE_BAD_RESPONSE", "Google sent an unexpected answer.")
                key = self._signing_key(client, id_token)
        except httpx.HTTPError:
            raise GoogleError("GOOGLE_UNREACHABLE", "Could not reach Google. Try again.") from None
        return self._verify(id_token, key, nonce)

    def _signing_key(self, client: httpx.Client, id_token: str):
        try:
            kid = jwt.get_unverified_header(id_token).get("kid")
        except jwt.PyJWTError:
            raise GoogleError(
                "GOOGLE_BAD_TOKEN", "Google sent a token that cannot be read."
            ) from None
        for refresh in (False, True):
            keys = self._key_set(client, force=refresh)
            for jwk in keys.get("keys", []):
                if jwk.get("kid") == kid:
                    return jwt.PyJWK.from_dict(jwk).key
        raise GoogleError("GOOGLE_BAD_TOKEN", "Google signed the token with an unknown key.")

    def _key_set(self, client: httpx.Client, force: bool) -> dict:
        now = time.monotonic()
        if not force and self._jwks and now - self._jwks[0] < JWKS_TTL_SECONDS:
            return self._jwks[1]
        response = client.get(JWKS_URL)
        if response.status_code != 200:
            raise GoogleError("GOOGLE_UNREACHABLE", "Could not reach Google. Try again.")
        self._jwks = (now, response.json())
        return self._jwks[1]

    @staticmethod
    def _verify(id_token: str, key, nonce: str) -> GoogleProfile:
        settings = get_settings()
        try:
            claims = jwt.decode(
                id_token,
                key,
                algorithms=["RS256"],
                audience=settings.google_client_id,
                issuer=list(ISSUERS),
                options={"require": ["exp", "iat", "sub", "aud", "iss"]},
            )
        except jwt.PyJWTError:
            raise GoogleError(
                "GOOGLE_BAD_TOKEN", "Google's sign-in could not be verified."
            ) from None
        if claims.get("nonce") != nonce:
            raise GoogleError("GOOGLE_BAD_TOKEN", "Google's sign-in could not be verified.")
        email = claims.get("email")
        if not isinstance(email, str) or not email:
            raise GoogleError("GOOGLE_NO_EMAIL", "Google did not share an email address.")
        verified = claims.get("email_verified")
        return GoogleProfile(
            subject=str(claims["sub"]),
            email=email,
            email_verified=verified is True or verified == "true",
            name=claims.get("name") if isinstance(claims.get("name"), str) else None,
        )


_client: GoogleClient | None = None


def get_google_client() -> GoogleClient:
    global _client
    if _client is None:
        _client = GoogleClient()
    return _client
