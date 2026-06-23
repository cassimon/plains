"""Integration: experiments CRUD, material/solution linking, ownership."""

import uuid
import httpx
import pytest
from .conftest import API_V1


def _exp(headers, **kw) -> dict:
    r = httpx.post(
        f"{API_V1}/experiments/",
        json={"name": f"exp-{uuid.uuid4().hex[:6]}", **kw},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _mat(headers) -> dict:
    r = httpx.post(
        f"{API_V1}/materials/",
        json={"name": f"mat-{uuid.uuid4().hex[:6]}", "type": "substrate"},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _sol(headers) -> dict:
    r = httpx.post(
        f"{API_V1}/solutions/",
        json={"name": f"sol-{uuid.uuid4().hex[:6]}"},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


class TestExperimentCRUD:
    def test_create_read_update_delete(self, user_headers):
        exp = _exp(user_headers, description="test experiment")
        eid = exp["id"]
        assert exp["description"] == "test experiment"
        assert exp["material_refs"] == []
        assert exp["solution_refs"] == []

        # Read
        r = httpx.get(f"{API_V1}/experiments/{eid}", headers=user_headers)
        assert r.json()["id"] == eid

        # Update
        r = httpx.put(
            f"{API_V1}/experiments/{eid}",
            json={"name": "renamed-exp"},
            headers=user_headers,
        )
        assert r.json()["name"] == "renamed-exp"

        # Delete
        assert httpx.delete(f"{API_V1}/experiments/{eid}", headers=user_headers).status_code == 200
        assert httpx.get(f"{API_V1}/experiments/{eid}", headers=user_headers).status_code == 404

    def test_create_missing_name_returns_422(self, user_headers):
        r = httpx.post(f"{API_V1}/experiments/", json={}, headers=user_headers)
        assert r.status_code == 422

    def test_list_experiments(self, user_headers):
        exp = _exp(user_headers)
        r = httpx.get(f"{API_V1}/experiments/", headers=user_headers)
        assert r.status_code == 200
        data = r.json()
        assert data["count"] >= 1
        ids = [e["id"] for e in data["data"]]
        assert exp["id"] in ids
        httpx.delete(f"{API_V1}/experiments/{exp['id']}", headers=user_headers)

    def test_idor(self, superuser_headers, user_headers):
        exp = _exp(superuser_headers)
        assert httpx.get(f"{API_V1}/experiments/{exp['id']}", headers=user_headers).status_code == 403
        httpx.delete(f"{API_V1}/experiments/{exp['id']}", headers=superuser_headers)


class TestExperimentMaterials:
    def test_link_and_replace_materials(self, user_headers):
        exp = _exp(user_headers)
        mat1 = _mat(user_headers)
        mat2 = _mat(user_headers)
        eid = exp["id"]

        # Link mat1
        r = httpx.put(
            f"{API_V1}/experiments/{eid}/materials",
            json={"ids": [mat1["id"]]},
            headers=user_headers,
        )
        assert r.status_code == 200
        assert len(r.json()["material_refs"]) == 1

        # Replace with mat2
        r = httpx.put(
            f"{API_V1}/experiments/{eid}/materials",
            json={"ids": [mat2["id"]]},
            headers=user_headers,
        )
        assert len(r.json()["material_refs"]) == 1
        assert r.json()["material_refs"][0]["material_id"] == mat2["id"]

        # Clear
        r = httpx.put(
            f"{API_V1}/experiments/{eid}/materials",
            json={"ids": []},
            headers=user_headers,
        )
        assert r.json()["material_refs"] == []

        httpx.delete(f"{API_V1}/experiments/{eid}", headers=user_headers)
        httpx.delete(f"{API_V1}/materials/{mat1['id']}", headers=user_headers)
        httpx.delete(f"{API_V1}/materials/{mat2['id']}", headers=user_headers)


class TestExperimentSolutions:
    def test_link_and_replace_solutions(self, user_headers):
        exp = _exp(user_headers)
        sol = _sol(user_headers)
        eid = exp["id"]

        r = httpx.put(
            f"{API_V1}/experiments/{eid}/solutions",
            json={"ids": [sol["id"]]},
            headers=user_headers,
        )
        assert r.status_code == 200
        assert len(r.json()["solution_refs"]) == 1

        r = httpx.put(
            f"{API_V1}/experiments/{eid}/solutions",
            json={"ids": []},
            headers=user_headers,
        )
        assert r.json()["solution_refs"] == []

        httpx.delete(f"{API_V1}/experiments/{eid}", headers=user_headers)
        httpx.delete(f"{API_V1}/solutions/{sol['id']}", headers=user_headers)


class TestExperimentWithSubstrates:
    def test_create_with_substrates(self, user_headers):
        exp = _exp(
            user_headers,
            substrates=[{"name": "Sub1", "position": 0}],
        )
        assert len(exp["substrates"]) == 1
        assert exp["substrates"][0]["name"] == "Sub1"
        httpx.delete(f"{API_V1}/experiments/{exp['id']}", headers=user_headers)
