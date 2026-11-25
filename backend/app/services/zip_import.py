"""ZIP import: parse supported measurement files into native Plains records.

Read-only until an explicit confirmation. Reuses ``zip_explorer`` for archive
validation and filename classification.

Primary import source is the **original JV instrument file** (``Stability (JV)``
entries), whose ``[General info]`` section carries the explicit ``Device``
identifier and whose ``## Data ##`` section carries the FW/RV photovoltaic
parameters. The directional JV summaries are a fallback (summary-only archives)
and a coverage cross-check resolved against directory context and scan
direction.
"""

import io
import math
import re
import zipfile
from typing import Any

from app.services.zip_explorer import (
    DEFAULT_LIMITS,
    ZipExploreLimits,
    inspect_zip,
)

FILE_TYPE = "JV"

_SUMMARY_MIN_COLUMNS = 10
_FILE = 0
_VOC = 1
_JSC = 2
_FF = 8
_EFF = 9

SUPPORTED_SUMMARY_TYPES = frozenset({"summary-fw", "summary-rv"})

# Terminal cell/pixel suffix in compound device labels, e.g.
# "PVK1-BSAM-C60-28-1A" → ("PVK1-BSAM-C60-28", "1", "A").
_HYPHEN_CELL_PIXEL = re.compile(r"^(.*)-(\d+)([A-Za-z]?)$")
# "3C_C1_2" → ("3C", "C1", "2").
_UNDERSCORE_CELL_PIXEL = re.compile(r"^(.*)_([^_]+)_([^_]+)$")


def _number(value: str) -> float | None:
    """Parse a numeric cell; accepts decimal comma, rejects non-finite values."""
    s = value.strip().replace(",", ".")
    if not s:
        return None
    try:
        n = float(s)
    except ValueError:
        return None
    return n if math.isfinite(n) else None  # reject NaN and ±inf


def _basename(path: str) -> str:
    return path.replace("\\", "/").rstrip("/").split("/")[-1]


def _parent_dir(path: str) -> str:
    parts = path.replace("\\", "/").rstrip("/").split("/")
    return "/".join(parts[:-1]) if len(parts) > 1 else ""


def parse_device_identifier(device: str) -> dict[str, str]:
    """Split a device label into (substrate, cell, pixel).

    Recognizes a terminal ``<cell><pixel?>`` suffix from the right for compound
    hyphenated identifiers (preserving the rest verbatim), and the existing
    ``device_cell_pixel`` underscore convention. Returns ``{"substrate", "cell",
    "pixel"}``; missing parts are empty strings.
    """
    s = (device or "").strip()
    if not s:
        return {"substrate": "", "cell": "", "pixel": ""}
    m = _HYPHEN_CELL_PIXEL.match(s)
    if m:
        return {"substrate": m.group(1), "cell": m.group(2), "pixel": m.group(3).upper()}
    m = _UNDERSCORE_CELL_PIXEL.match(s)
    if m:
        return {"substrate": m.group(1), "cell": m.group(2), "pixel": m.group(3)}
    return {"substrate": s, "cell": "", "pixel": ""}


def parse_jv_file(text: str) -> dict[str, Any] | None:
    """Parse an original JV instrument file (``## Header ##`` / ``## Data ##``)."""
    lines = text.splitlines()

    general: dict[str, str] = {}
    in_general = False
    for line in lines:
        t = line.strip()
        if t.startswith("[General info]"):
            in_general = True
            continue
        if in_general:
            if t.startswith("[") and t.endswith("]"):
                break
            if "\t" in line:
                key, _, value = line.partition("\t")
                general[key.strip()] = value.strip()

    data_start = -1
    for i, line in enumerate(lines):
        if line.strip() == "## Data ##":
            data_start = i + 1
            break
    if data_start < 0:
        return None

    fw: dict[str, float | None] | None = None
    rv: dict[str, float | None] | None = None
    for line in lines[data_start:]:
        parts = line.split("\t")
        if len(parts) < _SUMMARY_MIN_COLUMNS:
            continue
        scan = parts[0].strip().upper()
        if scan not in ("FW", "RV"):
            continue
        row = {
            "voc": _number(parts[1]),
            "jsc": _number(parts[2]),
            "ff": _number(parts[8]),
            "eff": _number(parts[9]),
        }
        if scan == "FW":
            fw = row
        else:
            rv = row

    if fw is None and rv is None:
        return None

    return {
        "device": general.get("Device"),
        "user": general.get("User"),
        "date": general.get("Date"),
        "time": general.get("Time"),
        "test": general.get("Test"),
        "cell_area": general.get("Cell area (cm2)") or general.get("Cell Area (cm2)"),
        "fw": fw,
        "rv": rv,
    }


def parse_jv_summary(text: str) -> list[dict[str, Any]]:
    """Parse a JV Summary file (tab-delimited) into measurement rows (fallback)."""
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


def _discover_batches(info: dict[str, Any]) -> list[str]:
    """Acquisition blocks = parent directories of the directional summaries."""
    batches = set()
    for e in info["entries"]:
        if not e["directory"] and e["type"] in SUPPORTED_SUMMARY_TYPES:
            parent = _parent_dir(e["name"])
            if parent:
                batches.add(parent)
    return sorted(batches)


def _batch_for_path(path: str, batches: list[str]) -> str:
    best = ""
    for b in batches:
        if path == b or path.startswith(b + "/"):
            if len(b) > len(best):
                best = b
    return best


