from fastapi.testclient import TestClient

from app.core.config import settings

BASE = f"{settings.API_V1_STR}/state"


class TestStateAuth:
    def test_get_state_requires_auth(self, client: TestClient) -> None:
        assert client.get(f"{BASE}/").status_code == 401

    def test_put_state_requires_auth(self, client: TestClient) -> None:
        assert client.put(f"{BASE}/", json={"ui_prefs": {}}).status_code == 401

    def test_get_bulk_requires_auth(self, client: TestClient) -> None:
        assert client.get(f"{BASE}/bulk").status_code == 401


class TestStateGet:
    def test_get_state_empty(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.get(f"{BASE}/", headers=normal_user_token_headers)
        assert r.status_code == 200
        data = r.json()
        assert "data" in data
        assert isinstance(data["data"], dict)


class TestStatePut:
    def test_put_ui_prefs_only(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.put(
            f"{BASE}/",
            json={"ui_prefs": {"activePanel": "materials", "zoom": 2}},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        data = r.json()["data"]
        assert data["ui_prefs"]["activePanel"] == "materials"
        # Round-trip
        r2 = client.get(f"{BASE}/", headers=normal_user_token_headers)
        assert r2.json()["data"]["ui_prefs"]["zoom"] == 2

    def test_put_rejects_non_ui_prefs_keys(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        # Missing required ui_prefs key -> 422
        r = client.put(
            f"{BASE}/",
            json={"materials": []},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 422


class TestStateBulk:
    def test_bulk_shape(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.get(f"{BASE}/bulk", headers=normal_user_token_headers)
        assert r.status_code == 200
        data = r.json()
        for key in (
            "materials",
            "solutions",
            "processes",
            "experiments",
            "results",
            "analyses",
            "planes",
        ):
            assert key in data
            assert isinstance(data[key], list)

    def test_bulk_includes_created_entities(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        client.post(
            f"{settings.API_V1_STR}/materials/",
            json={"name": "BulkMat"},
            headers=normal_user_token_headers,
        )
        client.post(
            f"{settings.API_V1_STR}/processes/",
            json={"name": "BulkProc"},
            headers=normal_user_token_headers,
        )
        r = client.get(f"{BASE}/bulk", headers=normal_user_token_headers)
        assert r.status_code == 200
        data = r.json()
        assert any(m["name"] == "BulkMat" for m in data["materials"])
        assert any(p["name"] == "BulkProc" for p in data["processes"])
