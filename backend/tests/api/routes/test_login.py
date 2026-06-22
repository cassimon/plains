"""Tests for the login/auth endpoints."""

from unittest.mock import patch

from fastapi.testclient import TestClient

from app.core.config import settings


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
