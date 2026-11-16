import base64
import hashlib
from functools import lru_cache

import jwt
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa

from app.core.config import get_settings

ISSUER = "marec-store-api"


class LaunchSigner:
    """Signs launch tokens and leases as RS256 JWTs. The game's SDK holds only the public key
    (from /v1/launch/public-keys) and checks the signature locally."""

    def __init__(self, private_pem: bytes) -> None:
        key = serialization.load_pem_private_key(private_pem, password=None)
        if not isinstance(key, rsa.RSAPrivateKey) or key.key_size < 2048:
            raise ValueError("The launch signing key must be an RSA key of at least 2048 bits.")
        self._key = key
        public = key.public_key()
        self.public_pem = public.public_bytes(
            serialization.Encoding.PEM, serialization.PublicFormat.SubjectPublicKeyInfo
        ).decode("ascii")
        der = public.public_bytes(
            serialization.Encoding.DER, serialization.PublicFormat.SubjectPublicKeyInfo
        )
        self.kid = hashlib.sha256(der).hexdigest()[:16]

    def issue(self, claims: dict) -> str:
        return jwt.encode(
            {"iss": ISSUER, **claims}, self._key, algorithm="RS256", headers={"kid": self.kid}
        )

    def verify(self, token: str) -> dict:
        """Raises jwt.PyJWTError if the signature, issuer or expiry is wrong."""
        return jwt.decode(
            token,
            self._key.public_key(),
            algorithms=["RS256"],
            issuer=ISSUER,
            options={"verify_aud": False, "require": ["exp", "iat", "jti", "aud", "sub"]},
        )


def new_private_key_b64() -> str:
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    pem = key.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    return base64.b64encode(pem).decode("ascii")


@lru_cache
def get_launch_signer() -> LaunchSigner:
    configured = get_settings().launch_signing_key
    # Without a configured key (local and test only; Settings requires one elsewhere) an
    # ephemeral key is used, so tokens signed before a restart will not verify afterwards.
    encoded = configured.get_secret_value() if configured else new_private_key_b64()
    return LaunchSigner(base64.b64decode(encoded))
