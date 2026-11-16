import base64
import hashlib
import os
from functools import lru_cache

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey

from app.core.config import get_settings


class Signer:
    """Signs build manifests with Ed25519. Launchers and games hold only the public key."""

    def __init__(self, seed: bytes) -> None:
        self._key = Ed25519PrivateKey.from_private_bytes(seed)
        self.public_bytes = self._key.public_key().public_bytes(
            serialization.Encoding.Raw, serialization.PublicFormat.Raw
        )
        self.kid = hashlib.sha256(self.public_bytes).hexdigest()[:16]

    @property
    def public_key_b64(self) -> str:
        return base64.b64encode(self.public_bytes).decode("ascii")

    def sign(self, data: bytes) -> str:
        return base64.b64encode(self._key.sign(data)).decode("ascii")


def new_seed_b64() -> str:
    return base64.b64encode(os.urandom(32)).decode("ascii")


@lru_cache
def get_signer() -> Signer:
    key = get_settings().manifest_signing_key
    # Without a configured key (local and test only; Settings requires one elsewhere) an
    # ephemeral key is used, so manifests signed before a restart will not verify afterwards.
    seed = base64.b64decode(key.get_secret_value()) if key else os.urandom(32)
    return Signer(seed)
