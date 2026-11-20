"""Read-only, in-memory ZIP inspection for the archive explorer.

This module never writes to disk or to the database, never extracts entries to
the filesystem, and never executes archive contents. It only decodes bytes in
memory to describe what a researcher's archive *contains* — never to assert its
scientific meaning.

The safety checks mirror the defensive posture of the existing NOMAD archive
handling (`services/nomad.py`) but operate on the *read* side: path traversal,
symlinks, encrypted entries and decompression-bomb heuristics are all rejected
before any entry is decoded for preview.
"""

import io
import os
import re
import zipfile
from dataclasses import dataclass
from typing import Any

# ── Limits (explicit and conservative) ───────────────────────────────────────
# Values are server-side and in-memory; they bound the worst case for a single
# inspection request so a crafted archive cannot exhaust memory or CPU.


@dataclass(frozen=True)
class ZipExploreLimits:
    max_compressed_bytes: int = 128 * 1024 * 1024  # 128 MB upload
    max_files: int = 5000
    max_entry_bytes: int = 128 * 1024 * 1024  # 128 MB per entry
    max_total_uncompressed: int = 512 * 1024 * 1024  # 512 MB total
    max_compression_ratio: int = 100
    max_text_bytes: int = 16 * 1024 * 1024  # 16 MB per text entry for preview
    max_preview_files: int = 64  # cap how many entries we decode/return
    max_preview_chars: int = 4000
    max_preview_lines: int = 40


DEFAULT_LIMITS = ZipExploreLimits()

# File kinds we will decode as UTF-8 text for a bounded preview. Everything else
# is reported by name/size only (never decoded, never executed).
TEXT_EXTENSIONS = frozenset(
    {".txt", ".csv", ".tsv", ".md", ".json", ".yaml", ".yml", ".log"}
)

# Filename markers that identify a recognised measurement type (Plains
# `MeasurementType` family). Recognition is by *filename convention only* — it
# does not claim that the content is scientifically interpretable.
SUMMARY_BASENAMES = {
    "jv summary.txt": "summary",
    "jv summary_parameters fw.txt": "summary-fw",
    "jv summary_parameters rv.txt": "summary-rv",
}
MARKER_TYPES = [
    ("stability (jv)", "stability-jv"),
    ("stability (parameters)", "stability-parameters"),
    ("stability (tracking)", "stability-tracking"),
    ("uv-vis", "uv-vis"),
]

# Measurement types we treat as "recognised" (vs. plain text / unknown).
RECOGNIZED_TYPES = frozenset(
    {
        "summary",
        "summary-fw",
        "summary-rv",
        "stability-jv",
        "stability-parameters",
        "stability-tracking",
        "uv-vis",
    }
)

_ABSOLUTE_PATH = re.compile(r"^([A-Za-z]:[\\/]|[\\/])")
# Unix symlink file mode (S_IFLNK) in the high 16 bits of ZipInfo.external_attr.
_S_IFMT = 0o170000
_S_IFLNK = 0o120000


class ZipExploreError(ValueError):
    """Base class for all archive-inspection rejections."""


class InvalidZipError(ZipExploreError):
    pass


class UnsafeZipError(ZipExploreError):
    pass


class ResourceLimitError(ZipExploreError):
    pass


def _basename(name: str) -> str:
    return name.replace("\\", "/").rstrip("/").split("/")[-1]


def classify_entry(name: str) -> str:
    """Classify an archive entry by filename convention only.

    Returns one of: ``summary``, ``summary-fw``, ``summary-rv``,
    ``stability-jv``, ``stability-parameters``, ``stability-tracking``,
    ``uv-vis``, ``text`` or ``unknown``.
    """
    base = _basename(name)
    if base.endswith("/"):
        return "directory"
    low = base.lower()
    if low in SUMMARY_BASENAMES:
        return SUMMARY_BASENAMES[low]
    for marker, kind in MARKER_TYPES:
        if marker in low:
            return kind
    ext = os.path.splitext(low)[1]
    if ext in TEXT_EXTENSIONS:
        return "text"
    return "unknown"


