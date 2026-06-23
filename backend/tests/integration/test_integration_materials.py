"""Integration: materials CRUD, ownership, cascade."""

import uuid
import httpx
import pytest
from .conftest import API_V1


def _create(headers, **kwargs) -> dict:
    payload = {"name": f"mat-{uuid.uuid4().hex[:8]}", "type": "solvent", **kwargs}
    r = httpx.post(f"{API_V1}/materials/", json=payload, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


class TestMaterialsCRUD:
    def test_list_empty_for_new_user(self, user_headers):
        r = httpx.get(f"{API_V1}/materials/", headers=user_headers)
        assert r.status_code == 200
        data = r.json()
        assert data["count"] == 0
        assert data["data"] == []

    def test_create_material(self, user_headers):
        mat = _create(user_headers, type="precursor", purity="99%")
        assert mat["type"] == "precursor"
        assert mat["purity"] == "99%"
        assert "id" in mat and "owner_id" in mat

        # Appears in list
        r = httpx.get(f"{API_V1}/materials/", headers=user_headers)
        assert r.json()["count"] == 1

        # Clean up
        httpx.delete(f"{API_V1}/materials/{mat['id']}", headers=user_headers)

    def test_create_missing_name_returns_422(self, user_headers):
        r = httpx.post(f"{API_V1}/materials/", json={}, headers=user_headers)
        assert r.status_code == 422

    def test_read_material(self, user_headers):
        mat = _create(user_headers)
        r = httpx.get(f"{API_V1}/materials/{mat['id']}", headers=user_headers)
        assert r.status_code == 200
        assert r.json()["id"] == mat["id"]
        httpx.delete(f"{API_V1}/materials/{mat['id']}", headers=user_headers)

    def test_read_not_found(self, user_headers):
        r = httpx.get(f"{API_V1}/materials/{uuid.uuid4()}", headers=user_headers)
        assert r.status_code == 404

    def test_update_material(self, user_headers):
        mat = _create(user_headers)
        r = httpx.put(
            f"{API_V1}/materials/{mat['id']}",
            json={"name": "updated-name"},
            headers=user_headers,
        )
        assert r.status_code == 200
        assert r.json()["name"] == "updated-name"

        # Verify persisted
        r2 = httpx.get(f"{API_V1}/materials/{mat['id']}", headers=user_headers)
        assert r2.json()["name"] == "updated-name"

        httpx.delete(f"{API_V1}/materials/{mat['id']}", headers=user_headers)

    def test_delete_material(self, user_headers):
        mat = _create(user_headers)
        r = httpx.delete(f"{API_V1}/materials/{mat['id']}", headers=user_headers)
        assert r.status_code == 200

        r2 = httpx.get(f"{API_V1}/materials/{mat['id']}", headers=user_headers)
        assert r2.status_code == 404

    def test_delete_not_found(self, user_headers):
        r = httpx.delete(f"{API_V1}/materials/{uuid.uuid4()}", headers=user_headers)
        assert r.status_code == 404


class TestMaterialsAuth:
    def test_list_requires_auth(self):
        assert httpx.get(f"{API_V1}/materials/").status_code == 401

    def test_create_requires_auth(self):
        assert httpx.post(f"{API_V1}/materials/", json={"name": "x"}).status_code == 401


class TestMaterialsIDOR:
    def test_cannot_read_other_users_material(self, superuser_headers, user_headers):
        mat = _create(superuser_headers)
        r = httpx.get(f"{API_V1}/materials/{mat['id']}", headers=user_headers)
        assert r.status_code == 403
        httpx.delete(f"{API_V1}/materials/{mat['id']}", headers=superuser_headers)

    def test_cannot_update_other_users_material(self, superuser_headers, user_headers):
        mat = _create(superuser_headers)
        r = httpx.put(
            f"{API_V1}/materials/{mat['id']}",
            json={"name": "hacked"},
            headers=user_headers,
        )
        assert r.status_code == 403
        httpx.delete(f"{API_V1}/materials/{mat['id']}", headers=superuser_headers)

    def test_cannot_delete_other_users_material(self, superuser_headers, user_headers):
        mat = _create(superuser_headers)
        r = httpx.delete(f"{API_V1}/materials/{mat['id']}", headers=user_headers)
        assert r.status_code == 403
        httpx.delete(f"{API_V1}/materials/{mat['id']}", headers=superuser_headers)
