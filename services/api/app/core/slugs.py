import re
import secrets

from sqlalchemy import select
from sqlalchemy.orm import Session

_NON_ALNUM = re.compile(r"[^a-z0-9]+")


def slugify(text: str, max_length: int = 60) -> str:
    slug = _NON_ALNUM.sub("-", text.lower()).strip("-")[:max_length].strip("-")
    return slug or "item"


def unique_slug(db: Session, model, text: str, max_length: int = 60) -> str:
    """URL-safe slug that is not used yet by `model.slug`. Appends -2, -3, ... when taken.
    A rare race between two requests is caught by the unique constraint."""
    base = slugify(text, max_length - 8)
    candidate = base
    for number in range(2, 50):
        if db.scalar(select(model.id).where(model.slug == candidate)) is None:
            return candidate
        candidate = f"{base}-{number}"
    return f"{base}-{secrets.token_hex(3)}"
