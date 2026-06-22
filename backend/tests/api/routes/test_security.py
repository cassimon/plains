"""Security-focused tests: token forgery, injection, header validation."""
import uuid

import jwt
import pytest
from fastapi.testclient import TestClient

from app.core.config import settings

API = settings.API_V1_STR


class TestInvalidBearerTokens:
    """Ensure the app correctly rejects malformed or forged tokens."""

    def test_missing_bearer_token_returns_401(self, client: TestClient) -> None:
        for path in ["/materials/", "/solutions/", "/experiments/", "/results/", "/planes/"]:
            r = client.get(f"{API}{path}")
            assert r.status_code == 401, f"Expected 401 for GET {path}, got {r.status_code}"

    def test_invalid_token_returns_401(self, client: TestClient) -> None:
        headers = {"Authorization": "Bearer not.a.valid.jwt"}
        r = client.get(f"{API}/materials/", headers=headers)
        assert r.status_code == 401

    def test_empty_bearer_string_returns_401(self, client: TestClient) -> None:
        headers = {"Authorization": "Bearer "}
        r = client.get(f"{API}/materials/", headers=headers)
        assert r.status_code == 401

    def test_wrong_scheme_returns_401(self, client: TestClient) -> None:
        headers = {"Authorization": "Basic dXNlcjpwYXNz"}
        r = client.get(f"{API}/materials/", headers=headers)
        assert r.status_code == 401

    def test_jwt_none_algorithm_rejected(self, client: TestClient) -> None:
        """A JWT signed with 'none' algorithm must be rejected."""
        payload = {"sub": str(uuid.uuid4()), "exp": 9999999999}
        # Craft a token with algorithm=none (no signature)
        token = jwt.encode(payload, "", algorithm="none")
        headers = {"Authorization": f"Bearer {token}"}
        r = client.get(f"{API}/materials/", headers=headers)
        assert r.status_code == 401

    def test_jwt_wrong_secret_rejected(self, client: TestClient) -> None:
        """A JWT signed with a different secret must be rejected."""
        payload = {"sub": str(uuid.uuid4()), "exp": 9999999999}
        token = jwt.encode(payload, "wrong-secret", algorithm="HS256")
        headers = {"Authorization": f"Bearer {token}"}
        r = client.get(f"{API}/materials/", headers=headers)
        assert r.status_code == 401

    def test_expired_jwt_rejected(self, client: TestClient) -> None:
        """An expired JWT must return 401."""
        payload = {"sub": str(uuid.uuid4()), "exp": 1}  # epoch 1 = long expired
        token = jwt.encode(payload, settings.SECRET_KEY, algorithm="HS256")
        headers = {"Authorization": f"Bearer {token}"}
        r = client.get(f"{API}/materials/", headers=headers)
        assert r.status_code == 401


class TestIDORProtection:
    """Ensure users cannot access or modify resources they don't own."""

    def test_material_idor_get(
        self, client: TestClient, superuser_token_headers: dict[str, str], normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(f"{API}/materials/", json={"name": "private-mat"}, headers=superuser_token_headers)
        mat_id = r.json()["id"]
        assert client.get(f"{API}/materials/{mat_id}", headers=normal_user_token_headers).status_code == 403

    def test_solution_idor_get(
        self, client: TestClient, superuser_token_headers: dict[str, str], normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(f"{API}/solutions/", json={"name": "priv-sol"}, headers=superuser_token_headers)
        sol_id = r.json()["id"]
        assert client.get(f"{API}/solutions/{sol_id}", headers=normal_user_token_headers).status_code == 403

    def test_experiment_idor_get(
        self, client: TestClient, superuser_token_headers: dict[str, str], normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(f"{API}/experiments/", json={"name": "priv-exp"}, headers=superuser_token_headers)
        exp_id = r.json()["id"]
        assert client.get(f"{API}/experiments/{exp_id}", headers=normal_user_token_headers).status_code == 403

    def test_result_idor_get(
        self, client: TestClient, superuser_token_headers: dict[str, str], normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(f"{API}/experiments/", json={"name": "e"}, headers=superuser_token_headers)
        exp_id = r.json()["id"]
        r2 = client.post(f"{API}/results/", params={"experiment_id": exp_id}, json={}, headers=superuser_token_headers)
        res_id = r2.json()["id"]
        assert client.get(f"{API}/results/{res_id}", headers=normal_user_token_headers).status_code == 403

    def test_plane_idor_get(
        self, client: TestClient, superuser_token_headers: dict[str, str], normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(f"{API}/planes/", json={"name": "priv-plane"}, headers=superuser_token_headers)
        plane_id = r.json()["id"]
        assert client.get(f"{API}/planes/{plane_id}", headers=normal_user_token_headers).status_code == 403

    def test_state_isolation(
        self,
        client: TestClient,
        db,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        """Normal user's state GET should not include superuser's materials."""
        client.post(
            f"{API}/materials/",
            json={"name": "superuser-only-material"},
            headers=superuser_token_headers,
        )
        r = client.get(f"{API}/state/", headers=normal_user_token_headers)
        mat_names = [m.get("name") for m in r.json()["data"]["materials"]]
        assert "superuser-only-material" not in mat_names


class TestResponseHeaders:
    """Verify that security headers are present in responses."""

    def test_x_content_type_options_header(self, client: TestClient) -> None:
        r = client.get(f"{API}/utils/health-check/")
        assert r.headers.get("x-content-type-options") == "nosniff"

    def test_x_frame_options_header(self, client: TestClient) -> None:
        r = client.get(f"{API}/utils/health-check/")
        assert r.headers.get("x-frame-options") == "DENY"

    def test_referrer_policy_header(self, client: TestClient) -> None:
        r = client.get(f"{API}/utils/health-check/")
        assert r.headers.get("referrer-policy") == "strict-origin-when-cross-origin"


class TestInputValidation:
    """Test that the API properly validates and rejects malformed input."""

    def test_invalid_uuid_in_path_returns_422(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        for path in ["/materials/", "/solutions/", "/experiments/", "/results/", "/planes/"]:
            r = client.get(f"{API}{path}not-a-uuid", headers=normal_user_token_headers)
            assert r.status_code == 422, f"Expected 422 for GET {API}{path}not-a-uuid"

    def test_create_material_empty_name_rejected(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(
            f"{API}/materials/", json={"name": ""}, headers=normal_user_token_headers
        )
        assert r.status_code == 422

    def test_create_material_name_too_long(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(
            f"{API}/materials/",
            json={"name": "x" * 256},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 422
