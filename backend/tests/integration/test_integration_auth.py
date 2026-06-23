"""Integration: authentication endpoints."""

import httpx
import pytest
from .conftest import API_V1, SUPERUSER_EMAIL, SUPERUSER_PASSWORD


def test_health_check():
    r = httpx.get(f"{API_V1}/utils/health-check/")
    assert r.status_code == 200
    assert r.json() is True


def test_login_returns_jwt():
    r = httpx.post(
        f"{API_V1}/login/access-token",
        data={"username": SUPERUSER_EMAIL, "password": SUPERUSER_PASSWORD},
    )
    assert r.status_code == 200
    data = r.json()
    assert "access_token" in data
    assert data["token_type"] == "bearer"
    assert len(data["access_token"]) > 20


def test_login_wrong_password():
    r = httpx.post(
        f"{API_V1}/login/access-token",
        data={"username": SUPERUSER_EMAIL, "password": "wrongpassword"},
    )
    assert r.status_code == 400


def test_login_unknown_user():
    r = httpx.post(
        f"{API_V1}/login/access-token",
        data={"username": "nobody@nowhere.com", "password": "x"},
    )
    assert r.status_code == 400


def test_protected_route_without_token():
    r = httpx.get(f"{API_V1}/users/me")
    assert r.status_code == 401


def test_protected_route_with_invalid_token():
    r = httpx.get(
        f"{API_V1}/users/me",
        headers={"Authorization": "Bearer not.a.valid.jwt"},
    )
    assert r.status_code == 401


def test_me_returns_correct_user(superuser_headers):
    r = httpx.get(f"{API_V1}/users/me", headers=superuser_headers)
    assert r.status_code == 200
    data = r.json()
    assert data["email"] == SUPERUSER_EMAIL
    assert data["is_superuser"] is True
    assert data["is_active"] is True


def test_auth_config_disabled_when_nomad_off():
    """NOMAD OAuth config endpoint returns 400 when OAuth is disabled."""
    r = httpx.get(f"{API_V1}/auth/config")
    assert r.status_code == 400
    assert "not enabled" in r.json()["detail"].lower()
