# Put the store online (Render, phone-friendly)

The Android and Windows apps talk to the store API, and `localhost` only works on the computer
that runs it. This hosts the API and its database on Render so the apps can reach it from anywhere.
Everything below can be done in a phone browser.

This sets up **demo mode**: the six demo games are loaded, game builds are kept on temporary disk
(they vanish on restart), and no signing keys are set. Do not use it for real customers or real
game builds yet (see "Going to production").

## Steps

1. Open https://render.com in your browser and sign up with GitHub. Allow it to see `marec-store`.
2. Dashboard, then **New**, then **Blueprint**, pick `mrmystery26/marec-store`, and apply it. Render
   reads `render.yaml` and creates the API (`marec-store-api`) and the database (`marec-db`).
3. Wait for the first deploy to finish (a few minutes). Open the service and copy its address. It
   looks like `https://marec-store-api.onrender.com`.
4. Check it in your browser:
   - `<address>/v1/health` should show `"status":"ok"`.
   - `<address>/v1/games` should list the 6 demo games.
5. Tell the apps where it is, either way:
   - **Right now, no rebuild:** open the Android app and type the address on the first-start screen.
   - **Built in:** on GitHub open Settings, Secrets and variables, Actions, Variables, and add
     `MAREC_API_BASE_URL` with the same address (no trailing slash). Then re-run **Build apps**
     under Actions. The new Windows and Android downloads will already point at your store.

## Good to know

- Free web services on Render go to sleep when idle, so the first request after a quiet period can
  take about a minute. Render's free plans have limits (for example on the database) that can
  change, so check https://render.com/pricing for the current terms.
- Each start runs the database migrations. The demo games are only added once (turn them off by
  setting `SEED_DEMO` to `false` in the service's Environment tab).
- The API address must be `https://`. The release Android build refuses plain `http://`.

## Going to production

Set `ENVIRONMENT=production`. The API then refuses to start until all of this is set:

- `JWT_SECRET`: random, at least 32 characters (Render generates one for you).
- `STORAGE_BACKEND=s3` with `S3_ENDPOINT_URL`, `S3_BUCKET`, `S3_ACCESS_KEY_ID` and
  `S3_SECRET_ACCESS_KEY` (any S3-compatible bucket, for example Cloudflare R2).
- `MANIFEST_SIGNING_KEY` and `LAUNCH_SIGNING_KEY`, made with `python -m app.cli gen-signing-key`
  and `python -m app.cli gen-launch-key` and kept secret.
- `PUBLIC_API_BASE_URL`: the public `https://` address of the API.
