"""Snapshot integrity: a stale/incomplete measurement-files snapshot must never
hard-delete measurements or their correction history, and a stale snapshot must
never overwrite a corrected value. Individual measurements are removed only by
the explicit delete endpoint, by deleting the whole result, or via trash.
"""

import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.core.config import settings
from app.models import ExperimentResults, ImportedSourceFile
from app.services import source_store
from tests.utils.utils import random_lower_string

BASE = f"{settings.API_V1_STR}/results"
EXP_BASE = f"{settings.API_V1_STR}/experiments"


def _experiment(client: TestClient, headers: dict) -> str:
    r = client.post(f"{EXP_BASE}/", json={"name": random_lower_string()}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _result_with_files(
    client: TestClient, headers: dict, experiment_id: str, n: int = 2
) -> tuple[str, list[str]]:
    file_ids = [str(uuid.uuid4()) for _ in range(n)]
    payload = {
        "device_groups": [],
        "measurement_files": [
            {
                "id": fid,
                "filename": f"{fid[:8]}.txt",
                "file_type": "JV",
                "device_name": "DEV",
                "value": 10.0 + i,
            }
            for i, fid in enumerate(file_ids)
        ],
    }
    r = client.post(f"{BASE}/", params={"experiment_id": experiment_id}, json=payload, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()["id"], file_ids


def _file_payload(fid: str, value: float = 10.0) -> dict:
    return {
        "id": fid,
        "filename": f"{fid[:8]}.txt",
        "file_type": "JV",
        "device_name": "DEV",
        "value": value,
    }


def test_stale_snapshot_does_not_delete_measurements(
    client: TestClient, normal_user_token_headers: dict
) -> None:
    headers = normal_user_token_headers
    exp = _experiment(client, headers)
    result_id, file_ids = _result_with_files(client, headers, exp, n=2)

    # A snapshot carrying only one of the two files (stale/incomplete) must not
    # delete the other.
    r = client.put(
        f"{BASE}/{result_id}/measurement-files",
        json=[_file_payload(file_ids[0])],
        headers=headers,
    )
    assert r.status_code == 200, r.text

    data = client.get(f"{BASE}/{result_id}", headers=headers).json()
    assert {f["id"] for f in data["measurement_files"]} == set(file_ids)


def test_correction_history_survives_stale_snapshot(
    client: TestClient, normal_user_token_headers: dict
) -> None:
    headers = normal_user_token_headers
    exp = _experiment(client, headers)
    result_id, file_ids = _result_with_files(client, headers, exp, n=1)
    fid = file_ids[0]

    r = client.post(
        f"{BASE}/{result_id}/corrections",
        json={
            "measurement_id": fid,
            "operation": "scale",
            "field": "value",
            "factor": 0.5,
            "reason": "unit conversion",
        },
        headers=headers,
    )
    assert r.status_code == 200, r.text

    # A stale snapshot omitting the corrected file must preserve both the row
    # and its correction history.
    r = client.put(
        f"{BASE}/{result_id}/measurement-files", json=[], headers=headers
    )
    assert r.status_code == 200, r.text

    data = client.get(f"{BASE}/{result_id}", headers=headers).json()
    assert len(data["measurement_files"]) == 1

    corrections = client.get(f"{BASE}/{result_id}/corrections", headers=headers).json()
    assert len(corrections) == 1
    assert corrections[0]["operation"] == "scale"


def test_explicit_result_delete_removes_measurements(
    client: TestClient, normal_user_token_headers: dict
) -> None:
    headers = normal_user_token_headers
    exp = _experiment(client, headers)
    result_id, _ = _result_with_files(client, headers, exp, n=2)

    r = client.delete(f"{BASE}/{result_id}", headers=headers)
    assert r.status_code == 200, r.text
    r = client.get(f"{BASE}/{result_id}", headers=headers)
    assert r.status_code == 404


def test_delete_measurement_endpoint(
    client: TestClient, normal_user_token_headers: dict
) -> None:
    headers = normal_user_token_headers
    exp = _experiment(client, headers)
    result_id, file_ids = _result_with_files(client, headers, exp, n=2)

    r = client.delete(
        f"{BASE}/{result_id}/measurement-files/{file_ids[0]}", headers=headers
    )
    assert r.status_code == 200, r.text

    data = client.get(f"{BASE}/{result_id}", headers=headers).json()
    assert {f["id"] for f in data["measurement_files"]} == {file_ids[1]}

    # A foreign / already-deleted measurement id is a 404.
    r = client.delete(
        f"{BASE}/{result_id}/measurement-files/{uuid.uuid4()}", headers=headers
    )
    assert r.status_code == 404


def test_delete_measurement_cascades_correction_history(
    client: TestClient, normal_user_token_headers: dict
) -> None:
    headers = normal_user_token_headers
    exp = _experiment(client, headers)
    result_id, file_ids = _result_with_files(client, headers, exp, n=1)
    fid = file_ids[0]

    client.post(
        f"{BASE}/{result_id}/corrections",
        json={
            "measurement_id": fid,
            "operation": "scale",
            "field": "value",
            "factor": 0.5,
            "reason": "unit conversion",
        },
        headers=headers,
    )
    client.delete(f"{BASE}/{result_id}/measurement-files/{fid}", headers=headers)

    corrections = client.get(f"{BASE}/{result_id}/corrections", headers=headers).json()
    assert corrections == []


def test_delete_measurement_preserves_upload_history_and_source(
    client: TestClient,
    normal_user_token_headers: dict,
    db: Session,
    monkeypatch,
    tmp_path: Path,
) -> None:
    headers = normal_user_token_headers
    monkeypatch.setattr(settings, "SOURCE_STORAGE_DIR", str(tmp_path))
    exp = _experiment(client, headers)
    result_id, file_ids = _result_with_files(client, headers, exp, n=1)
    fid = file_ids[0]

    # Attach an original source file and point the measurement at it.
    sid = str(uuid.uuid4())
    source_store.write_source(sid, b"bytes")
    db.add(
        ImportedSourceFile(
            id=uuid.UUID(sid),
            experiment_id=uuid.UUID(exp),
            import_id=uuid.uuid4(),
            original_filename="f.txt",
            relative_path="f.txt",
            size=len(b"bytes"),
            sha256=source_store.sha256_hex(b"bytes"),
            file_type="text",
        )
    )
    db.commit()
    client.put(
        f"{BASE}/{result_id}/measurement-files",
        json=[{**_file_payload(fid), "source_file_id": sid}],
        headers=headers,
    )

    # Simulate a historical (successful) NOMAD upload on the result row.
    row = db.get(ExperimentResults, uuid.UUID(result_id))
    row.nomad_upload_id = "up-1"
    row.nomad_upload_status = "SUCCESS"
    db.commit()

    # Clear the measurement via the explicit delete endpoint.
    r = client.delete(f"{BASE}/{result_id}/measurement-files/{fid}", headers=headers)
    assert r.status_code == 200, r.text

    # The result row and its upload history survive; the measurement is gone.
    data = client.get(f"{BASE}/{result_id}", headers=headers).json()
    assert data["nomad_upload_id"] == "up-1"
    assert data["nomad_upload_status"] == "SUCCESS"
    assert data["measurement_files"] == []

    # The original source file (row + bytes) is preserved.
    assert source_store.source_exists(sid) is True
    assert (
        db.exec(
            select(ImportedSourceFile).where(ImportedSourceFile.id == uuid.UUID(sid))
        ).first()
        is not None
    )


def test_stale_snapshot_does_not_overwrite_corrected_value(
    client: TestClient, normal_user_token_headers: dict
) -> None:
    headers = normal_user_token_headers
    exp = _experiment(client, headers)
    result_id, file_ids = _result_with_files(client, headers, exp, n=1)
    fid = file_ids[0]  # value = 10.0

    client.post(
        f"{BASE}/{result_id}/corrections",
        json={
            "measurement_id": fid,
            "operation": "scale",
            "field": "value",
            "factor": 0.5,
            "reason": "unit conversion",
        },
        headers=headers,
    )

    # A stale snapshot carrying the pre-correction value must not overwrite it.
    client.put(
        f"{BASE}/{result_id}/measurement-files",
        json=[_file_payload(fid, value=10.0)],
        headers=headers,
    )

    data = client.get(f"{BASE}/{result_id}", headers=headers).json()
    assert data["measurement_files"][0]["value"] == 5.0


def test_concurrent_snapshot_and_correction_keeps_correction(
    client: TestClient, normal_user_token_headers: dict
) -> None:
    headers = normal_user_token_headers
    exp = _experiment(client, headers)
    result_id, file_ids = _result_with_files(client, headers, exp, n=1)
    fid = file_ids[0]  # value = 10.0
    barrier = threading.Barrier(2)

    def correct() -> int:
        barrier.wait()
        return client.post(
            f"{BASE}/{result_id}/corrections",
            json={
                "measurement_id": fid,
                "operation": "scale",
                "field": "value",
                "factor": 0.5,
                "reason": "unit conversion",
            },
            headers=headers,
        ).status_code

    def snapshot() -> int:
        barrier.wait()
        return client.put(
            f"{BASE}/{result_id}/measurement-files",
            json=[_file_payload(fid, value=10.0)],
            headers=headers,
        ).status_code

    with ThreadPoolExecutor(max_workers=2) as pool:
        f1 = pool.submit(correct)
        f2 = pool.submit(snapshot)
        assert f1.result() == 200
        assert f2.result() == 200

    # The correction is authoritative: whichever committed first, the row lock
    # serialises the snapshot so it can never reintroduce the stale value.
    data = client.get(f"{BASE}/{result_id}", headers=headers).json()
    assert data["measurement_files"][0]["value"] == 5.0
