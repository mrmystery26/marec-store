import re

from fastapi import APIRouter, Depends, Request, Response
from fastapi.responses import StreamingResponse

from app.core.config import get_settings
from app.core.errors import ApiError
from app.core.launch_signing import get_launch_signer
from app.core.signing import get_signer
from app.core.storage import LocalStorage, get_storage
from app.modules.builds import schemas

router = APIRouter(tags=["storage"])

_RANGE = re.compile(r"^bytes=(\d*)-(\d*)$")


def _local_only(storage) -> LocalStorage:
    if not isinstance(storage, LocalStorage) or get_settings().environment == "production":
        raise ApiError(404, "NOT_FOUND", "Not found.")
    return storage


def parse_range(header: str, size: int) -> tuple[int, int] | None:
    """Returns (start, end) inclusive for a single byte range, None if the header should be
    ignored, and raises 416 for a range outside the file."""
    match = _RANGE.match(header.strip())
    if match is None or (match.group(1) == "" and match.group(2) == ""):
        return None
    unsatisfiable = ApiError(
        416,
        "RANGE_NOT_SATISFIABLE",
        "The requested range is outside the file.",
        headers={"Content-Range": f"bytes */{size}"},
    )
    first, last = match.group(1), match.group(2)
    if first == "":  # suffix range: the last N bytes
        count = int(last)
        if count == 0:
            raise unsatisfiable
        return max(size - count, 0), size - 1
    start = int(first)
    end = int(last) if last else size - 1
    if start >= size or start > end:
        raise unsatisfiable
    return start, min(end, size - 1)


@router.put("/dev-storage/{token}", status_code=204)
async def local_upload(token: str, request: Request, storage=Depends(get_storage)) -> Response:
    """Receives uploads when STORAGE_BACKEND=local. Not available in production."""
    local = _local_only(storage)
    claims = local.verify_token(token, "put")
    await local.write_stream(claims["key"], request.stream(), claims["max_size"])
    return Response(status_code=204)


@router.get("/dev-storage/{token}")
def local_download(token: str, request: Request, storage=Depends(get_storage)) -> Response:
    """Serves downloads (with Range support, like R2) when STORAGE_BACKEND=local."""
    local = _local_only(storage)
    key = local.verify_token(token, "get")["key"]
    size = local.head(key)
    if size is None:
        raise ApiError(404, "NOT_FOUND", "Not found.")
    if size == 0:
        return Response(content=b"", media_type="application/octet-stream")

    start, end, partial = 0, size - 1, False
    header = request.headers.get("range")
    if header:
        parsed = parse_range(header, size)
        if parsed is not None:
            (start, end), partial = parsed, True
    headers = {"Accept-Ranges": "bytes", "Content-Length": str(end - start + 1)}
    if partial:
        headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return StreamingResponse(
        local.iter_range(key, start, end),
        status_code=206 if partial else 200,
        media_type="application/octet-stream",
        headers=headers,
    )


@router.get("/launch/public-keys", response_model=schemas.PublicKeys)
def public_keys() -> schemas.PublicKeys:
    """Public keys that launchers and games use to verify signed manifests."""
    manifest, launch = get_signer(), get_launch_signer()
    return schemas.PublicKeys(
        keys=[
            schemas.PublicKeyOut(
                kid=manifest.kid, alg="EdDSA", use="manifest", public_key=manifest.public_key_b64
            ),
            schemas.PublicKeyOut(
                kid=launch.kid, alg="RS256", use="launch", public_key=launch.public_pem
            ),
        ]
    )
