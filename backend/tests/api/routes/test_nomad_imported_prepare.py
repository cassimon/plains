"""Server-side NOMAD preparation for imported measurements: authoritative
database values, source resolution, and the partial-exclusion / corrected-scalar
safety blocks."""

import uuid
import zipfile
from pathlib import Path

from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app.core.config import settings
from app.models import (
    DeviceGroup,
    Experiment,
    ExperimentResults,
    ImportedSourceFile,
    LabSubstrate,
    MeasurementFile,
    User,
)
from app.services import source_store

API = settings.API_V1_STR


def _owner_id(db: Session) -> uuid.UUID:
    user = db.exec(select(User).where(User.email == settings.EMAIL_TEST_USER)).first()
    assert user is not None
    return user.id


def _setup(db: Session, monkeypatch, tmp_path: Path):
    monkeypatch.setattr(settings, "SOURCE_STORAGE_DIR", str(tmp_path))
    owner = _owner_id(db)
    exp = Experiment(name="exp", owner_id=owner)
    db.add(exp)
    db.commit()
    db.refresh(exp)
    sub = LabSubstrate(name="sub-1", experiment_id=exp.id)
    db.add(sub)
    db.commit()
    db.refresh(sub)
    res = ExperimentResults(experiment_id=exp.id, owner_id=owner)
    db.add(res)
    db.commit()
    db.refresh(res)
    grp = DeviceGroup(name="dev-1", assigned_substrate_id=sub.id, results_id=res.id)
    db.add(grp)
    db.commit()
    db.refresh(grp)

    sid = uuid.uuid4()
    source_store.write_source(str(sid), b"jv data")
    db.add(
        ImportedSourceFile(
            id=sid,
            experiment_id=exp.id,
            import_id=uuid.uuid4(),
            original_filename="jv.txt",
            relative_path="jv.txt",
            size=len(b"jv data"),
            sha256=source_store.sha256_hex(b"jv data"),
            file_type="JV",
        )
    )
    db.commit()

    fw = MeasurementFile(
        results_id=res.id,
        device_group_id=grp.id,
        filename="jv.txt",
        file_type="JV",
        device_name="dev-1",
        direction="FW",
        value=10.0,
        source_file_id=sid,
    )
    rv = MeasurementFile(
        results_id=res.id,
        device_group_id=grp.id,
        filename="jv.txt",
        file_type="JV",
        device_name="dev-1",
        direction="RV",
        value=12.0,
        source_file_id=sid,
    )
    db.add(fw)
    db.add(rv)
    db.commit()
    db.refresh(fw)
    db.refresh(rv)
    return exp.id, fw.id, rv.id


def test_prepare_imported_builds_archive(
    client: TestClient, normal_user_token_headers: dict, db: Session, monkeypatch, tmp_path: Path
) -> None:
    exp_id, _fw_id, _rv_id = _setup(db, monkeypatch, tmp_path)
    r = client.post(
        f"{API}/nomad/imported/prepare",
        data={"experiment_id": str(exp_id)},
        headers=normal_user_token_headers,
    )
    assert r.status_code == 200, r.text
    archive_path = r.json()["archive_path"]
    with zipfile.ZipFile(archive_path) as zf:
        names = set(zf.namelist())
        assert "jv.txt" in names
        assert zf.read("jv.txt") == b"jv data"
        assert any(n.endswith(".archive.yaml") for n in names)


def test_partial_fw_rv_exclusion_blocks(
    client: TestClient, normal_user_token_headers: dict, db: Session, monkeypatch, tmp_path: Path
) -> None:
    exp_id, fw_id, _rv_id = _setup(db, monkeypatch, tmp_path)
    fw = db.get(MeasurementFile, fw_id)
    fw.excluded = True
    db.commit()
    r = client.post(
        f"{API}/nomad/imported/prepare",
        data={"experiment_id": str(exp_id)},
        headers=normal_user_token_headers,
    )
    assert r.status_code == 409
    assert "partial FW/RV" in r.json()["detail"]


def test_corrected_scalar_blocks(
    client: TestClient, normal_user_token_headers: dict, db: Session, monkeypatch, tmp_path: Path
) -> None:
    exp_id, fw_id, _rv_id = _setup(db, monkeypatch, tmp_path)
    fw = db.get(MeasurementFile, fw_id)
    fw.corrected_fields = ["value"]
    db.commit()
    r = client.post(
        f"{API}/nomad/imported/prepare",
        data={"experiment_id": str(exp_id)},
        headers=normal_user_token_headers,
    )
    assert r.status_code == 409
    assert "corrected" in r.json()["detail"]
