"""Sending email through Resend (https://resend.com), plus a quiet fallback for development.

Resend's free plan allows 3,000 emails a month and 100 a day, so the app only sends email when a
person needs it (a verification code, a studio decision), never for marketing or "welcome" mail.
"""

import logging
from dataclasses import dataclass
from html import escape

import httpx

from app.core.config import get_settings

logger = logging.getLogger("marec.email")
RESEND_URL = "https://api.resend.com/emails"


@dataclass
class Email:
    to: str
    subject: str
    text: str
    html: str | None = None


class EmailSender:
    """Send one email. Returns True when it was handed to the provider."""

    def send(self, email: Email) -> bool:  # pragma: no cover - interface
        raise NotImplementedError


class ResendSender(EmailSender):
    def __init__(self, api_key: str, sender: str, transport: httpx.BaseTransport | None = None):
        self._api_key = api_key
        self._sender = sender
        self._transport = transport

    def send(self, email: Email) -> bool:
        payload = {
            "from": self._sender,
            "to": [email.to],
            "subject": email.subject,
            "text": email.text,
        }
        if email.html:
            payload["html"] = email.html
        try:
            with httpx.Client(timeout=10.0, transport=self._transport) as client:
                response = client.post(
                    RESEND_URL,
                    json=payload,
                    headers={"Authorization": f"Bearer {self._api_key}"},
                )
        except httpx.HTTPError:
            logger.exception("Resend could not be reached")
            return False
        if response.status_code >= 300:
            # The body says why (unverified domain, daily limit, bad key). Never log the key.
            logger.error(
                "Resend refused an email: %s %s", response.status_code, response.text[:300]
            )
            return False
        return True


class DisabledSender(EmailSender):
    """Used when Resend is not configured. Nothing leaves the server."""

    def send(self, email: Email) -> bool:
        logger.warning("Email is not configured, so %r was not sent.", email.subject)
        return False


class MemorySender(EmailSender):
    """Keeps what would have been sent. Used by tests."""

    def __init__(self) -> None:
        self.sent: list[Email] = []

    def send(self, email: Email) -> bool:
        self.sent.append(email)
        return True


def get_email_sender() -> EmailSender:
    settings = get_settings()
    if settings.email_enabled:
        return ResendSender(settings.resend_api_key.get_secret_value(), settings.email_from)
    return DisabledSender()


# ---------------------------------------------------------------- the messages themselves


def _page(title: str, lines: list[str], big: str | None = None) -> str:
    body = "".join(f'<p style="margin:0 0 12px">{escape(line)}</p>' for line in lines)
    big_style = "font-size:30px;letter-spacing:6px;font-weight:700;margin:16px 0"
    code = f'<p style="{big_style}">{escape(big)}</p>' if big else ""
    return (
        '<div style="font-family:Arial,sans-serif;max-width:480px;margin:auto;color:#15161a">'
        f'<h2 style="margin:0 0 16px">{escape(title)}</h2>{body}{code}'
        '<p style="color:#6b6f78;font-size:12px;margin-top:24px">MAREC Store</p></div>'
    )


def verification_code_email(to: str, code: str, minutes: int) -> Email:
    lines = [
        "Use this code in the MAREC Store app to confirm your email address.",
        f"It works for {minutes} minutes. If you did not ask for it, you can ignore this email.",
    ]
    return Email(
        to=to,
        subject=f"Your MAREC Store code: {code}",
        text="\n".join(lines + ["", f"Code: {code}"]),
        html=_page("Confirm your email", lines, big=code),
    )


def studio_verified_email(to: str, studio_name: str) -> Email:
    lines = [
        f"Your studio “{studio_name}” was verified.",
        "You can now upload demos and submit them for review.",
    ]
    return Email(
        to=to,
        subject=f"{studio_name} is verified on MAREC Store",
        text="\n".join(lines),
        html=_page("Studio verified", lines),
    )


def studio_pending_email(to: str, studio_name: str, developer: str) -> Email:
    lines = [f"{developer} registered the studio “{studio_name}” and is waiting for verification."]
    return Email(
        to=to,
        subject=f"New developer studio waiting: {studio_name}",
        text="\n".join(lines),
        html=_page("Studio waiting for verification", lines),
    )


def game_decision_email(to: str, game_title: str, status: str, reason: str | None) -> Email:
    headline = {
        "approved": f"“{game_title}” was approved.",
        "published": f"“{game_title}” is now live on MAREC Store.",
        "changes_requested": f"“{game_title}” needs changes before it can go live.",
        "suspended": f"“{game_title}” was suspended.",
        "removed": f"“{game_title}” was removed from the store.",
    }.get(status, f"“{game_title}” changed to {status}.")
    lines = [headline] + ([f"Reason: {reason}"] if reason else [])
    return Email(
        to=to,
        subject=f"{game_title}: {status.replace('_', ' ')}",
        text="\n".join(lines),
        html=_page("Your game was reviewed", lines),
    )
