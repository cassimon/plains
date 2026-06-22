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


class TestProcessRecipes:
    def test_create_recipe(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        proc = create_process(client, normal_user_token_headers)
        payload = {
            "name": "Perovskite ink",
            "total_solvent_volume_ml": "1.0",
            "solvents": [{"name": "DMF", "volume_ratio": 0.8, "color": ""}],
            "solutes": [{"name": "PbI2", "amount": "461", "unit": "mg", "color": ""}],
            "added_solutions": [],
        }
        r = client.post(
            f"{BASE}/{proc['id']}/recipes/",
            json=payload,
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["name"] == "Perovskite ink"
        assert len(data["solvents"]) == 1
        assert len(data["solutes"]) == 1

    def test_update_recipe(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        proc = create_process(client, normal_user_token_headers)
        payload = {"name": "Ink v1", "total_solvent_volume_ml": "1", "solvents": [], "solutes": [], "added_solutions": []}
        recipe = client.post(f"{BASE}/{proc['id']}/recipes/", json=payload, headers=normal_user_token_headers).json()
        updated = {"name": "Ink v2", "total_solvent_volume_ml": "2", "solvents": [], "solutes": [], "added_solutions": []}
        r = client.put(
            f"{BASE}/{proc['id']}/recipes/{recipe['id']}",
            json=updated,
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        assert r.json()["name"] == "Ink v2"

    def test_delete_recipe(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        proc = create_process(client, normal_user_token_headers)
        payload = {"name": "Ink", "total_solvent_volume_ml": "1", "solvents": [], "solutes": [], "added_solutions": []}
        recipe = client.post(f"{BASE}/{proc['id']}/recipes/", json=payload, headers=normal_user_token_headers).json()
        r = client.delete(
            f"{BASE}/{proc['id']}/recipes/{recipe['id']}",
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        remaining = client.get(f"{BASE}/{proc['id']}/recipes/", headers=normal_user_token_headers).json()
        assert remaining == []

    def test_recipe_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        proc = create_process(client, normal_user_token_headers)
        r = client.put(
            f"{BASE}/{proc['id']}/recipes/{uuid.uuid4()}",
            json={"name": "x", "total_solvent_volume_ml": "1", "solvents": [], "solutes": [], "added_solutions": []},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 404

    def test_recipe_idor(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        proc = create_process(client, superuser_token_headers)
        r = client.post(
            f"{BASE}/{proc['id']}/recipes/",
            json={"name": "x", "total_solvent_volume_ml": "1", "solvents": [], "solutes": [], "added_solutions": []},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403


class TestProcessSteps:
    def test_create_step(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        proc = create_process(client, normal_user_token_headers)
        payload = {"name": "Spin coat", "step_category": "spin_coating", "stage_index": 0, "step_index": 0}
        r = client.post(
            f"{BASE}/{proc['id']}/steps/",
            json=payload,
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["name"] == "Spin coat"
        assert data["step_category"] == "spin_coating"

    def test_update_step(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        proc = create_process(client, normal_user_token_headers)
        step = client.post(
            f"{BASE}/{proc['id']}/steps/",
            json={"name": "Step A", "step_category": "anneal", "stage_index": 0, "step_index": 0},
            headers=normal_user_token_headers,
        ).json()
        r = client.put(
            f"{BASE}/{proc['id']}/steps/{step['id']}",
            json={"name": "Step B", "step_category": "anneal", "stage_index": 0, "step_index": 0},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        assert r.json()["name"] == "Step B"

    def test_delete_step(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        proc = create_process(client, normal_user_token_headers)
        step = client.post(
            f"{BASE}/{proc['id']}/steps/",
            json={"name": "Step X", "step_category": "other", "stage_index": 0, "step_index": 0},
            headers=normal_user_token_headers,
        ).json()
        r = client.delete(f"{BASE}/{proc['id']}/steps/{step['id']}", headers=normal_user_token_headers)
        assert r.status_code == 200
        assert client.get(f"{BASE}/{proc['id']}/steps/", headers=normal_user_token_headers).json() == []

    def test_step_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        proc = create_process(client, normal_user_token_headers)
        r = client.delete(f"{BASE}/{proc['id']}/steps/{uuid.uuid4()}", headers=normal_user_token_headers)
        assert r.status_code == 404

    def test_step_idor(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        proc = create_process(client, superuser_token_headers)
        r = client.post(
            f"{BASE}/{proc['id']}/steps/",
            json={"name": "x", "step_category": "other", "stage_index": 0, "step_index": 0},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403


class TestProcessStacks:
    def test_create_stack(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        proc = create_process(client, normal_user_token_headers)
        payload = {
            "combination": 1,
            "architecture": "n-i-p",
            "layers": [{"layer_index": 0, "name": "ITO", "layer_type": "transport", "color": "#aaa"}],
        }
        r = client.post(
            f"{BASE}/{proc['id']}/stacks/",
            json=payload,
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["architecture"] == "n-i-p"
        assert len(data["layers"]) == 1

    def test_update_stack(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        proc = create_process(client, normal_user_token_headers)
        stack = client.post(
            f"{BASE}/{proc['id']}/stacks/",
            json={"combination": 1, "layers": []},
            headers=normal_user_token_headers,
        ).json()
        r = client.put(
            f"{BASE}/{proc['id']}/stacks/{stack['id']}",
            json={"combination": 2, "architecture": "p-i-n", "layers": [{"layer_index": 0, "name": "Au", "layer_type": "metal", "color": ""}]},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["combination"] == 2
        assert len(data["layers"]) == 1

    def test_delete_stack(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        proc = create_process(client, normal_user_token_headers)
        stack = client.post(
            f"{BASE}/{proc['id']}/stacks/",
            json={"combination": 0, "layers": []},
            headers=normal_user_token_headers,
        ).json()
        r = client.delete(f"{BASE}/{proc['id']}/stacks/{stack['id']}", headers=normal_user_token_headers)
        assert r.status_code == 200
        assert client.get(f"{BASE}/{proc['id']}/stacks/", headers=normal_user_token_headers).json() == []

    def test_stack_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        proc = create_process(client, normal_user_token_headers)
        r = client.delete(f"{BASE}/{proc['id']}/stacks/{uuid.uuid4()}", headers=normal_user_token_headers)
        assert r.status_code == 404

    def test_stack_idor(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        proc = create_process(client, superuser_token_headers)
        r = client.post(
            f"{BASE}/{proc['id']}/stacks/",
            json={"combination": 0, "layers": []},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403


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
