"""Exploit-style tests for the email access whitelist.

The whitelist (``ALLOWED_EMAILS``) is the gate that ensures only pre-authorised
NOMAD accounts can obtain a session or be provisioned. These tests attack that
gate from every provisioning/authentication entry point:

* the ``get_current_user`` auth choke point (local HS256 path),
* the ``get_current_user`` NOMAD-OAuth path (existing + auto-provisioned users),
* ``POST /users/signup`` (open registration),
* ``POST /private/users/`` (local-env bootstrap route).

When the whitelist is empty the app must stay fully backward-compatible
(everyone allowed); when populated it must be strictly deny-by-default.
"""

import uuid
from datetime import timedelta
from unittest.mock import patch

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlmodel import Session

from app import crud
from app.api.deps import get_current_user
from app.core import security
from app.core.config import Settings, settings
from app.models import User, UserCreate
from tests.utils.utils import random_email, random_lower_string

API = settings.API_V1_STR


# ── Pure config-level checks ──────────────────────────────────────────────────


class TestWhitelistConfig:
    def test_disabled_when_empty_allows_everyone(self) -> None:
        s = _settings(allowed="")
        assert s.email_whitelist_enabled is False
        assert s.is_email_allowed("literally-anyone@evil.test") is True

    def test_enabled_is_deny_by_default(self) -> None:
        s = _settings(allowed="alice@nomad.eu")
        assert s.email_whitelist_enabled is True
        assert s.is_email_allowed("alice@nomad.eu") is True
        assert s.is_email_allowed("mallory@evil.test") is False

    def test_matching_is_case_insensitive(self) -> None:
        s = _settings(allowed="Alice@Nomad.EU")
        assert s.is_email_allowed("ALICE@nomad.eu") is True
        assert s.is_email_allowed("  alice@nomad.eu  ") is True

    def test_missing_email_is_rejected_when_enabled(self) -> None:
        s = _settings(allowed="alice@nomad.eu")
        assert s.is_email_allowed(None) is False
        assert s.is_email_allowed("") is False

    def test_bootstrap_superuser_is_always_allowed(self) -> None:
        # Operator can never lock themselves out even if omitted from the list.
        s = _settings(allowed="alice@nomad.eu")
        assert s.is_email_allowed(settings.FIRST_SUPERUSER) is True


def _settings(*, allowed: str) -> Settings:
    return Settings(
        PROJECT_NAME="Plains",
        FIRST_SUPERUSER="admin@example.com",
        FIRST_SUPERUSER_PASSWORD="changethis",
        POSTGRES_SERVER="localhost",
        POSTGRES_USER="postgres",
        ALLOWED_EMAILS=allowed,
    )


# ── Auth choke point (local HS256 path) ───────────────────────────────────────


class TestAuthChokePoint:
    def test_valid_token_for_non_whitelisted_user_is_forbidden(
        self, db: Session
    ) -> None:
        """A perfectly valid, correctly-signed token is still rejected (403)
        when its subject is not on the whitelist."""
        email = random_email()
        crud.create_user(
            session=db,
            user_create=UserCreate(email=email, password=random_lower_string()),
        )
        token = security.create_access_token(email, timedelta(minutes=5))
        with (
            patch.object(settings, "NOMAD_OAUTH_ENABLED", False),
            patch.object(settings, "ALLOWED_EMAILS", ["someone-else@nomad.eu"]),
        ):
            with pytest.raises(HTTPException) as exc:
                get_current_user(session=db, token=token)
        assert exc.value.status_code == 403

    def test_valid_token_for_whitelisted_user_passes(self, db: Session) -> None:
        email = random_email()
        crud.create_user(
            session=db,
            user_create=UserCreate(email=email, password=random_lower_string()),
        )
        token = security.create_access_token(email, timedelta(minutes=5))
        with (
            patch.object(settings, "NOMAD_OAUTH_ENABLED", False),
            patch.object(settings, "ALLOWED_EMAILS", [email]),
        ):
            user = get_current_user(session=db, token=token)
        assert user.email == email

    def test_empty_whitelist_preserves_legacy_access(self, db: Session) -> None:
        email = random_email()
        crud.create_user(
            session=db,
            user_create=UserCreate(email=email, password=random_lower_string()),
        )
        token = security.create_access_token(email, timedelta(minutes=5))
        with (
            patch.object(settings, "NOMAD_OAUTH_ENABLED", False),
            patch.object(settings, "ALLOWED_EMAILS", []),
        ):
            user = get_current_user(session=db, token=token)
        assert user.email == email


