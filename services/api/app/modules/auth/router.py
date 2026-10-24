import uuid

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.modules.auth import service
from app.modules.auth.deps import AuthContext, get_auth_context
from app.modules.auth.models import User
from app.modules.auth.schemas import (
    LoginRequest,
    RefreshRequest,
    RegisterRequest,
    SessionOut,
    TokenResponse,
    UserOut,
)

router = APIRouter(tags=["auth"])


def _to_user_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        email_verified=user.email_verified_at is not None,
        status=user.status,
        created_at=user.created_at,
    )


def _to_token_response(tokens: service.TokenPair) -> TokenResponse:
    return TokenResponse(
        access_token=tokens.access_token,
        refresh_token=tokens.refresh_token,
        expires_in=tokens.expires_in,
    )


@router.post("/auth/register", status_code=201, response_model=UserOut)
def register(body: RegisterRequest, db: Session = Depends(get_db)) -> UserOut:
    user = service.register_user(db, body.email, body.password, body.display_name)
    return _to_user_out(user)


@router.post("/auth/login", response_model=TokenResponse)
def login(body: LoginRequest, request: Request, db: Session = Depends(get_db)) -> TokenResponse:
    ip = request.client.host if request.client else None
    tokens = service.login(db, body.email, body.password, ip, request.headers.get("user-agent"))
    return _to_token_response(tokens)


@router.post("/auth/refresh", response_model=TokenResponse)
def refresh(body: RefreshRequest, db: Session = Depends(get_db)) -> TokenResponse:
    return _to_token_response(service.refresh_session(db, body.refresh_token))


@router.post("/auth/logout", status_code=204)
def logout(
    ctx: AuthContext = Depends(get_auth_context), db: Session = Depends(get_db)
) -> Response:
    service.revoke_session(db, ctx.user.id, ctx.session.id)
    return Response(status_code=204)


@router.get("/me", response_model=UserOut)
def me(ctx: AuthContext = Depends(get_auth_context)) -> UserOut:
    return _to_user_out(ctx.user)


@router.get("/me/sessions", response_model=list[SessionOut])
def my_sessions(
    ctx: AuthContext = Depends(get_auth_context), db: Session = Depends(get_db)
) -> list[SessionOut]:
    sessions = service.list_active_sessions(db, ctx.user.id)
    return [
        SessionOut(
            id=s.id,
            created_at=s.created_at,
            last_seen_at=s.last_seen_at,
            user_agent=s.user_agent,
            current=s.id == ctx.session.id,
        )
        for s in sessions
    ]


@router.delete("/me/sessions/{session_id}", status_code=204)
def revoke_my_session(
    session_id: uuid.UUID,
    ctx: AuthContext = Depends(get_auth_context),
    db: Session = Depends(get_db),
) -> Response:
    service.revoke_session(db, ctx.user.id, session_id)
    return Response(status_code=204)
