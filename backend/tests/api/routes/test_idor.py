"""Exploit-style IDOR tests.

These tests take the posture of a *malicious authenticated user* who owns a
valid session and tries to reach into another user's private data by guessing
or replaying object IDs (Insecure Direct Object Reference). Every resource type
is probed for read, update and delete, plus the bulk/list endpoints that must
never leak another owner's rows.

The attacker is the module's ``normal_user_token_headers`` (the EMAIL_TEST_USER
account). The victim is a freshly-created, unrelated user whose objects are
created directly through the CRUD layer so no attacker-side call is involved in
provisioning them.
"""

import uuid

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app import crud
from app.core.config import settings
from app.models import (
    AnalysisCreate,
    ExperimentCreate,
    ExperimentResultsCreate,
    LabMaterialCreate,
    LabSolutionCreate,
    PlaneCreate,
    ProcessCreate,
    User,
    UserCreate,
)
from tests.utils.utils import random_email, random_lower_string

API = settings.API_V1_STR


@pytest.fixture(scope="module")
def victim(db: Session) -> User:
    """An unrelated user, owner of the private objects the attacker will hunt."""
    return crud.create_user(
        session=db,
        user_create=UserCreate(email=random_email(), password=random_lower_string()),
    )


@pytest.fixture(scope="module")
def victim_objects(db: Session, victim: User) -> dict[str, uuid.UUID]:
    """Provision one private object of every type owned solely by the victim."""
    material = crud.create_material(
        session=db,
        material_in=LabMaterialCreate(name="victim-material"),
        owner_id=victim.id,
    )
    solution = crud.create_solution(
        session=db,
        solution_in=LabSolutionCreate(name="victim-solution"),
        owner_id=victim.id,
    )
    experiment = crud.create_experiment(
        session=db,
        experiment_in=ExperimentCreate(name="victim-experiment"),
        owner_id=victim.id,
    )
    results = crud.create_experiment_results(
        session=db,
        results_in=ExperimentResultsCreate(),
        owner_id=victim.id,
        experiment_id=experiment.id,
    )
    process = crud.create_process(
        session=db,
        process_in=ProcessCreate(name="victim-process"),
        owner_id=victim.id,
    )
    analysis = crud.create_analysis(
        session=db,
        analysis_in=AnalysisCreate(name="victim-analysis"),
        owner_id=victim.id,
    )
    plane = crud.create_plane(
        session=db,
        plane_in=PlaneCreate(name="victim-plane"),
        owner_id=victim.id,
    )
    return {
        "material": material.id,
        "solution": solution.id,
        "experiment": experiment.id,
        "result": results.id,
        "process": process.id,
        "analysis": analysis.id,
        "plane": plane.id,
    }


# (url segment, update payload) for the generic resource endpoints that follow
# the /{resource}/{id} shape with owner_id-based authorisation.
_RESOURCES = [
    ("materials", "material", {"name": "pwned"}),
    ("solutions", "solution", {"name": "pwned"}),
    ("experiments", "experiment", {"name": "pwned"}),
    ("results", "result", {"notes": "pwned"}),
    ("processes", "process", {"name": "pwned"}),
    ("analyses", "analysis", {"name": "pwned"}),
]


class TestCrossUserReadIsForbidden:
    @pytest.mark.parametrize("segment,key,_payload", _RESOURCES)
    def test_get_by_id_of_another_user_is_forbidden(
        self,
        client: TestClient,
        normal_user_token_headers: dict[str, str],
        victim_objects: dict[str, uuid.UUID],
        segment: str,
        key: str,
        _payload: dict,
    ) -> None:
        rid = victim_objects[key]
        r = client.get(f"{API}/{segment}/{rid}", headers=normal_user_token_headers)
        assert r.status_code == 403, (
            f"IDOR: attacker read {segment}/{rid} owned by another user "
            f"(status {r.status_code})"
        )

    def test_get_plane_of_another_user_is_forbidden(
        self,
        client: TestClient,
        normal_user_token_headers: dict[str, str],
        victim_objects: dict[str, uuid.UUID],
    ) -> None:
        rid = victim_objects["plane"]
        r = client.get(f"{API}/planes/{rid}", headers=normal_user_token_headers)
        assert r.status_code == 403


