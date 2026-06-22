import uuid

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.core.config import settings
from tests.utils.utils import random_lower_string

BASE = f"{settings.API_V1_STR}/materials"


def create_material(client: TestClient, headers: dict, name: str | None = None) -> dict:
    data = {"name": name or random_lower_string()}
    r = client.post(f"{BASE}/", json=data, headers=headers)
    assert r.status_code == 200
    return r.json()


class TestMaterialsAuth:
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


class TestMaterialsCRUD:
    def test_create_material(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        name = random_lower_string()
        r = client.post(
            f"{BASE}/", json={"name": name}, headers=normal_user_token_headers
        )
        assert r.status_code == 200
        data = r.json()
        assert data["name"] == name
        assert "id" in data
        assert "owner_id" in data

    def test_create_material_with_optional_fields(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        payload = {
            "name": random_lower_string(),
            "cas_number": "64-17-5",
            "molecular_weight": 46.07,
            "density": 0.789,
            "supplier": "Sigma-Aldrich",
            "notes": "test notes",
        }
        r = client.post(f"{BASE}/", json=payload, headers=normal_user_token_headers)
        assert r.status_code == 200
        data = r.json()
        assert data["cas_number"] == "64-17-5"
        assert data["supplier"] == "Sigma-Aldrich"

    def test_create_material_missing_name(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(f"{BASE}/", json={}, headers=normal_user_token_headers)
        assert r.status_code == 422

    def test_list_materials(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        create_material(client, normal_user_token_headers)
        r = client.get(f"{BASE}/", headers=normal_user_token_headers)
        assert r.status_code == 200
        data = r.json()
        assert "data" in data
        assert "count" in data
        assert data["count"] >= 1

    def test_get_material_by_id(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        mat = create_material(client, normal_user_token_headers)
        r = client.get(f"{BASE}/{mat['id']}", headers=normal_user_token_headers)
        assert r.status_code == 200
        assert r.json()["id"] == mat["id"]

    def test_get_material_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.get(f"{BASE}/{uuid.uuid4()}", headers=normal_user_token_headers)
        assert r.status_code == 404

    def test_update_material(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        mat = create_material(client, normal_user_token_headers)
        new_name = random_lower_string()
        r = client.put(
            f"{BASE}/{mat['id']}",
            json={"name": new_name},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        assert r.json()["name"] == new_name

    def test_update_material_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.put(
            f"{BASE}/{uuid.uuid4()}",
            json={"name": "x"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 404

    def test_delete_material(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        mat = create_material(client, normal_user_token_headers)
        r = client.delete(f"{BASE}/{mat['id']}", headers=normal_user_token_headers)
        assert r.status_code == 200
        assert r.json()["ok"] is True

        r2 = client.get(f"{BASE}/{mat['id']}", headers=normal_user_token_headers)
        assert r2.status_code == 404

    def test_delete_material_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.delete(f"{BASE}/{uuid.uuid4()}", headers=normal_user_token_headers)
        assert r.status_code == 404


class TestMaterialsIDOR:
    def test_material_owner_id_set_correctly(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        """Material owner_id is set to the creating user, not null."""
        mat = create_material(client, normal_user_token_headers)
        assert mat["owner_id"] is not None

    def test_update_other_user_material_forbidden(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        """Normal user cannot update a material owned by superuser."""
        mat = create_material(client, superuser_token_headers)
        r = client.put(
            f"{BASE}/{mat['id']}",
            json={"name": "hacked"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403

    def test_delete_other_user_material_forbidden(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        mat = create_material(client, superuser_token_headers)
        r = client.delete(f"{BASE}/{mat['id']}", headers=normal_user_token_headers)
        assert r.status_code == 403

    def test_get_other_user_material_forbidden(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        mat = create_material(client, superuser_token_headers)
        r = client.get(f"{BASE}/{mat['id']}", headers=normal_user_token_headers)
        assert r.status_code == 403


class TestMaterialsSuperuser:
    def test_superuser_sees_all_materials(
        self,
        client: TestClient,
        normal_user_token_headers: dict[str, str],
        superuser_token_headers: dict[str, str],
    ) -> None:
        create_material(client, normal_user_token_headers)
        r = client.get(f"{BASE}/", headers=superuser_token_headers)
        assert r.status_code == 200
        assert r.json()["count"] >= 1

    def test_superuser_can_update_normal_user_material(
        self,
        client: TestClient,
        normal_user_token_headers: dict[str, str],
        superuser_token_headers: dict[str, str],
    ) -> None:
        mat = create_material(client, normal_user_token_headers)
        r = client.put(
            f"{BASE}/{mat['id']}",
            json={"name": "superuser-updated"},
            headers=superuser_token_headers,
        )
        assert r.status_code == 200

    def test_superuser_can_delete_normal_user_material(
        self,
        client: TestClient,
        normal_user_token_headers: dict[str, str],
        superuser_token_headers: dict[str, str],
    ) -> None:
        mat = create_material(client, normal_user_token_headers)
        r = client.delete(f"{BASE}/{mat['id']}", headers=superuser_token_headers)
        assert r.status_code == 200
