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


class TestProcessRecipes:
    def test_crud(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        proc = create_process(client, normal_user_token_headers)
        pid = proc["id"]
        # Create
        r = client.post(
            f"{BASE}/{pid}/recipes/",
            json={
                "name": "Recipe A",
                "solvents": [{"name": "DMF", "volume_ratio": 1.0}],
                "solutes": [{"name": "PbI2", "amount": "100"}],
            },
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        rid = r.json()["id"]
        assert r.json()["name"] == "Recipe A"
        assert len(r.json()["solvents"]) == 1
        assert len(r.json()["solutes"]) == 1
        # Read list
        lst = client.get(f"{BASE}/{pid}/recipes/", headers=normal_user_token_headers)
        assert any(x["id"] == rid for x in lst.json())
        # Update
        u = client.put(
            f"{BASE}/{pid}/recipes/{rid}",
            json={"name": "Recipe B", "solvents": []},
            headers=normal_user_token_headers,
        )
        assert u.status_code == 200
        assert u.json()["name"] == "Recipe B"
        assert u.json()["solvents"] == []
        # Delete
        d = client.delete(
            f"{BASE}/{pid}/recipes/{rid}", headers=normal_user_token_headers
        )
        assert d.status_code == 200

    def test_update_wrong_parent_404(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        p1 = create_process(client, normal_user_token_headers)
        p2 = create_process(client, normal_user_token_headers)
        rid = client.post(
            f"{BASE}/{p1['id']}/recipes/",
            json={"name": "R"},
            headers=normal_user_token_headers,
        ).json()["id"]
        r = client.put(
            f"{BASE}/{p2['id']}/recipes/{rid}",
            json={"name": "X"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 404

    def test_delete_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        proc = create_process(client, normal_user_token_headers)
        r = client.delete(
            f"{BASE}/{proc['id']}/recipes/{uuid.uuid4()}",
            headers=normal_user_token_headers,
        )
        assert r.status_code == 404

    def test_idor(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        proc = create_process(client, superuser_token_headers)
        r = client.post(
            f"{BASE}/{proc['id']}/recipes/",
            json={"name": "R"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403


class TestProcessSteps:
    def test_crud(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        proc = create_process(client, normal_user_token_headers)
        pid = proc["id"]
        r = client.post(
            f"{BASE}/{pid}/steps/",
            json={
                "stage_index": 0,
                "step_index": 0,
                "name": "Spin coat",
                "step_category": "deposition",
                "deposition_method_value": "spin coating",
                "deposition_method_mode": "constant",
            },
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        sid = r.json()["id"]
        assert r.json()["name"] == "Spin coat"
        lst = client.get(f"{BASE}/{pid}/steps/", headers=normal_user_token_headers)
        assert any(x["id"] == sid for x in lst.json())
        u = client.put(
            f"{BASE}/{pid}/steps/{sid}",
            json={"name": "Anneal"},
            headers=normal_user_token_headers,
        )
        assert u.status_code == 200
        assert u.json()["name"] == "Anneal"
        d = client.delete(
            f"{BASE}/{pid}/steps/{sid}", headers=normal_user_token_headers
        )
        assert d.status_code == 200

    def test_update_wrong_parent_404(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        p1 = create_process(client, normal_user_token_headers)
        p2 = create_process(client, normal_user_token_headers)
        sid = client.post(
            f"{BASE}/{p1['id']}/steps/",
            json={"name": "S", "step_category": "deposition"},
            headers=normal_user_token_headers,
        ).json()["id"]
        r = client.put(
            f"{BASE}/{p2['id']}/steps/{sid}",
            json={"name": "X"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 404

    def test_idor(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        proc = create_process(client, superuser_token_headers)
        r = client.post(
            f"{BASE}/{proc['id']}/steps/",
            json={"name": "S", "step_category": "deposition"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403


class TestProcessStacks:
    def test_crud_with_nested_layers(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        proc = create_process(client, normal_user_token_headers)
        pid = proc["id"]
        r = client.post(
            f"{BASE}/{pid}/stacks/",
            json={
                "combination": 1,
                "architecture": "n-i-p",
                "layers": [
                    {"layer_index": 0, "name": "ITO", "is_substrate": True},
                    {"layer_index": 1, "name": "Perovskite", "layer_type": "absorber"},
                ],
            },
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        stack_id = r.json()["id"]
        assert len(r.json()["layers"]) == 2
        lst = client.get(f"{BASE}/{pid}/stacks/", headers=normal_user_token_headers)
        assert any(x["id"] == stack_id for x in lst.json())
        u = client.put(
            f"{BASE}/{pid}/stacks/{stack_id}",
            json={"combination": 1, "architecture": "p-i-n"},
            headers=normal_user_token_headers,
        )
        assert u.status_code == 200
        assert u.json()["architecture"] == "p-i-n"
        d = client.delete(
            f"{BASE}/{pid}/stacks/{stack_id}", headers=normal_user_token_headers
        )
        assert d.status_code == 200

    def test_update_wrong_parent_404(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        p1 = create_process(client, normal_user_token_headers)
        p2 = create_process(client, normal_user_token_headers)
        stack_id = client.post(
            f"{BASE}/{p1['id']}/stacks/",
            json={"combination": 0},
            headers=normal_user_token_headers,
        ).json()["id"]
        r = client.put(
            f"{BASE}/{p2['id']}/stacks/{stack_id}",
            json={"combination": 0},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 404

    def test_idor(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        proc = create_process(client, superuser_token_headers)
        r = client.post(
            f"{BASE}/{proc['id']}/stacks/",
            json={"combination": 0},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403
