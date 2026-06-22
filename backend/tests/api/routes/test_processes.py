import uuid

from fastapi.testclient import TestClient

from app.core.config import settings
from tests.utils.utils import random_lower_string

BASE = f"{settings.API_V1_STR}/processes"


def create_process(client: TestClient, headers: dict, **kwargs) -> dict:
    payload = {"name": random_lower_string(), **kwargs}
    r = client.post(f"{BASE}/", json=payload, headers=headers)
    assert r.status_code == 200
    return r.json()


class TestProcessesAuth:
    def test_list_requires_auth(self, client: TestClient) -> None:
        assert client.get(f"{BASE}/").status_code == 401

    def test_create_requires_auth(self, client: TestClient) -> None:
        assert client.post(f"{BASE}/", json={"name": "x"}).status_code == 401

    def test_get_requires_auth(self, client: TestClient) -> None:
        assert client.get(f"{BASE}/{uuid.uuid4()}").status_code == 401

    def test_delete_requires_auth(self, client: TestClient) -> None:
        assert client.delete(f"{BASE}/{uuid.uuid4()}").status_code == 401


class TestProcessesCRUD:
    def test_create_process(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        name = random_lower_string()
        r = client.post(
            f"{BASE}/",
            json={"name": name, "skip_chemistry": True},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["name"] == name
        assert data["skip_chemistry"] is True
        assert "owner_id" in data
        assert data["recipes"] == []
        assert data["steps"] == []
        assert data["stacks"] == []

    def test_create_missing_name(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(f"{BASE}/", json={}, headers=normal_user_token_headers)
        assert r.status_code == 422

    def test_get_process(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        proc = create_process(client, normal_user_token_headers)
        r = client.get(f"{BASE}/{proc['id']}", headers=normal_user_token_headers)
        assert r.status_code == 200
        assert r.json()["id"] == proc["id"]

    def test_get_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.get(f"{BASE}/{uuid.uuid4()}", headers=normal_user_token_headers)
        assert r.status_code == 404

    def test_update_process(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        proc = create_process(client, normal_user_token_headers)
        new_name = random_lower_string()
        r = client.put(
            f"{BASE}/{proc['id']}",
            json={"name": new_name},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        assert r.json()["name"] == new_name

    def test_delete_process(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        proc = create_process(client, normal_user_token_headers)
        r = client.delete(f"{BASE}/{proc['id']}", headers=normal_user_token_headers)
        assert r.status_code == 200
        g = client.get(f"{BASE}/{proc['id']}", headers=normal_user_token_headers)
        assert g.status_code == 404

    def test_delete_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.delete(f"{BASE}/{uuid.uuid4()}", headers=normal_user_token_headers)
        assert r.status_code == 404

    def test_sub_resource_lists(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        proc = create_process(client, normal_user_token_headers)
        for sub in ("recipes", "steps", "stacks"):
            r = client.get(
                f"{BASE}/{proc['id']}/{sub}/", headers=normal_user_token_headers
            )
            assert r.status_code == 200
            assert r.json() == []


class TestProcessesIDOR:
    def test_get_other_user_forbidden(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        proc = create_process(client, superuser_token_headers)
        r = client.get(f"{BASE}/{proc['id']}", headers=normal_user_token_headers)
        assert r.status_code == 403

    def test_update_other_user_forbidden(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        proc = create_process(client, superuser_token_headers)
        r = client.put(
            f"{BASE}/{proc['id']}",
            json={"name": "x"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403

    def test_delete_other_user_forbidden(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        proc = create_process(client, superuser_token_headers)
        r = client.delete(f"{BASE}/{proc['id']}", headers=normal_user_token_headers)
        assert r.status_code == 403
