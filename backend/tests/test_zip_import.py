"""Unit tests for the ZIP import parser/mapping (pure, no database)."""

import io
import zipfile

import pytest

from app.services.zip_explorer import UnsafeZipError
from app.services.zip_import import (
    extract_importable_measurements,
    parse_jv_file,
    parse_jv_summary,
)


def make_zip(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in entries.items():
            zf.writestr(name, content)
    return buf.getvalue()


SUMMARY_HEADER = (
    "File\tVoc (V)\tJsc (mA/cm2)\tVMPP (V)\tJMPP (mA/cm2)\tPMPP (mW/cm2)"
    "\tRs (Ohm)\tRsh (Ohm)\tFF (%)\tEff (%)\n"
)


def test_parse_jv_summary_extracts_supported_metrics() -> None:
    text = (
        SUMMARY_HEADER
        + "sample_A_01\t1.10\t22.5\t0.90\t21.0\t18.9\t1.2\t3000\t76.4\t18.9\n"
        + "sample_A_02\t1.08\t21.9\t0.88\t20.5\t18.0\t1.3\t2800\t75.0\t18.0\n"
    )
    rows = parse_jv_summary(text)
    assert len(rows) == 2
    assert rows[0] == {
        "file": "sample_A_01",
        "voc": 1.10,
        "jsc": 22.5,
        "ff": 76.4,
        "eff": 18.9,
    }
    assert rows[1]["file"] == "sample_A_02"


def test_parse_jv_summary_skips_unparseable_rows() -> None:
    text = (
        SUMMARY_HEADER
        + "sample_ok\t1.0\t20.0\t0.8\t19.0\t15.0\t1.0\t2000\t75.0\t15.0\n"
        + "sample_bad\tnotanumber\n"  # too few columns → skipped
        + "\t1.0\t20.0\t0.8\t19.0\t15.0\t1.0\t2000\t75.0\t15.0\n"  # empty file → skipped
    )
    rows = parse_jv_summary(text)
    assert [r["file"] for r in rows] == ["sample_ok"]


def test_parse_jv_summary_accepts_decimal_comma() -> None:
    text = SUMMARY_HEADER + "s1\t1,10\t22,5\t0,90\t21,0\t18,9\t1,2\t3000\t76,4\t18,9\n"
    rows = parse_jv_summary(text)
    assert rows[0]["voc"] == 1.10
    assert rows[0]["eff"] == 18.9


def test_parse_jv_summary_rejects_non_finite_numbers() -> None:
    # nan / inf / -inf must be rejected (become None, and the row is dropped
    # only if every metric is None).
    text = (
        SUMMARY_HEADER
        + "s_nan\tnan\t22.5\t0.9\t21.0\t18.9\t1.2\t3000\t76.4\t18.9\n"
        + "s_inf\tinf\t22.5\t0.9\t21.0\t18.9\t1.2\t3000\t76.4\t18.9\n"
    )
    rows = parse_jv_summary(text)
    # voc is None for both, but jsc/ff/eff are finite → rows still parsed.
    assert all(r["voc"] is None for r in rows)
    assert rows[0]["jsc"] == 22.5


JV_FILE = (
    "## Header ##\n"
    "[General info]\n"
    "User\tRESEARCHER\n"
    "Device\tPVK1-BSAM-C60-28-1A\n"
    "Cell area (cm2)\t0.086\n"
    "Test\tStability (JV)\n"
    "Date\t2026-08-27\n"
    "Time\t16:14:20\n"
    "Note\tSMU 1A\n"
    "\n"
    "[JV Settings]\n"
    "Vmin (V)\t-0.100\n"
    "\n"
    "## Data ##\n"
    "Scan\tVoc\tJsc\tV_MPP\tJ_MPP\tP_MPP\tRs\tR//\tFF\tEff\n"
    "\tV\tmA/cm²\tV\tmA/cm²\tmW/cm²\tOhm\tOhm\t%\t%\n"
    "FW\t0.929921\t12.750992\t0.616521\t7.294367\t4.497130\t3.10E+2\t1.98E+3\t37.93\t4.50\n"
    "RV\t0.927747\t12.135900\t0.589129\t7.818476\t4.606093\t4.11E+2\t6.84E+4\t40.91\t4.61\n"
)


def test_parse_jv_file_extracts_device_and_directions() -> None:
    parsed = parse_jv_file(JV_FILE)
    assert parsed is not None
    assert parsed["device"] == "PVK1-BSAM-C60-28-1A"
    assert parsed["user"] == "RESEARCHER"
    assert parsed["date"] == "2026-08-27"
    assert parsed["fw"]["voc"] == 0.929921
    assert parsed["rv"]["voc"] == 0.927747
    assert parsed["fw"]["eff"] == 4.50


def test_extract_uses_original_jv_device_identity() -> None:
    data = make_zip(
        {
            "2026-08-27/DEVICE-1/0001_Stability (JV)_DEVICE-1.txt": JV_FILE.encode(),
        }
    )
    result = extract_importable_measurements(data)
    assert len(result["measurements"]) == 2  # FW + RV
    m = result["measurements"][0]
    # The explicit Device field is the identity, not the filename.
    assert m["device"] == "PVK1-BSAM-C60-28-1A"
    assert m["file"].startswith("2026-08-27/DEVICE-1/")
    assert m["direction"] == "FW"
    assert result["measurements"][1]["direction"] == "RV"


def test_identical_summary_filenames_in_different_directories() -> None:
    data = make_zip(
        {
            "batchA/JV Summary_Parameters FW.txt": (
                SUMMARY_HEADER + "same.txt\t1.0\t20\t0.8\t19\t15\t1\t2000\t75\t15\n"
            ).encode(),
            "batchB/JV Summary_Parameters FW.txt": (
                SUMMARY_HEADER + "same.txt\t1.1\t21\t0.81\t19.5\t15.5\t1.1\t2100\t76\t15.5\n"
            ).encode(),
        }
    )
    result = extract_importable_measurements(data)
    # Two distinct measurements from different directories, not one.
    assert len(result["measurements"]) == 2
    assert {m["batch"] for m in result["measurements"]} == {"batchA", "batchB"}


def test_mixed_original_and_summary_only_archives() -> None:
    data = make_zip(
        {
            "batchA/DEV/0001_Stability (JV)_DEV.txt": JV_FILE.encode(),
            "batchB/JV Summary_Parameters FW.txt": (
                SUMMARY_HEADER + "only.txt\t1.0\t20\t0.8\t19\t15\t1\t2000\t75\t15\n"
            ).encode(),
        }
    )
    result = extract_importable_measurements(data)
    # 2 (JV FW+RV) + 1 (summary FW) = 3 measurements.
    assert len(result["measurements"]) == 3


def test_extract_preserves_fw_and_rv_directions() -> None:
    data = make_zip(
        {
            "JV Summary_Parameters FW.txt": (
                SUMMARY_HEADER
                + "sample_A_01\t1.10\t22.5\t0.90\t21.0\t18.9\t1.2\t3000\t76.4\t18.9\n"
            ).encode(),
            "JV Summary_Parameters RV.txt": (
                SUMMARY_HEADER
                + "sample_A_01\t1.08\t21.9\t0.88\t20.5\t18.0\t1.3\t2800\t75.0\t18.0\n"
            ).encode(),
        }
    )
    result = extract_importable_measurements(data)

    # Same filename, two distinct scan directions → both preserved.
    assert [(m["file"], m["direction"]) for m in result["measurements"]] == [
        ("sample_A_01", "FW"),
        ("sample_A_01", "RV"),
    ]
    assert result["measurements"][0]["voc"] == 1.10
    assert result["measurements"][1]["voc"] == 1.08
    assert result["skipped"] == []


def test_extract_dedupes_true_duplicate_in_same_file() -> None:
    data = make_zip(
        {
            "JV Summary_Parameters FW.txt": (
                SUMMARY_HEADER
                + "sample_A_01\t1.10\t22.5\t0.90\t21.0\t18.9\t1.2\t3000\t76.4\t18.9\n"
                + "sample_A_01\t1.10\t22.5\t0.90\t21.0\t18.9\t1.2\t3000\t76.4\t18.9\n"
            ).encode(),
        }
    )
    result = extract_importable_measurements(data)

    assert [(m["file"], m["direction"]) for m in result["measurements"]] == [
        ("sample_A_01", "FW"),
    ]
    assert any(s["file"] == "sample_A_01" for s in result["skipped"])


def test_extract_combined_summary_is_not_imported() -> None:
    # The combined `JV Summary.txt` (type `summary`) uses a different 6-column
    # layout and is not importable; it must not produce measurements.
    data = make_zip(
        {
            "JV Summary.txt": (
                "File\tScan\tVoc (V)\tJsc (mA/cm2)\tFF (%)\tEfficiency (%)\n"
                + "sample_A_01\tFW\t1.10\t22.5\t76.4\t18.9\n"
            ).encode(),
        }
    )
    result = extract_importable_measurements(data)
    assert result["measurements"] == []
    assert any("No supported import files" in w for w in result["warnings"])


def test_extract_returns_no_measurements_without_summary() -> None:
    data = make_zip({"notes.txt": b"hello\n"})
    result = extract_importable_measurements(data)
    assert result["measurements"] == []
    assert any("No supported import files" in w for w in result["warnings"])


def test_extract_rejects_unsafe_archive() -> None:
    data = make_zip({"../evil.txt": b"x"})
    with pytest.raises(UnsafeZipError):
        extract_importable_measurements(data)
