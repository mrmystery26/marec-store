import base64
import binascii
import hashlib
import hmac
import json
import os
import time
import uuid
from collections.abc import AsyncIterator, Iterator
from functools import lru_cache
from pathlib import Path

from app.core.config import get_settings
from app.core.errors import ApiError

BLOCK_SIZE = 1024 * 1024


class LocalStorage:
    """Files on local disk, with signed upload URLs served by this API. Development and tests
    only: the settings require the s3 backend in staging and production."""

    def __init__(self, root: Path, secret: bytes, public_base_url: str) -> None:
        self.root = Path(root).resolve()
        self.root.mkdir(parents=True, exist_ok=True)
        self._signing_key = hashlib.sha256(b"local-storage:" + secret).digest()
        self.public_base_url = public_base_url.rstrip("/")

    def _path(self, key: str) -> Path:
        path = (self.root / key).resolve()
        if self.root not in path.parents:
            raise ValueError("Invalid storage key.")
        return path

    def _link(self, key: str, operation: str, max_size: int, expires_s: int) -> str:
        payload = {"k": key, "o": operation, "m": max_size, "x": int(time.time()) + expires_s}
        raw = json.dumps(payload, separators=(",", ":")).encode("utf-8")
        body = base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")
        signature = hmac.new(self._signing_key, body.encode("ascii"), hashlib.sha256).hexdigest()
        return f"{self.public_base_url}/v1/dev-storage/{body}.{signature}"

    def presign_put(self, key: str, max_size: int, expires_s: int = 3600) -> str:
        return self._link(key, "put", max_size, expires_s)

    def presign_get(self, key: str, expires_s: int = 3600) -> str:
        return self._link(key, "get", 0, expires_s)

    def verify_token(self, token: str, operation: str) -> dict:
        """A link made for one operation (put or get) cannot be used for the other."""
        bad = ApiError(403, "INVALID_UPLOAD_URL", "This upload link is not valid.")
        try:
            body, signature = token.rsplit(".", 1)
            expected = hmac.new(
                self._signing_key, body.encode("ascii"), hashlib.sha256
            ).hexdigest()
            if not hmac.compare_digest(signature, expected):
                raise bad
            payload = json.loads(base64.urlsafe_b64decode(body + "=" * (-len(body) % 4)))
            expires, key, max_size = payload["x"], payload["k"], payload["m"]
            if payload["o"] != operation:
                raise bad
        except (ValueError, KeyError, TypeError, binascii.Error):
            raise bad from None
        if expires < time.time():
            raise ApiError(403, "UPLOAD_URL_EXPIRED", "This upload link has expired.")
        return {"key": key, "max_size": max_size}

    async def write_stream(self, key: str, stream: AsyncIterator[bytes], max_size: int) -> int:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        temp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.part")
        size = 0
        try:
            with open(temp, "wb") as handle:
                async for block in stream:
                    size += len(block)
                    if size > max_size:
                        raise ApiError(413, "UPLOAD_TOO_LARGE", "The file is larger than declared.")
                    handle.write(block)
            os.replace(temp, path)
        finally:
            if temp.exists():
                temp.unlink()
        return size

    def head(self, key: str) -> int | None:
        path = self._path(key)
        return path.stat().st_size if path.is_file() else None

    def iter_bytes(self, key: str, block_size: int = BLOCK_SIZE) -> Iterator[bytes]:
        with open(self._path(key), "rb") as handle:
            while block := handle.read(block_size):
                yield block

    def iter_range(
        self, key: str, start: int, end: int, block_size: int = BLOCK_SIZE
    ) -> Iterator[bytes]:
        """Bytes start..end inclusive."""
        remaining = end - start + 1
        with open(self._path(key), "rb") as handle:
            handle.seek(start)
            while remaining > 0:
                block = handle.read(min(block_size, remaining))
                if not block:
                    break
                remaining -= len(block)
                yield block

    def put_bytes(self, key: str, data: bytes) -> None:
        path = self._path(key)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)

    def delete(self, key: str) -> None:
        path = self._path(key)
        if path.is_file():
            path.unlink()


class S3Storage:
    """S3-compatible storage (Cloudflare R2). Not yet exercised against a real bucket.

    Presigned PUT URLs cannot cap the upload size, so sizes and hashes are verified when the
    developer finishes the upload."""

    def __init__(
        self,
        endpoint_url: str,
        bucket: str,
        access_key_id: str,
        secret_access_key: str,
        region: str = "auto",
    ) -> None:
        import boto3
        from botocore.config import Config

        self.bucket = bucket
        self._client = boto3.client(
            "s3",
            endpoint_url=endpoint_url,
            aws_access_key_id=access_key_id,
            aws_secret_access_key=secret_access_key,
            region_name=region,
            config=Config(signature_version="s3v4"),
        )

    def presign_put(self, key: str, max_size: int, expires_s: int = 3600) -> str:
        return self._client.generate_presigned_url(
            "put_object", Params={"Bucket": self.bucket, "Key": key}, ExpiresIn=expires_s
        )

    def presign_get(self, key: str, expires_s: int = 3600) -> str:
        return self._client.generate_presigned_url(
            "get_object", Params={"Bucket": self.bucket, "Key": key}, ExpiresIn=expires_s
        )

    def head(self, key: str) -> int | None:
        from botocore.exceptions import ClientError

        try:
            return self._client.head_object(Bucket=self.bucket, Key=key)["ContentLength"]
        except ClientError as error:
            if error.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                return None
            raise

    def iter_bytes(self, key: str, block_size: int = BLOCK_SIZE) -> Iterator[bytes]:
        body = self._client.get_object(Bucket=self.bucket, Key=key)["Body"]
        yield from body.iter_chunks(chunk_size=block_size)

    def put_bytes(self, key: str, data: bytes) -> None:
        self._client.put_object(Bucket=self.bucket, Key=key, Body=data)

    def delete(self, key: str) -> None:
        self._client.delete_object(Bucket=self.bucket, Key=key)


@lru_cache
def get_storage() -> LocalStorage | S3Storage:
    settings = get_settings()
    if settings.storage_backend == "s3":
        return S3Storage(
            settings.s3_endpoint_url,
            settings.s3_bucket,
            settings.s3_access_key_id,
            settings.s3_secret_access_key.get_secret_value(),
            settings.s3_region,
        )
    return LocalStorage(
        Path(settings.storage_local_dir),
        settings.jwt_secret.get_secret_value().encode("utf-8"),
        settings.public_api_base_url,
    )
