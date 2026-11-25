"""Unit tests for the ZIP import parser/mapping (pure, no database)."""

import io
import zipfile

import pytest

from app.services.zip_explorer import UnsafeZipError
from app.services.zip_import import (
    extract_importable_measurements,
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
