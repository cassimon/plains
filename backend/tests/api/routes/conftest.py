"""
Test fixtures for API route tests.

The app uses NOMAD Keycloak (RS256) for authentication in production.
In tests, we bypass the auth dependency entirely using dependency_overrides
so tests don't require a live Keycloak server.

Two synthetic bearer tokens are recognised:
  "test-superuser-token"  → returns the FIRST_SUPERUSER user
  "test-normaluser-token" → returns a non-superuser test user
"""
import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlmodel import Session

from app import crud
from app.api import deps
from app.core.config import settings
from app.main import app
from app.models import User, UserCreate

_SUPERUSER_TOKEN = "test-superuser-token"
_NORMALUSER_TOKEN = "test-normaluser-token"

# Module-level cache so the override closure can reference the current user
_current_users: dict[str, User | None] = {
    "superuser": None,
    "normaluser": None,
}


def _make_get_current_user():
    def _override(token: str = None) -> User:
        if token == _SUPERUSER_TOKEN:
            user = _current_users["superuser"]
        elif token == _NORMALUSER_TOKEN:
            user = _current_users["normaluser"]
        else:
            raise HTTPException(status_code=401, detail="Not authenticated")
        if user is None:
            raise HTTPException(status_code=401, detail="Test user not initialised")
        return user

    return _override


@pytest.fixture(scope="session", autouse=True)
def _setup_test_users(db: Session) -> None:
    """Create the superuser and a normal test user once per test session."""
    # Superuser is created by init_db; just fetch it
    su = crud.get_user_by_email(session=db, email=settings.FIRST_SUPERUSER)
    _current_users["superuser"] = su

    # Normal test user
    nu = crud.get_user_by_email(session=db, email=settings.EMAIL_TEST_USER)
    if not nu:
        nu = crud.create_user(
            session=db,
            user_create=UserCreate(email=settings.EMAIL_TEST_USER, password="testpassword123"),
        )
    _current_users["normaluser"] = nu


@pytest.fixture(scope="module", autouse=True)
def _override_auth() -> None:
    """Override get_current_user for the duration of each test module."""
    override = _make_get_current_user()

    # The override receives the raw token string extracted by _require_token,
    # so we also override _require_token to pass the literal bearer value.
    def _token_from_header(
        credentials=None,
    ) -> str:
        # During overridden auth, the actual credentials object may not match;
        # the dep is called with the real credentials — just return the raw string.
        if credentials and credentials.credentials:
            return credentials.credentials
        raise HTTPException(status_code=401, detail="Not authenticated")

    app.dependency_overrides[deps.get_current_user] = lambda: _current_users["superuser"]
    # We need a smarter override that switches based on the token value.
    # Use the full override that reads from DI properly.
    app.dependency_overrides.clear()

    def _smart_override() -> User:
        # This is called without args during DI; we can't easily read headers here.
        # Use the Request-level approach instead — we override _require_token too.
        raise HTTPException(status_code=401, detail="Override not configured")

    # Better approach: override get_current_user with request-based dependency.
    from fastapi import Depends
    from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

    _bearer = HTTPBearer(auto_error=False)

    def _real_override(
        credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    ) -> User:
        token = credentials.credentials if credentials else None
        if token == _SUPERUSER_TOKEN:
            user = _current_users["superuser"]
        elif token == _NORMALUSER_TOKEN:
            user = _current_users["normaluser"]
        else:
            raise HTTPException(status_code=401, detail="Not authenticated")
        if user is None:
            raise HTTPException(status_code=401, detail="Test user not found")
        return user

    app.dependency_overrides[deps.get_current_user] = _real_override

    yield

    app.dependency_overrides.clear()


@pytest.fixture(scope="module")
def superuser_token_headers(client: TestClient) -> dict[str, str]:  # type: ignore[override]
    return {"Authorization": f"Bearer {_SUPERUSER_TOKEN}"}


@pytest.fixture(scope="module")
def normal_user_token_headers(client: TestClient, db: Session) -> dict[str, str]:  # type: ignore[override]
    return {"Authorization": f"Bearer {_NORMALUSER_TOKEN}"}
