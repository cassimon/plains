from __future__ import annotations

import json
import uuid
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
