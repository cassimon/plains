"""Integration tests for the ZIP import endpoint (requires DB fixtures)."""

import io
import zipfile

from fastapi.testclient import TestClient

from app.core.config import settings

BASE = f"{settings.API_V1_STR}/zip-explorer"
RESULTS = f"{settings.API_V1_STR}/results"
EXP_BASE = f"{settings.API_V1_STR}/experiments"
PLANES = f"{settings.API_V1_STR}/planes"
PROCESSES = f"{settings.API_V1_STR}/processes"

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

    def test_import_creates_new_experiment_without_process(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        # Data-first path: no pre-existing experiment/process is required.
        r = client.post(
            f"{BASE}/import",
            files={"file": ("archive.zip", make_zip(), "application/zip")},
            data={"experiment_name": "Imported data", "dry_run": "false"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["created_experiment"] is True
        assert body["experiment_id"]
        assert body["imported"] == 2

        # The experiment exists, is owned by the caller, and has no process.
        g = client.get(
            f"{EXP_BASE}/{body['experiment_id']}", headers=normal_user_token_headers
        )
        assert g.status_code == 200
        exp = g.json()
        assert exp["name"] == "Imported data"
        assert exp["process_id"] is None

        # Imported results are retrievable.
        res = client.get(
            f"{RESULTS}/{body['result_id']}", headers=normal_user_token_headers
        )
        assert res.status_code == 200
        assert len(res.json()["measurement_files"]) == 2

    def test_import_organizes_new_experiment(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = client.post(
            f"{PLANES}/", json={"name": "Import plane"}, headers=normal_user_token_headers
        ).json()
        proc = client.post(
            f"{PROCESSES}/", json={"name": "Import process"}, headers=normal_user_token_headers
        ).json()

        r = client.post(
            f"{BASE}/import",
            files={"file": ("archive.zip", make_zip(), "application/zip")},
            data={
                "experiment_name": "Organized import",
                "plane_id": plane["id"],
                "process_id": proc["id"],
                "dry_run": "false",
            },
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["created_experiment"] is True

        # The experiment is linked to the selected plane and process.
        exp = client.get(
            f"{EXP_BASE}/{body['experiment_id']}", headers=normal_user_token_headers
        ).json()
        assert exp["plane_id"] == plane["id"]
        assert exp["process_id"] == proc["id"]

        # Measurements are grouped into device groups (one per filename).
        res = client.get(
            f"{RESULTS}/{body['result_id']}", headers=normal_user_token_headers
        ).json()
        assert len(res["measurement_files"]) == 2
        assert len(res["device_groups"]) == 2
