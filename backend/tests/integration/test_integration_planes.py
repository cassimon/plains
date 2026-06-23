"""Integration: planes CRUD, sub-resources (sticky notes, text fields, collections)."""

import uuid
import httpx
import pytest
from .conftest import API_V1


def _plane(headers, **kw) -> dict:
    r = httpx.post(
        f"{API_V1}/planes/",
        json={"name": f"plane-{uuid.uuid4().hex[:6]}", **kw},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


class TestPlaneCRUD:
    def test_create_read_update_delete(self, user_headers):
        plane = _plane(user_headers)
        pid = plane["id"]
        assert plane["name"].startswith("plane-")

        r = httpx.get(f"{API_V1}/planes/{pid}", headers=user_headers)
        assert r.json()["id"] == pid

        r = httpx.put(f"{API_V1}/planes/{pid}", json={"name": "renamed"}, headers=user_headers)
        assert r.json()["name"] == "renamed"

        assert httpx.delete(f"{API_V1}/planes/{pid}", headers=user_headers).status_code == 200
        assert httpx.get(f"{API_V1}/planes/{pid}", headers=user_headers).status_code == 404

    def test_list_planes(self, user_headers):
        plane = _plane(user_headers)
        r = httpx.get(f"{API_V1}/planes/", headers=user_headers)
        assert r.status_code == 200
        ids = [p["id"] for p in r.json()["data"]]
        assert plane["id"] in ids
        httpx.delete(f"{API_V1}/planes/{plane['id']}", headers=user_headers)

    def test_idor(self, superuser_headers, user_headers):
        plane = _plane(superuser_headers)
        assert httpx.get(f"{API_V1}/planes/{plane['id']}", headers=user_headers).status_code == 403
        httpx.delete(f"{API_V1}/planes/{plane['id']}", headers=superuser_headers)


class TestStickyNotes:
    def test_full_lifecycle(self, user_headers):
        plane = _plane(user_headers)
        pid = plane["id"]

        r = httpx.post(
            f"{API_V1}/planes/{pid}/sticky-notes",
            json={"i": 0, "j": 0, "content": "hello"},
            headers=user_headers,
        )
        assert r.status_code == 200
        note = r.json()
        nid = note["id"]
        assert note["content"] == "hello"

        r = httpx.put(
            f"{API_V1}/planes/{pid}/sticky-notes/{nid}",
            json={"i": 1, "j": 2, "content": "updated"},
            headers=user_headers,
        )
        assert r.json()["content"] == "updated"

        assert httpx.delete(f"{API_V1}/planes/{pid}/sticky-notes/{nid}", headers=user_headers).status_code == 200
        httpx.delete(f"{API_V1}/planes/{pid}", headers=user_headers)


class TestTextFields:
    def test_full_lifecycle(self, user_headers):
        plane = _plane(user_headers)
        pid = plane["id"]

        r = httpx.post(
            f"{API_V1}/planes/{pid}/text-fields",
            json={"i": 0, "j": 0, "content": "label text"},
            headers=user_headers,
        )
        assert r.status_code == 200
        field = r.json()
        fid = field["id"]
        assert field["content"] == "label text"

        r = httpx.put(
            f"{API_V1}/planes/{pid}/text-fields/{fid}",
            json={"i": 0, "j": 0, "content": "updated label"},
            headers=user_headers,
        )
        assert r.json()["content"] == "updated label"

        assert httpx.delete(f"{API_V1}/planes/{pid}/text-fields/{fid}", headers=user_headers).status_code == 200
        httpx.delete(f"{API_V1}/planes/{pid}", headers=user_headers)


class TestDataCollections:
    def test_full_lifecycle(self, user_headers):
        plane = _plane(user_headers)
        pid = plane["id"]

        r = httpx.post(
            f"{API_V1}/planes/{pid}/collections",
            json={"name": "My Collection", "i": 0, "j": 0, "di": 3, "dj": 3},
            headers=user_headers,
        )
        assert r.status_code == 200
        coll = r.json()
        cid = coll["id"]
        assert coll["name"] == "My Collection"

        r = httpx.put(
            f"{API_V1}/planes/{pid}/collections/{cid}",
            json={"name": "Updated Collection", "i": 0, "j": 0, "di": 3, "dj": 3},
            headers=user_headers,
        )
        assert r.json()["name"] == "Updated Collection"

        assert httpx.delete(f"{API_V1}/planes/{pid}/collections/{cid}", headers=user_headers).status_code == 200
        httpx.delete(f"{API_V1}/planes/{pid}", headers=user_headers)
