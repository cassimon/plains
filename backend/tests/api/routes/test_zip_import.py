"""Integration tests for the ZIP import endpoint (requires DB fixtures)."""

import io
import zipfile

from fastapi.testclient import TestClient

from app.core.config import settings

BASE = f"{settings.API_V1_STR}/zip-explorer"
RESULTS = f"{settings.API_V1_STR}/results"
EXP_BASE = f"{settings.API_V1_STR}/experiments"

SUMMARY = (
    "File\tVoc (V)\tJsc (mA/cm2)\tVMPP (V)\tJMPP (mA/cm2)\tPMPP (mW/cm2)"
    "\tRs (Ohm)\tRsh (Ohm)\tFF (%)\tEff (%)\n"
    "sample_A_01\t1.10\t22.5\t0.90\t21.0\t18.9\t1.2\t3000\t76.4\t18.9\n"
    "sample_A_02\t1.08\t21.9\t0.88\t20.5\t18.0\t1.3\t2800\t75.0\t18.0\n"
)


def make_zip() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("JV Summary_Parameters FW.txt", SUMMARY)
    return buf.getvalue()


def _post_import(
    client: TestClient,
    headers: dict,
    zip_bytes: bytes,
    experiment_id: str,
    dry_run: str = "false",
):
    return client.post(
        f"{BASE}/import",
        files={"file": ("archive.zip", zip_bytes, "application/zip")},
        data={"experiment_id": experiment_id, "dry_run": dry_run},
        headers=headers,
    )


def create_experiment(client: TestClient, headers: dict) -> dict:
    r = client.post(f"{EXP_BASE}/", json={"name": "import-test"}, headers=headers)
    assert r.status_code == 200
    return r.json()


class TestZipImport:
    def test_import_creates_native_results(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        exp = create_experiment(client, normal_user_token_headers)
        r = _post_import(client, normal_user_token_headers, make_zip(), exp["id"])
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["imported"] == 2
        assert body["result_id"]
        assert len(body["skipped"]) == 0

        # Imported result is retrievable after "reload".
        g = client.get(f"{RESULTS}/{body['result_id']}", headers=normal_user_token_headers)
        assert g.status_code == 200
        files = g.json()["measurement_files"]
        assert len(files) == 2
        first = files[0]
        assert first["filename"] == "sample_A_01"
        assert first["file_type"] == "JV"
        assert first["voc"] == 1.10
        assert first["jsc"] == 22.5
        assert first["ff"] == 76.4
        assert first["value"] == 18.9

    def test_dry_run_does_not_persist(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        exp = create_experiment(client, normal_user_token_headers)
        r = _post_import(
            client, normal_user_token_headers, make_zip(), exp["id"], dry_run="true"
        )
        assert r.status_code == 200
        body = r.json()
        assert body["imported"] == 0
        assert body["result_id"] is None
        assert len(body["measurements"]) == 2

    def test_import_requires_experiment_ownership(
        self,
        client: TestClient,
        normal_user_token_headers: dict[str, str],
        superuser_token_headers: dict[str, str],
    ) -> None:
        exp = create_experiment(client, superuser_token_headers)
        r = _post_import(client, normal_user_token_headers, make_zip(), exp["id"])
        assert r.status_code == 403

    def test_import_rejects_invalid_experiment_id(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = _post_import(
            client, normal_user_token_headers, make_zip(), "not-a-uuid"
        )
        assert r.status_code == 400
