"""Unit tests for the read-only ZIP explorer.

These tests are pure (no database, no HTTP) and only exercise the inspection
logic in ``app.services.zip_explorer``.
"""

import io
import zipfile

import pytest

from app.services.zip_explorer import (
    DEFAULT_LIMITS,
    InvalidZipError,
    ResourceLimitError,
    UnsafeZipError,
    ZipExploreLimits,
    _validate_entries,
    classify_entry,
    inspect_zip,
)


def make_zip(entries: dict[str, bytes]) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, content in entries.items():
            zf.writestr(name, content)
    return buf.getvalue()


class _FakeZip:
    def __init__(self, infos: list[zipfile.ZipInfo]) -> None:
        self._infos = infos

    def infolist(self) -> list[zipfile.ZipInfo]:
        return self._infos


def _info(
    name: str,
    file_size: int = 100,
    compress_size: int = 10,
    *,
    symlink: bool = False,
    encrypted: bool = False,
) -> zipfile.ZipInfo:
    info = zipfile.ZipInfo(name)
    info.file_size = file_size
    info.compress_size = compress_size
    if symlink:
        info.create_system = 3  # Unix
        info.external_attr = (0o120777) << 16  # S_IFLNK | rwxrwxrwx
    if encrypted:
        info.flag_bits |= 0x1
    return info


# ── classify_entry ────────────────────────────────────────────────────────────


def test_classify_summary_and_measurement_markers() -> None:
    assert classify_entry("JV Summary.txt") == "summary"
    assert classify_entry("run/JV Summary_Parameters FW.txt") == "summary-fw"
    assert classify_entry("JV Summary_Parameters RV.txt") == "summary-rv"
    assert classify_entry("a Stability (JV) 001.txt") == "stability-jv"
    assert classify_entry("a Stability (Parameters) 002.txt") == "stability-parameters"
    assert classify_entry("a Stability (Tracking) 003.txt") == "stability-tracking"
    assert classify_entry("a UV-Vis scan.txt") == "uv-vis"


def test_classify_text_and_unknown() -> None:
    assert classify_entry("notes.txt") == "text"
    assert classify_entry("data.csv") == "text"
    assert classify_entry("image.png") == "unknown"
    assert classify_entry("archive.zip") == "unknown"


# ── _validate_entries (safety) ───────────────────────────────────────────────


def test_reject_path_traversal() -> None:
    with pytest.raises(UnsafeZipError):
        _validate_entries(_FakeZip([_info("../evil.txt")]), DEFAULT_LIMITS)


def test_reject_absolute_path() -> None:
    with pytest.raises(UnsafeZipError):
        _validate_entries(_FakeZip([_info("/etc/passwd")]), DEFAULT_LIMITS)


def test_reject_symlink() -> None:
    with pytest.raises(UnsafeZipError):
        _validate_entries(_FakeZip([_info("link.txt", symlink=True)]), DEFAULT_LIMITS)


def test_reject_encrypted_entry() -> None:
    with pytest.raises(UnsafeZipError):
        _validate_entries(_FakeZip([_info("secret.txt", encrypted=True)]), DEFAULT_LIMITS)


def test_reject_zip_bomb_ratio() -> None:
    info = _info("bomb.txt", file_size=100_000_000, compress_size=1_000)
    with pytest.raises(UnsafeZipError):
        _validate_entries(_FakeZip([info]), DEFAULT_LIMITS)


def test_reject_oversized_entry() -> None:
    info = _info("big.bin", file_size=200 * 1024 * 1024, compress_size=10)
    with pytest.raises(ResourceLimitError):
        _validate_entries(_FakeZip([info]), DEFAULT_LIMITS)


def test_reject_too_many_files() -> None:
    limits = ZipExploreLimits(max_files=3)
    infos = [_info(f"f{i}.txt") for i in range(4)]
    with pytest.raises(ResourceLimitError):
        _validate_entries(_FakeZip(infos), limits)


# ── inspect_zip (end-to-end) ─────────────────────────────────────────────────


def test_inspect_valid_archive() -> None:
    data = make_zip(
        {
            "JV Summary.txt": "File\tVoc\tJsc\nsample1\t1.1\t22.0\n",
            "sample1 Stability (JV) 001.txt": "[Header]\nScan\tVoc\tJsc\nFW\t1.1\t22.0\n",
            "notes.txt": ("hello\n" * 100),
            "image.png": b"\x89PNG\r\n\x1a\n" + (b"\x00" * 20),
        }
    )
    result = inspect_zip(data)

    assert result["file_count"] == 4
    assert result["recognized_files"] == 2  # summary + stability-jv

    by_name = {e["name"]: e for e in result["entries"]}
    assert by_name["JV Summary.txt"]["type"] == "summary"
    assert by_name["JV Summary.txt"]["recognized"] is True
    assert by_name["sample1 Stability (JV) 001.txt"]["type"] == "stability-jv"
    assert by_name["notes.txt"]["type"] == "text"
    assert by_name["notes.txt"]["recognized"] is False
    assert by_name["notes.txt"]["preview"] is not None
    assert by_name["notes.txt"]["preview_truncated"] is True  # > 40 lines
    assert by_name["image.png"]["type"] == "unknown"
    assert by_name["image.png"]["previewable"] is False
    assert by_name["image.png"]["preview"] is None


def test_inspect_rejects_invalid_zip() -> None:
    with pytest.raises(InvalidZipError):
        inspect_zip(b"this is not a zip archive")


def test_inspect_rejects_traversal_entry() -> None:
    data = make_zip({"../evil.txt": b"x"})
    with pytest.raises(UnsafeZipError):
        inspect_zip(data)


def test_inspect_ignores_directory_entries() -> None:
    data = make_zip({"folder/": b"", "folder/notes.txt": b"hello\n"})
    result = inspect_zip(data)
    # The directory itself is reported, not counted as a file.
    names = {e["name"]: e for e in result["entries"]}
    assert "folder/" in names
    assert names["folder/"]["directory"] is True
    assert names["folder/notes.txt"]["type"] == "text"
    assert result["file_count"] == 1
