import re
import uuid

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from app.core.config import get_settings
from app.core.errors import register_error_handlers
from app.modules.auth.router import router as auth_router
from app.modules.health import router as health_router

_REQUEST_ID_PATTERN = re.compile(r"[A-Za-z0-9_-]{8,64}")


def create_app() -> FastAPI:
    settings = get_settings()
    is_production = settings.environment == "production"

    app = FastAPI(
        title="MAREC STORE API",
        version="0.1.0",
        docs_url=None if is_production else "/docs",
        redoc_url=None,
        openapi_url=None if is_production else "/openapi.json",
    )

    if settings.cors_origin_list:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=settings.cors_origin_list,
            allow_credentials=True,
            allow_methods=["GET", "POST", "PUT", "DELETE"],
            allow_headers=["Authorization", "Content-Type", "X-Request-ID"],
            expose_headers=["X-Request-ID"],
        )

    @app.middleware("http")
    async def request_context(request: Request, call_next):
        request_id = request.headers.get("X-Request-ID", "")
        if not _REQUEST_ID_PATTERN.fullmatch(request_id):
            request_id = uuid.uuid4().hex
        request.state.request_id = request_id

        response = await call_next(request)

        response.headers["X-Request-ID"] = request_id
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        if request.url.path.startswith(("/v1/auth", "/v1/me")):
            response.headers["Cache-Control"] = "no-store"
        return response

    register_error_handlers(app)
    app.include_router(health_router, prefix="/v1")
    app.include_router(auth_router, prefix="/v1")
    return app


app = create_app()
