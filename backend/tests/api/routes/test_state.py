import uuid

from fastapi.testclient import TestClient

from app.core.config import settings

BASE = f"{settings.API_V1_STR}/state"


class TestStateAuth:
    def test_get_state_requires_auth(self, client: TestClient) -> None:
        assert client.get(f"{BASE}/").status_code == 401

    def test_put_state_requires_auth(self, client: TestClient) -> None:
        assert client.put(f"{BASE}/", json={"data": {}}).status_code == 401

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

    def test_get_state_contains_expected_keys(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.get(f"{BASE}/", headers=normal_user_token_headers)
        assert r.status_code == 200
        snapshot = r.json()["data"]
        for key in ("materials", "solutions", "experiments", "results", "planes", "processes"):
            assert key in snapshot, f"Missing key: {key}"


class TestStatePut:
    def test_put_empty_state(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        payload = {
            "data": {
                "materials": [],
                "solutions": [],
                "experiments": [],
                "results": [],
                "planes": [],
                "processes": [],
            }
        }
        r = client.put(f"{BASE}/", json=payload, headers=normal_user_token_headers)
        assert r.status_code == 200

    def test_put_state_with_material(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        mat_id = str(uuid.uuid4())
        payload = {
            "data": {
                "materials": [{"id": mat_id, "name": "Ethanol"}],
                "solutions": [],
                "experiments": [],
                "results": [],
                "planes": [],
                "processes": [],
            }
        }
        r = client.put(f"{BASE}/", json=payload, headers=normal_user_token_headers)
        assert r.status_code == 200

        # Verify the material now appears on GET
        r2 = client.get(f"{BASE}/", headers=normal_user_token_headers)
        mat_names = [m.get("name") for m in r2.json()["data"]["materials"]]
        assert "Ethanol" in mat_names

    def test_put_state_deletes_removed_entities(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        mat_id = str(uuid.uuid4())
        # First upsert a material
        client.put(
            f"{BASE}/",
            json={"data": {"materials": [{"id": mat_id, "name": "ToDelete"}], "solutions": [], "experiments": [], "results": [], "planes": [], "processes": []}},
            headers=normal_user_token_headers,
        )
        # Now sync without that material
        r = client.put(
            f"{BASE}/",
            json={"data": {"materials": [], "solutions": [], "experiments": [], "results": [], "planes": [], "processes": []}},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        # Material should be gone
        r2 = client.get(f"{BASE}/", headers=normal_user_token_headers)
        mat_ids = [m.get("id") for m in r2.json()["data"]["materials"]]
        assert mat_id not in mat_ids

    def test_put_state_with_experiment_and_result(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        exp_id = str(uuid.uuid4())
        res_id = str(uuid.uuid4())
        payload = {
            "data": {
                "materials": [],
                "solutions": [],
                "experiments": [{"id": exp_id, "name": "ExpA"}],
                "results": [{"id": res_id, "experimentId": exp_id}],
                "planes": [],
                "processes": [],
            }
        }
        r = client.put(f"{BASE}/", json=payload, headers=normal_user_token_headers)
        assert r.status_code == 200

    def test_put_state_with_plane_and_elements(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane_id = str(uuid.uuid4())
        el_id = str(uuid.uuid4())
        payload = {
            "data": {
                "materials": [],
                "solutions": [],
                "experiments": [],
                "results": [],
                "planes": [
                    {
                        "id": plane_id,
                        "name": "TestPlane",
                        "elements": [
                            {
                                "id": el_id,
                                "type": "text",
                                "position": {"x": 10, "y": 20},
                                "size": {"x": 100, "y": 50},
                                "content": "Hello",
                            }
                        ],
                    }
                ],
                "processes": [],
            }
        }
        r = client.put(f"{BASE}/", json=payload, headers=normal_user_token_headers)
        assert r.status_code == 200

    def test_put_state_skips_result_without_experiment(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        """Results referencing an unknown experiment_id should be silently skipped."""
        res_id = str(uuid.uuid4())
        payload = {
            "data": {
                "materials": [],
                "solutions": [],
                "experiments": [],
                "results": [{"id": res_id, "experimentId": str(uuid.uuid4())}],
                "planes": [],
                "processes": [],
            }
        }
        r = client.put(f"{BASE}/", json=payload, headers=normal_user_token_headers)
        assert r.status_code == 200

    def test_put_state_roundtrip(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        mat_id = str(uuid.uuid4())
        sol_id = str(uuid.uuid4())
        exp_id = str(uuid.uuid4())
        payload = {
            "data": {
                "materials": [{"id": mat_id, "name": "Material1"}],
                "solutions": [{"id": sol_id, "name": "Solution1", "components": []}],
                "experiments": [{"id": exp_id, "name": "Exp1"}],
                "results": [],
                "planes": [],
                "processes": [{"id": "p1", "name": "Process1"}],
            }
        }
        client.put(f"{BASE}/", json=payload, headers=normal_user_token_headers)
        r = client.get(f"{BASE}/", headers=normal_user_token_headers)
        assert r.status_code == 200
        snap = r.json()["data"]
        mat_names = [m.get("name") for m in snap["materials"]]
        assert "Material1" in mat_names
        # Processes are persisted as-is via UserState JSON
        proc_names = [p.get("name") for p in snap.get("processes", [])]
        assert "Process1" in proc_names


class TestStateBulk:
    def test_get_bulk_state(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.get(f"{BASE}/bulk", headers=normal_user_token_headers)
        assert r.status_code == 200
        data = r.json()
        for key in ("materials", "solutions", "experiments", "results", "planes"):
            assert key in data, f"Missing key in bulk response: {key}"
        assert isinstance(data["materials"], list)

    def test_bulk_returns_user_data_only(
        self, client: TestClient, normal_user_token_headers: dict[str, str], superuser_token_headers: dict[str, str]
    ) -> None:
        # Create material as superuser
        client.post(
            f"{settings.API_V1_STR}/materials/",
            json={"name": "super-mat"},
            headers=superuser_token_headers,
        )
        r = client.get(f"{BASE}/bulk", headers=normal_user_token_headers)
        assert r.status_code == 200
        # Normal user should not see superuser's material
        mat_names = [m.get("name") for m in r.json()["materials"]]
        assert "super-mat" not in mat_names


class TestStateSolutionComponents:
    def test_put_state_solution_with_components(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        mat_id = str(uuid.uuid4())
        sol_id = str(uuid.uuid4())
        comp_id = str(uuid.uuid4())
        payload = {
            "data": {
                "materials": [{"id": mat_id, "name": "Solvent"}],
                "solutions": [
                    {
                        "id": sol_id,
                        "name": "MySolution",
                        "components": [
                            {"id": comp_id, "materialId": mat_id, "amount": "5", "unit": "ml"}
                        ],
                    }
                ],
                "experiments": [],
                "results": [],
                "planes": [],
                "processes": [],
            }
        }
        r = client.put(f"{BASE}/", json=payload, headers=normal_user_token_headers)
        assert r.status_code == 200

        # Update same component (cover the update branch)
        payload["data"]["solutions"][0]["components"][0]["amount"] = "10"
        r2 = client.put(f"{BASE}/", json=payload, headers=normal_user_token_headers)
        assert r2.status_code == 200

        # Clean up
        client.put(
            f"{BASE}/",
            json={"data": {"materials": [], "solutions": [], "experiments": [], "results": [], "planes": [], "processes": []}},
            headers=normal_user_token_headers,
        )

    def test_put_state_solution_component_without_material_id(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        sol_id = str(uuid.uuid4())
        payload = {
            "data": {
                "materials": [],
                "solutions": [
                    {
                        "id": sol_id,
                        "name": "EmptySolution",
                        "components": [
                            {"id": str(uuid.uuid4()), "amount": "5", "unit": "ml"}
                        ],
                    }
                ],
                "experiments": [],
                "results": [],
                "planes": [],
                "processes": [],
            }
        }
        r = client.put(f"{BASE}/", json=payload, headers=normal_user_token_headers)
        assert r.status_code == 200
        client.put(
            f"{BASE}/",
            json={"data": {"materials": [], "solutions": [], "experiments": [], "results": [], "planes": [], "processes": []}},
            headers=normal_user_token_headers,
        )
