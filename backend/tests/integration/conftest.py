"""
Integration test conftest.

Tests run against a live backend (default: http://127.0.0.1:8001).
Authentication uses the real POST /api/v1/login/access-token endpoint,
which requires NOMAD_OAUTH_ENABLED=false on the backend.

Each test session creates a fresh user with a unique email, runs all tests
as that user, and deletes the user at teardown.
"""

import os
import uuid

import httpx
import pytest

# Accept either API_BASE_URL (used by CI / the Playwright suite) or the older
# INTEGRATION_API_BASE name, falling back to the host-mapped test port.
API_BASE = (
    os.getenv("API_BASE_URL")
    or os.getenv("INTEGRATION_API_BASE")
    or "http://127.0.0.1:8001"
)
API_V1 = f"{API_BASE}/api/v1"

SUPERUSER_EMAIL = os.getenv("FIRST_SUPERUSER", "admin@example.com")
SUPERUSER_PASSWORD = os.getenv("FIRST_SUPERUSER_PASSWORD", "changethis")

# These tests require NOMAD_OAUTH_ENABLED=false (local JWT login) and
# ENVIRONMENT=local (private /private/users/ endpoint). Skip automatically
# when those conditions aren't met so the suite doesn't fail against a real
# production deployment.
_REQUIRES_LOCAL_AUTH = pytest.mark.skipif(
    os.getenv("NOMAD_OAUTH_ENABLED", "false").lower() == "true",
    reason="Integration tests require NOMAD_OAUTH_ENABLED=false (local JWT mode)",
)


def get_token(email: str, password: str) -> str:
    r = httpx.post(
        f"{API_V1}/login/access-token",
        data={"username": email, "password": password},
        timeout=10,
    )
    assert r.status_code == 200, f"Login failed: {r.text}"
    return r.json()["access_token"]


def auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


@pytest.fixture(scope="session")
def superuser_token() -> str:
    return get_token(SUPERUSER_EMAIL, SUPERUSER_PASSWORD)


@pytest.fixture(scope="session")
def superuser_headers(superuser_token: str) -> dict:
    return auth_headers(superuser_token)


@pytest.fixture(scope="session")
@_REQUIRES_LOCAL_AUTH
def test_user(superuser_headers: dict):
    """Create a test user for the session; delete it at teardown."""
    uid = uuid.uuid4().hex[:8]
    email = f"integ-{uid}@test.plains"
    password = f"pass-{uid}-secure"

    # Create via private endpoint (local mode only)
    r = httpx.post(
        f"{API_V1}/private/users/",
        json={"email": email, "password": password, "full_name": "Integration Tester"},
        timeout=10,
    )
    assert r.status_code == 200, f"Failed to create test user: {r.text}"
    user_id = r.json()["id"]

    yield {"id": user_id, "email": email, "password": password}

    # Teardown — delete via superuser
    httpx.delete(
        f"{API_V1}/users/{user_id}",
        headers=superuser_headers,
        timeout=10,
    )


@pytest.fixture(scope="session")
def user_token(test_user: dict) -> str:
    return get_token(test_user["email"], test_user["password"])


@pytest.fixture(scope="session")
def user_headers(user_token: str) -> dict:
    return auth_headers(user_token)


@pytest.fixture(scope="session")
def client() -> httpx.Client:
    with httpx.Client(base_url=API_V1, timeout=15) as c:
        yield c


@pytest.fixture(scope="session")
def superuser_client(superuser_headers: dict) -> httpx.Client:
    with httpx.Client(base_url=API_BASE, headers=superuser_headers, timeout=30) as c:
        yield c


@pytest.fixture(scope="session")
def test_user_client(user_headers: dict) -> httpx.Client:
    with httpx.Client(base_url=API_BASE, headers=user_headers, timeout=30) as c:
        yield c


@pytest.fixture(scope="session")
def test_user_id(test_user: dict) -> str:
    return test_user["id"]