def _validate_entries(
    zf: zipfile.ZipFile, limits: ZipExploreLimits
) -> list[zipfile.ZipInfo]:
    """Reject unsafe archives before decoding anything."""
    infos = zf.infolist()
    file_infos = [i for i in infos if not i.is_dir()]

    if len(file_infos) > limits.max_files:
        raise ResourceLimitError(
            f"Archive contains too many files ({len(file_infos)} > {limits.max_files})."
        )

    total = 0
    for info in file_infos:
        name = info.filename

        # Path traversal / absolute paths.
        if _ABSOLUTE_PATH.match(name) or ".." in name.replace("\\", "/").split("/"):
            raise UnsafeZipError(f"Unsafe archive path: {name!r}")

        # Symlinks (never follow them).
        mode = (info.external_attr >> 16) & _S_IFMT
        if mode == _S_IFLNK:
            raise UnsafeZipError(f"Symlink entries are not allowed: {name!r}")

        # Encrypted entries.
        if info.flag_bits & 0x1:
            raise UnsafeZipError(f"Encrypted entries are not allowed: {name!r}")

        # Decompression-bomb heuristics + per-entry cap.
        if info.file_size > limits.max_entry_bytes:
            raise ResourceLimitError(
                f"Entry too large: {name!r} ({info.file_size} bytes)."
            )
        if info.compress_size > 0:
            ratio = info.file_size / info.compress_size
            if ratio > limits.max_compression_ratio:
                raise UnsafeZipError(
                    f"Unusually high compression ratio in {name!r} "
                    f"({ratio:.1f}x) — refusing to decompress."
                )
        total += info.file_size

    if total > limits.max_total_uncompressed:
        raise ResourceLimitError(
            f"Archive expands beyond the safe total ({total} > "
            f"{limits.max_total_uncompressed} bytes)."
        )

    return infos


def _preview_text(raw: bytes, limits: ZipExploreLimits) -> tuple[str, bool]:
    """Decode UTF-8 (lossy) and return a bounded preview + a truncated flag."""
    text = raw.decode("utf-8", errors="replace")
    lines = text.splitlines()
    truncated = len(lines) > limits.max_preview_lines
    lines = lines[: limits.max_preview_lines]
    joined = "\n".join(lines)
    if len(joined) > limits.max_preview_chars:
        joined = joined[: limits.max_preview_chars]
        truncated = True
    return joined, truncated


def inspect_zip(
    data: bytes, limits: ZipExploreLimits | None = None
) -> dict[str, Any]:
    """Inspect a ZIP archive held entirely in memory.

    Returns a plain dict suitable for JSON serialisation. Raises
    :class:`ZipExploreError` subclasses on invalid/unsafe/resource-limit input.
    """
    limits = limits or DEFAULT_LIMITS

    if len(data) > limits.max_compressed_bytes:
        raise ResourceLimitError(
            f"Archive is larger than the supported upload size "
            f"({len(data)} > {limits.max_compressed_bytes} bytes)."
        )

    try:
        zf = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise InvalidZipError("File is not a valid ZIP archive.") from exc

    with zf:
        infos = _validate_entries(zf, limits)

        entries: list[dict[str, Any]] = []
        warnings: list[str] = []
        previewed = 0

        for info in infos:
            directory = info.is_dir()
            entry_type = "directory" if directory else classify_entry(info.filename)
            previewable = (
                not directory
                and os.path.splitext(_basename(info.filename).lower())[1]
                in TEXT_EXTENSIONS
            )
            preview: str | None = None
            preview_truncated = False

            if previewable and previewed < limits.max_preview_files:
                raw = zf.read(info)
                if len(raw) > limits.max_text_bytes:
                    warnings.append(
                        f"{info.filename}: text file too large to preview "
                        f"({len(raw)} bytes)."
                    )
                else:
                    preview, preview_truncated = _preview_text(raw, limits)
                    previewed += 1

            entries.append(
                {
                    "name": info.filename,
                    "directory": directory,
                    "size": info.file_size,
                    "type": entry_type,
                    "recognized": entry_type in RECOGNIZED_TYPES,
                    "previewable": previewable and preview is not None,
                    "preview": preview,
                    "preview_truncated": preview_truncated,
                }
            )

        file_count = len([e for e in entries if not e["directory"]])

        return {
            "file_count": file_count,
            "total_uncompressed_bytes": sum(e["size"] for e in entries),
            "recognized_files": len(
                [e for e in entries if e["recognized"]]
            ),
            "previewed_files": previewed,
            "warnings": warnings,
            "entries": entries,
        }
