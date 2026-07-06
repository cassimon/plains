"""
Archive deletion on inactivity.

Temporary NOMAD upload archives (.zip in /tmp/plains_nomad_uploads) must be
swept once they have been inactive for longer than
settings.NOMAD_ARCHIVE_MAX_AGE_S. The sweep runs opportunistically on NOMAD
endpoint activity (POST /upload/files and POST /upload/nomad), so an
abandoned archive is removed the next time anyone touches the upload API.

These tests require filesystem access to the backend's temp directory to
backdate an archive's mtime — they are skipped automatically when running
against a remote backend (CI runs them inside the backend container).
"""

import os
import time
import uuid
from pathlib import Path

import pytest


def _upload_archive(client, user_headers) -> Path:
    """Create a temp archive via the API and return its server-side path.

    Uses a unique experiment id per call — the archive filename is derived
    from its first 8 characters, and two uploads within the same second would
    otherwise collide on the same file.
    """
    r = client.post(
        "/api/v1/nomad/upload/files",
        headers=user_headers,
        data={
            "experiment_id": uuid.uuid4().hex,  # first 8 chars name the archive
            "experiment_name": "Cleanup",
        },
        files=[("files", ("cleanup_AB01_JV.txt", b"JV\nPCE: 1.0\n", "text/plain"))],
    )
    assert r.status_code == 200, r.text
    archive_path = r.json().get("archive_path")
    assert archive_path, "upload/files must return archive_path"
    return Path(archive_path)


def _skip_unless_local_fs(archive: Path) -> None:
    if not archive.exists():
        pytest.skip(
            "archive path not on this filesystem — run inside the backend "
            "container to exercise the inactivity sweep"
        )


class TestArchiveInactivitySweep:
    def test_stale_archive_is_deleted_on_next_upload_activity(
        self, test_user_client, user_headers
    ) -> None:
        """An archive inactive beyond the window is deleted; active ones stay."""
        stale = _upload_archive(test_user_client, user_headers)
        _skip_unless_local_fs(stale)

        # Backdate the archive beyond the inactivity window (default 30 min)
        old = time.time() - (31 * 60)
        os.utime(stale, (old, old))

        # Any new upload activity triggers the sweep…
        fresh = _upload_archive(test_user_client, user_headers)
        try:
            assert not stale.exists(), "stale archive must be swept on upload activity"
            # …but the archive that is still active is NOT deleted.
            assert fresh.exists(), "fresh archive must survive the sweep"
        finally:
            fresh.unlink(missing_ok=True)

    def test_archive_within_window_is_kept(
        self, test_user_client, user_headers
    ) -> None:
        """An archive inactive for less than the window survives the sweep."""
        recent = _upload_archive(test_user_client, user_headers)
        _skip_unless_local_fs(recent)

        # Only a few minutes old — must not be swept.
        nearly = time.time() - (5 * 60)
        os.utime(recent, (nearly, nearly))

        other = _upload_archive(test_user_client, user_headers)
        try:
            assert recent.exists(), "recent archive must not be swept"
        finally:
            recent.unlink(missing_ok=True)
            other.unlink(missing_ok=True)

    def test_final_upload_also_sweeps(self, test_user_client, user_headers) -> None:
        """POST /upload/nomad (the final upload) also runs the sweep."""
        stale = _upload_archive(test_user_client, user_headers)
        _skip_unless_local_fs(stale)
        old = time.time() - (31 * 60)
        os.utime(stale, (old, old))

        current = _upload_archive(test_user_client, user_headers)
        try:
            r = test_user_client.post(
                "/api/v1/nomad/upload/nomad",
                headers=user_headers,
                data={
                    "request_json": (
                        '{"experiment_id": "cleanup-test", '
                        '"experiment_name": "Cleanup", "substrates": [], '
                        '"measurement_files": [], "device_groups": []}'
                    ),
                    "archive_path": str(current),
                },
            )
            assert r.status_code == 200, r.text
            assert not stale.exists(), (
                "stale archive must be swept by the final upload endpoint"
            )
            # (Deletion of the successfully uploaded archive itself is covered
            # by the GUI flow tests in nomad-upload-flows.spec.ts — here the
            # metadata generation fails on the fake experiment id, so the
            # endpoint returns success=False and keeps the archive.)
        finally:
            current.unlink(missing_ok=True)
            stale.unlink(missing_ok=True)
