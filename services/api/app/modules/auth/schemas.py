import uuid
from datetime import datetime

from pydantic import BaseModel, EmailStr, Field, field_validator, model_validator


class RegisterRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=10, max_length=128)
    display_name: str = Field(min_length=2, max_length=40)

    @field_validator("display_name")
    @classmethod
    def clean_display_name(cls, value: str) -> str:
        value = " ".join(value.split())
        if len(value) < 2:
            raise ValueError("Display name is too short.")
        return value

    @model_validator(mode="after")
    def password_differs_from_email(self) -> "RegisterRequest":
        if self.password.lower() == str(self.email).lower():
            raise ValueError("Password must not be the same as the email address.")
        return self


class LoginRequest(BaseModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=128)


class RefreshRequest(BaseModel):
    refresh_token: str = Field(min_length=20, max_length=256)


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
    expires_in: int


class UserOut(BaseModel):
    id: uuid.UUID
    email: str
    display_name: str
    email_verified: bool
    status: str
    created_at: datetime
    # Staff roles (for example "game_moderator"). Empty for players. The app uses this only to
    # decide which screens to show; every action is still checked on the server.
    roles: list[str] = []


class SessionOut(BaseModel):
    id: uuid.UUID
    created_at: datetime
    last_seen_at: datetime
    user_agent: str | None
    current: bool


class ProvidersOut(BaseModel):
    google: bool
    email_codes: bool


class GoogleStartRequest(BaseModel):
    # base64url(SHA-256(code_verifier)): the app keeps the verifier, so only it can finish.
    code_challenge: str = Field(min_length=43, max_length=43)


class GoogleStartResponse(BaseModel):
    auth_url: str


class GoogleExchangeRequest(BaseModel):
    ticket: str = Field(min_length=20, max_length=128)
    code_verifier: str = Field(min_length=43, max_length=128)


class SendCodeResponse(BaseModel):
    expires_in_minutes: int


class VerifyEmailRequest(BaseModel):
    code: str = Field(pattern=r"^\d{6}$")
