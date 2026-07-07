"""Integration tests for the NOMAD upload log + failed-archive stash flow.

Exercises the real endpoints end-to-end (mocked NOMAD calls):
- POST /nomad/upload/nomad records a PENDING log row and stashes the archive.
- GET  /nomad/upload/{id}/status purges the stash on SUCCESS, keeps + annotates
  it on failure.
- GET  /nomad/upload-log is superuser-only and lists attempts.
- GET  /nomad/upload-log/{id}/archive downloads a failed upload's archive.
"""

from __future__ import annotations

import json
import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app import crud
from app.api import deps
from app.api.routes import nomad as nomad_routes
from app.core.config import settings
from app.main import app
from app.models import NomadUploadLog, User
from app.services import nomad as nomad_service
from app.services.nomad import TEMP_UPLOAD_DIR

BASE = f"{settings.API_V1_STR}/nomad"


@pytest.fixture
def stash_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    d = tmp_path / "stash"
    monkeypatch.setattr(nomad_service, "STASH_DIR", d)
    return d


def _superuser(db: Session) -> User:
    user = db.exec(select(User).where(User.email == settings.FIRST_SUPERUSER)).first()
    assert user is not None
    return user


def _stashed_log(
    db: Session,
    *,
    upload_id: str,
    status: str = "PENDING",
) -> NomadUploadLog:
    """Create a log row with a real stashed archive under the patched STASH_DIR."""
    user = _superuser(db)
    log = crud.create_nomad_upload_log(
        session=db,
        user=user,
        experiment_id=uuid.uuid4(),
        experiment_name="Stash Test",
        upload_id=upload_id,
        status=status,
    )
    tmp = TEMP_UPLOAD_DIR / f"seed_{uuid.uuid4().hex}.zip"
    tmp.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(tmp, "w") as zf:
        zf.writestr("m.csv", b"a,b\n1,2\n")
    stashed = nomad_service.stash_archive(tmp, log.id)
    tmp.unlink(missing_ok=True)
    crud.update_nomad_upload_log(
        session=db,
        log=log,
        archive_stash_path=str(stashed),
        # Future expiry so the opportunistic TTL sweep doesn't purge it mid-test.
        archive_expires_at=datetime.now(timezone.utc) + timedelta(days=7),
    )
    return log


class TestUploadRecordsLogAndStash:
    def test_upload_creates_pending_log_and_stashes_archive(
        self, client: TestClient, db: Session, stash_dir: Path, monkeypatch
    ) -> None:
        TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        archive_path = TEMP_UPLOAD_DIR / f"log_flow_{uuid.uuid4().hex}.zip"
        archive_path.write_bytes(b"fake zip content")

        monkeypatch.setattr(settings, "NOMAD_USE_GLOBAL_AUTH", True)
        monkeypatch.setattr(settings, "NOMAD_USERNAME", "u")
        monkeypatch.setattr(settings, "NOMAD_PASSWORD", "p")
        monkeypatch.setattr(settings, "NOMAD_OAUTH_ENABLED", False)
        monkeypatch.setattr(nomad_routes, "create_nomad_metadata_yaml", lambda **_: {})
        monkeypatch.setattr(nomad_routes, "get_nomad_token", lambda: "tok")
        monkeypatch.setattr(
            nomad_routes,
            "upload_to_nomad",
            lambda zip_path, token, upload_name, existing_upload_id=None: {
                "upload_id": "log-up-1",
                "entry_ids": [],
                "upload_create_time": "2026-01-01T00:00:00Z",
                "processing_status": "RUNNING",
            },
        )

        saved = dict(app.dependency_overrides)
        app.dependency_overrides[deps.get_current_user] = lambda: _superuser(db)
        app.dependency_overrides[deps._require_token] = lambda: "tok"

        log = None
        try:
            r = client.post(
                f"{BASE}/upload/nomad",
                data={
                    "request_json": json.dumps(
                        {
                            "experiment_id": str(uuid.uuid4()),
                            "experiment_name": "Log Flow",
                            "substrates": [],
                            "measurement_files": [],
                            "device_groups": [],
                        }
                    ),
                    "archive_path": str(archive_path),
                },
            )
            assert r.status_code == 200
            assert r.json()["success"] is True

            db.expire_all()
            log = db.exec(
                select(NomadUploadLog).where(NomadUploadLog.upload_id == "log-up-1")
            ).first()
            assert log is not None
            assert log.status == "PENDING"
            assert log.archive_stash_path == str(stash_dir / f"{log.id}.zip")
            assert Path(log.archive_stash_path).is_file()
            # The temporary (non-stash) archive is still cleaned up.
            assert not archive_path.exists()
        finally:
            app.dependency_overrides.clear()
            app.dependency_overrides.update(saved)
            archive_path.unlink(missing_ok=True)
            if log is not None:
                db.delete(db.get(NomadUploadLog, log.id))
                db.commit()


