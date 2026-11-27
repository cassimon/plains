"""Source-file integrity across deletion, download and provenance paths.

Exercises the durability contract for imported source files: bytes survive a
failed/rejected delete, are removed after a successful (cascade) delete, are
detected when corrupted, and are never cross-referenced from another experiment.
"""

import uuid
from pathlib import Path

from fastapi.testclient import TestClient
from sqlmodel import Session

from app.core.config import settings
from app.models import ImportedSourceFile
from app.services import source_store

API = settings.API_V1_STR


def _create_experiment(client: TestClient, headers: dict) -> str:
    r = client.post(f"{API}/experiments/", json={"name": "exp"}, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()["id"]


def _write_source(
    db: Session, experiment_id: str, data: bytes = b"original bytes", name: str = "sample.txt"
) -> str:
    sid = str(uuid.uuid4())
    source_store.write_source(sid, data)
    db.add(
        ImportedSourceFile(
            id=uuid.UUID(sid),
            experiment_id=uuid.UUID(experiment_id),
            import_id=uuid.uuid4(),
            original_filename=name,
            relative_path=name,
            size=len(data),
            sha256=source_store.sha256_hex(data),
            file_type="text",
        )
    )
    db.commit()
    return sid


def test_experiment_delete_removes_source_bytes(
    client: TestClient, normal_user_token_headers: dict, db: Session, monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(settings, "SOURCE_STORAGE_DIR", str(tmp_path))
    exp = _create_experiment(client, normal_user_token_headers)
    sid = _write_source(db, exp)

    r = client.delete(f"{API}/experiments/{exp}", headers=normal_user_token_headers)
    assert r.status_code == 200, r.text
    assert source_store.source_exists(sid) is False


def test_delete_of_one_experiment_spares_anothers_source(
    client: TestClient, normal_user_token_headers: dict, db: Session, monkeypatch, tmp_path: Path
) -> None:
    """Source removal is scoped to the deleted experiment only."""
    monkeypatch.setattr(settings, "SOURCE_STORAGE_DIR", str(tmp_path))
    exp_a = _create_experiment(client, normal_user_token_headers)
    sid_a = _write_source(db, exp_a)
    exp_b = _create_experiment(client, normal_user_token_headers)

    r = client.delete(f"{API}/experiments/{exp_b}", headers=normal_user_token_headers)
    assert r.status_code == 200
    assert source_store.source_exists(sid_a) is True


def test_trash_purge_removes_source_bytes(
    client: TestClient, normal_user_token_headers: dict, db: Session, monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(settings, "SOURCE_STORAGE_DIR", str(tmp_path))
    exp = _create_experiment(client, normal_user_token_headers)
    sid = _write_source(db, exp)

    r = client.post(
        f"{API}/trash/",
        json={"entity_type": "experiment", "entity_id": exp},
        headers=normal_user_token_headers,
    )
    assert r.status_code == 200, r.text
    r = client.post(
        f"{API}/trash/experiment/{exp}/purge",
        headers=normal_user_token_headers,
    )
    assert r.status_code == 200, r.text
    assert source_store.source_exists(sid) is False


def test_download_detects_corruption(
    client: TestClient, normal_user_token_headers: dict, db: Session, monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(settings, "SOURCE_STORAGE_DIR", str(tmp_path))
    exp = _create_experiment(client, normal_user_token_headers)
    sid = _write_source(db, exp)

    # Corrupt the stored bytes after the row was recorded.
    source_store.write_source(sid, b"tampered!")

    r = client.get(f"{API}/zip-explorer/sources/{sid}/download", headers=normal_user_token_headers)
    assert r.status_code == 409


def test_download_roundtrips_unicode_filename(
    client: TestClient, normal_user_token_headers: dict, db: Session, monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(settings, "SOURCE_STORAGE_DIR", str(tmp_path))
    exp = _create_experiment(client, normal_user_token_headers)
    name = "caffè-ü-1.txt"
    sid = _write_source(db, exp, data=b"unicode", name=name)

    r = client.get(f"{API}/zip-explorer/sources/{sid}/download", headers=normal_user_token_headers)
    assert r.status_code == 200, r.text
    cd = r.headers.get("content-disposition", "")
    assert "filename*=UTF-8''" in cd
    assert "attachment;" in cd


def test_import_retry_detects_corrupted_source(
    client: TestClient, normal_user_token_headers: dict, db: Session, monkeypatch, tmp_path: Path
) -> None:
    """Re-importing the same operation with a corrupted stored file is rejected
    by the SHA-256 integrity check (same dataset metadata, different bytes)."""
    monkeypatch.setattr(settings, "SOURCE_STORAGE_DIR", str(tmp_path))
    exp = _create_experiment(client, normal_user_token_headers)
    import_id = str(uuid.uuid4())
    data = b"jv header\n1.0 2.0\n"

    sid = str(uuid.uuid4())
    source_store.write_source(sid, data)
    db.add(
        ImportedSourceFile(
            id=uuid.UUID(sid),
            experiment_id=uuid.UUID(exp),
            import_id=uuid.UUID(import_id),
            original_filename="jv.txt",
            relative_path="jv.txt",
            size=len(data),
            sha256=source_store.sha256_hex(data),
            file_type="text",
        )
    )
    db.commit()

    # Corrupt the stored bytes while leaving the row (and its recorded hash).
    source_store.write_source(sid, b"corrupted!")

    # Retry the same operation: same filename, same recorded bytes — the row's
    # metadata still matches, so the corruption must be caught by the hash check.
    files = [("files", ("jv.txt", data, "text/plain"))]
    r = client.post(
        f"{API}/zip-explorer/import",
        data={"experiment_id": exp, "import_id": import_id},
        files=files,
        headers=normal_user_token_headers,
    )
    assert r.status_code == 409
    assert "corrupted" in r.json()["detail"]


def _measurement_with_source(source_id: str, fid: str | None = None) -> dict:
    return {
        "id": fid or str(uuid.uuid4()),
        "filename": "f.txt",
        "file_type": "JV",
        "device_name": "DEV",
        "source_file_id": source_id,
    }


def test_create_result_rejects_cross_experiment_source(
    client: TestClient, normal_user_token_headers: dict, db: Session, monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(settings, "SOURCE_STORAGE_DIR", str(tmp_path))
    exp_a = _create_experiment(client, normal_user_token_headers)
    sid = _write_source(db, exp_a)
    exp_b = _create_experiment(client, normal_user_token_headers)

    payload = {
        "device_groups": [],
        "measurement_files": [_measurement_with_source(sid)],
    }
    r = client.post(
        f"{API}/results/",
        params={"experiment_id": exp_b},
        json=payload,
        headers=normal_user_token_headers,
    )
    assert r.status_code == 409


def test_replace_measurement_files_rejects_cross_experiment_source(
    client: TestClient, normal_user_token_headers: dict, db: Session, monkeypatch, tmp_path: Path
) -> None:
    monkeypatch.setattr(settings, "SOURCE_STORAGE_DIR", str(tmp_path))
    exp_a = _create_experiment(client, normal_user_token_headers)
    sid = _write_source(db, exp_a)
    exp_b = _create_experiment(client, normal_user_token_headers)

    # Create a result on exp_b with no provenance, then try to inject exp_a's source.
    r = client.post(
        f"{API}/results/",
        params={"experiment_id": exp_b},
        json={"device_groups": [], "measurement_files": []},
        headers=normal_user_token_headers,
    )
    assert r.status_code == 200, r.text
    result_id = r.json()["id"]

    r = client.put(
        f"{API}/results/{result_id}/measurement-files",
        json=[_measurement_with_source(sid)],
        headers=normal_user_token_headers,
    )
    assert r.status_code == 409

