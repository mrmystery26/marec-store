import uuid

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.launch_signing import get_launch_signer
from app.modules.audit import service as audit
from app.modules.auth.deps import AuthContext, get_auth_context
from app.modules.launch import schemas, service

router = APIRouter(tags=["launch"])


@router.post("/launch/authorizations", response_model=schemas.TokenOut)
def create_authorization(
    body: schemas.LaunchRequest,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> schemas.TokenOut:
    return service.authorize(db, get_launch_signer(), ctx.user.id, body)


@router.post("/launch/leases", response_model=schemas.TokenOut)
def create_lease(
    body: schemas.LeaseRequest,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> schemas.TokenOut:
    return service.issue_lease(db, get_launch_signer(), ctx.user.id, body)


@router.post("/launch/dev-authorizations", response_model=schemas.TokenOut)
def create_dev_authorization(
    body: schemas.LaunchRequest,
    request: Request,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> schemas.TokenOut:
    return service.authorize_dev(
        db, get_launch_signer(), ctx.user.id, body, audit.context_from_request(request)
    )


@router.post("/launch/redeem", response_model=schemas.RedeemOut)
def redeem_token(body: schemas.RedeemRequest, db: Session = Depends(get_db)) -> schemas.RedeemOut:
    return service.redeem(db, get_launch_signer(), body)


@router.get("/me/devices", response_model=list[schemas.DeviceOut])
def my_devices(
    ctx: AuthContext = Depends(get_auth_context), db: Session = Depends(get_db)
) -> list[schemas.DeviceOut]:
    return [
        schemas.DeviceOut(
            id=d.id, label=d.label, first_seen_at=d.first_seen_at, last_seen_at=d.last_seen_at
        )
        for d in service.list_devices(db, ctx.user.id)
    ]


@router.delete("/me/devices/{device_id}", status_code=204)
def remove_device(
    device_id: uuid.UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> Response:
    service.revoke_device(db, ctx.user.id, device_id)
    return Response(status_code=204)
