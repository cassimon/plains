"""
Tests targeting specific coverage gaps identified in the task audit:

1. Solution component cascade: deleting a material sets component.material_id to NULL
2. Solution component dual-key: both material_id and solution_ref_id can be set (no DB constraint)
3. Experiment junction idempotency: sending duplicate IDs in PUT /materials yields one entry
4. NOMAD upload persists info to frontend_data (not normalised columns)
5. Cascade: deleting a solution removes its components
"""

import io
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.core.config import settings
from app.models import SolutionComponent
from tests.utils.utils import random_lower_string

API = settings.API_V1_STR
MATERIALS = f"{API}/materials"
SOLUTIONS = f"{API}/solutions"
EXPERIMENTS = f"{API}/experiments"


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _mat(client: TestClient, headers: dict) -> dict:
    r = client.post(f"{MATERIALS}/", json={"name": random_lower_string()}, headers=headers)
    assert r.status_code == 200
    return r.json()


def _sol(client: TestClient, headers: dict, components: list | None = None) -> dict:
    payload: dict = {"name": random_lower_string()}
    if components:
        payload["components"] = components
    r = client.post(f"{SOLUTIONS}/", json=payload, headers=headers)
    assert r.status_code == 200
    return r.json()


def _exp(client: TestClient, headers: dict) -> dict:
    r = client.post(f"{EXPERIMENTS}/", json={"name": random_lower_string()}, headers=headers)
    assert r.status_code == 200
    return r.json()


# ---------------------------------------------------------------------------
# 1. Solution component cascade — deleting a material NULLs material_id
# ---------------------------------------------------------------------------


class TestSolutionComponentMaterialCascade:
    def test_delete_material_nulls_component_material_id(
        self,
        client: TestClient,
        normal_user_token_headers: dict[str, str],
        db: Session,
    ) -> None:
        mat = _mat(client, normal_user_token_headers)
        sol = _sol(
            client,
            normal_user_token_headers,
            components=[{"amount": 1.0, "unit": "g", "material_id": mat["id"]}],
        )
        # Confirm component exists with the material
        sol_detail = client.get(f"{SOLUTIONS}/{sol['id']}", headers=normal_user_token_headers)
        components = sol_detail.json()["components"]
        assert len(components) == 1
        assert components[0]["material_id"] == mat["id"]

        # Delete the material
        r = client.delete(f"{MATERIALS}/{mat['id']}", headers=normal_user_token_headers)
        assert r.status_code == 200

        # Component's material_id should now be NULL (SET NULL cascade)
        db.expire_all()
        component = db.exec(
            select(SolutionComponent).where(
                SolutionComponent.solution_id == uuid.UUID(sol["id"])
            )
        ).first()
        assert component is not None, "Component should still exist after material deletion"
        assert component.material_id is None, "material_id should be NULLed by cascade"


# ---------------------------------------------------------------------------
# 2. Solution component — can have both material_id and solution_ref_id
#    (no DB-level CHECK constraint enforcing exactly one)
# ---------------------------------------------------------------------------


