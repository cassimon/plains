from __future__ import annotations

import io
import json
import uuid
import zipfile
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

from app.api import deps
from app.api.routes import nomad as nomad_routes
from app.core.config import settings
from app.main import app
from app.models import User
from app.services.nomad import TEMP_UPLOAD_DIR

BASE = f"{settings.API_V1_STR}/nomad"


class TestNomadConfig:
    def test_get_config_requires_auth(self, client: TestClient) -> None:
        r = client.get(f"{BASE}/config")
        assert r.status_code == 401

    def test_get_config_returns_structure(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.get(f"{BASE}/config", headers=normal_user_token_headers)
        assert r.status_code == 200
        data = r.json()
        assert "enabled" in data
        assert "url" in data
        assert "use_global_auth" in data
        assert "has_credentials" in data

    def test_get_config_reflects_settings(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.get(f"{BASE}/config", headers=normal_user_token_headers)
        data = r.json()
        assert data["enabled"] == settings.NOMAD_OAUTH_ENABLED
        assert data["url"] == settings.NOMAD_URL


class TestNomadAuthEndpoint:
    def test_auth_test_requires_auth(self, client: TestClient) -> None:
        r = client.post(f"{BASE}/auth/test")
        assert r.status_code == 401

    def test_auth_test_without_credentials_returns_unconfigured(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        """When NOMAD credentials are not set, auth/test returns not-configured response."""
        with (
            patch.object(settings, "NOMAD_USERNAME", None),
            patch.object(settings, "NOMAD_PASSWORD", None),
        ):
            r = client.post(
                f"{BASE}/auth/test",
                headers=normal_user_token_headers,
            )
            assert r.status_code == 200
            data = r.json()
            assert data["success"] is False
            assert data["configured"] is False


class TestNomadEndpointsRequireAuth:
    def test_upload_files_requires_auth(self, client: TestClient) -> None:
        r = client.post(
            f"{BASE}/upload/files",
            data={"results_id": str(uuid.uuid4())},
        )
        assert r.status_code == 401

    def test_upload_metadata_requires_auth(self, client: TestClient) -> None:
        r = client.post(
            f"{BASE}/upload/metadata",
            json={
                "results_id": str(uuid.uuid4()),
                "experiment": {},
                "deviceGroups": [],
            },
        )
        assert r.status_code == 401

    def test_metadata_preview_requires_auth(self, client: TestClient) -> None:
        r = client.post(f"{BASE}/metadata/preview", json={})
        assert r.status_code == 401

    def test_discard_archive_requires_auth(self, client: TestClient) -> None:
        r = client.post(
            f"{BASE}/upload/archive/discard",
            json={"results_id": str(uuid.uuid4())},
        )
        assert r.status_code == 401

    def test_upload_to_nomad_requires_auth(self, client: TestClient) -> None:
        r = client.post(
            f"{BASE}/upload/nomad",
            json={"results_id": str(uuid.uuid4())},
        )
        assert r.status_code == 401

    def test_get_upload_status_requires_auth(self, client: TestClient) -> None:
        r = client.get(f"{BASE}/upload/{uuid.uuid4()}/status")
        assert r.status_code == 401


class TestNomadUploadAuthorization:
    def test_upload_files_non_nomad_user_forbidden_when_oauth_enabled(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        """When NOMAD OAuth is enabled and user has no nomad_sub, upload should 403."""
        import io

        with patch.object(settings, "NOMAD_OAUTH_ENABLED", True):
            r = client.post(
                f"{BASE}/upload/files",
                data={"results_id": str(uuid.uuid4())},
                files={"files": ("test.csv", io.BytesIO(b"data"), "text/plain")},
                headers=normal_user_token_headers,
            )
            assert r.status_code == 403


def test_upload_to_nomad_accepts_archive_path_from_form_data(
    client: TestClient,
    monkeypatch,
) -> None:
    TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    archive_path = TEMP_UPLOAD_DIR / "test_nomad_upload.zip"
    archive_path.write_bytes(b"fake zip content")

    upload_calls: list[tuple[str, str, str]] = []

    monkeypatch.setattr(settings, "NOMAD_USE_GLOBAL_AUTH", True)
    monkeypatch.setattr(settings, "NOMAD_USERNAME", "test-user")
    monkeypatch.setattr(settings, "NOMAD_PASSWORD", "test-pass")

    monkeypatch.setattr(
        nomad_routes,
        "create_nomad_metadata_yaml",
        lambda **_kwargs: {"test.archive.yaml": {"data": "value"}},
    )
    monkeypatch.setattr(nomad_routes, "get_nomad_token", lambda: "fake-token")

    def fake_upload_to_nomad(zip_path, token, upload_name):
        upload_calls.append((str(zip_path), token, upload_name))

    def fake_upload_to_nomad(zip_path, token, upload_name, existing_upload_id=None):
        upload_calls.append((str(zip_path), token, upload_name))
        return {
            "upload_id": "upload-123",
            "entry_ids": ["entry-1"],
            "upload_create_time": "2026-05-25T00:00:00Z",
            "processing_status": "RUNNING",
        }

    monkeypatch.setattr(nomad_routes, "upload_to_nomad", fake_upload_to_nomad)

    app.dependency_overrides[deps.get_current_user] = lambda: User(
        email="superuser@example.com",
        full_name="Test Superuser",
        is_superuser=True,
        is_active=True,
    )
    app.dependency_overrides[deps._require_token] = lambda: "request-token"

    request_data = {
        "experiment_id": str(uuid.uuid4()),
        "experiment_name": "Archive Upload",
        "substrates": [],
        "measurement_files": [],
        "device_groups": [],
    }

    response = client.post(
        f"{settings.API_V1_STR}/nomad/upload/nomad",
        data={
            "request_json": json.dumps(request_data),
            "archive_path": str(archive_path),
        },
    )

    try:
        assert response.status_code == 200
        assert response.json()["success"] is True
        assert upload_calls == [
            (str(archive_path.resolve()), "fake-token", "Archive Upload")
        ]
        assert not archive_path.exists()
    finally:
        app.dependency_overrides.clear()
        archive_path.unlink(missing_ok=True)


# ─────────────────────────────────────────────────────────────────────────────
# POST /nomad/upload/files — functional tests
# ─────────────────────────────────────────────────────────────────────────────

class TestNomadUploadFiles:
    """Test POST /nomad/upload/files (file → zip creation)."""

    def _post_file(
        self,
        client: TestClient,
        headers: dict,
        filename: str = "data.csv",
        content: bytes = b"wavelength,intensity\n500,1.0\n",
        extra_data: dict | None = None,
    ) -> "requests.Response":  # noqa: F821
        data: dict = {**(extra_data or {})}
        return client.post(
            f"{BASE}/upload/files",
            data=data,
            files=[("files", (filename, io.BytesIO(content), "text/plain"))],
            headers=headers,
        )

    def test_upload_file_creates_archive(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        """Uploading a file returns a zip archive path."""
        TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        with patch.object(__import__("app.core.config", fromlist=["settings"]).settings, "NOMAD_OAUTH_ENABLED", False):
            r = self._post_file(client, normal_user_token_headers)
        assert r.status_code == 200
        data = r.json()
        assert data["success"] is True
        assert "archive_path" in data
        assert data["file_count"] == 1
        # Cleanup
        Path(data["archive_path"]).unlink(missing_ok=True)

    def test_upload_no_files_returns_400(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(
            f"{BASE}/upload/files",
            data={},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 400

    def test_upload_multiple_files(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        with patch.object(__import__("app.core.config", fromlist=["settings"]).settings, "NOMAD_OAUTH_ENABLED", False):
            r = client.post(
                f"{BASE}/upload/files",
                files=[
                    ("files", ("a.csv", io.BytesIO(b"col,val\n1,2\n"), "text/plain")),
                    ("files", ("b.csv", io.BytesIO(b"col,val\n3,4\n"), "text/plain")),
                ],
                headers=normal_user_token_headers,
            )
        assert r.status_code == 200
        data = r.json()
        assert data["file_count"] == 2
        Path(data["archive_path"]).unlink(missing_ok=True)

    def test_uploaded_archive_is_valid_zip(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        with patch.object(__import__("app.core.config", fromlist=["settings"]).settings, "NOMAD_OAUTH_ENABLED", False):
            r = self._post_file(
                client, normal_user_token_headers, "measurement.txt", b"data"
            )
        assert r.status_code == 200
        archive_path = Path(r.json()["archive_path"])
        try:
            assert zipfile.is_zipfile(archive_path)
            with zipfile.ZipFile(archive_path) as zf:
                assert any("measurement.txt" in name for name in zf.namelist())
        finally:
            archive_path.unlink(missing_ok=True)


# ─────────────────────────────────────────────────────────────────────────────
# POST /nomad/metadata/preview — functional tests
# ─────────────────────────────────────────────────────────────────────────────

class TestNomadMetadataPreview:
    """Test POST /nomad/metadata/preview (read YAML from archive)."""

    def _make_archive_with_yaml(self, content: str = "data: value\n") -> Path:
        TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        archive_path = TEMP_UPLOAD_DIR / f"test_preview_{uuid.uuid4().hex}.zip"
        with zipfile.ZipFile(archive_path, "w") as zf:
            zf.writestr("measurement.csv", b"col,val\n1,2\n")
            zf.writestr("metadata.archive.yaml", content)
        return archive_path

    def test_preview_reads_yaml_files(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        archive = self._make_archive_with_yaml("key: value\n")
        try:
            r = client.post(
                f"{BASE}/metadata/preview",
                data={"archive_path": str(archive)},
                headers=normal_user_token_headers,
            )
            assert r.status_code == 200
            data = r.json()
            assert data["success"] is True
            assert data["metadata_count"] >= 1
            assert "metadata.archive.yaml" in data["yaml_files"]
        finally:
            archive.unlink(missing_ok=True)

    def test_preview_lists_all_files(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        archive = self._make_archive_with_yaml()
        try:
            r = client.post(
                f"{BASE}/metadata/preview",
                data={"archive_path": str(archive)},
                headers=normal_user_token_headers,
            )
            assert r.status_code == 200
            data = r.json()
            assert "measurement.csv" in data["all_files"]
            assert data["total_file_count"] == 2
        finally:
            archive.unlink(missing_ok=True)

    def test_preview_archive_not_found_returns_404(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        fake_path = TEMP_UPLOAD_DIR / "nonexistent.zip"
        r = client.post(
            f"{BASE}/metadata/preview",
            data={"archive_path": str(fake_path)},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 404

    def test_preview_path_outside_temp_dir_forbidden(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(
            f"{BASE}/metadata/preview",
            data={"archive_path": "/etc/passwd"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403


# ─────────────────────────────────────────────────────────────────────────────
# POST /nomad/upload/archive/discard — functional tests
# ─────────────────────────────────────────────────────────────────────────────

class TestNomadArchiveDiscard:
    """Test POST /nomad/upload/archive/discard."""

    def test_discard_existing_archive(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
        archive = TEMP_UPLOAD_DIR / f"discard_{uuid.uuid4().hex}.zip"
        archive.write_bytes(b"fake zip")

        r = client.post(
            f"{BASE}/upload/archive/discard",
            data={"archive_path": str(archive)},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        assert r.json()["success"] is True
        assert not archive.exists()

    def test_discard_nonexistent_archive_returns_false(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        fake = TEMP_UPLOAD_DIR / "never_existed.zip"
        r = client.post(
            f"{BASE}/upload/archive/discard",
            data={"archive_path": str(fake)},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        assert r.json()["success"] is False

    def test_discard_path_outside_temp_dir_forbidden(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(
            f"{BASE}/upload/archive/discard",
            data={"archive_path": "/etc/passwd"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403


# ─────────────────────────────────────────────────────────────────────────────
# GET /nomad/upload/{upload_id}/status — functional tests
# ─────────────────────────────────────────────────────────────────────────────

class TestNomadUploadStatus:
    """Test GET /nomad/upload/{upload_id}/status."""

    def test_status_returns_structure_with_mocked_service(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        """Upload status endpoint returns the expected shape when the NOMAD service is mocked."""
        upload_id = str(uuid.uuid4())
        with (
            patch.object(__import__("app.core.config", fromlist=["settings"]).settings, "NOMAD_MOCK_MODE", True),
            patch("app.api.routes.nomad.get_upload_status") as mock_status,
        ):
            mock_status.return_value = {
                "process_status": "SUCCESS",
                "last_status_message": "completed successfully",
                "entries": [{"entry_id": "e1"}],
            }
            r = client.get(
                f"{BASE}/upload/{upload_id}/status",
                headers=normal_user_token_headers,
            )
        assert r.status_code == 200
        data = r.json()
        assert data["upload_id"] == upload_id
        assert data["status"] == "SUCCESS"

    def test_status_normalises_failure_message(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        upload_id = str(uuid.uuid4())
        with (
            patch.object(__import__("app.core.config", fromlist=["settings"]).settings, "NOMAD_MOCK_MODE", True),
            patch("app.api.routes.nomad.get_upload_status") as mock_status,
        ):
            mock_status.return_value = {
                "process_status": "RUNNING",
                "last_status_message": "Processing failed with error",
                "entries": None,
            }
            r = client.get(
                f"{BASE}/upload/{upload_id}/status",
                headers=normal_user_token_headers,
            )
        assert r.status_code == 200
        assert r.json()["status"] == "FAILURE"

    def test_status_not_configured_returns_503(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        """Without NOMAD configured and no OAuth, returns 503."""
        with (
            patch.object(__import__("app.core.config", fromlist=["settings"]).settings, "NOMAD_MOCK_MODE", False),
            patch.object(__import__("app.core.config", fromlist=["settings"]).settings, "NOMAD_OAUTH_ENABLED", False),
            patch.object(__import__("app.core.config", fromlist=["settings"]).settings, "NOMAD_USERNAME", None),
            patch.object(__import__("app.core.config", fromlist=["settings"]).settings, "NOMAD_PASSWORD", None),
        ):
            r = client.get(
                f"{BASE}/upload/{uuid.uuid4()}/status",
                headers=normal_user_token_headers,
            )
        assert r.status_code == 503


# ─────────────────────────────────────────────────────────────────────────────
# POST /nomad/upload/nomad — full upload flow tests
# ─────────────────────────────────────────────────────────────────────────────

class TestNomadFullUploadFlow:
    """Test the complete upload/nomad endpoint end-to-end with mocked NOMAD calls."""

    _REQUEST = {
        "experiment_id": str(uuid.uuid4()),
        "experiment_name": "Full Flow Test",
        "substrates": [],
        "measurement_files": [],
        "device_groups": [],
        "ignored_files": [],
    }

    def test_upload_with_files_calls_nomad(
        self, client: TestClient, monkeypatch
    ) -> None:
        """Uploading with files triggers the NOMAD upload service."""
        from app.api import deps
        from app.api.routes import nomad as nomad_routes
        from app.models import User

        upload_calls: list = []
        TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

        monkeypatch.setattr(settings, "NOMAD_USE_GLOBAL_AUTH", True)
        monkeypatch.setattr(settings, "NOMAD_USERNAME", "u")
        monkeypatch.setattr(settings, "NOMAD_PASSWORD", "p")
        monkeypatch.setattr(settings, "NOMAD_OAUTH_ENABLED", False)
        monkeypatch.setattr(
            nomad_routes,
            "create_nomad_metadata_yaml",
            lambda **_: {},
        )
        monkeypatch.setattr(nomad_routes, "get_nomad_token", lambda: "tok")

        def _fake_upload(zip_path, token, upload_name, existing_upload_id=None):
            upload_calls.append(zip_path)
            return {
                "upload_id": "upload-abc",
                "entry_ids": [],
                "upload_create_time": "2026-01-01T00:00:00Z",
                "processing_status": "RUNNING",
            }

        monkeypatch.setattr(nomad_routes, "upload_to_nomad", _fake_upload)

        app.dependency_overrides[deps.get_current_user] = lambda: User(
            email="su@example.com", is_superuser=True, is_active=True
        )
        app.dependency_overrides[deps._require_token] = lambda: "tok"

        try:
            r = client.post(
                f"{BASE}/upload/nomad",
                data={"request_json": json.dumps(self._REQUEST)},
                files=[("files", ("m.csv", io.BytesIO(b"a,b\n1,2\n"), "text/plain"))],
            )
            assert r.status_code == 200
            assert r.json()["success"] is True
            assert r.json()["upload_id"] == "upload-abc"
            assert len(upload_calls) == 1
        finally:
            app.dependency_overrides.clear()

    def test_upload_not_configured_returns_failure(
        self, client: TestClient, monkeypatch
    ) -> None:
        """When NOMAD is not configured, returns success=False (not an error)."""
        from app.api import deps
        from app.models import User

        monkeypatch.setattr(settings, "NOMAD_OAUTH_ENABLED", False)
        monkeypatch.setattr(settings, "NOMAD_USERNAME", None)
        monkeypatch.setattr(settings, "NOMAD_PASSWORD", None)

        app.dependency_overrides[deps.get_current_user] = lambda: User(
            email="su@example.com", is_superuser=True, is_active=True
        )
        app.dependency_overrides[deps._require_token] = lambda: "tok"

        try:
            r = client.post(
                f"{BASE}/upload/nomad",
                data={"request_json": json.dumps(self._REQUEST)},
            )
            assert r.status_code == 200
            assert r.json()["success"] is False
        finally:
            app.dependency_overrides.clear()

    def test_upload_invalid_request_json_returns_422(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(
            f"{BASE}/upload/nomad",
            data={"request_json": "NOT JSON"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 422
