"""Local scientific export: the ZIP contains accepted measurements, curves,
correction history, a manifest, and unchanged originals — with excluded
observations kept out of the accepted tables."""

import io
import json
import uuid
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.core.config import settings
from app.models import (
    Experiment,
    ExperimentResults,
    ImportedSourceFile,
    MeasurementCorrection,
    MeasurementFile,
    User,
)
from app.services import source_store

API = settings.API_V1_STR


def _owner_id(db: Session) -> uuid.UUID:
    user = db.exec(select(User).where(User.email == settings.EMAIL_TEST_USER)).first()
    assert user is not None
    return user.id


def _setup(
    db: Session,
    monkeypatch,
    tmp_path: Path,
) -> tuple[str, str, str]:
    monkeypatch.setattr(settings, "SOURCE_STORAGE_DIR", str(tmp_path))
    owner = _owner_id(db)
    exp = Experiment(name="export-exp", owner_id=owner)
    db.add(exp)
    db.commit()
    db.refresh(exp)

    res = ExperimentResults(experiment_id=exp.id, owner_id=owner)
    db.add(res)
    db.commit()
    db.refresh(res)

    sid = uuid.uuid4()
    source_store.write_source(str(sid), b"original bytes")
    db.add(
        ImportedSourceFile(
            id=sid,
            experiment_id=exp.id,
            import_id=uuid.uuid4(),
            original_filename="src.txt",
            relative_path="src.txt",
            size=len(b"original bytes"),
            sha256=source_store.sha256_hex(b"original bytes"),
            file_type="text",
        )
    )
    db.commit()

    accepted = MeasurementFile(
        results_id=res.id,
        filename="accepted.txt",
        file_type="JV",
        device_name="DEV-A",
        direction="FW",
        value=12.5,
        voc=1.1,
        jsc=22.0,
        ff=78.0,
        source_file_id=sid,
        curve=[{"v": 0.0, "j": 22.0}, {"v": 0.5, "j": 21.0}],
    )
    excluded = MeasurementFile(
        results_id=res.id,
        filename="excluded.txt",
        file_type="JV",
        device_name="DEV-B",
        direction="RV",
        value=99.0,
        excluded=True,
    )
    db.add(accepted)
    db.add(excluded)
    db.commit()
    db.refresh(accepted)

    db.add(
        MeasurementCorrection(
            measurement_id=accepted.id,
            field="value",
            operation="scale",
            previous_value="10.0",
            new_value="12.5",
            reason="calibration",
            actor_email="researcher@example.com",
        )
    )
    db.commit()

    return str(exp.id), str(res.id), str(accepted.id)


def test_export_zip_contents(
    client: TestClient,
    normal_user_token_headers: dict,
    db: Session,
    monkeypatch,
    tmp_path: Path,
) -> None:
    exp_id, _res_id, _accepted_id = _setup(
        db, monkeypatch, tmp_path
    )

    r = client.get(f"{API}/export/experiments/{exp_id}", headers=normal_user_token_headers)
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/zip")

    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        names = set(zf.namelist())
        assert "measurements.csv" in names
        assert "curves.csv" in names
        assert "corrections.csv" in names
        assert "manifest.json" in names
        assert any(n.startswith("originals/") for n in names)

        meas = zf.read("measurements.csv").decode("utf-8")
        assert "accepted.txt" in meas
        assert "excluded.txt" not in meas  # excluded never in accepted table
        assert "DEV-A" in meas

        curves = zf.read("curves.csv").decode("utf-8")
        assert "0.5" in curves  # a curve point

        corr = zf.read("corrections.csv").decode("utf-8")
        assert "calibration" in corr
        assert "researcher@example.com" not in corr  # no personal information

        manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
        assert manifest["measurement_count"] == 1
        assert manifest["excluded_count"] == 1
        assert manifest["excluded_measurements"][0]["file_name"] == "excluded.txt"
        assert manifest["correction_count"] == 1
        assert manifest["source_files"][0]["sha256"] == source_store.sha256_hex(
            b"original bytes"
        )

        original = next(zf.read(n) for n in names if n.startswith("originals/"))
        assert original == b"original bytes"


def test_export_requires_ownership(
    client: TestClient,
    normal_user_token_headers: dict,
    db: Session,
    monkeypatch,
    tmp_path: Path,
) -> None:
    monkeypatch.setattr(settings, "SOURCE_STORAGE_DIR", str(tmp_path))
    su = db.exec(select(User).where(User.email == settings.FIRST_SUPERUSER)).first()
    assert su is not None
    exp = Experiment(name="su-exp", owner_id=su.id)
    db.add(exp)
    db.commit()
    db.refresh(exp)
    res = ExperimentResults(experiment_id=exp.id, owner_id=su.id)
    db.add(res)
    db.commit()
    db.refresh(res)
    db.add(
        MeasurementFile(
            results_id=res.id, filename="f.txt", file_type="JV", device_name="D", value=10.0
        )
    )
    db.commit()

    r = client.get(f"{API}/export/experiments/{exp.id}", headers=normal_user_token_headers)
    assert r.status_code == 403


def test_export_errors_on_corrupted_source(
    client: TestClient,
    normal_user_token_headers: dict,
    db: Session,
    monkeypatch,
    tmp_path: Path,
) -> None:
    exp_id, _res_id, _accepted_id = _setup(db, monkeypatch, tmp_path)
    source = db.exec(
        select(ImportedSourceFile).where(
            ImportedSourceFile.experiment_id == uuid.UUID(exp_id)
        )
    ).first()
    assert source is not None
    # Corrupt the stored bytes: the export must fail explicitly, not silently
    # present an incomplete archive.
    source_store.write_source(str(source.id), b"tampered!")
    r = client.get(
        f"{API}/export/experiments/{exp_id}", headers=normal_user_token_headers
    )
    assert r.status_code == 409
    assert "corrupted" in r.json()["detail"]


def test_export_includes_retained_originals(
    client: TestClient,
    normal_user_token_headers: dict,
    db: Session,
    monkeypatch,
    tmp_path: Path,
) -> None:
    exp_id, _res_id, _accepted_id = _setup(db, monkeypatch, tmp_path)
    # Add an extra durable source not referenced by any measurement (a retained
    # original whose measurement was removed).
    retained = uuid.uuid4()
    source_store.write_source(str(retained), b"retained bytes")
    db.add(
        ImportedSourceFile(
            id=retained,
            experiment_id=uuid.UUID(exp_id),
            import_id=uuid.uuid4(),
            original_filename="retained.txt",
            relative_path="retained.txt",
            size=len(b"retained bytes"),
            sha256=source_store.sha256_hex(b"retained bytes"),
            file_type="text",
        )
    )
    db.commit()

    r = client.get(
        f"{API}/export/experiments/{exp_id}", headers=normal_user_token_headers
    )
    assert r.status_code == 200, r.text

    with zipfile.ZipFile(io.BytesIO(r.content)) as zf:
        manifest = json.loads(zf.read("manifest.json").decode("utf-8"))
        member_names = {s["archive_member"] for s in manifest["source_files"]}
        # The retained original is present with its recorded archive member.
        assert any(n.endswith("retained.txt") for n in member_names)
        assert b"retained bytes" in [zf.read(n) for n in member_names]
