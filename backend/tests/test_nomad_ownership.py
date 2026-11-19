"""Ownership enforcement for NOMAD export (SECURITY-02A).

Every endpoint that processes a client-supplied experiment id must reject, with
403, experiments owned by another user — before materializing chemicals,
generating metadata, or performing an external NOMAD upload. Missing/malformed
ids follow the 404 convention.
"""

from __future__ import annotations

import io
import json
import uuid
from datetime import timedelta
from unittest.mock import Mock

from fastapi.testclient import TestClient

from app.api.routes import nomad as nomad_routes
from app.core import security
from app.core.config import settings
from tests.utils.user import create_random_user

BASE = f"{settings.API_V1_STR}/nomad"


def _make_user(db):
    """Create a user and mint its JWT directly (no login endpoint → no rate-limit)."""
    user = create_random_user(db)
    token = security.create_access_token(user.email, timedelta(minutes=60))
    return user, {"Authorization": f"Bearer {token}"}


def _make_experiment(client: TestClient, headers: dict, name: str) -> dict:
    r = client.post(
        f"{settings.API_V1_STR}/experiments/",
        json={"name": name},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _request_json(experiment_id: str) -> str:
    return json.dumps(
        {
            "experiment_id": experiment_id,
            "experiment_name": "Ownership test",
            "substrates": [],
            "measurement_files": [],
            "device_groups": [],
        }
    )


def _mock_nomad(monkeypatch):
    """Point NOMAD at a mock and return the side-effect mocks for assertions."""
    monkeypatch.setattr(settings, "NOMAD_USE_GLOBAL_AUTH", True)
    monkeypatch.setattr(settings, "NOMAD_USERNAME", "test-user")
    monkeypatch.setattr(settings, "NOMAD_PASSWORD", "test-pass")
    monkeypatch.setattr(nomad_routes, "get_nomad_token", lambda: "fake-token")
    materialize = Mock()
    metadata = Mock(return_value={"test.archive.yaml": {"data": "value"}})
    upload = Mock(
        return_value={
            "upload_id": "upload-123",
            "entry_ids": ["entry-1"],
            "upload_create_time": "2026-06-01T12:00:00Z",
            "processing_status": "RUNNING",
        }
    )
    monkeypatch.setattr(nomad_routes, "_materialize_chemicals", materialize)
    monkeypatch.setattr(nomad_routes, "create_nomad_metadata_yaml", metadata)
    monkeypatch.setattr(nomad_routes, "upload_to_nomad", upload)
    return materialize, metadata, upload


# ── POST /nomad/upload/nomad ────────────────────────────────────────────────


def test_owner_can_upload_owned_experiment(client: TestClient, db, monkeypatch) -> None:
    owner, headers = _make_user(db)
    exp = _make_experiment(client, headers, "Owned by caller")
    _mock_nomad(monkeypatch)

    archive = nomad_routes._user_upload_dir(owner.id) / "ownership_owner.zip"
    archive.parent.mkdir(parents=True, exist_ok=True)
    archive.write_bytes(b"fake zip content")

    try:
        r = client.post(
            f"{BASE}/upload/nomad",
            data={
                "request_json": _request_json(exp["id"]),
                "archive_path": str(archive),
            },
            headers=headers,
        )
        assert r.status_code == 200, r.text
        assert r.json()["success"] is True
    finally:
        archive.unlink(missing_ok=True)


def test_other_user_cannot_upload_experiment(
    client: TestClient, db, monkeypatch
) -> None:
    _user_a, headers_a = _make_user(db)
    exp = _make_experiment(client, headers_a, "A's experiment")
    _user_b, headers_b = _make_user(db)
    materialize, metadata, upload = _mock_nomad(monkeypatch)

    r = client.post(
        f"{BASE}/upload/nomad",
        data={"request_json": _request_json(exp["id"])},
        headers=headers_b,
    )

    assert r.status_code == 403, r.text
    materialize.assert_not_called()
    metadata.assert_not_called()
    upload.assert_not_called()


def test_missing_experiment_id_returns_404(
    client: TestClient, db, monkeypatch
) -> None:
    _user, headers = _make_user(db)
    _mock_nomad(monkeypatch)

    r = client.post(
        f"{BASE}/upload/nomad",
        data={"request_json": _request_json(str(uuid.uuid4()))},
        headers=headers,
    )

    assert r.status_code == 404, r.text


def test_malformed_experiment_id_returns_404(
    client: TestClient, db, monkeypatch
) -> None:
    _user, headers = _make_user(db)
    _mock_nomad(monkeypatch)

    r = client.post(
        f"{BASE}/upload/nomad",
        data={"request_json": _request_json("not-a-uuid")},
        headers=headers,
    )

    assert r.status_code == 404, r.text


# ── POST /nomad/upload/metadata ─────────────────────────────────────────────


def test_other_user_cannot_add_metadata_for_experiment(
    client: TestClient, db, monkeypatch
) -> None:
    _user_a, headers_a = _make_user(db)
    exp = _make_experiment(client, headers_a, "A's experiment")
    _user_b, headers_b = _make_user(db)
    materialize, metadata, _upload = _mock_nomad(monkeypatch)

    r = client.post(
        f"{BASE}/upload/metadata",
        data={
            "request_json": _request_json(exp["id"]),
            "archive_path": "whatever.zip",
        },
        headers=headers_b,
    )

    assert r.status_code == 403, r.text
    materialize.assert_not_called()
    metadata.assert_not_called()


# ── POST /nomad/upload/files (with request_json) ────────────────────────────


def test_other_user_cannot_prepare_files_with_metadata_for_experiment(
    client: TestClient, db, monkeypatch
) -> None:
    _user_a, headers_a = _make_user(db)
    exp = _make_experiment(client, headers_a, "A's experiment")
    _user_b, headers_b = _make_user(db)
    materialize, metadata, _upload = _mock_nomad(monkeypatch)

    r = client.post(
        f"{BASE}/upload/files",
        data={"request_json": _request_json(exp["id"])},
        files=[("files", ("data.csv", io.BytesIO(b"x,y\n1,2\n"), "text/plain"))],
        headers=headers_b,
    )

    assert r.status_code == 403, r.text
    materialize.assert_not_called()
    metadata.assert_not_called()
