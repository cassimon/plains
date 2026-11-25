"""Tests for the native-upload structured parse endpoint and shared parser."""

import io
import zipfile

from fastapi.testclient import TestClient

from app.core.config import settings
from app.services.zip_import import measurements_from_jv_file

BASE = f"{settings.API_V1_STR}/zip-explorer"

JV_FILE = (
    "## Header ##\n"
    "[General info]\n"
    "User\tKARTHI\n"
    "Device\tPVK1-BSAM-C60-28-1A\n"
    "Cell area (cm2)\t0.5\n"
    "Date\t2026-01-22\n"
    "\n"
    "[JV Settings]\n"
    "Scan direction\tFW then RV\n"
    "\n"
    "## Data ##\n"
    "Scan\tVoc\tJsc\tV_MPP\tJ_MPP\tP_MPP\tRs\tR//\tFF\tEff\n"
    "\tV\tmA/cm2\tV\tmA/cm2\tmW/cm2\tOhm\tOhm\t%\t%\n"
    "FW\t1.013\t21.189\t0.754\t19.118\t14.416\t1.42E+1\t2.01E+3\t67.11\t14.42\n"
    "RV\t1.018\t21.219\t0.857\t18.943\t16.243\t9.80E+0\t2.71E+3\t75.14\t16.24\n"
)


def test_measurements_from_jv_file_parses_fw_rv():
    rows = measurements_from_jv_file(JV_FILE.encode(), "dir/0001_Stability (JV)_PVK1-BSAM-C60-28-1A.txt")
    assert len(rows) == 2
    fw = next(r for r in rows if r["direction"] == "FW")
    rv = next(r for r in rows if r["direction"] == "RV")
    assert fw["device"] == "PVK1-BSAM-C60-28-1A"
    assert fw["cell"] == "1"
    assert fw["pixel"] == "A"
    assert fw["voc"] == 1.013
    assert fw["jsc"] == 21.189
    assert fw["ff"] == 67.11
    assert fw["eff"] == 14.42
    assert rv["direction"] == "RV"
    assert rv["eff"] == 16.24
    # Individual files have unknown summary coverage, never a confirmed exclusion.
    assert all(r["in_summary"] is None for r in rows)


def make_jv_zip() -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("batch/0001_Stability (JV)_N 1 1-1A.txt", JV_FILE.replace("PVK1-BSAM-C60-28-1A", "N 1 1-1A"))
    return buf.getvalue()


class TestParseEndpoint:
    def test_parse_zip_returns_measurements_and_raw_archive(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(
            f"{BASE}/parse",
            files={"files": ("archive.zip", make_jv_zip(), "application/zip")},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert len(body["measurements"]) == 2
        assert body["measurements"][0]["device"] == "N 1 1-1A"
        assert body["measurements"][0]["cell"] == "1"
        assert body["measurements"][0]["pixel"] == "A"
        assert body["archive_path"] is not None
        assert body["raw_file_count"] == 1

    def test_parse_individual_chose_file(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(
            f"{BASE}/parse",
            files={"files": ("0001_Stability (JV)_PVK1-BSAM-C60-28-1A.txt", JV_FILE.encode(), "text/plain")},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert len(body["measurements"]) == 2
        assert {m["direction"] for m in body["measurements"]} == {"FW", "RV"}

    def test_parse_ignores_unsupported_text(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(
            f"{BASE}/parse",
            files={"files": ("notes.txt", b"Device: AI44\nVoc: 1.1", "text/plain")},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["measurements"] == []
        assert body["skipped"][0]["reason"].startswith("Not a supported")

    def test_successive_drops_append_to_the_same_archive(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        headers = normal_user_token_headers
        first = client.post(
            f"{BASE}/parse",
            files={
                "files": ("0001_Stability (JV)_A-1A.txt", JV_FILE.replace("PVK1-BSAM-C60-28-1A", "A-1A").encode(), "text/plain")
            },
            headers=headers,
        ).json()
        archive = first["archive_path"]

        second = client.post(
            f"{BASE}/parse",
            files={
                "files": ("0002_Stability (JV)_B-1A.txt", JV_FILE.replace("PVK1-BSAM-C60-28-1A", "B-1A").encode(), "text/plain")
            },
            data={"archive_path": archive},
            headers=headers,
        )
        assert second.status_code == 200, second.text
        assert second.json()["archive_path"] == archive

        # The archive now holds both raw files.
        import os
        import zipfile as zfmod
        with zfmod.ZipFile(archive) as zf:
            names = sorted(zf.namelist())
        assert len(names) == 2
        assert any("A-1A" in n for n in names)
        assert any("B-1A" in n for n in names)

    def test_colliding_basenames_are_rejected(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(
            f"{BASE}/parse",
            files=[
                ("files", ("dir1/same.txt", JV_FILE.replace("PVK1-BSAM-C60-28-1A", "A-1A").encode(), "text/plain")),
                ("files", ("dir2/same.txt", JV_FILE.replace("PVK1-BSAM-C60-28-1A", "B-1A").encode(), "text/plain")),
            ],
            headers=normal_user_token_headers,
        )
        assert r.status_code == 409
        assert "Collision" in r.json()["detail"]

    def test_zip_preserves_non_jv_files_as_other_files(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        params = (
            "## Header ##\n[General info]\nDevice\tA-1A\nTest\tStability (Parameters)\n"
            "## Data ##\nScan\tVoc\nFW\t1.0\n"
        )
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            zf.writestr("b/0001_Stability (JV)_A-1A.txt", JV_FILE.replace("PVK1-BSAM-C60-28-1A", "A-1A"))
            zf.writestr("b/0001_Stability (Parameters)_A-1A.txt", params)
        r = client.post(
            f"{BASE}/parse",
            files={"files": ("archive.zip", buf.getvalue(), "application/zip")},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert len(body["measurements"]) == 2  # FW + RV of the JV file
        assert len(body["other_files"]) == 1
        assert body["other_files"][0]["filename"] == "0001_Stability (Parameters)_A-1A.txt"
        assert "Stability (Parameters)" in body["other_files"][0]["content"]