class TestStatusResolvesStash:
    def test_success_purges_stash_and_marks_success(
        self,
        client: TestClient,
        db: Session,
        stash_dir: Path,
        normal_user_token_headers: dict[str, str],
        monkeypatch,
    ) -> None:
        log = _stashed_log(db, upload_id=f"succ-{uuid.uuid4().hex[:8]}")
        stash_file = Path(log.archive_stash_path)
        assert stash_file.exists()

        monkeypatch.setattr(settings, "NOMAD_MOCK_MODE", True)
        monkeypatch.setattr(
            nomad_routes,
            "get_upload_status",
            lambda upload_id, token=None: {
                "process_status": "SUCCESS",
                "last_status_message": "Processing completed successfully",
                "entries": 4,
            },
        )
        try:
            r = client.get(
                f"{BASE}/upload/{log.upload_id}/status",
                headers=normal_user_token_headers,
            )
            assert r.status_code == 200
            assert r.json()["status"] == "SUCCESS"

            db.expire_all()
            row = db.get(NomadUploadLog, log.id)
            assert row.status == "SUCCESS"
            assert row.archive_stash_path is None
            assert row.entries_count == 4
            assert not stash_file.exists()  # purged on success
        finally:
            db.delete(db.get(NomadUploadLog, log.id))
            db.commit()

    def test_failure_keeps_stash_and_records_error(
        self,
        client: TestClient,
        db: Session,
        stash_dir: Path,
        normal_user_token_headers: dict[str, str],
        monkeypatch,
    ) -> None:
        log = _stashed_log(db, upload_id=f"fail-{uuid.uuid4().hex[:8]}")
        stash_file = Path(log.archive_stash_path)

        monkeypatch.setattr(settings, "NOMAD_MOCK_MODE", True)
        monkeypatch.setattr(
            nomad_routes,
            "get_upload_status",
            lambda upload_id, token=None: {
                "process_status": "FAILURE",
                "last_status_message": "Processing failed",
                "errors": ["parser boom"],
                "warnings": ["heads up"],
                "entries": 0,
            },
        )
        try:
            r = client.get(
                f"{BASE}/upload/{log.upload_id}/status",
                headers=normal_user_token_headers,
            )
            assert r.status_code == 200
            body = r.json()
            assert body["status"] == "FAILURE"
            assert body["errors"] == ["parser boom"]

            db.expire_all()
            row = db.get(NomadUploadLog, log.id)
            assert row.status == "FAILED"
            assert row.error_message and "parser boom" in row.error_message
            assert row.archive_stash_path == str(stash_file)
            assert stash_file.exists()  # retained for failed uploads
        finally:
            db.delete(db.get(NomadUploadLog, log.id))
            db.commit()


class TestAdminUploadLog:
    def test_list_requires_superuser(
        self,
        client: TestClient,
        normal_user_token_headers: dict[str, str],
    ) -> None:
        r = client.get(f"{BASE}/upload-log", headers=normal_user_token_headers)
        assert r.status_code == 403

    def test_list_requires_auth(self, client: TestClient) -> None:
        r = client.get(f"{BASE}/upload-log")
        assert r.status_code == 401

    def test_superuser_sees_row(
        self,
        client: TestClient,
        db: Session,
        stash_dir: Path,
        superuser_token_headers: dict[str, str],
    ) -> None:
        log = _stashed_log(db, upload_id=f"list-{uuid.uuid4().hex[:8]}")
        try:
            r = client.get(f"{BASE}/upload-log", headers=superuser_token_headers)
            assert r.status_code == 200
            body = r.json()
            match = next((x for x in body["data"] if x["id"] == str(log.id)), None)
            assert match is not None
            assert match["user_email"] == settings.FIRST_SUPERUSER
            assert match["archive_available"] is True
        finally:
            db.delete(db.get(NomadUploadLog, log.id))
            db.commit()

    def test_download_archive_returns_zip(
        self,
        client: TestClient,
        db: Session,
        stash_dir: Path,
        superuser_token_headers: dict[str, str],
    ) -> None:
        log = _stashed_log(db, upload_id=f"dl-{uuid.uuid4().hex[:8]}")
        try:
            r = client.get(
                f"{BASE}/upload-log/{log.id}/archive",
                headers=superuser_token_headers,
            )
            assert r.status_code == 200
            assert r.headers["content-type"] == "application/zip"
            assert zipfile.is_zipfile(__import__("io").BytesIO(r.content))
        finally:
            db.delete(db.get(NomadUploadLog, log.id))
            db.commit()

    def test_download_missing_archive_returns_404(
        self,
        client: TestClient,
        db: Session,
        stash_dir: Path,
        superuser_token_headers: dict[str, str],
    ) -> None:
        # A log with no stashed archive (succeeded / expired) → 404.
        user = _superuser(db)
        log = crud.create_nomad_upload_log(
            session=db,
            user=user,
            experiment_id=None,
            experiment_name="No Archive",
            upload_id="no-arch",
            status="SUCCESS",
        )
        try:
            r = client.get(
                f"{BASE}/upload-log/{log.id}/archive",
                headers=superuser_token_headers,
            )
            assert r.status_code == 404
        finally:
            db.delete(db.get(NomadUploadLog, log.id))
            db.commit()

    def test_download_unknown_log_returns_404(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
    ) -> None:
        r = client.get(
            f"{BASE}/upload-log/{uuid.uuid4()}/archive",
            headers=superuser_token_headers,
        )
        assert r.status_code == 404
