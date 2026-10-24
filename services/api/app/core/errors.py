import logging

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger("marec.api")

_STATUS_CODES = {
    401: "NOT_AUTHENTICATED",
    403: "FORBIDDEN",
    404: "NOT_FOUND",
    405: "METHOD_NOT_ALLOWED",
}


class ApiError(Exception):
    """An expected error with a stable machine-readable code."""

    def __init__(
        self,
        status_code: int,
        code: str,
        message: str,
        headers: dict[str, str] | None = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.code = code
        self.message = message
        self.headers = headers


def error_response(
    request: Request,
    status_code: int,
    code: str,
    message: str,
    details: list[dict] | None = None,
    headers: dict[str, str] | None = None,
) -> JSONResponse:
    error: dict = {
        "code": code,
        "message": message,
        "request_id": getattr(request.state, "request_id", "unknown"),
    }
    if details:
        error["details"] = details
    return JSONResponse(status_code=status_code, content={"error": error}, headers=headers)


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(ApiError)
    async def handle_api_error(request: Request, exc: ApiError) -> JSONResponse:
        return error_response(request, exc.status_code, exc.code, exc.message, headers=exc.headers)

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(request: Request, exc: RequestValidationError):
        # Only location, message and type are returned. The submitted input is never echoed,
        # because it may contain a password.
        details = [
            {
                "field": ".".join(str(part) for part in err.get("loc", ()) if part != "body"),
                "message": str(err.get("msg", "")),
                "type": str(err.get("type", "")),
            }
            for err in exc.errors()
        ]
        return error_response(
            request, 422, "VALIDATION_ERROR", "Request validation failed.", details=details
        )

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_error(request: Request, exc: StarletteHTTPException):
        code = _STATUS_CODES.get(exc.status_code, f"HTTP_{exc.status_code}")
        return error_response(request, exc.status_code, code, str(exc.detail), headers=exc.headers)

    @app.exception_handler(Exception)
    async def handle_unexpected_error(request: Request, exc: Exception):
        logger.exception("Unhandled error", exc_info=exc)
        return error_response(
            request, 500, "INTERNAL_ERROR", "Something went wrong on our side."
        )
