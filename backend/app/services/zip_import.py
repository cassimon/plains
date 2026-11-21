"""ZIP import: parse supported measurement files into native Plains records.

Read-only until an explicit confirmation. Reuses ``zip_explorer`` for archive
validation and filename classification; only the JV Summary family is currently
supported for import (the simplest format with a verifiable mapping into
``MeasurementFile``).
"""

import io
import zipfile
from typing import Any

from app.services.zip_explorer import (
    DEFAULT_LIMITS,
    ZipExploreLimits,
    inspect_zip,
)

# Filename-classification types that map to an importable JV summary.
# Only the per-direction parameter summaries use the 10-column tab format the
# parser understands. The combined `JV Summary.txt` (type ``summary``) has a
# different 6-column layout (`File, Scan, Voc, Jsc, FF, Efficiency`) and is
# intentionally left preview-only.
SUPPORTED_SUMMARY_TYPES = frozenset({"summary-fw", "summary-rv"})


def _direction_for_type(entry_type: str) -> str | None:
    """Scan direction encoded in the summary filename (FW/RV)."""
    if entry_type == "summary-fw":
        return "FW"
    if entry_type == "summary-rv":
        return "RV"
    return None

# JV Summary is tab-delimited with 10 columns:
#   File, Voc (V), Jsc (mA/cm²), VMPP (V), JMPP (mA/cm²), PMPP (mW/cm²),
#   Rs (Ohm), Rsh (Ohm), FF (%), Eff (%)
_SUMMARY_MIN_COLUMNS = 10
_FILE = 0
_VOC = 1
_JSC = 2
_FF = 8
_EFF = 9

# Native Plains file_type for these measurements.
FILE_TYPE = "JV"


def _number(value: str) -> float | None:
    """Parse a numeric cell; accepts decimal comma, rejects non-finite values."""
    s = value.strip().replace(",", ".")
    if not s:
        return None
    try:
        n = float(s)
    except ValueError:
        return None
    return n if n == n else None  # reject NaN


def parse_jv_summary(text: str) -> list[dict[str, Any]]:
    """Parse a JV Summary file (tab-delimited) into measurement rows.

    Each row is ``{"file", "voc", "jsc", "ff", "eff"}`` with floats or ``None``.
    Rows without a non-empty ``file`` or without any parseable metric are
    dropped (they carry no importable information).
    """
    lines = text.splitlines()
    header_idx = -1
    for i, line in enumerate(lines):
        if line.lstrip().startswith("File"):
            header_idx = i
            break
    if header_idx < 0:
        return []

    rows: list[dict[str, Any]] = []
    for line in lines[header_idx + 1 :]:
        if not line.strip():
            continue
        parts = line.split("\t")
        if len(parts) < _SUMMARY_MIN_COLUMNS:
            continue
        name = parts[_FILE].strip()
        if not name:
            continue
        voc = _number(parts[_VOC])
        jsc = _number(parts[_JSC])
        ff = _number(parts[_FF])
        eff = _number(parts[_EFF])
        if voc is None and jsc is None and ff is None and eff is None:
            continue
        rows.append({"file": name, "voc": voc, "jsc": jsc, "ff": ff, "eff": eff})
    return rows


def _read_text_entry(data: bytes, name: str, limits: ZipExploreLimits) -> str | None:
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        raw = zf.read(name)
    if len(raw) > limits.max_text_bytes:
        return None
    return raw.decode("utf-8", errors="replace")


def extract_importable_measurements(
    data: bytes, limits: ZipExploreLimits | None = None
) -> dict[str, Any]:
    """Inspect a ZIP and extract importable JV measurements (no persistence).

    Returns ``{"measurements": [...], "skipped": [...], "warnings": [...]}``.
    ``inspect_zip`` is called first, so unsafe/invalid archives raise here
    before any parsing happens.
    """
    limits = limits or DEFAULT_LIMITS
    info = inspect_zip(data, limits)  # raises ZipExploreError on unsafe input

    measurements: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    warnings: list[str] = list(info["warnings"])

    supported_entries = [
        e for e in info["entries"] if not e["directory"] and e["type"] in SUPPORTED_SUMMARY_TYPES
    ]
    if not supported_entries:
        warnings.append(
            "No supported import files found (expected 'JV Summary_Parameters FW.txt' "
            "and/or 'JV Summary_Parameters RV.txt')."
        )
        return {"measurements": [], "skipped": [], "warnings": warnings}

    # A measurement file legitimately appears in BOTH the FW and RV summaries,
    # each carrying a different scan direction and different values. Dedup must
    # therefore be keyed on (filename, direction), never filename alone, or the
    # reverse scan would be silently dropped.
    seen: set[tuple[str, str | None]] = set()
    for entry in supported_entries:
        direction = _direction_for_type(entry["type"])
        text = _read_text_entry(data, entry["name"], limits)
        if text is None:
            skipped.append({"file": entry["name"], "reason": "Summary too large to import."})
            continue
        rows = parse_jv_summary(text)
        if not rows:
            skipped.append(
                {"file": entry["name"], "reason": "Recognized as JV Summary but no rows parsed."}
            )
            continue
        for row in rows:
            name = row["file"]
            key = (name, direction)
            if key in seen:
                skipped.append(
                    {
                        "file": name,
                        "reason": "Duplicate row in the same summary file.",
                    }
                )
                continue
            seen.add(key)
            measurements.append(
                {
                    "file": name,
                    "direction": direction,
                    "voc": row["voc"],
                    "jsc": row["jsc"],
                    "ff": row["ff"],
                    "eff": row["eff"],
                    "source": entry["name"],
                }
            )

    return {"measurements": measurements, "skipped": skipped, "warnings": warnings}
