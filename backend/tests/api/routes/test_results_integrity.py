"""RESULTS-INTEGRITY-01 — persistent group membership by stable id.

Exercises the actual persistence endpoints (create / replace files / replace
groups / read) so that membership survives rename, move, unassign, group
deletion and cross-result rejection.
"""

import uuid

from fastapi.testclient import TestClient

from app.core.config import settings
from tests.utils.utils import random_lower_string

BASE = f"{settings.API_V1_STR}/results"
EXP_BASE = f"{settings.API_V1_STR}/experiments"


def create_experiment(client: TestClient, headers: dict) -> dict:
    r = client.post(
        f"{EXP_BASE}/", json={"name": random_lower_string()}, headers=headers
    )
    assert r.status_code == 200
    return r.json()


def create_result_with_group(
    client: TestClient, headers: dict, experiment_id: str, name: str
) -> tuple[str, str]:
    """Create a result with one group and one file in it. Returns (result_id, group_id)."""
    group_id = str(uuid.uuid4())
    file_id = str(uuid.uuid4())
    payload = {
        "device_groups": [
            {"id": group_id, "name": name, "assigned_substrate_id": None}
        ],
        "measurement_files": [
            {
                "id": file_id,
                "filename": f"{name}.txt",
                "file_type": "JV",
                "device_name": name,
                "device_group_id": group_id,
                "voc": 1.1,
                "jsc": 22.5,
                "ff": 76.4,
                "value": 18.9,
            }
        ],
    }
    r = client.post(
        f"{BASE}/", params={"experiment_id": experiment_id}, json=payload, headers=headers
    )
    assert r.status_code == 200, r.text
    return r.json()["id"], group_id


class TestResultsGroupIntegrity:
    def test_rename_group_keeps_membership_and_device_name(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        headers = normal_user_token_headers
        exp = create_experiment(client, headers)
        result_id, group_id = create_result_with_group(client, headers, exp["id"], "DEV-A")

        # Rename the group (same id) — the device identifier on the file is unchanged.
        r = client.put(
            f"{BASE}/{result_id}/device-groups",
            json=[{"id": group_id, "name": "Renamed Device", "assigned_substrate_id": None}],
            headers=headers,
        )
        assert r.status_code == 200, r.text

        data = client.get(f"{BASE}/{result_id}", headers=headers).json()
        assert data["device_groups"][0]["name"] == "Renamed Device"
        assert data["measurement_files"][0]["device_name"] == "DEV-A"
        assert data["measurement_files"][0]["device_group_id"] == group_id

    def test_move_measurement_between_groups(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        headers = normal_user_token_headers
        exp = create_experiment(client, headers)
        result_id, group_id = create_result_with_group(client, headers, exp["id"], "DEV-A")

        new_group_id = str(uuid.uuid4())
        client.put(
            f"{BASE}/{result_id}/device-groups",
            json=[
                {"id": group_id, "name": "DEV-A", "assigned_substrate_id": None},
                {"id": new_group_id, "name": "DEV-B", "assigned_substrate_id": None},
            ],
            headers=headers,
        )
        data = client.get(f"{BASE}/{result_id}", headers=headers).json()
        file_id = data["measurement_files"][0]["id"]

        r = client.put(
            f"{BASE}/{result_id}/measurement-files",
            json=[
                {
                    "id": file_id,
                    "filename": "DEV-A.txt",
                    "file_type": "JV",
                    "device_name": "DEV-A",
                    "device_group_id": new_group_id,
                    "voc": 1.1,
                }
            ],
            headers=headers,
        )
        assert r.status_code == 200, r.text

        data = client.get(f"{BASE}/{result_id}", headers=headers).json()
        assert data["measurement_files"][0]["device_group_id"] == new_group_id

    def test_unassign_measurement_stays_unassigned(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        headers = normal_user_token_headers
        exp = create_experiment(client, headers)
        result_id, _group_id = create_result_with_group(client, headers, exp["id"], "DEV-A")

        data = client.get(f"{BASE}/{result_id}", headers=headers).json()
        file_id = data["measurement_files"][0]["id"]

        r = client.put(
            f"{BASE}/{result_id}/measurement-files",
            json=[
                {
                    "id": file_id,
                    "filename": "DEV-A.txt",
                    "file_type": "JV",
                    "device_name": "DEV-A",
                    "device_group_id": None,
                    "voc": 1.1,
                }
            ],
            headers=headers,
        )
        assert r.status_code == 200, r.text

        data = client.get(f"{BASE}/{result_id}", headers=headers).json()
        assert data["measurement_files"][0]["device_group_id"] is None

    def test_delete_group_keeps_measurements(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        headers = normal_user_token_headers
        exp = create_experiment(client, headers)
        result_id, _group_id = create_result_with_group(client, headers, exp["id"], "DEV-A")

        # Replace groups with an empty list → the group is deleted.
        r = client.put(
            f"{BASE}/{result_id}/device-groups", json=[], headers=headers
        )
        assert r.status_code == 200, r.text

        data = client.get(f"{BASE}/{result_id}", headers=headers).json()
        assert data["device_groups"] == []
        # The measurement survives, now unassigned.
        assert len(data["measurement_files"]) == 1
        assert data["measurement_files"][0]["device_group_id"] is None

    def test_reject_measurement_referencing_foreign_group(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        headers = normal_user_token_headers
        exp_a = create_experiment(client, headers)
        exp_b = create_experiment(client, headers)
        _result_a, group_a = create_result_with_group(client, headers, exp_a["id"], "DEV-A")
        result_b, _group_b = create_result_with_group(client, headers, exp_b["id"], "DEV-B")

        data = client.get(f"{BASE}/{result_b}", headers=headers).json()
        file_b = data["measurement_files"][0]["id"]

        # Try to point result B's file at result A's group → must be rejected.
        r = client.put(
            f"{BASE}/{result_b}/measurement-files",
            json=[
                {
                    "id": file_b,
                    "filename": "DEV-B.txt",
                    "file_type": "JV",
                    "device_name": "DEV-B",
                    "device_group_id": group_a,
                }
            ],
            headers=headers,
        )
        assert r.status_code == 409

    def test_independent_groups_with_same_name_remain_distinct(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        """Two groups in the same result can share a display name; membership is
        by id, so each file points at its own group."""
        headers = normal_user_token_headers
        exp = create_experiment(client, headers)
        g1 = str(uuid.uuid4())
        g2 = str(uuid.uuid4())
        payload = {
            "device_groups": [
                {"id": g1, "name": "Shared", "assigned_substrate_id": None},
                {"id": g2, "name": "Shared", "assigned_substrate_id": None},
            ],
            "measurement_files": [
                {
                    "id": str(uuid.uuid4()),
                    "filename": "one.txt",
                    "file_type": "JV",
                    "device_name": "Shared",
                    "device_group_id": g1,
                },
                {
                    "id": str(uuid.uuid4()),
                    "filename": "two.txt",
                    "file_type": "JV",
                    "device_name": "Shared",
                    "device_group_id": g2,
                },
            ],
        }
        r = client.post(
            f"{BASE}/", params={"experiment_id": exp["id"]}, json=payload, headers=headers
        )
        assert r.status_code == 200, r.text
        result_id = r.json()["id"]

        data = client.get(f"{BASE}/{result_id}", headers=headers).json()
        by_group = {g["id"]: g["name"] for g in data["device_groups"]}
        assert len(by_group) == 2
        assert {f["device_group_id"] for f in data["measurement_files"]} == {g1, g2}
