import uuid

from fastapi.testclient import TestClient
from sqlmodel import Session

from app.core.config import settings
from tests.utils.utils import random_lower_string

BASE = f"{settings.API_V1_STR}/solutions"
MAT_BASE = f"{settings.API_V1_STR}/materials"


def create_material(client: TestClient, headers: dict) -> dict:
    r = client.post(f"{MAT_BASE}/", json={"name": random_lower_string()}, headers=headers)
    assert r.status_code == 200
    return r.json()


def create_solution(client: TestClient, headers: dict, components: list | None = None) -> dict:
    payload: dict = {"name": random_lower_string()}
    if components:
        payload["components"] = components
    r = client.post(f"{BASE}/", json=payload, headers=headers)
    assert r.status_code == 200
    return r.json()


class TestSolutionsAuth:
    def test_list_requires_auth(self, client: TestClient) -> None:
        r = client.get(f"{BASE}/")
        assert r.status_code == 401

    def test_get_requires_auth(self, client: TestClient) -> None:
        r = client.get(f"{BASE}/{uuid.uuid4()}")
        assert r.status_code == 401

    def test_create_requires_auth(self, client: TestClient) -> None:
        r = client.post(f"{BASE}/", json={"name": "test"})
        assert r.status_code == 401

    def test_update_requires_auth(self, client: TestClient) -> None:
        r = client.put(f"{BASE}/{uuid.uuid4()}", json={"name": "test"})
        assert r.status_code == 401

    def test_delete_requires_auth(self, client: TestClient) -> None:
        r = client.delete(f"{BASE}/{uuid.uuid4()}")
        assert r.status_code == 401


class TestSolutionsCRUD:
    def test_create_solution(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        name = random_lower_string()
        r = client.post(f"{BASE}/", json={"name": name}, headers=normal_user_token_headers)
        assert r.status_code == 200
        data = r.json()
        assert data["name"] == name
        assert "id" in data
        assert data["components"] == []

    def test_create_solution_with_components(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        mat = create_material(client, normal_user_token_headers)
        components = [{"amount": 100.0, "unit": "mg", "material_id": mat["id"]}]
        sol = create_solution(client, normal_user_token_headers, components=components)
        assert len(sol["components"]) == 1
        assert sol["components"][0]["amount"] == 100.0

    def test_create_solution_missing_name(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(f"{BASE}/", json={}, headers=normal_user_token_headers)
        assert r.status_code == 422

    def test_list_solutions(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        create_solution(client, normal_user_token_headers)
        r = client.get(f"{BASE}/", headers=normal_user_token_headers)
        assert r.status_code == 200
        data = r.json()
        assert "data" in data
        assert data["count"] >= 1

    def test_get_solution_by_id(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        sol = create_solution(client, normal_user_token_headers)
        r = client.get(f"{BASE}/{sol['id']}", headers=normal_user_token_headers)
        assert r.status_code == 200
        assert r.json()["id"] == sol["id"]

    def test_get_solution_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.get(f"{BASE}/{uuid.uuid4()}", headers=normal_user_token_headers)
        assert r.status_code == 404

    def test_update_solution(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        sol = create_solution(client, normal_user_token_headers)
        new_name = random_lower_string()
        r = client.put(
            f"{BASE}/{sol['id']}",
            json={"name": new_name},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        assert r.json()["name"] == new_name

    def test_update_solution_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.put(
            f"{BASE}/{uuid.uuid4()}",
            json={"name": "x"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 404

    def test_delete_solution(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        sol = create_solution(client, normal_user_token_headers)
        r = client.delete(f"{BASE}/{sol['id']}", headers=normal_user_token_headers)
        assert r.status_code == 200
        assert r.json()["ok"] is True

        r2 = client.get(f"{BASE}/{sol['id']}", headers=normal_user_token_headers)
        assert r2.status_code == 404

    def test_delete_solution_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.delete(f"{BASE}/{uuid.uuid4()}", headers=normal_user_token_headers)
        assert r.status_code == 404


class TestSolutionsIDOR:
    def test_get_other_user_solution_forbidden(
        self, client: TestClient, superuser_token_headers: dict[str, str], normal_user_token_headers: dict[str, str]
    ) -> None:
        sol = create_solution(client, superuser_token_headers)
        r = client.get(f"{BASE}/{sol['id']}", headers=normal_user_token_headers)
        assert r.status_code == 403

    def test_update_other_user_solution_forbidden(
        self, client: TestClient, superuser_token_headers: dict[str, str], normal_user_token_headers: dict[str, str]
    ) -> None:
        sol = create_solution(client, superuser_token_headers)
        r = client.put(f"{BASE}/{sol['id']}", json={"name": "hacked"}, headers=normal_user_token_headers)
        assert r.status_code == 403

    def test_delete_other_user_solution_forbidden(
        self, client: TestClient, superuser_token_headers: dict[str, str], normal_user_token_headers: dict[str, str]
    ) -> None:
        sol = create_solution(client, superuser_token_headers)
        r = client.delete(f"{BASE}/{sol['id']}", headers=normal_user_token_headers)
        assert r.status_code == 403


class TestSolutionsSuperuser:
    def test_superuser_sees_all_solutions(
        self,
        client: TestClient,
        normal_user_token_headers: dict[str, str],
        superuser_token_headers: dict[str, str],
    ) -> None:
        create_solution(client, normal_user_token_headers)
        r = client.get(f"{BASE}/", headers=superuser_token_headers)
        assert r.status_code == 200
        assert r.json()["count"] >= 1

    def test_superuser_can_update_any_solution(
        self,
        client: TestClient,
        normal_user_token_headers: dict[str, str],
        superuser_token_headers: dict[str, str],
    ) -> None:
        sol = create_solution(client, normal_user_token_headers)
        r = client.put(
            f"{BASE}/{sol['id']}",
            json={"name": "super-updated"},
            headers=superuser_token_headers,
        )
        assert r.status_code == 200
