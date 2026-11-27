import secrets
from html import escape
from json import dumps

from fastapi import APIRouter, Depends, Query, Request
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.core.google import GoogleClient, get_google_client
from app.modules.audit import service as audit
from app.modules.auth import google_service as service
from app.modules.auth.router import _to_token_response
from app.modules.auth.schemas import (
    GoogleExchangeRequest,
    GoogleStartRequest,
    GoogleStartResponse,
    TokenResponse,
)

router = APIRouter(tags=["auth"])

_MESSAGES = {
    "GOOGLE_CANCELLED": "Sign-in was cancelled.",
    "ACCOUNT_SUSPENDED": "This account is suspended.",
    "GOOGLE_EMAIL_UNVERIFIED": "Your Google email address is not verified.",
    "SIGNIN_EXPIRED": "That sign-in took too long. Start again from the app.",
}


def _landing_page(target: str) -> HTMLResponse:
    """A small page that hands the browser over to the app. It also works as a fallback button,
    because some browsers refuse to open an app address without a tap."""
    ok = "ticket=" in target
    nonce = secrets.token_urlsafe(16)
    code = target.split("error=", 1)[1] if "error=" in target else ""
    message = (
        "You are signed in. Returning to MAREC Store…"
        if ok
        else _MESSAGES.get(code, "Sign-in did not finish. Go back to the app and try again.")
    )
    button = "Open MAREC Store"
    body = f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>MAREC Store</title>
<style>
 body{{margin:0;min-height:100vh;display:grid;place-items:center;background:#121316;color:#f2f3f5;
 font-family:system-ui,sans-serif}}
 main{{max-width:380px;padding:32px;text-align:center}}
 h1{{font-size:20px;margin:0 0 8px;letter-spacing:.04em}}
 p{{color:#b7bbc4;line-height:1.5}}
 a{{display:inline-block;margin-top:12px;padding:12px 20px;border-radius:8px;background:#e0a63a;
 color:#15161a;font-weight:600;text-decoration:none}}
</style></head>
<body><main><h1>MAREC STORE</h1><p>{escape(message)}</p>
<a href="{escape(target, quote=True)}">{button}</a>
<p style="font-size:13px">You can close this tab afterwards.</p></main>
<script nonce="{nonce}">setTimeout(function(){{location.href={dumps(target)};}},150);</script>
</body></html>"""
    response = HTMLResponse(body)
    response.headers["Content-Security-Policy"] = (
        f"default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-{nonce}'; "
        "base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
    )
    response.headers["Cache-Control"] = "no-store"
    return response


@router.post("/auth/google/start", response_model=GoogleStartResponse)
def google_start(
    body: GoogleStartRequest, google: GoogleClient = Depends(get_google_client)
) -> GoogleStartResponse:
    return GoogleStartResponse(auth_url=service.start(body.code_challenge, google))


@router.get("/auth/google/callback", response_class=HTMLResponse, include_in_schema=False)
def google_callback(
    request: Request,
    code: str | None = Query(None, max_length=2048),
    state: str | None = Query(None, max_length=2048),
    error: str | None = Query(None, max_length=100),
    db: Session = Depends(get_db),
    google: GoogleClient = Depends(get_google_client),
) -> HTMLResponse:
    target = service.finish(db, google, code, state, error, **audit.context_from_request(request))
    return _landing_page(target)


@router.post("/auth/google/exchange", response_model=TokenResponse)
def google_exchange(
    body: GoogleExchangeRequest, request: Request, db: Session = Depends(get_db)
) -> TokenResponse:
    ip = request.client.host if request.client else None
    tokens = service.exchange_ticket(
        db, body.ticket, body.code_verifier, ip, request.headers.get("user-agent")
    )
    return _to_token_response(tokens)
