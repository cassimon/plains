"""Per-user authorization for temporary NOMAD upload archives (SECURITY-02B).

An archive lives under TEMP_UPLOAD_DIR/<user_id>, so ownership is enforced by
filesystem location. A user may preview/append/discard only archives inside
their own directory; any other path (another user's, a legacy root archive, or
anything outside TEMP_UPLOAD_DIR) is rejected with 403 before any side effect.
"""

from __future__ import annotations

import io
import json
import uuid
import zipfile
from datetime import timedelta
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.api.routes import nomad as nomad_routes
from app.core import security
from app.core.config import settings
from app.services.nomad import TEMP_UPLOAD_DIR
from tests.utils.user import create_random_user

BASE = f"{settings.API_V1_STR}/nomad"


def _make_user(db):
    """Create a user and mint its JWT directly (no login endpoint)."""
    user = create_random_user(db)
    token = security.create_access_token(user.email, timedelta(minutes=60))
    return user, {"Authorization": f"Bearer {token}"}


def _make_archive(user) -> Path:
    """Create a disposable zip inside the user's own upload directory."""
    d = nomad_routes._user_upload_dir(user.id)
    d.mkdir(parents=True, exist_ok=True)
    p = d / f"test_{uuid.uuid4().hex}.zip"
    with zipfile.ZipFile(p, "w") as zf:
        zf.writestr("m.csv", b"a,b\n1,2\n")
    return p


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
            "experiment_name": "Archive ownership",
            "substrates": [],
            "measurement_files": [],
            "device_groups": [],
        }
    )


@pytest.fixture(autouse=True)
def local_auth(monkeypatch):
    """Local auth mode so non-OAuth users can exercise the archive endpoints."""
    monkeypatch.setattr(settings, "NOMAD_OAUTH_ENABLED", False)


# ── Authorized operations ───────────────────────────────────────────────────


def test_owner_can_preview_archive(client: TestClient, db) -> None:
    user, headers = _make_user(db)
    archive = _make_archive(user)
    try:
        r = client.post(
            f"{BASE}/metadata/preview",
            data={"archive_path": str(archive)},
            headers=headers,
        )
        assert r.status_code == 200, r.text
    finally:
        archive.unlink(missing_ok=True)


def test_owner_can_append_files(client: TestClient, db) -> None:
    user, headers = _make_user(db)
    archive = _make_archive(user)
    try:
        r = client.post(
            f"{BASE}/upload/files",
            data={"archive_path": str(archive)},
            files=[("files", ("x.csv", io.BytesIO(b"x,y\n"), "text/plain"))],
            headers=headers,
        )
        assert r.status_code == 200, r.text
    finally:
        archive.unlink(missing_ok=True)


