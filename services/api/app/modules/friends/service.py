import secrets
import uuid

from sqlalchemy import func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.db import utcnow
from app.core.errors import ApiError
from app.modules.auth.models import User
from app.modules.friends import schemas
from app.modules.friends.models import FriendCode, Friendship, FriendshipStatus

# No 0/O, 1/I/L: codes are read aloud and typed on phones.
CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
CODE_LENGTH = 8
MAX_FRIENDS = 200
MAX_PENDING_OUTGOING = 50

PENDING = FriendshipStatus.PENDING.value
ACCEPTED = FriendshipStatus.ACCEPTED.value
DECLINED = FriendshipStatus.DECLINED.value


# ------------------------------------------------------------------ friend codes
def show_code(code: str) -> str:
    return f"{code[:4]}-{code[4:]}"


def normalize_code(raw: str) -> str:
    code = "".join(ch for ch in raw.upper() if ch not in " -")
    if len(code) != CODE_LENGTH or any(ch not in CODE_ALPHABET for ch in code):
        raise ApiError(
            400, "INVALID_FRIEND_CODE", "That is not a friend code. It looks like ABCD-2345."
        )
    return code


def _new_code() -> str:
    return "".join(secrets.choice(CODE_ALPHABET) for _ in range(CODE_LENGTH))


def _save_code(db: Session, user_id: uuid.UUID, replace: bool) -> str:
    for _ in range(5):  # a clash with someone else's code is very unlikely; just pick again
        row = db.scalar(select(FriendCode).where(FriendCode.user_id == user_id))
        code = _new_code()
        if row is None:
            db.add(FriendCode(id=uuid.uuid4(), user_id=user_id, code=code))
        elif replace:
            row.code = code
            row.created_at = utcnow()
        else:
            return row.code
        try:
            db.commit()
            return code
        except IntegrityError:
            db.rollback()
    raise ApiError(503, "TRY_AGAIN", "Could not make a friend code. Please try again.")


def get_code(db: Session, user_id: uuid.UUID) -> str:
    """The player's code, made the first time it is asked for."""
    return show_code(_save_code(db, user_id, replace=False))


def reset_code(db: Session, user_id: uuid.UUID) -> str:
    """Gives the player a new code. The old one stops working at once."""
    return show_code(_save_code(db, user_id, replace=True))


# ------------------------------------------------------------------ helpers
def _pair(a: uuid.UUID, b: uuid.UUID) -> tuple[uuid.UUID, uuid.UUID]:
    return (a, b) if a.int < b.int else (b, a)


def _between(a: uuid.UUID, b: uuid.UUID):
    low, high = _pair(a, b)
    return (Friendship.user_low_id == low, Friendship.user_high_id == high)


def _mine(user_id: uuid.UUID):
    return or_(Friendship.user_low_id == user_id, Friendship.user_high_id == user_id)


def _other(row: Friendship, me: uuid.UUID) -> uuid.UUID:
    return row.user_high_id if row.user_low_id == me else row.user_low_id


def _count_friends(db: Session, user_id: uuid.UUID) -> int:
    stmt = select(func.count(Friendship.id)).where(_mine(user_id), Friendship.status == ACCEPTED)
    return db.scalar(stmt) or 0


def _active_users(db: Session, ids: list[uuid.UUID]) -> dict[uuid.UUID, User]:
    if not ids:
        return {}
    rows = db.scalars(select(User).where(User.id.in_(ids), User.status == "active"))
    return {user.id: user for user in rows}


def _my_request(db: Session, me: uuid.UUID, request_id: uuid.UUID) -> Friendship:
    """A pending request that involves me. Anything else looks like it does not exist."""
    row = db.get(Friendship, request_id)
    if row is None or row.status != PENDING or me not in (row.user_low_id, row.user_high_id):
        raise ApiError(404, "REQUEST_NOT_FOUND", "Friend request not found.")
    return row


# ------------------------------------------------------------------ lists
def list_friends(db: Session, me: uuid.UUID) -> schemas.FriendList:
    rows = db.scalars(select(Friendship).where(_mine(me), Friendship.status == ACCEPTED)).all()
    people = _active_users(db, [_other(row, me) for row in rows])
    items = [
        schemas.FriendOut(
            user_id=_other(row, me),
            display_name=people[_other(row, me)].display_name,
            since=row.responded_at,
        )
        for row in rows
        if _other(row, me) in people
    ]
    items.sort(key=lambda f: (f.display_name.lower(), str(f.user_id)))
    return schemas.FriendList(items=items, total=len(items))


def list_requests(db: Session, me: uuid.UUID) -> schemas.RequestLists:
    rows = db.scalars(
        select(Friendship).where(_mine(me), Friendship.status == PENDING).order_by(
            Friendship.created_at.desc(), Friendship.id
        )
    ).all()
    people = _active_users(db, [_other(row, me) for row in rows])
    incoming: list[schemas.RequestOut] = []
    outgoing: list[schemas.RequestOut] = []
    for row in rows:
        other = _other(row, me)
        if other not in people:
            continue
        entry = schemas.RequestOut(
            id=row.id,
            user_id=other,
            display_name=people[other].display_name,
            created_at=row.created_at,
        )
        (outgoing if row.requested_by == me else incoming).append(entry)
    return schemas.RequestLists(incoming=incoming, outgoing=outgoing)


