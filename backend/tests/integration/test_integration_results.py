"""Integration: experiment results CRUD, ownership."""

import uuid
import httpx
import pytest
from .conftest import API_V1


def _exp(headers) -> dict:
    r = httpx.post(
        f"{API_V1}/experiments/",
        json={"name": f"exp-{uuid.uuid4().hex[:6]}"},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _result(headers, experiment_id: str, **kw) -> dict:
    r = httpx.post(
        f"{API_V1}/results/",
        json=kw,
        params={"experiment_id": experiment_id},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


class TestResultsCRUD:
    def test_create_read_update_delete(self, user_headers):
        exp = _exp(user_headers)
        res = _result(user_headers, exp["id"], notes="initial notes")
        rid = res["id"]
        assert res["notes"] == "initial notes"
        assert res["experiment_id"] == exp["id"]

        # Read single
        r = httpx.get(f"{API_V1}/results/{rid}", headers=user_headers)
        assert r.status_code == 200
        assert r.json()["id"] == rid

        # Update
        r = httpx.put(
            f"{API_V1}/results/{rid}",
            json={"notes": "updated notes"},
            headers=user_headers,
        )
        assert r.status_code == 200
        assert r.json()["notes"] == "updated notes"

        # Delete
        assert httpx.delete(f"{API_V1}/results/{rid}", headers=user_headers).status_code == 200
        assert httpx.get(f"{API_V1}/results/{rid}", headers=user_headers).status_code == 404

        httpx.delete(f"{API_V1}/experiments/{exp['id']}", headers=user_headers)

    def test_list_results(self, user_headers):
        exp = _exp(user_headers)
        _result(user_headers, exp["id"])
        r = httpx.get(f"{API_V1}/results/", headers=user_headers)
        assert r.status_code == 200
        assert r.json()["count"] >= 1
        httpx.delete(f"{API_V1}/experiments/{exp['id']}", headers=user_headers)

    def test_cascade_delete_with_experiment(self, user_headers):
        exp = _exp(user_headers)
        res = _result(user_headers, exp["id"])
        rid = res["id"]

        httpx.delete(f"{API_V1}/experiments/{exp['id']}", headers=user_headers)
        assert httpx.get(f"{API_V1}/results/{rid}", headers=user_headers).status_code == 404

    def test_idor_read(self, superuser_headers, user_headers):
        exp = _exp(superuser_headers)
        res = _result(superuser_headers, exp["id"])
        assert httpx.get(f"{API_V1}/results/{res['id']}", headers=user_headers).status_code == 403
        httpx.delete(f"{API_V1}/experiments/{exp['id']}", headers=superuser_headers)

    def test_idor_update(self, superuser_headers, user_headers):
        exp = _exp(superuser_headers)
        res = _result(superuser_headers, exp["id"])
        r = httpx.put(
            f"{API_V1}/results/{res['id']}",
            json={"notes": "hacked"},
            headers=user_headers,
        )
        assert r.status_code == 403
        httpx.delete(f"{API_V1}/experiments/{exp['id']}", headers=superuser_headers)

    def test_idor_delete(self, superuser_headers, user_headers):
        exp = _exp(superuser_headers)
        res = _result(superuser_headers, exp["id"])
        assert httpx.delete(f"{API_V1}/results/{res['id']}", headers=user_headers).status_code == 403
        httpx.delete(f"{API_V1}/experiments/{exp['id']}", headers=superuser_headers)

    def test_read_not_found(self, user_headers):
        assert httpx.get(f"{API_V1}/results/{uuid.uuid4()}", headers=user_headers).status_code == 404