# ── NOMAD OAuth path ──────────────────────────────────────────────────────────


class TestNomadOAuthChokePoint:
    def test_auto_provisioning_blocked_for_non_whitelisted_email(
        self, db: Session
    ) -> None:
        """An attacker holding a genuine NOMAD token whose email is not
        whitelisted must NOT be auto-provisioned a local account."""
        rogue_email = random_email()
        claims = {"sub": f"nomad-{uuid.uuid4()}", "email": rogue_email, "name": "Rogue"}
        with (
            patch.object(settings, "NOMAD_OAUTH_ENABLED", True),
            patch.object(settings, "ALLOWED_EMAILS", ["allowed@nomad.eu"]),
            patch.object(security, "verify_nomad_token", return_value=claims),
        ):
            with pytest.raises(HTTPException) as exc:
                get_current_user(session=db, token="opaque-nomad-token")
        assert exc.value.status_code == 403
        # And crucially: no account leaked into the DB.
        assert crud.get_user_by_email(session=db, email=rogue_email) is None

    def test_existing_nomad_user_revoked_via_whitelist(self, db: Session) -> None:
        """Removing an email from the whitelist locks out an already-provisioned
        NOMAD user on their next request."""
        email = random_email()
        sub = f"nomad-{uuid.uuid4()}"
        user = User(email=email, nomad_sub=sub, is_active=True, is_superuser=False)
        db.add(user)
        db.commit()
        claims = {"sub": sub, "email": email, "name": "X"}
        with (
            patch.object(settings, "NOMAD_OAUTH_ENABLED", True),
            patch.object(settings, "ALLOWED_EMAILS", ["not-this-user@nomad.eu"]),
            patch.object(security, "verify_nomad_token", return_value=claims),
        ):
            with pytest.raises(HTTPException) as exc:
                get_current_user(session=db, token="opaque-nomad-token")
        assert exc.value.status_code == 403

    def test_whitelisted_nomad_user_provisioned(self, db: Session) -> None:
        email = random_email()
        claims = {"sub": f"nomad-{uuid.uuid4()}", "email": email, "name": "Ok"}
        with (
            patch.object(settings, "NOMAD_OAUTH_ENABLED", True),
            patch.object(settings, "ALLOWED_EMAILS", [email]),
            patch.object(security, "verify_nomad_token", return_value=claims),
        ):
            user = get_current_user(session=db, token="opaque-nomad-token")
        assert user.email == email
        assert crud.get_user_by_email(session=db, email=email) is not None


# ── Registration endpoints ────────────────────────────────────────────────────


class TestSignupRespectsWhitelist:
    def test_signup_rejects_non_whitelisted_email(self, client: TestClient) -> None:
        rogue = random_email()
        with (
            patch.object(settings, "ALLOWED_EMAILS", ["allowed@nomad.eu"]),
            patch.object(settings, "USERS_OPEN_REGISTRATION", True),
        ):
            r = client.post(
                f"{API}/users/signup",
                json={"email": rogue, "password": random_lower_string()},
            )
        assert r.status_code == 403

    def test_signup_allows_whitelisted_email(self, client: TestClient) -> None:
        allowed = random_email()
        with (
            patch.object(settings, "ALLOWED_EMAILS", [allowed]),
            patch.object(settings, "USERS_OPEN_REGISTRATION", True),
        ):
            r = client.post(
                f"{API}/users/signup",
                json={"email": allowed, "password": random_lower_string()},
            )
        assert r.status_code == 200


class TestPrivateCreateRespectsWhitelist:
    def test_private_create_rejects_non_whitelisted_email(
        self, client: TestClient
    ) -> None:
        rogue = random_email()
        with patch.object(settings, "ALLOWED_EMAILS", ["allowed@nomad.eu"]):
            r = client.post(
                f"{API}/private/users/",
                json={
                    "email": rogue,
                    "password": random_lower_string(),
                    "full_name": "Rogue",
                },
            )
        assert r.status_code == 403