# ------------------------------------------------------------------ sending and answering
def _accept(db: Session, row: Friendship) -> None:
    for user_id in (row.user_low_id, row.user_high_id):
        if _count_friends(db, user_id) >= MAX_FRIENDS:
            raise ApiError(
                409, "FRIEND_LIMIT_REACHED", f"A friends list holds up to {MAX_FRIENDS} people."
            )
    row.status = ACCEPTED
    row.responded_at = utcnow()


def send_request(
    db: Session, me: uuid.UUID, raw_code: str, _retry: bool = True
) -> tuple[Friendship, User]:
    """Sends a friend request by code. If the other player had already asked me, the two
    requests meet and we become friends straight away."""
    code = normalize_code(raw_code)
    owner = db.scalar(select(FriendCode.user_id).where(FriendCode.code == code))
    other = db.get(User, owner) if owner is not None else None
    if other is None or other.status != "active":
        raise ApiError(404, "FRIEND_CODE_NOT_FOUND", "No player has that friend code.")
    if other.id == me:
        raise ApiError(400, "CANNOT_ADD_SELF", "That is your own friend code.")

    row = db.scalar(select(Friendship).where(*_between(me, other.id)))
    if row is not None:
        if row.status == ACCEPTED:
            raise ApiError(409, "ALREADY_FRIENDS", "You are already friends.")
        if row.status == PENDING:
            if row.requested_by == me:
                raise ApiError(
                    409, "REQUEST_ALREADY_SENT", "You already sent this player a request."
                )
            _accept(db, row)  # they asked me first: the requests meet
        elif row.requested_by == me:
            raise ApiError(
                409, "REQUEST_DECLINED", "This player did not accept your earlier request."
            )
        else:  # I declined them before; if I now ask them myself, that starts a fresh request
            _check_outgoing_room(db, me)
            row.requested_by = me
            row.status = PENDING
            row.responded_at = None
            row.created_at = utcnow()
    else:
        _check_outgoing_room(db, me)
        low, high = _pair(me, other.id)
        row = Friendship(
            id=uuid.uuid4(), user_low_id=low, user_high_id=high, requested_by=me, status=PENDING
        )
        db.add(row)
    try:
        db.commit()
    except IntegrityError:  # both players asked at the same moment: look again once
        db.rollback()
        if _retry:
            return send_request(db, me, raw_code, _retry=False)
        raise ApiError(
            409, "REQUEST_ALREADY_SENT", "You already sent this player a request."
        ) from None
    return row, other


def _check_outgoing_room(db: Session, me: uuid.UUID) -> None:
    waiting = db.scalar(
        select(func.count(Friendship.id)).where(
            Friendship.requested_by == me, Friendship.status == PENDING
        )
    )
    if (waiting or 0) >= MAX_PENDING_OUTGOING:
        raise ApiError(
            409,
            "FRIEND_REQUEST_LIMIT",
            f"You have {MAX_PENDING_OUTGOING} requests waiting. Cancel some before sending more.",
        )


def accept_request(db: Session, me: uuid.UUID, request_id: uuid.UUID) -> schemas.FriendOut:
    row = _my_request(db, me, request_id)
    if row.requested_by == me:  # you cannot accept your own request
        raise ApiError(404, "REQUEST_NOT_FOUND", "Friend request not found.")
    other = _active_users(db, [_other(row, me)]).get(_other(row, me))
    if other is None:
        raise ApiError(404, "REQUEST_NOT_FOUND", "Friend request not found.")
    _accept(db, row)
    db.commit()
    return schemas.FriendOut(
        user_id=other.id, display_name=other.display_name, since=row.responded_at
    )


def decline_request(db: Session, me: uuid.UUID, request_id: uuid.UUID) -> None:
    row = _my_request(db, me, request_id)
    if row.requested_by == me:
        raise ApiError(404, "REQUEST_NOT_FOUND", "Friend request not found.")
    row.status = DECLINED
    row.responded_at = utcnow()
    db.commit()


def cancel_request(db: Session, me: uuid.UUID, request_id: uuid.UUID) -> None:
    row = _my_request(db, me, request_id)
    if row.requested_by != me:  # only the sender can take a request back
        raise ApiError(404, "REQUEST_NOT_FOUND", "Friend request not found.")
    db.delete(row)
    db.commit()


def remove_friend(db: Session, me: uuid.UUID, other_id: uuid.UUID) -> None:
    row = db.scalar(
        select(Friendship).where(*_between(me, other_id), Friendship.status == ACCEPTED)
    )
    if row is None:
        raise ApiError(404, "NOT_FRIENDS", "You are not friends with this player.")
    db.delete(row)
    db.commit()
