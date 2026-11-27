# MAREC STORE

Game marketplace for Malawi and Africa, by MAREC STUDIOS. *Play Local. Think Global.*

## Status: M0 done (CI green). Everything after it is written, not yet run

**Honest status:** the M0 code (auth, sessions, health) passed CI on GitHub. Everything added
after that (roles, audit log, studios, game catalog and review, demo seed, build uploads and signed manifests, player library and install plans, launch authorization, Windows launcher prototype, build upload tool, Godot SDK) was written and syntax-checked but
has NOT been run: its first real run is your next push. If CI is red, paste the log to Claude and
it will be fixed before anything is built on top.

What exists now:

- FastAPI service with health endpoints and a consistent error format (code, message, request ID)
- PostgreSQL schema through Alembic migrations: `users`, `user_sessions`
- Registration, login, refresh-token rotation with replay detection, logout, session list and revoke
- argon2id password hashing, short-lived access tokens, account lockout after repeated failures
- Roles (super_admin, store_admin, game_moderator, customer_support, finance_admin, developer)
  with permissions defined in code and checked on every request
- Admin API: look up a user, suspend and reinstate (with a required reason), grant and revoke roles
  (the last super administrator cannot be removed), browse the audit log with filters
- Append-only audit log. On PostgreSQL a trigger blocks UPDATE, DELETE and TRUNCATE on it
- Command-line tool to create the first super administrator
- Studios: developers can create up to 3; staff verify them. Members have studio roles
  (owner, manager, developer, finance) that decide who can edit content, change the price, submit
- Game catalog: games with the nine blueprint states (draft, submitted, under review, changes
  requested, approved, scheduled, published, suspended, removed), categories, system requirements,
  price in tambala (MWK), age rating, protection level, offline days
- Developer API: create studio and games, edit drafts, submit for review (needs a verified studio
  and a complete listing)
- Review API: moderators move games through the states; a written reason is required to request
  changes, suspend, reinstate or remove; every step is audit-logged
