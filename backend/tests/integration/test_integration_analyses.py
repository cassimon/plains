"""Integration: analyses CRUD, refs, ownership."""

import uuid
import httpx
import pytest
from .conftest import API_V1


def _analysis(headers, **kw) -> dict:
    r = httpx.post(
        f"{API_V1}/analyses/",
        json={"name": f"analysis-{uuid.uuid4().hex[:6]}", **kw},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


class TestAnalysesCRUD:
    def test_create_read_update_delete(self, user_headers):
        a = _analysis(user_headers, description="test analysis")
        aid = a["id"]
        assert a["description"] == "test analysis"
        assert a["refs"] == []

        r = httpx.get(f"{API_V1}/analyses/{aid}", headers=user_headers)
        assert r.json()["id"] == aid

        r = httpx.put(
            f"{API_V1}/analyses/{aid}",
            json={"name": "renamed"},
            headers=user_headers,
        )
        assert r.json()["name"] == "renamed"

        assert httpx.delete(f"{API_V1}/analyses/{aid}", headers=user_headers).status_code == 200
        assert httpx.get(f"{API_V1}/analyses/{aid}", headers=user_headers).status_code == 404

    def test_create_with_refs(self, user_headers):
        ref_id = uuid.uuid4()
        a = _analysis(
            user_headers,
            refs=[{"kind": "experiment_results", "entity_id": str(ref_id)}],
        )
        assert len(a["refs"]) == 1
        assert a["refs"][0]["kind"] == "experiment_results"
        httpx.delete(f"{API_V1}/analyses/{a['id']}", headers=user_headers)

    def test_list_analyses(self, user_headers):
        a = _analysis(user_headers)
        r = httpx.get(f"{API_V1}/analyses/", headers=user_headers)
        assert r.status_code == 200
        data = r.json()
        assert data["count"] >= 1
        ids = [x["id"] for x in data["data"]]
        assert a["id"] in ids
        httpx.delete(f"{API_V1}/analyses/{a['id']}", headers=user_headers)

    def test_not_found(self, user_headers):
        assert httpx.get(f"{API_V1}/analyses/{uuid.uuid4()}", headers=user_headers).status_code == 404

    def test_idor(self, superuser_headers, user_headers):
        a = _analysis(superuser_headers)
        assert httpx.get(f"{API_V1}/analyses/{a['id']}", headers=user_headers).status_code == 403
        httpx.delete(f"{API_V1}/analyses/{a['id']}", headers=superuser_headers)
