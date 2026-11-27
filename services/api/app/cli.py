"""Command-line tools for operators.

Bootstrap the first super administrator (run where DATABASE_URL points at the right database):

    python -m app.cli grant-role --email you@example.com --role super_admin

See which developer studios are waiting, and verify one (this also lets it upload):

    python -m app.cli list-studios --status pending
    python -m app.cli verify-studio --slug zomba-games

Create the key that signs game build manifests (store it as a secret, never in the repository):

    python -m app.cli gen-signing-key
"""
import argparse
import sys

from sqlalchemy import select

from app.core.db import get_sessionmaker
from app.core.errors import ApiError
from app.core.launch_signing import new_private_key_b64
from app.core.signing import new_seed_b64
from app.modules.audit import service as audit
from app.modules.auth.models import User
from app.modules.auth.service import normalize_email
from app.modules.rbac import service as rbac
from app.modules.rbac.permissions import Role
from app.modules.studios import service as studios
from app.modules.studios.models import Studio


def _build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="python -m app.cli")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("gen-signing-key", help="print a new MANIFEST_SIGNING_KEY value")
    commands.add_parser("gen-launch-key", help="print a new LAUNCH_SIGNING_KEY value")
    listing = commands.add_parser("list-studios", help="list studios, newest last")
    listing.add_argument("--status", choices=["pending", "verified", "suspended"])
    verify = commands.add_parser("verify-studio", help="verify a studio so it can upload")
    verify.add_argument("--slug", required=True)
    for name in ("grant-role", "revoke-role"):
        command = commands.add_parser(name)
        command.add_argument("--email", required=True)
        command.add_argument("--role", required=True, choices=[role.value for role in Role])
    return parser


def _list_studios(factory, status: str | None) -> int:
    with factory() as db:
        stmt = select(Studio).order_by(Studio.created_at)
        if status:
            stmt = stmt.where(Studio.status == status)
        rows = list(db.scalars(stmt))
        for studio in rows:
            print(f"{studio.slug}\t{studio.status}\t{studio.name}")
        if not rows:
            print("No studios.")
    return 0


def _verify_studio(factory, slug: str) -> int:
    with factory() as db:
        studio = db.scalar(select(Studio).where(Studio.slug == slug))
        if studio is None:
            print(f"No studio with slug {slug}.", file=sys.stderr)
            return 1
        try:
            studios.verify_studio(db, studio, actor_user_id=None, actor_roles="cli")
        except ApiError as error:
            print(error.message)
            return 0
        print(f"Verified {studio.name}.")
    return 0


def main(argv: list[str] | None = None, session_factory=None) -> int:
    args = _build_parser().parse_args(argv)
    if args.command == "gen-signing-key":
        print(new_seed_b64())
        return 0
    if args.command == "gen-launch-key":
        print(new_private_key_b64())
        return 0
    factory = session_factory or get_sessionmaker()
    if args.command == "list-studios":
        return _list_studios(factory, args.status)
    if args.command == "verify-studio":
        return _verify_studio(factory, args.slug)
    role = Role(args.role)
    granting = args.command == "grant-role"

    with factory() as db:
        user = db.scalar(select(User).where(User.email == normalize_email(args.email)))
        if user is None:
            print(f"No user with email {args.email}.", file=sys.stderr)
            return 1

        if granting:
            changed = rbac.grant_role(db, user.id, role, granted_by=None)
        else:
            changed = rbac.revoke_role(db, user.id, role)

        if changed:
            audit.record(
                db,
                action="role.granted" if granting else "role.revoked",
                entity_type="user",
                entity_id=str(user.id),
                actor_roles="cli",
                after={"role": role.value} if granting else None,
                before=None if granting else {"role": role.value},
            )
            db.commit()
            print(f"{'Granted' if granting else 'Revoked'} {role.value} for {user.email}.")
        else:
            print("Nothing to change.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
