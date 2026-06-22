import uuid

from fastapi.testclient import TestClient
from sqlmodel import Session

from app.core.config import settings
from tests.utils.utils import random_lower_string

BASE = f"{settings.API_V1_STR}/results"
EXP_BASE = f"{settings.API_V1_STR}/experiments"


def create_experiment(client: TestClient, headers: dict) -> dict:
    r = client.post(f"{EXP_BASE}/", json={"name": random_lower_string()}, headers=headers)
    assert r.status_code == 200
    return r.json()


def create_result(client: TestClient, headers: dict, experiment_id: str) -> dict:
    r = client.post(
        f"{BASE}/",
        params={"experiment_id": experiment_id},
        json={},
        headers=headers,
    )
    assert r.status_code == 200
    return r.json()


class TestResultsAuth:
    def test_list_requires_auth(self, client: TestClient) -> None:
        assert client.get(f"{BASE}/").status_code == 401

    def test_get_requires_auth(self, client: TestClient) -> None:
        assert client.get(f"{BASE}/{uuid.uuid4()}").status_code == 401

    def test_create_requires_auth(self, client: TestClient) -> None:
        r = client.post(f"{BASE}/", params={"experiment_id": str(uuid.uuid4())}, json={})
        assert r.status_code == 401

    def test_update_requires_auth(self, client: TestClient) -> None:
        assert client.put(f"{BASE}/{uuid.uuid4()}", json={}).status_code == 401

    def test_delete_requires_auth(self, client: TestClient) -> None:
        assert client.delete(f"{BASE}/{uuid.uuid4()}").status_code == 401


class TestResultsCRUD:
    def test_create_result(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        exp = create_experiment(client, normal_user_token_headers)
        r = client.post(
            f"{BASE}/",
            params={"experiment_id": exp["id"]},
            json={},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["experiment_id"] == exp["id"]
        assert data["measurement_files"] == []
        assert data["device_groups"] == []

    def test_create_result_with_files_and_groups(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        exp = create_experiment(client, normal_user_token_headers)
        payload = {
            "notes": "test notes",
            "measurement_files": [
                {"filename": "jv_curve.csv", "file_type": "jv", "notes": "JV data"}
            ],
            "device_groups": [{"name": "Group A", "substrate_name": "Sub1"}],
        }
        r = client.post(
            f"{BASE}/",
            params={"experiment_id": exp["id"]},
            json=payload,
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        data = r.json()
        assert len(data["measurement_files"]) == 1
        assert len(data["device_groups"]) == 1

    def test_list_results(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        exp = create_experiment(client, normal_user_token_headers)
        create_result(client, normal_user_token_headers, exp["id"])
        r = client.get(f"{BASE}/", headers=normal_user_token_headers)
        assert r.status_code == 200
        data = r.json()
        assert "data" in data
        assert data["count"] >= 1

    def test_get_result_by_id(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        exp = create_experiment(client, normal_user_token_headers)
        res = create_result(client, normal_user_token_headers, exp["id"])
        r = client.get(f"{BASE}/{res['id']}", headers=normal_user_token_headers)
        assert r.status_code == 200
        assert r.json()["id"] == res["id"]

    def test_get_result_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.get(f"{BASE}/{uuid.uuid4()}", headers=normal_user_token_headers)
        assert r.status_code == 404

    def test_update_result(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        exp = create_experiment(client, normal_user_token_headers)
        res = create_result(client, normal_user_token_headers, exp["id"])
        r = client.put(
            f"{BASE}/{res['id']}",
            json={"notes": "updated notes"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        assert r.json()["notes"] == "updated notes"

    def test_update_result_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.put(
            f"{BASE}/{uuid.uuid4()}", json={}, headers=normal_user_token_headers
        )
        assert r.status_code == 404

    def test_delete_result(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        exp = create_experiment(client, normal_user_token_headers)
        res = create_result(client, normal_user_token_headers, exp["id"])
        r = client.delete(f"{BASE}/{res['id']}", headers=normal_user_token_headers)
        assert r.status_code == 200
        assert r.json()["ok"] is True
        assert (
            client.get(f"{BASE}/{res['id']}", headers=normal_user_token_headers).status_code
            == 404
        )

    def test_delete_result_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.delete(f"{BASE}/{uuid.uuid4()}", headers=normal_user_token_headers)
        assert r.status_code == 404


class TestResultsIDOR:
    def test_get_other_user_result_forbidden(
        self, client: TestClient, superuser_token_headers: dict[str, str], normal_user_token_headers: dict[str, str]
    ) -> None:
        exp = create_experiment(client, superuser_token_headers)
        res = create_result(client, superuser_token_headers, exp["id"])
        r = client.get(f"{BASE}/{res['id']}", headers=normal_user_token_headers)
        assert r.status_code == 403

    def test_update_other_user_result_forbidden(
        self, client: TestClient, superuser_token_headers: dict[str, str], normal_user_token_headers: dict[str, str]
    ) -> None:
        exp = create_experiment(client, superuser_token_headers)
        res = create_result(client, superuser_token_headers, exp["id"])
        r = client.put(f"{BASE}/{res['id']}", json={}, headers=normal_user_token_headers)
        assert r.status_code == 403

    def test_delete_other_user_result_forbidden(
        self, client: TestClient, superuser_token_headers: dict[str, str], normal_user_token_headers: dict[str, str]
    ) -> None:
        exp = create_experiment(client, superuser_token_headers)
        res = create_result(client, superuser_token_headers, exp["id"])
        r = client.delete(f"{BASE}/{res['id']}", headers=normal_user_token_headers)
        assert r.status_code == 403
