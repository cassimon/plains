"""Integration: user state (ui_prefs) and bulk state endpoint."""

import httpx
import pytest
from .conftest import API_V1


class TestUserState:
    def test_get_state_returns_empty_for_new_user(self, user_headers):
        r = httpx.get(f"{API_V1}/state/", headers=user_headers)
        assert r.status_code == 200
        data = r.json()
        assert "data" in data

    def test_put_state_saves_ui_prefs(self, user_headers):
        prefs = {"sidebar_open": True, "theme": "dark"}
        r = httpx.put(
            f"{API_V1}/state/",
            json={"ui_prefs": prefs},
            headers=user_headers,
        )
        assert r.status_code == 200
        assert r.json()["data"]["ui_prefs"] == prefs

    def test_get_state_returns_saved_prefs(self, user_headers):
        prefs = {"test_key": "test_value"}
        httpx.put(f"{API_V1}/state/", json={"ui_prefs": prefs}, headers=user_headers)
        r = httpx.get(f"{API_V1}/state/", headers=user_headers)
        assert r.json()["data"]["ui_prefs"] == prefs

    def test_put_state_rejects_extra_keys(self, user_headers):
        r = httpx.put(
            f"{API_V1}/state/",
            json={"ui_prefs": {"x": 1}, "domain_key": "should_reject"},
            headers=user_headers,
        )
        assert r.status_code == 422

    def test_put_state_requires_ui_prefs(self, user_headers):
        r = httpx.put(f"{API_V1}/state/", json={"not_ui_prefs": {}}, headers=user_headers)
        assert r.status_code == 422

    def test_state_requires_auth(self):
        assert httpx.get(f"{API_V1}/state/").status_code == 401
        assert httpx.put(f"{API_V1}/state/", json={"ui_prefs": {}}).status_code == 401


class TestBulkState:
    def test_bulk_returns_all_entity_keys(self, user_headers):
        r = httpx.get(f"{API_V1}/state/bulk", headers=user_headers)
        assert r.status_code == 200
        data = r.json()
        for key in ("materials", "solutions", "processes", "experiments", "results", "analyses", "planes"):
            assert key in data, f"missing key: {key}"

    def test_bulk_returns_only_own_data(self, user_headers, superuser_headers):
        # Create a material as superuser
        r = httpx.post(
            f"{API_V1}/materials/",
            json={"name": "super-mat", "type": "other"},
            headers=superuser_headers,
        )
        assert r.status_code == 200
        mat_id = r.json()["id"]

        # Regular user's bulk state should not include superuser's material
        bulk = httpx.get(f"{API_V1}/state/bulk", headers=user_headers).json()
        ids = [m["id"] for m in bulk["materials"]]
        assert mat_id not in ids

        httpx.delete(f"{API_V1}/materials/{mat_id}", headers=superuser_headers)

    def test_bulk_requires_auth(self):
        assert httpx.get(f"{API_V1}/state/bulk").status_code == 401
