import base64
import hashlib

import pytest
from cryptography.exceptions import InvalidSignature
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

from app.core.signing import Signer, get_signer, new_seed_b64
from app.core.storage import S3Storage
from app.modules.builds.hashing import hash_stream
from app.modules.builds.paths import validate_path


def sha(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


@pytest.mark.parametrize(
    "path",
    ["game.exe", "data/level1.pck", "Data/Textures/hero_01.png", "bin/x64/lib.dll", "a b/c.txt"],
)
def test_safe_paths_are_accepted(path):
    assert validate_path(path) is None


@pytest.mark.parametrize(
    "path",
    [
        "",
        "../evil.dll",
        "data/../../evil.dll",
        "/etc/passwd",
        "C:/Windows/x.dll",
        "a\\b.dll",
        "a//b.txt",
        "a/./b.txt",
        "CON",
        "data/nul.txt",
        "com1.dat",
        "ends.with.dot.",
        "dir /file.txt",
        "setup.bat",
        "tools/run.PS1",
        "installer.msi",
        "what?.png",
        "stream.txt:hidden",
        "tab\there.txt",
        "a" * 300,
    ],
)
def test_unsafe_paths_are_rejected(path):
    assert validate_path(path) is not None


def test_hash_stream_matches_slice_hashes_for_any_block_split():
    data = b"abcdefghij"
    expected = (10, sha(data), [sha(b"abcd"), sha(b"efgh"), sha(b"ij")])
    assert hash_stream([data], chunk_size=4) == expected
    assert hash_stream([b"abc", b"defgh", b"ij"], chunk_size=4) == expected
    assert hash_stream([bytes([b]) for b in data], chunk_size=4) == expected


def test_hash_stream_edge_cases():
    assert hash_stream([], chunk_size=4) == (0, sha(b""), [])
    assert hash_stream([b"abcdefgh"], chunk_size=4) == (
        8,
        sha(b"abcdefgh"),
        [sha(b"abcd"), sha(b"efgh")],
    )


def test_signer_signs_and_detects_tampering():
    signer = Signer(bytes(range(32)))
    assert len(signer.kid) == 16
    assert signer.kid == Signer(bytes(range(32))).kid
    public = Ed25519PublicKey.from_public_bytes(base64.b64decode(signer.public_key_b64))
    signature = base64.b64decode(signer.sign(b"manifest"))
    public.verify(signature, b"manifest")
    with pytest.raises(InvalidSignature):
        public.verify(signature, b"manifest!")


def test_new_seed_is_32_random_bytes():
    assert len(base64.b64decode(new_seed_b64())) == 32
    assert new_seed_b64() != new_seed_b64()


def test_app_signer_uses_the_configured_key():
    assert get_signer().kid == Signer(bytes(range(32))).kid


def test_s3_presigned_upload_url_is_signed():
    storage = S3Storage(
        "https://account.r2.cloudflarestorage.com", "builds", "AKIAEXAMPLE", "secret-example"
    )
    url = storage.presign_put("builds/game/file-1", 10, 600)
    assert url.startswith("https://")
    assert "builds/game/file-1" in url
    assert "X-Amz-Signature=" in url
    assert "r2.cloudflarestorage.com" in url
