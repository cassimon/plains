"""Integration: solutions CRUD, components, ownership."""

import uuid
import httpx
import pytest
from .conftest import API_V1


def _create(headers, **kwargs) -> dict:
    payload = {"name": f"sol-{uuid.uuid4().hex[:8]}", **kwargs}
    r = httpx.post(f"{API_V1}/solutions/", json=payload, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


class TestSolutionsCRUD:
    def test_list_empty_for_new_user(self, user_headers):
        r = httpx.get(f"{API_V1}/solutions/", headers=user_headers)
        assert r.status_code == 200
        data = r.json()
        assert data["count"] == 0
        assert data["data"] == []

    def test_create_solution(self, user_headers):
        sol = _create(user_headers, type="precursor", notes="test notes")
        assert sol["type"] == "precursor"
        assert sol["notes"] == "test notes"
        assert "id" in sol and "owner_id" in sol
        assert sol["components"] == []

        r = httpx.get(f"{API_V1}/solutions/", headers=user_headers)
        assert r.json()["count"] == 1

        httpx.delete(f"{API_V1}/solutions/{sol['id']}", headers=user_headers)

    def test_create_with_components(self, user_headers):
        sol = _create(
            user_headers,
            components=[{"amount": 1.5, "unit": "ml"}],
        )
        assert len(sol["components"]) == 1
        assert sol["components"][0]["amount"] == 1.5
        httpx.delete(f"{API_V1}/solutions/{sol['id']}", headers=user_headers)

    def test_create_missing_name_returns_422(self, user_headers):
        r = httpx.post(f"{API_V1}/solutions/", json={}, headers=user_headers)
        assert r.status_code == 422

    def test_read_solution(self, user_headers):
        sol = _create(user_headers)
        r = httpx.get(f"{API_V1}/solutions/{sol['id']}", headers=user_headers)
        assert r.status_code == 200
        assert r.json()["id"] == sol["id"]
        httpx.delete(f"{API_V1}/solutions/{sol['id']}", headers=user_headers)

    def test_read_not_found(self, user_headers):
        r = httpx.get(f"{API_V1}/solutions/{uuid.uuid4()}", headers=user_headers)
        assert r.status_code == 404

    def test_update_solution(self, user_headers):
        sol = _create(user_headers)
        r = httpx.put(
            f"{API_V1}/solutions/{sol['id']}",
            json={"name": "updated-sol"},
            headers=user_headers,
        )
        assert r.status_code == 200
        assert r.json()["name"] == "updated-sol"
        httpx.delete(f"{API_V1}/solutions/{sol['id']}", headers=user_headers)

    def test_delete_solution(self, user_headers):
        sol = _create(user_headers)
        r = httpx.delete(f"{API_V1}/solutions/{sol['id']}", headers=user_headers)
        assert r.status_code == 200
        assert httpx.get(f"{API_V1}/solutions/{sol['id']}", headers=user_headers).status_code == 404

    def test_delete_not_found(self, user_headers):
        r = httpx.delete(f"{API_V1}/solutions/{uuid.uuid4()}", headers=user_headers)
        assert r.status_code == 404


class TestSolutionsAuth:
    def test_list_requires_auth(self):
        assert httpx.get(f"{API_V1}/solutions/").status_code == 401

    def test_create_requires_auth(self):
        assert httpx.post(f"{API_V1}/solutions/", json={"name": "x"}).status_code == 401


class TestSolutionsIDOR:
    def test_cannot_read_other_users_solution(self, superuser_headers, user_headers):
        sol = _create(superuser_headers)
        r = httpx.get(f"{API_V1}/solutions/{sol['id']}", headers=user_headers)
        assert r.status_code == 403
        httpx.delete(f"{API_V1}/solutions/{sol['id']}", headers=superuser_headers)

    def test_cannot_update_other_users_solution(self, superuser_headers, user_headers):
        sol = _create(superuser_headers)
        r = httpx.put(
            f"{API_V1}/solutions/{sol['id']}",
            json={"name": "hacked"},
            headers=user_headers,
        )
        assert r.status_code == 403
        httpx.delete(f"{API_V1}/solutions/{sol['id']}", headers=superuser_headers)

    def test_cannot_delete_other_users_solution(self, superuser_headers, user_headers):
        sol = _create(superuser_headers)
        r = httpx.delete(f"{API_V1}/solutions/{sol['id']}", headers=user_headers)
        assert r.status_code == 403
        httpx.delete(f"{API_V1}/solutions/{sol['id']}", headers=superuser_headers)