class TestCrossUserWriteIsForbidden:
    @pytest.mark.parametrize("segment,key,payload", _RESOURCES)
    def test_update_of_another_user_is_forbidden(
        self,
        client: TestClient,
        normal_user_token_headers: dict[str, str],
        victim_objects: dict[str, uuid.UUID],
        segment: str,
        key: str,
        payload: dict,
    ) -> None:
        rid = victim_objects[key]
        r = client.put(
            f"{API}/{segment}/{rid}", json=payload, headers=normal_user_token_headers
        )
        assert r.status_code == 403, (
            f"IDOR: attacker updated {segment}/{rid} owned by another user"
        )

    @pytest.mark.parametrize("segment,key,_payload", _RESOURCES)
    def test_delete_of_another_user_is_forbidden(
        self,
        client: TestClient,
        normal_user_token_headers: dict[str, str],
        victim_objects: dict[str, uuid.UUID],
        segment: str,
        key: str,
        _payload: dict,
    ) -> None:
        rid = victim_objects[key]
        r = client.delete(f"{API}/{segment}/{rid}", headers=normal_user_token_headers)
        assert r.status_code == 403, (
            f"IDOR: attacker deleted {segment}/{rid} owned by another user"
        )


class TestListEndpointsDoNotLeak:
    @pytest.mark.parametrize(
        "segment,key",
        [(seg, key) for seg, key, _ in _RESOURCES] + [("planes", "plane")],
    )
    def test_list_excludes_other_users_objects(
        self,
        client: TestClient,
        normal_user_token_headers: dict[str, str],
        victim_objects: dict[str, uuid.UUID],
        segment: str,
        key: str,
    ) -> None:
        r = client.get(f"{API}/{segment}/", headers=normal_user_token_headers)
        assert r.status_code == 200
        ids = {row["id"] for row in r.json()["data"]}
        assert str(victim_objects[key]) not in ids, (
            f"Leak: {segment} list exposed another user's object"
        )

    def test_bulk_state_excludes_other_users_objects(
        self,
        client: TestClient,
        normal_user_token_headers: dict[str, str],
        victim_objects: dict[str, uuid.UUID],
    ) -> None:
        r = client.get(f"{API}/state/bulk", headers=normal_user_token_headers)
        assert r.status_code == 200
        body = r.json()
        for collection in [
            "materials",
            "solutions",
            "processes",
            "experiments",
            "results",
            "analyses",
            "planes",
        ]:
            ids = {row["id"] for row in body.get(collection, [])}
            leaked = {str(v) for v in victim_objects.values()} & ids
            assert not leaked, f"Leak: /state/bulk exposed victim rows in {collection}"


class TestCrossUserResultInjection:
    def test_cannot_attach_results_to_foreign_experiment(
        self,
        client: TestClient,
        normal_user_token_headers: dict[str, str],
        victim_objects: dict[str, uuid.UUID],
    ) -> None:
        """Attacker must not create results bound to a victim's experiment."""
        exp_id = victim_objects["experiment"]
        r = client.post(
            f"{API}/results/?experiment_id={exp_id}",
            json={},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403, (
            "IDOR: attacker attached results to another user's experiment "
            f"(status {r.status_code})"
        )


class TestCrossUserPlaneSharing:
    def test_attacker_cannot_share_victims_plane(
        self,
        client: TestClient,
        normal_user_token_headers: dict[str, str],
        victim: User,
        victim_objects: dict[str, uuid.UUID],
    ) -> None:
        """Only a plane's owner may grant shares — not any authenticated user."""
        plane_id = victim_objects["plane"]
        r = client.post(
            f"{API}/planes/{plane_id}/share",
            json={"user_id": str(victim.id)},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403

    def test_attacker_cannot_add_notes_to_victims_plane(
        self,
        client: TestClient,
        normal_user_token_headers: dict[str, str],
        victim_objects: dict[str, uuid.UUID],
    ) -> None:
        plane_id = victim_objects["plane"]
        r = client.post(
            f"{API}/planes/{plane_id}/sticky-notes",
            json={"content": "pwn", "i": 0, "j": 0},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403