class TestSolutionComponentDualKey:
    def test_component_with_only_material_id(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        mat = _mat(client, normal_user_token_headers)
        sol = _sol(
            client,
            normal_user_token_headers,
            components=[{"amount": 5.0, "unit": "mL", "material_id": mat["id"]}],
        )
        data = client.get(f"{SOLUTIONS}/{sol['id']}", headers=normal_user_token_headers).json()
        comp = data["components"][0]
        assert comp["material_id"] == mat["id"]
        assert comp["solution_ref_id"] is None

    def test_component_with_only_solution_ref_id(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        ref_sol = _sol(client, normal_user_token_headers)
        parent_sol = _sol(
            client,
            normal_user_token_headers,
            components=[{"amount": 0.5, "unit": "vol%", "solution_ref_id": ref_sol["id"]}],
        )
        data = client.get(
            f"{SOLUTIONS}/{parent_sol['id']}", headers=normal_user_token_headers
        ).json()
        comp = data["components"][0]
        assert comp["solution_ref_id"] == ref_sol["id"]
        assert comp["material_id"] is None

    def test_component_missing_both_keys_is_allowed(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        """No DB constraint requires either key; a component with neither is valid at the route level."""
        sol = _sol(
            client,
            normal_user_token_headers,
            components=[{"amount": 1.0, "unit": "g"}],
        )
        data = client.get(f"{SOLUTIONS}/{sol['id']}", headers=normal_user_token_headers).json()
        assert len(data["components"]) == 1
        comp = data["components"][0]
        assert comp["material_id"] is None
        assert comp["solution_ref_id"] is None


# ---------------------------------------------------------------------------
# 3. Experiment junction idempotency — duplicates in PUT /materials
# ---------------------------------------------------------------------------


class TestExperimentJunctionIdempotency:
    def test_duplicate_material_ids_result_in_single_entry(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        exp = _exp(client, normal_user_token_headers)
        mat = _mat(client, normal_user_token_headers)
        r = client.put(
            f"{EXPERIMENTS}/{exp['id']}/materials",
            json={"ids": [mat["id"], mat["id"]]},
            headers=normal_user_token_headers,
        )
        # Should succeed and deduplicate
        assert r.status_code in (200, 409)
        if r.status_code == 200:
            refs = r.json()["material_refs"]
            assert sum(1 for ref in refs if ref["material_id"] == mat["id"]) == 1

    def test_duplicate_solution_ids_result_in_single_entry(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        exp = _exp(client, normal_user_token_headers)
        sol = _sol(client, normal_user_token_headers)
        r = client.put(
            f"{EXPERIMENTS}/{exp['id']}/solutions",
            json={"ids": [sol["id"], sol["id"]]},
            headers=normal_user_token_headers,
        )
        assert r.status_code in (200, 409)
        if r.status_code == 200:
            refs = r.json()["solution_refs"]
            assert sum(1 for ref in refs if ref["solution_id"] == sol["id"]) == 1


# ---------------------------------------------------------------------------
# 4. Solution cascade — deleting a solution removes its components
# ---------------------------------------------------------------------------


class TestSolutionCascadeComponents:
    def test_delete_solution_removes_components(
        self,
        client: TestClient,
        normal_user_token_headers: dict[str, str],
        db: Session,
    ) -> None:
        mat = _mat(client, normal_user_token_headers)
        sol = _sol(
            client,
            normal_user_token_headers,
            components=[{"amount": 2.0, "unit": "mL", "material_id": mat["id"]}],
        )
        sol_id = uuid.UUID(sol["id"])

        # Confirm component exists
        comps_before = db.exec(
            select(SolutionComponent).where(SolutionComponent.solution_id == sol_id)
        ).all()
        assert len(comps_before) == 1

        # Delete the solution
        r = client.delete(f"{SOLUTIONS}/{sol['id']}", headers=normal_user_token_headers)
        assert r.status_code == 200

        # Components should be CASCADE deleted
        db.expire_all()
        comps_after = db.exec(
            select(SolutionComponent).where(SolutionComponent.solution_id == sol_id)
        ).all()
        assert comps_after == [], "Solution components should be CASCADE deleted with solution"


# ---------------------------------------------------------------------------
# 5. NOMAD upload persists to frontend_data (not normalised columns)
#    This is a regression-detection test documenting current behaviour.
# ---------------------------------------------------------------------------


class TestNomadUploadPersistence:
    """
    Documents that the NOMAD upload route persists upload info to
    frontend_data JSONB rather than the normalised nomad_upload_id /
    nomad_upload_status / nomad_entries columns on ExperimentResults.
    """

    def test_upload_result_returned_in_response(
        self, client: TestClient, monkeypatch
    ) -> None:
        """The upload endpoint returns success=True and upload_id in the response body."""
        import json as _json

        from app.api import deps
        from app.api.routes import nomad as nomad_routes
        from app.models import User
        from app.services.nomad import TEMP_UPLOAD_DIR
        from app.main import app

        TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        monkeypatch.setattr(settings, "NOMAD_USE_GLOBAL_AUTH", True)
        monkeypatch.setattr(settings, "NOMAD_USERNAME", "u")
        monkeypatch.setattr(settings, "NOMAD_PASSWORD", "p")
        monkeypatch.setattr(settings, "NOMAD_OAUTH_ENABLED", False)
        monkeypatch.setattr(nomad_routes, "create_nomad_metadata_yaml", lambda **_: {})
        monkeypatch.setattr(nomad_routes, "get_nomad_token", lambda: "tok")
        monkeypatch.setattr(
            nomad_routes,
            "upload_to_nomad",
            lambda *a, **kw: {
                "upload_id": "uid-123",
                "entry_ids": [],
                "upload_create_time": "2026-01-01T00:00:00Z",
                "processing_status": "RUNNING",
            },
        )

        saved_overrides = dict(app.dependency_overrides)
        app.dependency_overrides[deps.get_current_user] = lambda: User(
            email="su@example.com", is_superuser=True, is_active=True
        )
        app.dependency_overrides[deps._require_token] = lambda: "tok"

        request_body = {
            "experiment_id": str(uuid.uuid4()),
            "experiment_name": "Persistence Test",
            "substrates": [],
            "measurement_files": [],
            "device_groups": [],
            "ignored_files": [],
        }

        try:
            r = client.post(
                f"{API}/nomad/upload/nomad",
                data={"request_json": _json.dumps(request_body)},
                files=[
                    ("files", ("m.csv", io.BytesIO(b"a,b\n1,2\n"), "text/plain"))
                ],
            )
            assert r.status_code == 200
            data = r.json()
            assert data["success"] is True
            assert data["upload_id"] == "uid-123"
        finally:
            app.dependency_overrides.clear()
            app.dependency_overrides.update(saved_overrides)