def test_owner_can_discard_archive(client: TestClient, db) -> None:
    user, headers = _make_user(db)
    archive = _make_archive(user)
    r = client.post(
        f"{BASE}/upload/archive/discard",
        data={"archive_path": str(archive)},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    assert not archive.exists()


# ── Cross-user rejection (no side effects) ──────────────────────────────────


def test_other_user_cannot_preview_archive(
    client: TestClient, db
) -> None:
    user_a, _ = _make_user(db)
    _user_b, headers_b = _make_user(db)
    archive = _make_archive(user_a)
    try:
        r = client.post(
            f"{BASE}/metadata/preview",
            data={"archive_path": str(archive)},
            headers=headers_b,
        )
        assert r.status_code == 403, r.text
        assert archive.exists()  # untouched
    finally:
        archive.unlink(missing_ok=True)


def test_other_user_cannot_append(client: TestClient, db) -> None:
    user_a, _ = _make_user(db)
    _user_b, headers_b = _make_user(db)
    archive = _make_archive(user_a)
    try:
        r = client.post(
            f"{BASE}/upload/files",
            data={"archive_path": str(archive)},
            files=[("files", ("x.csv", io.BytesIO(b"x,y\n"), "text/plain"))],
            headers=headers_b,
        )
        assert r.status_code == 403, r.text
        assert archive.exists()  # not modified
    finally:
        archive.unlink(missing_ok=True)


def test_other_user_cannot_discard(client: TestClient, db) -> None:
    user_a, _ = _make_user(db)
    _user_b, headers_b = _make_user(db)
    archive = _make_archive(user_a)
    try:
        r = client.post(
            f"{BASE}/upload/archive/discard",
            data={"archive_path": str(archive)},
            headers=headers_b,
        )
        assert r.status_code == 403, r.text
        assert archive.exists()  # not removed
    finally:
        archive.unlink(missing_ok=True)


# ── Path confinement ────────────────────────────────────────────────────────


def test_path_outside_upload_dir_rejected(
    client: TestClient, db
) -> None:
    _user, headers = _make_user(db)
    r = client.post(
        f"{BASE}/metadata/preview",
        data={"archive_path": "/etc/passwd"},
        headers=headers,
    )
    assert r.status_code == 403, r.text


def test_legacy_root_archive_denied(client: TestClient, db) -> None:
    """A pre-SECURITY-02B archive in the TEMP_UPLOAD_DIR root has no owner: deny."""
    _user, headers = _make_user(db)
    TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    legacy = TEMP_UPLOAD_DIR / f"legacy_{uuid.uuid4().hex}.zip"
    with zipfile.ZipFile(legacy, "w") as zf:
        zf.writestr("m.csv", b"a,b\n1,2\n")
    try:
        r = client.post(
            f"{BASE}/metadata/preview",
            data={"archive_path": str(legacy)},
            headers=headers,
        )
        assert r.status_code == 403, r.text
        assert legacy.exists()  # not silently deleted
    finally:
        legacy.unlink(missing_ok=True)


# ── Cross-user with a valid experiment (SECURITY-FINAL-GATE) ───────────────


def test_other_user_cannot_add_metadata_to_others_archive(
    client: TestClient, db, monkeypatch
) -> None:
    """B owns a valid experiment but supplies A's archive → 403, no side effects."""
    user_a, _ = _make_user(db)
    _user_b, headers_b = _make_user(db)

    # A valid experiment owned by B (so the experiment ownership check passes).
    exp = _make_experiment(client, headers_b, "B's experiment")
    archive = _make_archive(user_a)

    materialize = Mock()
    metadata = Mock()
    monkeypatch.setattr(nomad_routes, "_materialize_chemicals", materialize)
    monkeypatch.setattr(nomad_routes, "create_nomad_metadata_yaml", metadata)

    try:
        r = client.post(
            f"{BASE}/upload/metadata",
            data={
                "request_json": _request_json(exp["id"]),
                "archive_path": str(archive),
            },
            headers=headers_b,
        )
        assert r.status_code == 403, r.text
        assert archive.exists()  # not modified/removed
        materialize.assert_not_called()
        metadata.assert_not_called()
    finally:
        archive.unlink(missing_ok=True)


def test_other_user_cannot_upload_with_others_archive(
    client: TestClient, db, monkeypatch
) -> None:
    """B owns a valid experiment but supplies A's archive → 403, no NOMAD upload."""
    user_a, _ = _make_user(db)
    _user_b, headers_b = _make_user(db)

    exp = _make_experiment(client, headers_b, "B's experiment")
    archive = _make_archive(user_a)

    monkeypatch.setattr(settings, "NOMAD_USE_GLOBAL_AUTH", True)
    monkeypatch.setattr(settings, "NOMAD_USERNAME", "test-user")
    monkeypatch.setattr(settings, "NOMAD_PASSWORD", "test-pass")
    monkeypatch.setattr(nomad_routes, "get_nomad_token", lambda: "fake-token")
    upload = Mock()
    monkeypatch.setattr(nomad_routes, "upload_to_nomad", upload)
    monkeypatch.setattr(
        nomad_routes,
        "create_nomad_metadata_yaml",
        lambda **_kwargs: {"test.archive.yaml": {"data": "value"}},
    )

    try:
        r = client.post(
            f"{BASE}/upload/nomad",
            data={
                "request_json": _request_json(exp["id"]),
                "archive_path": str(archive),
            },
            headers=headers_b,
        )
        assert r.status_code == 403, r.text
        assert archive.exists()  # not modified/removed
        upload.assert_not_called()
    finally:
        archive.unlink(missing_ok=True)
