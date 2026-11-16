import hashlib
from collections.abc import Iterable

CHUNK_SIZE = 8 * 1024 * 1024  # launcher downloads and verifies in chunks of this size


def hash_stream(
    blocks: Iterable[bytes], chunk_size: int = CHUNK_SIZE
) -> tuple[int, str, list[str]]:
    """Returns (size, sha256 of the whole stream, sha256 of each chunk_size slice).
    Works however the stream is split into blocks."""
    whole = hashlib.sha256()
    chunk = hashlib.sha256()
    in_chunk = 0
    size = 0
    chunks: list[str] = []
    for block in blocks:
        view = memoryview(block)
        size += len(view)
        whole.update(view)
        while len(view):
            take = min(len(view), chunk_size - in_chunk)
            chunk.update(view[:take])
            in_chunk += take
            view = view[take:]
            if in_chunk == chunk_size:
                chunks.append(chunk.hexdigest())
                chunk = hashlib.sha256()
                in_chunk = 0
    if in_chunk:
        chunks.append(chunk.hexdigest())
    return size, whole.hexdigest(), chunks
