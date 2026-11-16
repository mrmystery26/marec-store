import uuid

from fastapi import APIRouter, Depends, Query, Request
from sqlalchemy import update
from sqlalchemy.orm import Session

from app.core.db import get_db, utcnow
from app.core.errors import ApiError
from app.modules.admin.schemas import (
    AdminUserOut,
    AuditLogOut,
    AuditLogPage,
    ReasonBody,
    RolesOut,
)
from app.modules.audit import service as audit
from app.modules.auth.models import User, UserSession
from app.modules.rbac import service as rbac
from app.modules.rbac.deps import StaffContext, require_permission
from app.modules.rbac.permissions import Permission, Role

router = APIRouter(prefix="/admin", tags=["admin"])

users_read = require_permission(Permission.USERS_READ)
users_suspend = require_permission(Permission.USERS_SUSPEND)
roles_manage = require_permission(Permission.ROLES_MANAGE)
audit_read = require_permission(Permission.AUDIT_READ)


def _get_user_or_404(db: Session, user_id: uuid.UUID) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise ApiError(404, "USER_NOT_FOUND", "User not found.")
    return user


def _to_admin_user(db: Session, user: User) -> AdminUserOut:
    return AdminUserOut(
        id=user.id,
        email=user.email,
        display_name=user.display_name,
        email_verified=user.email_verified_at is not None,
        status=user.status,
        created_at=user.created_at,
        roles=[role.value for role in rbac.get_roles(db, user.id)],
    )


@router.get("/users/{user_id}", response_model=AdminUserOut)
def get_user(
    user_id: uuid.UUID,
    staff: StaffContext = Depends(users_read),
    db: Session = Depends(get_db),
) -> AdminUserOut:
    return _to_admin_user(db, _get_user_or_404(db, user_id))


@router.post("/users/{user_id}/suspend", response_model=AdminUserOut)
def suspend_user(
    user_id: uuid.UUID,
    body: ReasonBody,
    request: Request,
    staff: StaffContext = Depends(users_suspend),
    db: Session = Depends(get_db),
) -> AdminUserOut:
    user = _get_user_or_404(db, user_id)
    if user.id == staff.user.id:
        raise ApiError(409, "CANNOT_MODIFY_SELF", "You cannot suspend your own account.")
    if user.status != "active":
        raise ApiError(409, "INVALID_STATE", "Only active accounts can be suspended.")

    user.status = "suspended"
    db.execute(
        update(UserSession)
        .where(UserSession.user_id == user.id, UserSession.revoked_at.is_(None))
        .values(revoked_at=utcnow())
    )
    audit.record(
        db,
        action="user.suspended",
        entity_type="user",
        entity_id=str(user.id),
        actor_user_id=staff.user.id,
        actor_roles=staff.roles_label,
        before={"status": "active"},
        after={"status": "suspended"},
        reason=body.reason,
        **audit.context_from_request(request),
    )
    db.commit()
    return _to_admin_user(db, user)


@router.post("/users/{user_id}/reinstate", response_model=AdminUserOut)
def reinstate_user(
    user_id: uuid.UUID,
    body: ReasonBody,
    request: Request,
    staff: StaffContext = Depends(users_suspend),
    db: Session = Depends(get_db),
) -> AdminUserOut:
    user = _get_user_or_404(db, user_id)
    if user.status != "suspended":
        raise ApiError(409, "INVALID_STATE", "Only suspended accounts can be reinstated.")

    user.status = "active"
    audit.record(
        db,
        action="user.reinstated",
        entity_type="user",
        entity_id=str(user.id),
        actor_user_id=staff.user.id,
        actor_roles=staff.roles_label,
        before={"status": "suspended"},
        after={"status": "active"},
        reason=body.reason,
        **audit.context_from_request(request),
    )
    db.commit()
    return _to_admin_user(db, user)


@router.put("/users/{user_id}/roles/{role}", response_model=RolesOut)
def grant_role(
    user_id: uuid.UUID,
    role: Role,
    request: Request,
    staff: StaffContext = Depends(roles_manage),
    db: Session = Depends(get_db),
) -> RolesOut:
    user = _get_user_or_404(db, user_id)
    if rbac.grant_role(db, user.id, role, granted_by=staff.user.id):
        audit.record(
            db,
            action="role.granted",
            entity_type="user",
            entity_id=str(user.id),
            actor_user_id=staff.user.id,
            actor_roles=staff.roles_label,
            after={"role": role.value},
            **audit.context_from_request(request),
        )
    db.commit()
    return RolesOut(roles=[r.value for r in rbac.get_roles(db, user.id)])


@router.delete("/users/{user_id}/roles/{role}", response_model=RolesOut)
def revoke_role(
    user_id: uuid.UUID,
    role: Role,
    request: Request,
    staff: StaffContext = Depends(roles_manage),
    db: Session = Depends(get_db),
) -> RolesOut:
    user = _get_user_or_404(db, user_id)
    if role == Role.SUPER_ADMIN and rbac.count_holders(db, Role.SUPER_ADMIN) <= 1:
        if Role.SUPER_ADMIN in rbac.get_roles(db, user.id):
            raise ApiError(
                409, "LAST_SUPER_ADMIN", "The last super administrator cannot be removed."
            )
    if rbac.revoke_role(db, user.id, role):
        audit.record(
            db,
            action="role.revoked",
            entity_type="user",
            entity_id=str(user.id),
            actor_user_id=staff.user.id,
            actor_roles=staff.roles_label,
            before={"role": role.value},
            **audit.context_from_request(request),
        )
    db.commit()
    return RolesOut(roles=[r.value for r in rbac.get_roles(db, user.id)])


@router.get("/audit-logs", response_model=AuditLogPage)
def list_audit_logs(
    action: str | None = None,
    entity_type: str | None = None,
    entity_id: str | None = None,
    actor_user_id: uuid.UUID | None = None,
    limit: int = Query(50, ge=1, le=200),
    cursor: str | None = None,
    staff: StaffContext = Depends(audit_read),
    db: Session = Depends(get_db),
) -> AuditLogPage:
    rows, next_cursor = audit.list_logs(
        db,
        action=action,
        entity_type=entity_type,
        entity_id=entity_id,
        actor_user_id=actor_user_id,
        limit=limit,
        cursor=cursor,
    )
    items = [
        AuditLogOut(
            id=row.id,
            created_at=row.created_at,
            actor_user_id=row.actor_user_id,
            actor_roles=row.actor_roles,
            action=row.action,
            entity_type=row.entity_type,
            entity_id=row.entity_id,
            reason=row.reason,
            before=row.before,
            after=row.after,
            ip=row.ip,
            request_id=row.request_id,
        )
        for row in rows
    ]
    return AuditLogPage(items=items, next_cursor=next_cursor)
