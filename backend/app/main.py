import logging
from collections.abc import Callable

import sentry_sdk
from fastapi import FastAPI, Request, Response
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy.exc import IntegrityError
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.middleware.cors import CORSMiddleware

from app.api.main import api_router
from app.core.config import settings
from app.core.limiter import limiter

logging.basicConfig(level=logging.INFO)


def custom_generate_unique_id(route: APIRoute) -> str:
    return f"{route.tags[0]}-{route.name}"


if settings.SENTRY_DSN and settings.ENVIRONMENT != "local":
    sentry_sdk.init(dsn=str(settings.SENTRY_DSN), enable_tracing=True)

app = FastAPI(
    title=settings.PROJECT_NAME,
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
    generate_unique_id_function=custom_generate_unique_id,
    root_path=settings.ROOT_PATH,
)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)


async def integrity_error_handler(request: Request, exc: IntegrityError) -> Response:
    """Return DB constraint violations as a structured 409 instead of a bare
    500. Handlers for specific exception types run inside the middleware
    stack, so (unlike unhandled 500s) the response passes back through
    CORSMiddleware and the browser sees the real error rather than a
    misleading 'CORS header missing' failure."""
    logging.getLogger("app").warning("Integrity error on %s: %s", request.url, exc)
    return JSONResponse(
        status_code=409,
        content={"detail": "Database constraint violated by this request."},
    )


app.add_exception_handler(IntegrityError, integrity_error_handler)

# Set all CORS enabled origins
if settings.all_cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.all_cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "Accept"],
    )


class SecurityHeadersMiddleware(BaseHTTPMiddleware):
    """Add security headers to every API response."""

    async def dispatch(self, request: Request, call_next: Callable) -> Response:
        response = await call_next(request)
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["X-Frame-Options"] = "DENY"
        response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
        # HSTS is set here as a safety net; the reverse proxy should also set it.
        if settings.ENVIRONMENT in ("staging", "production"):
            response.headers["Strict-Transport-Security"] = (
                "max-age=31536000; includeSubDomains"
            )
        return response


app.add_middleware(SecurityHeadersMiddleware)

app.include_router(api_router, prefix=settings.API_V1_STR)
