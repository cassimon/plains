"""Unit tests for the NOMAD failed-upload stash helpers and the upload-log CRUD.

Covers the service-level file operations (stash_archive / purge_stash_file /
get_upload_entries) and the crud helpers that back the central log and the
one-week retention sweep (create/update_nomad_upload_log, purge_expired_stash).
"""

from __future__ import annotations

import uuid
import zipfile
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from sqlmodel import Session, select

from app import crud
from app.core.config import settings
from app.models import NomadUploadLog, User
from app.services import nomad as nomad_service


def _superuser(db: Session) -> User:
    user = db.exec(select(User).where(User.email == settings.FIRST_SUPERUSER)).first()
    assert user is not None
    return user


def _make_zip(path: Path, content: bytes = b"col,val\n1,2\n") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path, "w") as zf:
        zf.writestr("measurement.csv", content)
    return path


@pytest.fixture
def stash_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """Point the module-level stash dir at a writable temp location."""
    d = tmp_path / "stash"
    monkeypatch.setattr(nomad_service, "STASH_DIR", d)
    return d


class TestStashArchive:
    def test_stash_copies_file_keyed_by_log_id(
        self, tmp_path: Path, stash_dir: Path
    ) -> None:
        src = _make_zip(tmp_path / "src.zip")
        log_id = uuid.uuid4()

        dest = nomad_service.stash_archive(src, log_id)

        assert dest == stash_dir / f"{log_id}.zip"
        assert dest.is_file()
        # Source is copied, not moved.
        assert src.exists()
        assert zipfile.is_zipfile(dest)

    def test_stash_missing_source_raises(self, stash_dir: Path) -> None:
        with pytest.raises(FileNotFoundError):
            nomad_service.stash_archive(Path("/does/not/exist.zip"), uuid.uuid4())


class TestPurgeStashFile:
    def test_purge_removes_file(self, tmp_path: Path, stash_dir: Path) -> None:
        src = _make_zip(tmp_path / "src.zip")
        dest = nomad_service.stash_archive(src, uuid.uuid4())

        assert nomad_service.purge_stash_file(dest) is True
        assert not dest.exists()

    def test_purge_none_is_noop(self, stash_dir: Path) -> None:
        assert nomad_service.purge_stash_file(None) is False

    def test_purge_refuses_path_outside_stash(
        self, tmp_path: Path, stash_dir: Path
    ) -> None:
        outside = _make_zip(tmp_path / "outside.zip")
        # Not under STASH_DIR — must be refused and left in place.
        assert nomad_service.purge_stash_file(outside) is False
        assert outside.exists()


class TestGetUploadEntriesMock:
    def test_mock_mode_returns_empty_diagnostics(
        self, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        monkeypatch.setattr(settings, "NOMAD_MOCK_MODE", True)
        info = nomad_service.get_upload_entries("upload-1", token="t")
        assert info == {"processing_failed": 0, "entry_errors": []}


class TestUploadLogCrud:
    def test_create_denormalizes_user_email(self, db: Session) -> None:
        user = _superuser(db)
        log = crud.create_nomad_upload_log(
            session=db,
            user=user,
            experiment_id=uuid.uuid4(),
            experiment_name="Exp A",
            upload_id="up-1",
            status="PENDING",
        )
        try:
            assert log.user_email == user.email
            assert log.user_id == user.id
            assert log.status == "PENDING"
        finally:
            db.delete(log)
            db.commit()

    def test_update_bumps_updated_at(self, db: Session) -> None:
        user = _superuser(db)
        log = crud.create_nomad_upload_log(
            session=db,
            user=user,
            experiment_id=None,
            experiment_name="Exp B",
            upload_id="up-2",
            status="PENDING",
        )
        before = log.updated_at
        try:
            updated = crud.update_nomad_upload_log(
                session=db, log=log, status="SUCCESS", entries_count=3
            )
            assert updated.status == "SUCCESS"
            assert updated.entries_count == 3
            assert updated.updated_at is not None
            assert before is None or updated.updated_at >= before
        finally:
            db.delete(log)
            db.commit()

    def test_purge_expired_stash_deletes_only_expired(
        self, db: Session, tmp_path: Path, stash_dir: Path
    ) -> None:
        user = _superuser(db)
        now = datetime.now(timezone.utc)

        # Expired: file should be deleted, path nulled, row kept.
        expired = crud.create_nomad_upload_log(
            session=db,
            user=user,
            experiment_id=None,
            experiment_name="expired",
            upload_id="exp",
            status="FAILED",
        )
        expired_file = nomad_service.stash_archive(
            _make_zip(tmp_path / "e.zip"), expired.id
        )
        crud.update_nomad_upload_log(
            session=db,
            log=expired,
            archive_stash_path=str(expired_file),
            archive_expires_at=now - timedelta(hours=1),
        )

        # Fresh: still within retention, must survive.
        fresh = crud.create_nomad_upload_log(
            session=db,
            user=user,
            experiment_id=None,
            experiment_name="fresh",
            upload_id="frsh",
            status="FAILED",
        )
        fresh_file = nomad_service.stash_archive(
            _make_zip(tmp_path / "f.zip"), fresh.id
        )
        crud.update_nomad_upload_log(
            session=db,
            log=fresh,
            archive_stash_path=str(fresh_file),
            archive_expires_at=now + timedelta(days=3),
        )

        try:
            purged = crud.purge_expired_stash(db)
            assert purged >= 1

            db.expire_all()
            expired_row = db.get(NomadUploadLog, expired.id)
            fresh_row = db.get(NomadUploadLog, fresh.id)
            assert expired_row is not None  # row kept as history
            assert expired_row.archive_stash_path is None
            assert not expired_file.exists()
            assert fresh_row is not None
            assert fresh_row.archive_stash_path == str(fresh_file)
            assert fresh_file.exists()
        finally:
            db.delete(db.get(NomadUploadLog, expired.id))
            db.delete(db.get(NomadUploadLog, fresh.id))
            db.commit()
