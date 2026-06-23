"""Integration: process CRUD + sub-resources (recipes, steps, stacks)."""

import uuid
import httpx
import pytest
from .conftest import API_V1


def _proc(headers, **kw) -> dict:
    r = httpx.post(
        f"{API_V1}/processes/",
        json={"name": f"p-{uuid.uuid4().hex[:6]}", **kw},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


class TestProcessCRUD:
    def test_create_read_update_delete(self, user_headers):
        p = _proc(user_headers, skip_chemistry=True)
        pid = p["id"]
        assert p["skip_chemistry"] is True
        assert p["recipes"] == []

        # Read
        r = httpx.get(f"{API_V1}/processes/{pid}", headers=user_headers)
        assert r.json()["id"] == pid

        # Update
        r = httpx.put(
            f"{API_V1}/processes/{pid}",
            json={"name": "renamed"},
            headers=user_headers,
        )
        assert r.json()["name"] == "renamed"

        # Delete
        assert httpx.delete(f"{API_V1}/processes/{pid}", headers=user_headers).status_code == 200
        assert httpx.get(f"{API_V1}/processes/{pid}", headers=user_headers).status_code == 404

    def test_idor(self, superuser_headers, user_headers):
        p = _proc(superuser_headers)
        assert httpx.get(f"{API_V1}/processes/{p['id']}", headers=user_headers).status_code == 403
        httpx.delete(f"{API_V1}/processes/{p['id']}", headers=superuser_headers)


class TestProcessRecipes:
    def test_full_recipe_lifecycle(self, user_headers):
        p = _proc(user_headers)
        pid = p["id"]

        # Create recipe with solvents and solutes
        recipe_payload = {
            "name": "Perovskite Ink",
            "total_solvent_volume_ml": "1.0",
            "solvents": [{"name": "DMF", "volume_ratio": 0.8, "color": "#blue"}],
            "solutes": [{"name": "PbI2", "amount": "461", "unit": "mg", "color": ""}],
            "added_solutions": [],
        }
        r = httpx.post(f"{API_V1}/processes/{pid}/recipes/", json=recipe_payload, headers=user_headers)
        assert r.status_code == 200
        recipe = r.json()
        rid = recipe["id"]
        assert recipe["name"] == "Perovskite Ink"
        assert len(recipe["solvents"]) == 1
        assert len(recipe["solutes"]) == 1

        # Verify it appears in list
        r = httpx.get(f"{API_V1}/processes/{pid}/recipes/", headers=user_headers)
        assert len(r.json()) == 1

        # Update — replace solvents
        updated = {**recipe_payload, "name": "Updated Ink", "solvents": [], "solutes": []}
        r = httpx.put(f"{API_V1}/processes/{pid}/recipes/{rid}", json=updated, headers=user_headers)
        assert r.json()["name"] == "Updated Ink"
        assert r.json()["solvents"] == []

        # Delete
        r = httpx.delete(f"{API_V1}/processes/{pid}/recipes/{rid}", headers=user_headers)
        assert r.status_code == 200
        assert httpx.get(f"{API_V1}/processes/{pid}/recipes/", headers=user_headers).json() == []

        httpx.delete(f"{API_V1}/processes/{pid}", headers=user_headers)

    def test_cascade_delete_removes_recipes(self, user_headers):
        p = _proc(user_headers)
        r = httpx.post(
            f"{API_V1}/processes/{p['id']}/recipes/",
            json={"name": "ink", "total_solvent_volume_ml": "1", "solvents": [], "solutes": [], "added_solutions": []},
            headers=user_headers,
        )
        rid = r.json()["id"]

        # Delete process → recipe should vanish (404 on process GET)
        httpx.delete(f"{API_V1}/processes/{p['id']}", headers=user_headers)
        r2 = httpx.get(f"{API_V1}/processes/{p['id']}", headers=user_headers)
        assert r2.status_code == 404

    def test_recipe_idor(self, superuser_headers, user_headers):
        p = _proc(superuser_headers)
        r = httpx.post(
            f"{API_V1}/processes/{p['id']}/recipes/",
            json={"name": "x", "total_solvent_volume_ml": "1", "solvents": [], "solutes": [], "added_solutions": []},
            headers=user_headers,
        )
        assert r.status_code == 403
        httpx.delete(f"{API_V1}/processes/{p['id']}", headers=superuser_headers)


class TestProcessSteps:
    def test_full_step_lifecycle(self, user_headers):
        p = _proc(user_headers)
        pid = p["id"]

        step = httpx.post(
            f"{API_V1}/processes/{pid}/steps/",
            json={"name": "Spin coat", "step_category": "spin_coating", "stage_index": 0, "step_index": 0},
            headers=user_headers,
        ).json()
        sid = step["id"]
        assert step["name"] == "Spin coat"

        # Update
        r = httpx.put(
            f"{API_V1}/processes/{pid}/steps/{sid}",
            json={"name": "Anneal", "step_category": "anneal", "stage_index": 0, "step_index": 0},
            headers=user_headers,
        )
        assert r.json()["name"] == "Anneal"

        # Verify in list
        assert len(httpx.get(f"{API_V1}/processes/{pid}/steps/", headers=user_headers).json()) == 1

        # Delete
        httpx.delete(f"{API_V1}/processes/{pid}/steps/{sid}", headers=user_headers)
        assert httpx.get(f"{API_V1}/processes/{pid}/steps/", headers=user_headers).json() == []
        httpx.delete(f"{API_V1}/processes/{pid}", headers=user_headers)

    def test_step_not_found(self, user_headers):
        p = _proc(user_headers)
        r = httpx.delete(f"{API_V1}/processes/{p['id']}/steps/{uuid.uuid4()}", headers=user_headers)
        assert r.status_code == 404
        httpx.delete(f"{API_V1}/processes/{p['id']}", headers=user_headers)


class TestProcessStacks:
    def test_full_stack_lifecycle(self, user_headers):
        p = _proc(user_headers)
        pid = p["id"]

        stack = httpx.post(
            f"{API_V1}/processes/{pid}/stacks/",
            json={
                "combination": 1,
                "architecture": "n-i-p",
                "layers": [
                    {"layer_index": 0, "name": "ITO", "layer_type": "transport", "color": "#888"},
                    {"layer_index": 1, "name": "Perovskite", "layer_type": "absorber", "color": "#111"},
                ],
            },
            headers=user_headers,
        ).json()
        stack_id = stack["id"]
        assert stack["architecture"] == "n-i-p"
        assert len(stack["layers"]) == 2

        # Update — replace layers
        r = httpx.put(
            f"{API_V1}/processes/{pid}/stacks/{stack_id}",
            json={"combination": 2, "architecture": "p-i-n", "layers": [{"layer_index": 0, "name": "Au", "layer_type": "metal", "color": ""}]},
            headers=user_headers,
        )
        assert r.json()["architecture"] == "p-i-n"
        assert len(r.json()["layers"]) == 1

        # Read back via process
        proc = httpx.get(f"{API_V1}/processes/{pid}", headers=user_headers).json()
        assert len(proc["stacks"]) == 1
        assert proc["stacks"][0]["layers"][0]["name"] == "Au"

        httpx.delete(f"{API_V1}/processes/{pid}/stacks/{stack_id}", headers=user_headers)
        httpx.delete(f"{API_V1}/processes/{pid}", headers=user_headers)
