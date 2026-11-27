"""Correction integrity: blank reasons/values rejected, idempotency enforced.

The request_id uniqueness constraint (partial unique index) plus the measurement
row lock guarantee a repeated correction intent can never double-apply, including
under concurrency.
"""

import threading
import uuid
from concurrent.futures import ThreadPoolExecutor

from fastapi.testclient import TestClient

from app.core.config import settings
from tests.utils.utils import random_lower_string

BASE = f"{settings.API_V1_STR}/results"
EXP_BASE = f"{settings.API_V1_STR}/experiments"


def _setup(client: TestClient, headers: dict) -> tuple[str, str]:
    exp = client.post(f"{EXP_BASE}/", json={"name": random_lower_string()}, headers=headers)
    assert exp.status_code == 200, exp.text
    exp_id = exp.json()["id"]
    fid = str(uuid.uuid4())
    payload = {
        "device_groups": [],
        "measurement_files": [
            {
                "id": fid,
                "filename": "f.txt",
                "file_type": "JV",
                "device_name": "DEV",
                "value": 10.0,
            }
        ],
    }
    r = client.post(f"{BASE}/", params={"experiment_id": exp_id}, json=payload, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()["id"], fid


def test_whitespace_only_reason_rejected(
    client: TestClient, normal_user_token_headers: dict
) -> None:
    result_id, fid = _setup(client, normal_user_token_headers)
    r = client.post(
        f"{BASE}/{result_id}/corrections",
        json={
            "measurement_id": fid,
            "operation": "exclude",
            "reason": "   ",
        },
        headers=normal_user_token_headers,
    )
    assert r.status_code == 422


def test_edit_blank_value_rejected(
    client: TestClient, normal_user_token_headers: dict
) -> None:
    result_id, fid = _setup(client, normal_user_token_headers)
    r = client.post(
        f"{BASE}/{result_id}/corrections",
        json={
            "measurement_id": fid,
            "operation": "edit",
            "field": "device_name",
            "value": "   ",
            "reason": "rename",
        },
        headers=normal_user_token_headers,
    )
    assert r.status_code == 400


def test_duplicate_request_id_rejected(
    client: TestClient, normal_user_token_headers: dict
) -> None:
    result_id, fid = _setup(client, normal_user_token_headers)
    req_id = str(uuid.uuid4())
    body = {
        "measurement_id": fid,
        "operation": "scale",
        "field": "value",
        "factor": 0.5,
        "reason": "unit conversion",
        "request_id": req_id,
    }
    r1 = client.post(f"{BASE}/{result_id}/corrections", json=body, headers=normal_user_token_headers)
    assert r1.status_code == 200, r1.text
    r2 = client.post(f"{BASE}/{result_id}/corrections", json=body, headers=normal_user_token_headers)
    assert r2.status_code == 409

    corrections = client.get(f"{BASE}/{result_id}/corrections", headers=normal_user_token_headers).json()
    assert len(corrections) == 1


def test_concurrent_duplicate_request_id_applies_once(
    client: TestClient, normal_user_token_headers: dict
) -> None:
    result_id, fid = _setup(client, normal_user_token_headers)
    req_id = str(uuid.uuid4())
    body = {
        "measurement_id": fid,
        "operation": "scale",
        "field": "value",
        "factor": 0.5,
        "reason": "unit conversion",
        "request_id": req_id,
    }
    barrier = threading.Barrier(2)

    def fire() -> int:
        barrier.wait()
        return client.post(
            f"{BASE}/{result_id}/corrections", json=body, headers=normal_user_token_headers
        ).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        statuses = list(pool.map(lambda _: fire(), range(2)))

    # Exactly one correction may be applied; the other must be rejected.
    assert sorted(statuses) == [200, 409]

    corrections = client.get(f"{BASE}/{result_id}/corrections", headers=normal_user_token_headers).json()
    assert len(corrections) == 1
    data = client.get(f"{BASE}/{result_id}", headers=normal_user_token_headers).json()
    assert data["measurement_files"][0]["value"] == 5.0
