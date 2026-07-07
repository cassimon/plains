"""Live-stack security hardening tests: cross-tenant isolation between two
independent non-privileged users.

The existing per-domain integration tests prove a normal user cannot reach a
*superuser's* objects. This file proves the stronger, more realistic property:
two ordinary users are fully isolated from each other, and no endpoint lets one
user read, mutate, enumerate, or graft data onto the other's resources.
"""

import os
import uuid

import httpx
import pytest

from tests.integration.conftest import API_V1, auth_headers, get_token

pytestmark = pytest.mark.skipif(
    os.getenv("NOMAD_OAUTH_ENABLED", "false").lower() == "true",
    reason="Requires local JWT auth mode",
)


def _make_user() -> dict:
    uid = uuid.uuid4().hex[:8]
    email = f"sec-{uid}@test.plains"
    password = f"pass-{uid}-secure"
    r = httpx.post(
        f"{API_V1}/private/users/",
        json={"email": email, "password": password, "full_name": f"Sec {uid}"},
        timeout=10,
    )
    assert r.status_code == 200, r.text
    return {"id": r.json()["id"], "email": email, "password": password}


@pytest.fixture(scope="module")
def attacker_headers(superuser_headers: dict) -> dict:
    """A second, unrelated normal user acting as the attacker."""
    user = _make_user()
    headers = auth_headers(get_token(user["email"], user["password"]))
    yield headers
    httpx.delete(
        f"{API_V1}/users/{user['id']}", headers=superuser_headers, timeout=10
    )


@pytest.fixture(scope="module")
def victim_material(user_headers: dict) -> str:
    r = httpx.post(
        f"{API_V1}/materials/",
        json={"name": "secret-material"},
        headers=user_headers,
        timeout=10,
    )
    assert r.status_code == 200
    return r.json()["id"]


@pytest.fixture(scope="module")
def victim_experiment(user_headers: dict) -> str:
    r = httpx.post(
        f"{API_V1}/experiments/",
        json={"name": "secret-experiment"},
        headers=user_headers,
        timeout=10,
    )
    assert r.status_code == 200
    return r.json()["id"]


class TestCrossTenantMaterialIsolation:
    def test_attacker_cannot_read(
        self, attacker_headers: dict, victim_material: str
    ) -> None:
        r = httpx.get(
            f"{API_V1}/materials/{victim_material}",
            headers=attacker_headers,
            timeout=10,
        )
        assert r.status_code == 403

    def test_attacker_cannot_update(
        self, attacker_headers: dict, victim_material: str
    ) -> None:
        r = httpx.put(
            f"{API_V1}/materials/{victim_material}",
            json={"name": "hijacked"},
            headers=attacker_headers,
            timeout=10,
        )
        assert r.status_code == 403

    def test_attacker_cannot_delete(
        self, attacker_headers: dict, victim_material: str
    ) -> None:
        r = httpx.delete(
            f"{API_V1}/materials/{victim_material}",
            headers=attacker_headers,
            timeout=10,
        )
        assert r.status_code == 403

    def test_attacker_list_does_not_leak(
        self, attacker_headers: dict, victim_material: str
    ) -> None:
        r = httpx.get(f"{API_V1}/materials/", headers=attacker_headers, timeout=10)
        assert r.status_code == 200
        assert victim_material not in {row["id"] for row in r.json()["data"]}

    def test_attacker_bulk_state_does_not_leak(
        self, attacker_headers: dict, victim_material: str
    ) -> None:
        r = httpx.get(f"{API_V1}/state/bulk", headers=attacker_headers, timeout=10)
        assert r.status_code == 200
        assert victim_material not in {m["id"] for m in r.json()["materials"]}


class TestCrossTenantExperimentInjection:
    def test_attacker_cannot_attach_results_to_victim_experiment(
        self, attacker_headers: dict, victim_experiment: str
    ) -> None:
        """Grafting results onto another user's experiment must be blocked."""
        r = httpx.post(
            f"{API_V1}/results/?experiment_id={victim_experiment}",
            json={},
            headers=attacker_headers,
            timeout=10,
        )
        assert r.status_code == 403

    def test_attacker_cannot_read_victim_experiment(
        self, attacker_headers: dict, victim_experiment: str
    ) -> None:
        r = httpx.get(
            f"{API_V1}/experiments/{victim_experiment}",
            headers=attacker_headers,
            timeout=10,
        )
        assert r.status_code == 403
