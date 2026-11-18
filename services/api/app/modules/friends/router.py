import uuid

from fastapi import APIRouter, Depends, Response
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.modules.auth.deps import AuthContext, get_auth_context
from app.modules.friends import schemas, service

router = APIRouter(prefix="/friends", tags=["friends"])


@router.get("", response_model=schemas.FriendList)
def my_friends(
    ctx: AuthContext = Depends(get_auth_context), db: Session = Depends(get_db)
) -> schemas.FriendList:
    return service.list_friends(db, ctx.user.id)


@router.get("/requests", response_model=schemas.RequestLists)
def my_requests(
    ctx: AuthContext = Depends(get_auth_context), db: Session = Depends(get_db)
) -> schemas.RequestLists:
    return service.list_requests(db, ctx.user.id)


@router.post("/requests", response_model=schemas.SendRequestOut, status_code=201)
def send_request(
    body: schemas.SendRequestIn,
    response: Response,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> schemas.SendRequestOut:
    """Asks the owner of a friend code to be friends. 201 for a new request, or 200 when they
    had already asked you and you are now friends."""
    row, other = service.send_request(db, ctx.user.id, body.friend_code)
    if row.status == service.ACCEPTED:
        response.status_code = 200
    return schemas.SendRequestOut(
        id=row.id, status=row.status, user_id=other.id, display_name=other.display_name
    )


@router.post("/requests/{request_id}/accept", response_model=schemas.FriendOut)
def accept_request(
    request_id: uuid.UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> schemas.FriendOut:
    return service.accept_request(db, ctx.user.id, request_id)


@router.post("/requests/{request_id}/decline", status_code=204)
def decline_request(
    request_id: uuid.UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> Response:
    service.decline_request(db, ctx.user.id, request_id)
    return Response(status_code=204)


@router.delete("/requests/{request_id}", status_code=204)
def cancel_request(
    request_id: uuid.UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> Response:
    """Takes back a request you sent."""
    service.cancel_request(db, ctx.user.id, request_id)
    return Response(status_code=204)


@router.get("/code", response_model=schemas.FriendCodeOut)
def my_code(
    ctx: AuthContext = Depends(get_auth_context), db: Session = Depends(get_db)
) -> schemas.FriendCodeOut:
    return schemas.FriendCodeOut(code=service.get_code(db, ctx.user.id))


@router.post("/code/reset", response_model=schemas.FriendCodeOut)
def reset_my_code(
    ctx: AuthContext = Depends(get_auth_context), db: Session = Depends(get_db)
) -> schemas.FriendCodeOut:
    """Makes a new code. The old one stops working immediately."""
    return schemas.FriendCodeOut(code=service.reset_code(db, ctx.user.id))


@router.delete("/{user_id}", status_code=204)
def remove_friend(
    user_id: uuid.UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> Response:
    service.remove_friend(db, ctx.user.id, user_id)
    return Response(status_code=204)
