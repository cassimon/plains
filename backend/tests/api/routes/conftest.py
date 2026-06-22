"""
Test fixtures for API route tests.

The app uses NOMAD Keycloak (RS256) for authentication in production.
In tests, we bypass the auth dependency entirely using dependency_overrides
so tests don't require a live Keycloak server.

Two synthetic bearer tokens are recognised:
  "test-superuser-token"  → returns the FIRST_SUPERUSER user
  "test-normaluser-token" → returns a non-superuser test user

The override fetches users fresh from the route's own DB session to avoid
SQLAlchemy "object already attached to another session" errors.
"""
import uuid

import pytest
from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app import crud
from app.api import deps
from app.core.config import settings
from app.main import app
from app.models import User, UserCreate

_SUPERUSER_TOKEN = "test-superuser-token"
_NORMALUSER_TOKEN = "test-normaluser-token"

# Store user IDs only — never ORM objects — to avoid cross-session contamination
_user_ids: dict[str, uuid.UUID | None] = {
    "superuser": None,
    "normaluser": None,
}


@pytest.fixture(scope="session", autouse=True)
def _setup_test_users(db: Session) -> None:
    """Create the superuser and a normal test user once per test session."""
    su = crud.get_user_by_email(session=db, email=settings.FIRST_SUPERUSER)
    if su:
        _user_ids["superuser"] = su.id

    nu = crud.get_user_by_email(session=db, email=settings.EMAIL_TEST_USER)
    if not nu:
        nu = crud.create_user(
            session=db,
            user_create=UserCreate(email=settings.EMAIL_TEST_USER, password="testpassword123"),
        )
    if nu:
        _user_ids["normaluser"] = nu.id


_bearer = HTTPBearer(auto_error=False)


def _real_override(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    session: Session = Depends(deps.get_db),
) -> User:
    """Auth override that fetches users fresh from the request's own DB session."""
    token = credentials.credentials if credentials else None
    if token == _SUPERUSER_TOKEN:
        uid = _user_ids["superuser"]
    elif token == _NORMALUSER_TOKEN:
        uid = _user_ids["normaluser"]
    else:
        raise HTTPException(status_code=401, detail="Not authenticated")
    if uid is None:
        raise HTTPException(status_code=401, detail="Test user not initialised")
    user = session.exec(select(User).where(User.id == uid)).first()
    if not user:
        raise HTTPException(status_code=401, detail="Test user not found in DB")
    return user


@pytest.fixture(scope="module", autouse=True)
def _override_auth() -> None:
    """Override get_current_user for the duration of each test module."""
    app.dependency_overrides[deps.get_current_user] = _real_override
    yield
    app.dependency_overrides.clear()


@pytest.fixture(scope="module")
def superuser_token_headers(client: TestClient) -> dict[str, str]:  # type: ignore[override]
    return {"Authorization": f"Bearer {_SUPERUSER_TOKEN}"}


@pytest.fixture(scope="module")
def normal_user_token_headers(client: TestClient, db: Session) -> dict[str, str]:  # type: ignore[override]
    return {"Authorization": f"Bearer {_NORMALUSER_TOKEN}"}
