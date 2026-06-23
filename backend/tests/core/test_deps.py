"""Tests for FastAPI dependency functions in app.api.deps."""

import pytest
import uuid
from unittest.mock import MagicMock, patch

from fastapi import HTTPException
from fastapi.security import HTTPAuthorizationCredentials


def test_require_token_raises_401_when_no_credentials():
    from app.api.deps import _require_token

    with pytest.raises(HTTPException) as exc_info:
        _require_token(None)
    assert exc_info.value.status_code == 401


def test_require_token_raises_401_when_empty_credentials():
    from app.api.deps import _require_token

    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="")
    # Empty string is falsy, should raise 401
    with pytest.raises(HTTPException) as exc_info:
        _require_token(creds)
    assert exc_info.value.status_code == 401


def test_require_token_returns_token_string():
    from app.api.deps import _require_token

    creds = HTTPAuthorizationCredentials(scheme="Bearer", credentials="mytoken")
    result = _require_token(creds)
    assert result == "mytoken"


def test_get_current_user_raises_401_when_token_missing_sub(db):
    from app.api.deps import get_current_user
    from app.core.config import settings as _settings

    with (
        patch.object(_settings, "NOMAD_OAUTH_ENABLED", True),
        patch("app.api.deps.security.verify_nomad_token") as mock_verify,
    ):
        mock_verify.return_value = {}  # no "sub" claim
        with pytest.raises(HTTPException) as exc_info:
            get_current_user(session=db, token="any.token")

    assert exc_info.value.status_code == 401
    assert "subject" in exc_info.value.detail.lower()


def test_get_current_user_creates_user_on_first_login(db):
    """Auto-creates a user record for a new NOMAD sub claim."""
    from app.api.deps import get_current_user
    from app.models import User
    from sqlmodel import select
    from app.core.config import settings as _settings

    unique_sub = f"keycloak|{uuid.uuid4().hex}"
    unique_email = f"{uuid.uuid4().hex}@nomad.test"

    with (
        patch.object(_settings, "NOMAD_OAUTH_ENABLED", True),
        patch("app.api.deps.security.verify_nomad_token") as mock_verify,
    ):
        mock_verify.return_value = {
            "sub": unique_sub,
            "email": unique_email,
            "name": "NOMAD TestUser",
        }
        user = get_current_user(session=db, token="valid.token")

    assert user.nomad_sub == unique_sub
    assert user.email == unique_email
    assert user.is_active is True

    db_user = db.exec(select(User).where(User.nomad_sub == unique_sub)).first()
    if db_user:
        db.delete(db_user)
        db.commit()


def test_get_current_user_returns_existing_user(db):
    """Returns existing user for a known NOMAD sub."""
    from app.api.deps import get_current_user
    from app.models import User
    from sqlmodel import select
    from app.core.config import settings as _settings

    unique_sub = f"keycloak|{uuid.uuid4().hex}"
    unique_email = f"{uuid.uuid4().hex}@nomad.test"

    existing = User(email=unique_email, nomad_sub=unique_sub, is_active=True)
    db.add(existing)
    db.commit()
    db.refresh(existing)

    with (
        patch.object(_settings, "NOMAD_OAUTH_ENABLED", True),
        patch("app.api.deps.security.verify_nomad_token") as mock_verify,
    ):
        mock_verify.return_value = {"sub": unique_sub, "email": unique_email}
        user = get_current_user(session=db, token="valid.token")

    assert user.id == existing.id

    db.delete(existing)
    db.commit()


def test_get_current_user_raises_400_for_inactive_user(db):
    """Inactive users get a 400 error."""
    from app.api.deps import get_current_user
    from app.models import User

    unique_sub = f"keycloak|{uuid.uuid4().hex}"
    unique_email = f"{uuid.uuid4().hex}@nomad.test"

    inactive = User(email=unique_email, nomad_sub=unique_sub, is_active=False)
    db.add(inactive)
    db.commit()

    from app.core.config import settings as _settings

    with (
        patch.object(_settings, "NOMAD_OAUTH_ENABLED", True),
        patch("app.api.deps.security.verify_nomad_token") as mock_verify,
    ):
        mock_verify.return_value = {"sub": unique_sub}
        with pytest.raises(HTTPException) as exc_info:
            get_current_user(session=db, token="valid.token")

    assert exc_info.value.status_code == 400
    assert "inactive" in exc_info.value.detail.lower()

    # Clean up
    db.delete(inactive)
    db.commit()
