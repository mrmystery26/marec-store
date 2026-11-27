# Put the store online (Render, phone-friendly)

The Android and Windows apps talk to the store API, and `localhost` only works on the computer
that runs it. This hosts the API and its database on Render so the apps can reach it from anywhere.
Everything below can be done in a phone browser.

This sets up the real store: production mode, a Cloudflare R2 bucket for game builds, Sign in with
Google, email through Resend, and signing keys. Do the one-time setup in `SETUP_ACCOUNTS.md` first
(or at least have its values ready), because Render asks for them when you apply the blueprint and
the API refuses to start in production without them.

## Steps

1. Open https://render.com in your browser and sign up with GitHub. Allow it to see `marec-store`.
2. Dashboard, then **New**, then **Blueprint**, pick `mrmystery26/marec-store`, and apply it. Render
   reads `render.yaml`, creates the API (`marec-store-api`) and the database (`marec-db`), and asks
   you for each secret value marked in the file. If you already applied an older version of the
   blueprint, open the blueprint and **Sync**: it asks for the new values, and the service restarts
   in production mode.
3. Wait for the first deploy to finish (a few minutes). Open the service and copy its address. It
   looks like `https://marec-store-api.onrender.com`.
4. Check it in your browser:
   - `<address>/v1/health` should show `"status":"ok"`.
   - `<address>/v1/auth/providers` should show `{"google":true,"email_codes":true}`.
   - `<address>/v1/games` starts empty: real games come from developers. (Any made-up demo games
     left by an older version are removed automatically on start.)
5. Tell the apps where it is, either way:
   - **Right now, no rebuild:** open the Android app and type the address on the first-start screen.
   - **Built in:** on GitHub open Settings, Secrets and variables, Actions, Variables, and add
     `MAREC_API_BASE_URL` with the same address (no trailing slash). Then re-run **Build apps**
     under Actions. The new Windows and Android downloads will already point at your store.

## The database (read this before real use)

A **free Render database expires 30 days after it is created**, and Render deletes it (and everything
in it) 14 days after that unless you upgrade it. That is fine for trying things out, but it would erase
every account, studio and demo. Before you rely on the store, do one of these:

- In Render, upgrade `marec-db` to a paid instance (the simplest), or
- Use a PostgreSQL service from another provider that offers a lasting free or paid plan (Neon and
  Supabase are two that people use), create a database there, and paste its connection address into
  the API service's `DATABASE_URL` on Render (remove the link to `marec-db` in the blueprint). Check
  that provider's current free terms yourself.

Also back up: from any computer, `pg_dump "<your database address>" > backup.sql` (the address is on
the database page). Game files live in Cloudflare R2, not in the database, so they are separate.

## Good to know

- Free web services on Render go to sleep when idle, so the first request after a quiet period can
  take about a minute. Render's free plans have limits (for example on the database) that can
  change, so check https://render.com/pricing for the current terms.
- Each start runs the database migrations, makes sure the store's categories exist, and removes old
  placeholder games if any are left.
- The API address must be `https://`. The release Android build refuses plain `http://`.
- Keep `MANIFEST_SIGNING_KEY` and `LAUNCH_SIGNING_KEY` forever. Changing either one stops every
  installed game from verifying.
