import uuid

from fastapi.testclient import TestClient

from app.core.config import settings
from tests.utils.utils import random_lower_string

BASE = f"{settings.API_V1_STR}/experiments"


def create_experiment(
    client: TestClient, headers: dict, name: str | None = None, **kwargs
) -> dict:
    payload = {"name": name or random_lower_string(), **kwargs}
    r = client.post(f"{BASE}/", json=payload, headers=headers)
    assert r.status_code == 200
    return r.json()


class TestExperimentsAuth:
    def test_list_requires_auth(self, client: TestClient) -> None:
        assert client.get(f"{BASE}/").status_code == 401

    def test_get_requires_auth(self, client: TestClient) -> None:
        assert client.get(f"{BASE}/{uuid.uuid4()}").status_code == 401

    def test_create_requires_auth(self, client: TestClient) -> None:
        assert client.post(f"{BASE}/", json={"name": "x"}).status_code == 401

    def test_update_requires_auth(self, client: TestClient) -> None:
        assert (
            client.put(f"{BASE}/{uuid.uuid4()}", json={"name": "x"}).status_code == 401
        )

    def test_delete_requires_auth(self, client: TestClient) -> None:
        assert client.delete(f"{BASE}/{uuid.uuid4()}").status_code == 401


class TestExperimentsCRUD:
    def test_create_experiment(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        name = random_lower_string()
        r = client.post(
            f"{BASE}/", json={"name": name}, headers=normal_user_token_headers
        )
        assert r.status_code == 200
        data = r.json()
        assert data["name"] == name
        assert "id" in data
        assert data["substrates"] == []
        assert data["material_refs"] == []
        assert data["solution_refs"] == []

    def test_create_experiment_with_substrates(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        payload = {
            "name": random_lower_string(),
            "description": "Test experiment",
            "architecture": "n-i-p",
            "device_area": 0.09,
            "substrates": [{"name": "ITO", "outcome_status": "complete"}],
        }
        r = client.post(f"{BASE}/", json=payload, headers=normal_user_token_headers)
        assert r.status_code == 200
        data = r.json()
        assert len(data["substrates"]) == 1
        assert data["substrates"][0]["name"] == "ITO"
        assert data["architecture"] == "n-i-p"

    def test_create_experiment_missing_name(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(f"{BASE}/", json={}, headers=normal_user_token_headers)
        assert r.status_code == 422

    def test_list_experiments(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        create_experiment(client, normal_user_token_headers)
        r = client.get(f"{BASE}/", headers=normal_user_token_headers)
        assert r.status_code == 200
        data = r.json()
        assert "data" in data
        assert data["count"] >= 1

    def test_get_experiment_by_id(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        exp = create_experiment(client, normal_user_token_headers)
        r = client.get(f"{BASE}/{exp['id']}", headers=normal_user_token_headers)
        assert r.status_code == 200
        assert r.json()["id"] == exp["id"]

    def test_get_experiment_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.get(f"{BASE}/{uuid.uuid4()}", headers=normal_user_token_headers)
        assert r.status_code == 404

    def test_update_experiment(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        exp = create_experiment(client, normal_user_token_headers)
        new_name = random_lower_string()
        r = client.put(
            f"{BASE}/{exp['id']}",
            json={"name": new_name},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        assert r.json()["name"] == new_name

    def test_update_experiment_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.put(
            f"{BASE}/{uuid.uuid4()}",
            json={"name": "x"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 404

    def test_delete_experiment(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        exp = create_experiment(client, normal_user_token_headers)
        r = client.delete(f"{BASE}/{exp['id']}", headers=normal_user_token_headers)
        assert r.status_code == 200
        assert r.json()["ok"] is True
        assert (
            client.get(
                f"{BASE}/{exp['id']}", headers=normal_user_token_headers
            ).status_code
            == 404
        )

    def test_delete_experiment_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.delete(f"{BASE}/{uuid.uuid4()}", headers=normal_user_token_headers)
        assert r.status_code == 404


class TestExperimentsIDOR:
    def test_get_other_user_experiment_forbidden(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        exp = create_experiment(client, superuser_token_headers)
        r = client.get(f"{BASE}/{exp['id']}", headers=normal_user_token_headers)
        assert r.status_code == 403

    def test_update_other_user_experiment_forbidden(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        exp = create_experiment(client, superuser_token_headers)
        r = client.put(
            f"{BASE}/{exp['id']}",
            json={"name": "hacked"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403

    def test_delete_other_user_experiment_forbidden(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        exp = create_experiment(client, superuser_token_headers)
        r = client.delete(f"{BASE}/{exp['id']}", headers=normal_user_token_headers)
        assert r.status_code == 403


class TestExperimentsSuperuser:
    def test_superuser_sees_all_experiments(
        self,
        client: TestClient,
        normal_user_token_headers: dict[str, str],
        superuser_token_headers: dict[str, str],
    ) -> None:
        create_experiment(client, normal_user_token_headers)
        r = client.get(f"{BASE}/", headers=superuser_token_headers)
        assert r.status_code == 200
        assert r.json()["count"] >= 1


MATERIALS = f"{settings.API_V1_STR}/materials"
SOLUTIONS = f"{settings.API_V1_STR}/solutions"


class TestExperimentJunctions:
    def test_set_materials_and_solutions(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        exp = create_experiment(client, normal_user_token_headers)
        mat = client.post(
            f"{MATERIALS}/",
            json={"name": random_lower_string()},
            headers=normal_user_token_headers,
        ).json()
        sol = client.post(
            f"{SOLUTIONS}/",
            json={"name": random_lower_string()},
            headers=normal_user_token_headers,
        ).json()

        r = client.put(
            f"{BASE}/{exp['id']}/materials",
            json={"ids": [mat["id"]]},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        data = r.json()
        assert len(data["material_refs"]) == 1
        assert data["material_refs"][0]["material_id"] == mat["id"]

        r = client.put(
            f"{BASE}/{exp['id']}/solutions",
            json={"ids": [sol["id"]]},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        data = r.json()
        assert len(data["solution_refs"]) == 1
        assert data["solution_refs"][0]["solution_id"] == sol["id"]

        # Clearing removes refs
        r = client.put(
            f"{BASE}/{exp['id']}/materials",
            json={"ids": []},
            headers=normal_user_token_headers,
        )
        assert r.json()["material_refs"] == []

    def test_set_materials_requires_auth(self, client: TestClient) -> None:
        r = client.put(f"{BASE}/{uuid.uuid4()}/materials", json={"ids": []})
        assert r.status_code == 401

    def test_set_materials_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.put(
            f"{BASE}/{uuid.uuid4()}/materials",
            json={"ids": []},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 404

    def test_set_materials_other_user_forbidden(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        exp = create_experiment(client, superuser_token_headers)
        r = client.put(
            f"{BASE}/{exp['id']}/materials",
            json={"ids": []},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403
