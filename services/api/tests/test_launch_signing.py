import base64
import os
from datetime import datetime, timedelta, timezone

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ed25519, rsa

from app.core.launch_signing import LaunchSigner, get_launch_signer, new_private_key_b64


def claims(**changes):
    now = datetime.now(timezone.utc)
    base = {
        "jti": "11111111-1111-1111-1111-111111111111",
        "aud": "game",
        "sub": "user",
        "iat": now,
        "exp": now + timedelta(minutes=2),
    }
    return {**base, **changes}


def make_signer():
    return LaunchSigner(base64.b64decode(new_private_key_b64()))


def test_tokens_are_rs256_jwts_that_verify_with_the_public_pem():
    signer = make_signer()
    token = signer.issue(claims())
    header = jwt.get_unverified_header(token)
    assert header["alg"] == "RS256"
    assert header["kid"] == signer.kid
    assert len(signer.kid) == 16
    assert signer.verify(token)["aud"] == "game"
    # What the game's SDK will do: verify with only the published public key.
    decoded = jwt.decode(
        token, signer.public_pem, algorithms=["RS256"], options={"verify_aud": False}
    )
    assert decoded["sub"] == "user"


def test_tampered_and_expired_tokens_fail():
    signer = make_signer()
    token = signer.issue(claims())
    head, body, signature = token.split(".")
    flipped = body[:-1] + ("A" if body[-1] != "A" else "B")
    with pytest.raises(jwt.PyJWTError):
        signer.verify(f"{head}.{flipped}.{signature}")

    past = datetime.now(timezone.utc) - timedelta(minutes=10)
    expired = signer.issue(claims(iat=past, exp=past + timedelta(minutes=2)))
    with pytest.raises(jwt.ExpiredSignatureError):
        signer.verify(expired)


def test_another_signer_cannot_forge_tokens():
    forged = make_signer().issue(claims())
    with pytest.raises(jwt.PyJWTError):
        make_signer().verify(forged)


def test_weak_or_wrong_keys_are_rejected():
    ed_pem = ed25519.Ed25519PrivateKey.generate().private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    with pytest.raises(ValueError):
        LaunchSigner(ed_pem)
    small = rsa.generate_private_key(public_exponent=65537, key_size=1024).private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    with pytest.raises(ValueError):
        LaunchSigner(small)


def test_app_signer_uses_the_configured_key():
    configured = LaunchSigner(base64.b64decode(os.environ["LAUNCH_SIGNING_KEY"]))
    assert get_launch_signer().kid == configured.kid