def measurements_from_jv_file(content: bytes, filename: str) -> list[dict[str, Any]]:
    """Parse a single original CHOSE ``Stability (JV)`` file into FW/RV rows.

    Shared by the native upload flow (individual files and extracted ZIP entries)
    so the structured parser is the single implementation for CHOSE JV files.
    """
    text = content.decode("utf-8", errors="replace")
    parsed = parse_jv_file(text)
    if not parsed:
        return []
    device = parsed["device"] or _basename(filename)
    ident = parse_device_identifier(device)
    rows: list[dict[str, Any]] = []
    for direction, row in (("FW", parsed["fw"]), ("RV", parsed["rv"])):
        if row is None:
            continue
        rows.append(
            {
                "file": filename,
                "filename": _basename(filename),
                "device": device,
                "substrate_group": ident["substrate"],
                "cell": ident["cell"],
                "pixel": ident["pixel"],
                "direction": direction,
                "voc": row["voc"],
                "jsc": row["jsc"],
                "ff": row["ff"],
                "eff": row["eff"],
                "source": filename,
                "batch": "",
                "user": parsed["user"],
                "date": parsed["date"],
                # Individual files have no summary context — unknown, never a
                # confirmed exclusion.
                "in_summary": None,
            }
        )
    return rows


def _summary_references(
    data: bytes, info: dict[str, Any], limits: ZipExploreLimits
) -> set[tuple[str, str, str]]:
    """(batch, basename, direction) tuples referenced by the summaries."""
    batches = _discover_batches(info)
    refs: set[tuple[str, str, str]] = set()
    for entry in info["entries"]:
        if entry["directory"] or entry["type"] not in SUPPORTED_SUMMARY_TYPES:
            continue
        direction = "FW" if entry["type"] == "summary-fw" else "RV"
        batch = _batch_for_path(entry["name"], batches)
        text = _read_text_entry(data, entry["name"], limits)
        if text is None:
            continue
        for row in parse_jv_summary(text):
            refs.add((batch, row["file"], direction))
    return refs


def extract_importable_measurements(
    data: bytes, limits: ZipExploreLimits | None = None
) -> dict[str, Any]:
    """Inspect a ZIP and extract importable JV measurements (no persistence)."""
    limits = limits or DEFAULT_LIMITS
    info = inspect_zip(data, limits)  # raises ZipExploreError on unsafe input

    measurements: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    warnings: list[str] = list(info["warnings"])

    batches = _discover_batches(info)
    summary_refs = _summary_references(data, info, limits)

    jv_entries = [
        e for e in info["entries"] if not e["directory"] and e["type"] == "stability-jv"
    ]

    # Primary: original JV files.
    jv_covered: set[tuple[str, str, str]] = set()  # (batch, basename, direction)
    summary_covered: set[tuple[str, str, str]] = set()
    for entry in jv_entries:
        text = _read_text_entry(data, entry["name"], limits)
        if text is None:
            skipped.append({"file": entry["name"], "reason": "JV file too large to parse."})
            continue
        parsed = parse_jv_file(text)
        if not parsed:
            skipped.append({"file": entry["name"], "reason": "No FW/RV data found."})
            continue
        basename = _basename(entry["name"])
        batch = _batch_for_path(entry["name"], batches)
        device = parsed["device"] or basename
        ident = parse_device_identifier(device)
        for direction, row in (("FW", parsed["fw"]), ("RV", parsed["rv"])):
            if row is None:
                continue
            key = (batch, basename, direction)
            jv_covered.add(key)
            measurements.append(
                {
                    "file": entry["name"],
                    "filename": basename,
                    "device": device,
                    "substrate_group": ident["substrate"],
                    "cell": ident["cell"],
                    "pixel": ident["pixel"],
                    "direction": direction,
                    "voc": row["voc"],
                    "jsc": row["jsc"],
                    "ff": row["ff"],
                    "eff": row["eff"],
                    "source": entry["name"],
                    "batch": batch,
                    "user": parsed["user"],
                    "date": parsed["date"],
                    "in_summary": key in summary_refs,
                }
            )

    # Mixed archives: import summary-only measurements not already covered by an
    # original JV file in the same batch.
    for entry in info["entries"]:
        if entry["directory"] or entry["type"] not in SUPPORTED_SUMMARY_TYPES:
            continue
        direction = "FW" if entry["type"] == "summary-fw" else "RV"
        batch = _batch_for_path(entry["name"], batches)
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
            key = (batch, name, direction)
            if key in jv_covered:
                continue  # already imported from the original JV file
            if key in summary_covered:
                skipped.append({"file": name, "reason": "Duplicate row in the same summary file."})
                continue
            summary_covered.add(key)
            measurements.append(
                {
                    "file": f"{batch}/{name}" if batch else name,
                    "filename": name,
                    "device": name,
                    "substrate_group": parse_device_identifier(name)["substrate"],
                    "cell": parse_device_identifier(name)["cell"],
                    "pixel": parse_device_identifier(name)["pixel"],
                    "direction": direction,
                    "voc": row["voc"],
                    "jsc": row["jsc"],
                    "ff": row["ff"],
                    "eff": row["eff"],
                    "source": entry["name"],
                    "batch": batch,
                    "user": None,
                    "date": None,
                    "in_summary": True,
                }
            )

    if not measurements:
        warnings.append(
            "No supported import files found (expected 'Stability (JV)' files or "
            "'JV Summary_Parameters FW/RV.txt')."
        )
    if jv_entries and summary_refs:
        warnings.append(
            "Summary coverage is resolved per acquisition block and scan direction."
        )
    return {"measurements": measurements, "skipped": skipped, "warnings": warnings}