- Build uploads: a developer declares a build (version plus every file's path, size and SHA-256),
  uploads each file to a short-lived signed URL, then finishes the build. The server checks every
  file, writes a manifest (with 8 MB chunk hashes), signs it with Ed25519 and marks the build ready.
  A game needs a ready build before it can be submitted. Staff can revoke a build
- Player library: a player can add a FREE published game to their library (ownership is recorded in
  the backend, one record per player and game), list their library, and ask for an install plan:
  the signed manifest plus download links that last 6 hours and support resuming (byte ranges).
  Only owners get a plan, and only while the game is published by a verified studio
- Launch authorization: when a player presses PLAY the backend checks ownership, the build and the
  PC, then signs a short-lived (2 minute) single-use token. The game redeems it once at start-up.
  Offline play uses a signed lease (the game's offline days, default 7) tied to that PC. Players can
  have 5 PCs and remove them. Studio members can test-launch their own unpublished builds
- Public store API: list and search published games (filters, sorting, paging), game detail, categories.
  Only published games from verified studios are visible
- Tests (SQLite locally, PostgreSQL in CI), lint, secret scan, migration up/down check

Also built since then: **Sign in with Google**, emailed verification codes (Resend), **developer
accounts** and **demo-only publishing** (see "Accounts, email and developers" below).

Not built yet (on purpose): IP-based rate limiting, two-factor authentication inside the store for
staff (use Google's 2-step verification on staff Google accounts), malware scanning, paid
purchases, offline play in the launcher, discounts, website, payments. See the blueprint for the order.

## Accounts, email and developers

- **Sign in with Google** (Windows and Android). The app opens Google in the system browser, and
  the API sends the player back with a one-time ticket that only that app can redeem (PKCE). Email
  and password sign-up still works. Setup: `docs/SETUP_ACCOUNTS.md`.
- **Email** goes through Resend (free plan: 3,000 emails a month, 100 a day). Only needed things are
  sent: a 6-digit code to confirm an email address, a notice when a studio is verified, and a notice
  when a game is approved, published or needs changes. Google accounts never need a code.
- **Developer accounts.** A signed-in player with a verified email accepts the developer rules and
  names a studio in the Publisher portal. The studio starts `pending`; a store administrator
  verifies it (in the launcher's Review screen, or `python -m app.cli verify-studio --slug ...`),
  and only then can it upload.
- **Demos only for now** (`DEMO_ONLY=true`). Every new game is a free demo (price fixed at 0, marked
  `release_kind: "demo"`), at most `DEMO_MAX_BUILD_MB` per build and `DEMO_MAX_GAMES_PER_STUDIO`
  per studio. Every game is still reviewed by staff before it appears in the store.
- **SDK file.** Each game downloads its own filled-in `marec_config.gd` from the Publisher portal
  (`GET /v1/developer/games/{id}/sdk-config`).

## Layout

```
.devcontainer/devcontainer.json   Cloud dev environment (Codespaces)
.github/workflows/ci.yml          Lint, migrations, tests, secret scan
.github/workflows/build.yml       Builds the Windows launcher and the Android app (see docs/GITHUB_ACTIONS.md)
VERSION                           The one version number both apps use
docs/DECISIONS.md                 Confirmed decisions
docs/GITHUB_ACTIONS.md            How the automatic builds work, where to download, settings and secrets
docs/BUILD_WINDOWS.md, BUILD_ANDROID.md, ANDROID_SIGNING.md, PLATFORM_COMPATIBILITY.md
apps/launcher/                    Windows launcher (Electron). Its src/renderer is the store interface shared with Android
apps/android/                     Android app (Java shell that hosts the shared store interface)
scripts/ci/, scripts/android/     Version stamping, APK checks, preparing the Android assets
infra/docker-compose.yml          Local PostgreSQL + API
services/api/
  app/main.py                     App factory, middleware
  app/core/                       config, db, security, errors
  app/modules/auth/               models, schemas, service, router, deps
  app/modules/rbac/               roles, permissions, role assignment, permission check
  app/modules/audit/              append-only audit log and its query helpers
  app/modules/admin/              admin endpoints (/v1/admin/...): users, roles, audit, studios, review
  app/modules/studios/            studios and studio memberships
  app/modules/catalog/            games, categories, requirements, state machine, public store API
  app/modules/developer/          developer endpoints (/v1/developer/...)
  app/modules/builds/             build uploads, hashing, manifests, storage endpoints
  app/modules/friends/            friend codes, friend requests and friends lists (/v1/friends/...)
  app/modules/library/            owned games (entitlements), library list, install plan
  app/core/storage.py             file storage: local disk (dev) and S3-compatible (Cloudflare R2)
  app/core/signing.py             Ed25519 signing of manifests
  app/core/launch_signing.py      RS256 signing of launch tokens and offline leases
  app/modules/launch/             devices, launch tokens, leases, redeem
apps/launcher/                    Windows launcher (Electron). See apps/launcher/README.md
tools/upload-build/               Command-line tool that uploads a game folder as a build
packages/marec-sdk-godot/         Godot SDK (GDScript addon) that games use to check a launch
  app/modules/health.py           /v1/health, /v1/health/db
  app/cli.py                      Operator commands (grant-role, revoke-role, list-studios, verify-studio)
  app/seed.py                     Creates the store's categories; removes old placeholder data
  app/core/google.py              Talks to Google (code exchange, ID token checks)
  app/core/email.py               Sends email through Resend; the messages
  app/modules/auth/               also: Google sign-in, one-time tickets, emailed codes
  alembic/                        Migrations (0001 users, 0002 roles + audit, 0003 studios + catalog, 0004 builds, 0005 entitlements, 0006 launch, 0007 build entry point, 0008 friends, 0009 Google sign-in + developers + demos)
  tests/                          pytest suite
  .env.example                    Variable names, no secrets
```

## Run it (Codespaces or any machine with Docker)

```
cd infra
docker compose up --build
```

API docs: http://localhost:8000/docs (disabled when `ENVIRONMENT=production`).

Smoke test:

```
curl -s localhost:8000/v1/health

curl -s -X POST localhost:8000/v1/auth/register -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"a-long-test-password","display_name":"Me"}'

curl -s -X POST localhost:8000/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"a-long-test-password"}'
```

Read the `access_token` out of the login response into a shell variable and use it:

```
TOKEN=$(curl -s -X POST localhost:8000/v1/auth/login -H 'Content-Type: application/json' \
  -d '{"email":"me@example.com","password":"a-long-test-password"}' \
  | python3 -c 'import sys, json; print(json.load(sys.stdin)["access_token"])')

curl -s localhost:8000/v1/me -H "Authorization: Bearer $TOKEN"
```

## Prepare the database

```
cd infra
docker compose exec api python -m app.seed
```

This adds the 8 store categories (safe to repeat). It never adds made-up games: real games come
from developers (see below). If an older version of this project loaded the made-up "MAREC Demo
Studio" games, `python -m app.seed --remove-placeholders` deletes them; the hosted start script runs
both commands on every start.

## Uploading a game build (development)

Files are stored under `services/api/.storage` (ignored by Git) and uploaded through signed links
served by the API itself, so no cloud account is needed. In `/docs`:

1. `POST /v1/developer/games/{game_id}/builds` with the version, platform `windows-x64` and the
   list of files (`path`, `size_bytes`, `sha256`). The reply contains one `upload_url` per file.
2. `PUT` each file's bytes to its `upload_url` (no login needed, the link is the permission).
3. `POST /v1/developer/builds/{build_id}/complete`. It lists any problems (missing file, wrong size,
   wrong hash). Fix those and call it again. When `problems` is empty the build is `ready`.

The signed manifest is stored with the build. Launchers and games verify it with the public key
from `GET /v1/launch/public-keys`. In Codespaces set `PUBLIC_API_BASE_URL` to the forwarded address
of port 8000 so upload links point at the right place.

**Signing key:** create one with `python -m app.cli gen-signing-key` and keep it secret. Without
`MANIFEST_SIGNING_KEY` a temporary key is used (local and test only), so manifests signed before a
restart stop verifying. Staging and production refuse to start without it.

## Installing a game as a player (development)

1. Log in as a player. `POST /v1/me/library/{game_id}` adds a free published game
   (a paid game answers 402; paying comes with the orders work).
2. `GET /v1/me/library` lists owned games with `available` and `latest_version`.
3. `POST /v1/games/{game_id}/install-plan` returns the signed manifest (`manifest_b64`, its
   signature and key id) and one download link per file. Download each file with a normal GET;
   send a `Range: bytes=START-END` header to resume. Verify the manifest signature first, then every
   file's SHA-256 and chunk hashes against the manifest. This is exactly what the launcher will do.

## Friends

Players add each other with a **friend code** (like `K7QM-2XWD`), never by email or name, so nobody
can look up who has an account. The code is made the first time it is asked for, and a player can
replace it if it was shared by mistake (the old one stops working at once).

All of these need a login:

- `GET /v1/friends/code` shows your code. `POST /v1/friends/code/reset` makes a new one.
- `POST /v1/friends/requests` with `{"friend_code": "..."}` sends a request. Codes may be typed in
  lower case, with spaces, or without the dash. If the other player had already asked you, the two
  requests meet and you are friends straight away (200 instead of 201).
- `GET /v1/friends/requests` lists `incoming` and `outgoing` pending requests.
- `POST /v1/friends/requests/{id}/accept` and `/decline` answer a request. Only the person who
  received it can. `DELETE /v1/friends/requests/{id}` takes back a request you sent.
- `GET /v1/friends` lists friends, sorted by name. `DELETE /v1/friends/{user_id}` unfriends.

Rules: no adding yourself; a player who was declined cannot ask again, but the player who declined
can send their own request; up to 200 friends and 50 waiting outgoing requests per player; suspended
and deleted accounts never appear. Responses show display names only, never email addresses.

## How a game proves the player owns it (launch authorization)

1. The launcher calls `POST /v1/launch/authorizations` with the game, the installed build, a
   random per-PC `device_id` it keeps secret, and a nonce. The reply is a signed token (an RS256
   JWT). Only the SHA-256 of `device_id` is stored.
2. The launcher starts the game and hands it the token (never on the command line).
3. The game checks the signature with the public key from `GET /v1/launch/public-keys` (the entry
   with `use: launch`), then checks `aud` is its own game id, `exp`, `dh` (this PC) and `bid`.
4. Online, the game also calls `POST /v1/launch/redeem` once. The backend marks the token used, so
   a copied token cannot be replayed, and re-checks ownership and the build.
5. Offline, the launcher uses a lease from `POST /v1/launch/leases` instead. The game checks the
   same signature and claims (`kind: lease`, `od` = days allowed) with no server call.

Two keys, on purpose: build manifests use Ed25519 (the launcher verifies them in Rust), but launch
tokens use RSA because Godot can verify RSA signatures with its built-in `Crypto` class and has no
Ed25519 support. **Still to confirm when the SDK is built:** Godot 4.7.2 `Crypto.verify` with
SHA-256 accepts these signatures (PKCS#1 v1.5), and a time check against the last server time seen.

Create the launch key with `python -m app.cli gen-launch-key` (a secret, like the manifest key).

## The Windows launcher

Lives in `apps/launcher`; its README explains how to get the installer from GitHub Actions and how
to try a real game end to end. Builds now carry an **entry point** (the `.exe` the launcher starts).
It is inferred when exactly one `.exe` sits at the top of the build, otherwise send `entry_point`.

To try it end to end: sign in, create a developer account in the **Publisher portal**, get the
studio verified, create a demo, upload the exported game folder from **Builds**, submit it, and
approve and publish it from the **Review** screen (or the admin API).

## The Android app

Lives in `apps/android`. It is a small native shell that shows the same store interface as the Windows launcher and talks
to the same API, so accounts and libraries are shared. Windows games show as Windows games and are never installed on a
phone. GitHub builds the APK for you; see `docs/BUILD_ANDROID.md`, `docs/ANDROID_SIGNING.md` and
`docs/PLATFORM_COMPATIBILITY.md`. Android builds of games need backend support that does not exist yet.

## Typical flow

1. A person signs in with Google (or registers with email and password and confirms the emailed
   code), then opens the Publisher portal and creates a developer account
   (`POST /v1/developer/account`) with a studio name. The studio starts as `pending`.
2. A store administrator verifies it (`POST /v1/admin/studios/{id}/verify`, the Review screen, or
   `python -m app.cli verify-studio --slug ...`). The developer gets an email.
3. The developer creates a demo, fills it in (`PATCH /v1/developer/games/{id}`), uploads a build
   and submits it.
4. A moderator reviews it (`POST /v1/admin/games/{id}/transition` with an action, or the Review
   screen) and publishes it. The developer gets an email for each decision.
5. It appears in `GET /v1/games`, marked as a demo.

Staff roles are given with the command below. A store admin is needed to create categories.

## Create the first super administrator

Staff accounts cannot be created through the API (that would be a way in for attackers). Two ways:

1. **Set `BOOTSTRAP_ADMIN_EMAILS`** to your own email address (several can be separated by
   commas). When you next sign in with that address **and it is verified** (a Google account always
   is), you become super administrator. An address registered with a password but never verified
   gets nothing, so nobody can claim yours by registering it first. The grant is audit-logged.
   This is how to do it on hosting without a shell, such as Render's free plan.
2. In a terminal where `DATABASE_URL` points at the right database:

```
cd services/api
python -m app.cli grant-role --email you@example.com --role super_admin
```

With the Docker setup, run it inside the API container instead:
`docker compose exec api python -m app.cli grant-role --email you@example.com --role super_admin`.
Every role change is audit-logged.

**Before real use:** admin endpoints are protected by role only, and the store itself has no second
factor for staff yet. Turn on Google's 2-step verification for every staff Google account.

## Run the tests (no Docker or PostgreSQL needed)

```
cd services/api
pip install -r requirements-dev.txt
pytest -q
```

To test against PostgreSQL, set `TEST_DATABASE_URL` to a database whose name contains `test`
(the tests drop and recreate all tables, so never point it at real data).

## Configuration

| Variable | Meaning | Default |
|---|---|---|
| ENVIRONMENT | local, test, staging, production | local |
| DATABASE_URL | SQLAlchemy URL (`postgresql+psycopg://...`) | required |
| JWT_SECRET | Signs access tokens. 32+ random characters outside local/test | required |
| ACCESS_TOKEN_MINUTES | Access token lifetime | 15 |
| REFRESH_TOKEN_DAYS | Refresh token lifetime (slides on each refresh) | 30 |
| MAX_FAILED_LOGINS | Failures before lockout | 5 |
| LOCKOUT_MINUTES | Lockout length | 15 |
| CORS_ORIGINS | Comma-separated website origins | empty |
| MANIFEST_SIGNING_KEY | Base64 of 32 random bytes; signs build manifests. Required in staging/production | temporary key |
| LAUNCH_SIGNING_KEY | Base64 of an RSA private key PEM (`python -m app.cli gen-launch-key`). Required in staging/production | temporary key |
| LAUNCH_TOKEN_SECONDS | Lifetime of an online launch token | 120 |
| MAX_DEVICES_PER_ACCOUNT | PCs one account may use | 5 |
| STORAGE_BACKEND | `local` (development) or `s3` (Cloudflare R2). Production needs `s3` | local |
| STORAGE_LOCAL_DIR | Where local files go | ./.storage |
| PUBLIC_API_BASE_URL | Address used inside local upload links | http://localhost:8000 |
| S3_ENDPOINT_URL, S3_BUCKET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, S3_REGION | R2 connection | none |
| GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET | Sign in with Google (set both or neither). Redirect URI: `<PUBLIC_API_BASE_URL>/v1/auth/google/callback` | off |
| APP_REDIRECT_URI | Where the browser returns to the app after Google (fixed, never taken from a request) | marecstore://auth |
| RESEND_API_KEY, EMAIL_FROM | Email through Resend. `EMAIL_FROM` must use a domain verified in Resend | off |
| ADMIN_NOTIFY_EMAIL | Gets "a developer is waiting" emails | none |
| BOOTSTRAP_ADMIN_EMAILS | Verified emails that become super administrators on sign-in | none |
| DEMO_ONLY | Developers may only publish free demos | true |
| DEMO_MAX_BUILD_MB, DEMO_MAX_GAMES_PER_STUDIO | Demo limits | 1024, 5 |

Generate a real secret: `python -c "import secrets; print(secrets.token_urlsafe(48))"`

## Database migrations

```
cd services/api
alembic upgrade head      # apply
alembic downgrade base    # roll everything back (local only)
```

Never change production tables by hand. Add a new migration file instead.

## Known limitations (to fix in later milestones)

- Registering with an existing email returns 409, which reveals that the email is registered.
  An enumeration-safe flow needs email delivery.
- Public lists use offset paging (limit/offset), not cursors. Fine for a small catalog; revisit later.
- Publishing a game with a future release date schedules it, but nothing promotes it
  automatically yet (staff publish it again to release it).
- Malware scanning is NOT connected. Builds show `scan_status: not_scanned`; only a file-type policy
  (no scripts or installers) and path-safety checks run. Do not treat a ready build as safe.
- The R2 storage code is written but has never talked to a real bucket. Test it with a staging
  bucket before relying on it. Presigned R2 links cannot cap upload size; sizes and hashes are
  verified when the build is completed.
- Finishing a build hashes every file inside the request. Fine for development, but it must move to
  a background worker before large games.
- Builds can only be added while a game is a draft or has changes requested. New versions of
  published games need an update flow.
- Paid games cannot be bought yet (no orders or payments), so only free games reach a library.
- The install plan and downloads have no rate limits yet, and there is no record of installs.
- Entitlements can be revoked in the database but there is no staff screen for it yet.
- `POST /v1/launch/redeem` has no rate limit yet (the token is the credential, so abuse needs a valid
  token, but limits are still needed). Offline leases cannot be recalled before they expire
  (a refund or ban takes effect at the next online check).
- Friends: there is no online status or "now playing" (that needs presence tracking), no blocking or
  reporting, and no notification when a request arrives (the Friends page shows it when opened).
  Friend codes are random (about 8.5 trillion possibilities) but guessing is not rate limited yet,
  which waits for the IP-based limits above.
- Published games cannot be edited by developers yet (an update-after-release flow is needed).
- Admin accounts have no second factor yet (see above), and there is no admin hostname split yet.
- Lockout is per account, so an attacker could lock out a known email. IP-based limits (Cloudflare
  and/or Redis) come next.
- No breached-password check yet. Behind a proxy, client IPs need forwarded-header handling.
- Dependency versions are ranges. Pin them with a lock file after the first green CI run.
- `.devcontainer` and `docker-compose.yml` are untested.
