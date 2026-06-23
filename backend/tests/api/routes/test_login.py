"""Tests for the login/auth endpoints."""

from unittest.mock import patch

from fastapi.testclient import TestClient
from sqlmodel import Session

from app import crud
from app.core.config import settings
from app.models import UserCreate


# ── GET /auth/config ─────────────────────────────────────────────────────────

def test_auth_config_when_oauth_disabled(client: TestClient) -> None:
    """GET /auth/config returns 400 when NOMAD OAuth is disabled."""
    with patch.object(settings, "NOMAD_OAUTH_ENABLED", False):
        r = client.get(f"{settings.API_V1_STR}/auth/config")
    assert r.status_code == 400
    assert "not enabled" in r.json()["detail"].lower()


def test_auth_config_when_oauth_enabled(client: TestClient) -> None:
    """GET /auth/config returns Keycloak config when OAuth is enabled."""
    with (
        patch.object(settings, "NOMAD_OAUTH_ENABLED", True),
        patch.object(
            settings,
            "NOMAD_KEYCLOAK_REALM_URL",
            "https://keycloak.example.com/realms/myrealm",
        ),
        patch.object(settings, "NOMAD_OAUTH_CLIENT_ID", "my-client"),
    ):
        r = client.get(f"{settings.API_V1_STR}/auth/config")
    assert r.status_code == 200
    data = r.json()
    assert data["keycloak_url"] == "https://keycloak.example.com"
    assert data["keycloak_realm"] == "myrealm"
    assert data["keycloak_client_id"] == "my-client"


def test_auth_config_no_auth_required(client: TestClient) -> None:
    """GET /auth/config is publicly accessible (no bearer token needed)."""
    with patch.object(settings, "NOMAD_OAUTH_ENABLED", False):
        r = client.get(f"{settings.API_V1_STR}/auth/config")
    # Should not return 401 — auth config is unauthenticated
    assert r.status_code != 401


def test_auth_config_realm_url_without_realms_segment(client: TestClient) -> None:
    """Handles NOMAD_KEYCLOAK_REALM_URL that has no /realms/ segment gracefully."""
    with (
        patch.object(settings, "NOMAD_OAUTH_ENABLED", True),
        patch.object(
            settings, "NOMAD_KEYCLOAK_REALM_URL", "https://keycloak.example.com"
        ),
        patch.object(settings, "NOMAD_OAUTH_CLIENT_ID", "plains"),
    ):
        r = client.get(f"{settings.API_V1_STR}/auth/config")
    assert r.status_code == 200
    data = r.json()
    assert data["keycloak_url"] == "https://keycloak.example.com"
    assert data["keycloak_realm"] == ""


# ── POST /login/access-token ──────────────────────────────────────────────────

def test_login_access_token_success(client: TestClient, db: Session) -> None:
    """Valid local credentials return a JWT access token."""
    email = "login-test@plains.dev"
    password = "LoginTestPass1!"
    existing = crud.get_user_by_email(session=db, email=email)
    if not existing:
        crud.create_user(session=db, user_create=UserCreate(email=email, password=password))

    with patch.object(settings, "NOMAD_OAUTH_ENABLED", False):
        r = client.post(
            f"{settings.API_V1_STR}/login/access-token",
            data={"username": email, "password": password},
        )
    assert r.status_code == 200
    data = r.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"
    assert len(data["access_token"]) > 20


def test_login_access_token_wrong_password(client: TestClient, db: Session) -> None:
    """Wrong password returns 400."""
    email = "login-wrongpw@plains.dev"
    crud.get_user_by_email(session=db, email=email) or crud.create_user(
        session=db, user_create=UserCreate(email=email, password="correct-pass!")
    )
    with patch.object(settings, "NOMAD_OAUTH_ENABLED", False):
        r = client.post(
            f"{settings.API_V1_STR}/login/access-token",
            data={"username": email, "password": "wrong-password"},
        )
    assert r.status_code == 400
    assert "incorrect" in r.json()["detail"].lower()


def test_login_access_token_unknown_user(client: TestClient) -> None:
    """Non-existent user returns 400."""
    with patch.object(settings, "NOMAD_OAUTH_ENABLED", False):
        r = client.post(
            f"{settings.API_V1_STR}/login/access-token",
            data={"username": "nobody@plains.dev", "password": "anything"},
        )
    assert r.status_code == 400


def test_login_access_token_disabled_when_oauth_enabled(client: TestClient) -> None:
    """When NOMAD_OAUTH_ENABLED=true, local login returns 400."""
    with patch.object(settings, "NOMAD_OAUTH_ENABLED", True):
        r = client.post(
            f"{settings.API_V1_STR}/login/access-token",
            data={"username": "anyone@plains.dev", "password": "pass"},
        )
    assert r.status_code == 400
    assert "oauth" in r.json()["detail"].lower()


def test_login_access_token_returns_usable_jwt(client: TestClient, db: Session) -> None:
    """Token from login endpoint can authenticate subsequent requests."""
    email = "jwt-test@plains.dev"
    password = "JwtTestPass1!"
    crud.get_user_by_email(session=db, email=email) or crud.create_user(
        session=db, user_create=UserCreate(email=email, password=password)
    )
    with patch.object(settings, "NOMAD_OAUTH_ENABLED", False):
        r = client.post(
            f"{settings.API_V1_STR}/login/access-token",
            data={"username": email, "password": password},
        )
    assert r.status_code == 200
    token = r.json()["access_token"]

    # Use the token to hit a protected endpoint
    me = client.get(
        f"{settings.API_V1_STR}/users/me",
        headers={"Authorization": f"Bearer {token}"},
    )
    assert me.status_code == 200
    assert me.json()["email"] == email
