# Set up Google sign-in, email and storage

This is the one-time setup for the store's accounts. Everything below can be done in a browser.
You make four things and paste their values into the API service on Render (**Environment** tab).
**Never paste these values into a chat, an issue or a file in this repository.**

| You make | You get | Render variable |
|---|---|---|
| A Google "OAuth client" | client id and secret | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` |
| A Resend account with your domain | an API key | `RESEND_API_KEY`, `EMAIL_FROM` |
| A Cloudflare R2 bucket | endpoint, bucket, key id, secret | `S3_ENDPOINT_URL`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY` |
| Two signing keys | two long values | `MANIFEST_SIGNING_KEY`, `LAUNCH_SIGNING_KEY` |

Also set `PUBLIC_API_BASE_URL` (the public `https://` address of your API, no trailing slash) and
`BOOTSTRAP_ADMIN_EMAILS` (your own Google address, see step 6).

## 1. A domain on Cloudflare (needed for email)

Resend only sends from a domain you own, and Cloudflare is where its DNS records go.

1. Add your domain to Cloudflare (the free plan is enough) and point the domain's name servers at
   Cloudflare as it tells you.
2. Optional but recommended: make the API reachable at `api.yourdomain.com`. In Render open the API
   service, **Settings, Custom Domains**, add `api.yourdomain.com`, and add the CNAME record Render
   shows you in Cloudflare DNS. Set that record to **DNS only** (grey cloud) until Render says the
   certificate is ready.
3. Use that address (`https://api.yourdomain.com`) as `PUBLIC_API_BASE_URL`. If you skip the custom
   domain, use the `https://....onrender.com` address instead.

## 2. Cloudflare R2 (where game builds are kept)

1. Cloudflare dashboard, **R2 Object Storage**, **Create bucket**. Name it, for example,
   `marec-builds`. Keep it **private**.
2. **Manage API tokens**, **Create API token**. Permission **Object Read & Write**, limited to that
   bucket. Copy the **Access Key ID** and **Secret Access Key** now (the secret is shown once).
3. The endpoint is `https://<account id>.r2.cloudflarestorage.com` (the account id is on the R2
   overview page).
4. Set `S3_ENDPOINT_URL`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`. `S3_REGION` is
   already `auto`.

No bucket CORS rules are needed: the Windows launcher uploads and downloads from its own process,
not from a web page.

**Free allowance.** At the time of writing R2's free tier is 10 GB of storage, 1 million writes and
10 million reads a month, with no charge for downloads. Check
https://developers.cloudflare.com/r2/pricing/ for the current numbers. Demos default to at most 1 GB
each, which fills 10 GB quickly; lower `DEMO_MAX_BUILD_MB` (for example to `300`) to make the free
space last.

## 3. Resend (email)

1. Create an account at https://resend.com. **Domains, Add domain**, enter your domain.
2. Resend shows DNS records (SPF, DKIM and so on). Add each one in **Cloudflare DNS**. Set them to
   **DNS only** (grey cloud). Press **Verify** in Resend.
3. **API Keys, Create API key**, permission **Sending access**, limited to your domain.
4. Set `RESEND_API_KEY` to that key, and `EMAIL_FROM` to something like
   `MAREC Store <no-reply@yourdomain.com>`. The address must be on the verified domain.
5. Set `ADMIN_NOTIFY_EMAIL` to the address that should hear about new developers.

**Free allowance.** Resend's free plan allows 3,000 emails a month and 100 a day (see
https://resend.com/pricing). The store only sends what people need (a code to confirm an email
address, a notice when a studio is verified, a notice when a game is approved or needs changes). Google
sign-ins never need an email. If the daily limit is hit, sending pauses until the next day and the
app tells the person to try again later.

## 4. Google sign-in

1. Open https://console.cloud.google.com and create a project (any name).
2. **Google Auth Platform** (also called **APIs & Services, OAuth consent screen**). Choose
   **External**. Fill in the app name (MAREC Store), your support email and a developer contact
   email. The only scopes the store asks for are `openid`, `email` and `profile`.
3. **Publish the app** (change the publishing status from *Testing* to *In production*). While it is
   in Testing, only addresses you list as test users can sign in. The basic scopes above do not
   need Google's app review, but read what the consent screen page says for your project.
4. **Clients (or Credentials), Create OAuth client ID**, type **Web application**.
5. Under **Authorized redirect URIs** add exactly:
   `https://api.yourdomain.com/v1/auth/google/callback` (your `PUBLIC_API_BASE_URL` followed by
   `/v1/auth/google/callback`). It must be `https`, and it must match to the letter.
6. Copy the **Client ID** and **Client secret** into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET`.

The same client serves both the Windows and the Android app. They never talk to Google directly: the
API does, and the apps only get a one-time ticket back through `marecstore://auth`.

## 5. The two signing keys

They sign game builds and launches. Make them once, store them safely, and never change them
(changing a key breaks every installed game). On any computer with Python 3.12:

```
git clone https://github.com/mrmystery26/marec-store
cd marec-store/services/api
python -m venv .venv && . .venv/bin/activate     # on Windows: .venv\Scripts\activate
pip install -r requirements.txt
python -m app.cli gen-signing-key      # value for MANIFEST_SIGNING_KEY
python -m app.cli gen-launch-key       # value for LAUNCH_SIGNING_KEY
```

## 6. Make yourself the store owner

Set `BOOTSTRAP_ADMIN_EMAILS` to your own Google address (several can be separated by commas).
Deploy, open the Windows launcher and **Continue with Google** with that account. You are now super
administrator and the **Review** screen appears in the sidebar. A verified address is required, so
nobody can claim yours by registering it with a password first.

Turn on **Google 2-step verification** on that Google account. The store has no second factor of its
own for staff yet, so your Google account is what protects the admin area.

## 7. Deploy and point the apps at it

1. Apply `render.yaml` as described in `DEPLOY_RENDER.md`. Render asks for the values above.
2. In GitHub, **Settings, Secrets and variables, Actions, Variables**, set `MAREC_API_BASE_URL` to
   your API address, then re-run **Build apps**. The new Windows and Android downloads use your store
   by default.
3. Check `https://api.yourdomain.com/v1/auth/providers`. It should say
   `{"google":true,"email_codes":true}`.

## If something fails

| What you see | Likely cause |
|---|---|
| Google says `redirect_uri_mismatch` | The redirect URI in Google does not match `PUBLIC_API_BASE_URL` + `/v1/auth/google/callback` exactly. |
| Google says "Access blocked" or only some people can sign in | The consent screen is still in Testing. Publish it. |
| `providers` shows `"google": false` | `GOOGLE_CLIENT_ID` or `GOOGLE_CLIENT_SECRET` is missing on Render. |
| The browser shows the sign-in page but the app does not open | The `marecstore://` link is not registered: use the installed Windows app (or the portable one once), or the installed Android app. The page has an **Open MAREC Store** button. |
| "This server cannot send email yet" | `RESEND_API_KEY` or `EMAIL_FROM` is missing. |
| "The email could not be sent" | The domain is not verified in Resend, the key is wrong, or the daily limit was reached. The API log shows Resend's reason (never the key). |
| The API will not start | In production it needs `JWT_SECRET`, `MANIFEST_SIGNING_KEY`, `LAUNCH_SIGNING_KEY` and the `S3_*` values. The log says which one. |
