"""Source-store integrity: bytes round-trip, corruption detection, safe removal.

Pure unit tests (no database) — ``collect_source_ids`` is exercised by the API
tests in ``tests/api/routes/test_source_integrity.py``.
"""

from pathlib import Path

from app.core.config import settings
from app.services import source_store


def test_write_read_roundtrip(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(settings, "SOURCE_STORAGE_DIR", str(tmp_path))
    source_store.write_source("abc", b"hello")
    assert source_store.read_source("abc") == b"hello"


def test_source_is_intact_matches_recorded_hash(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(settings, "SOURCE_STORAGE_DIR", str(tmp_path))
    data = b"durable bytes"
    source_store.write_source("abc", data)
    assert source_store.source_is_intact("abc", source_store.sha256_hex(data)) is True


def test_source_is_intact_detects_corruption(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(settings, "SOURCE_STORAGE_DIR", str(tmp_path))
    source_store.write_source("abc", b"original")
    # Corrupt the stored bytes after recording the original hash.
    source_store.write_source("abc", b"tampered!")
    assert source_store.source_is_intact("abc", source_store.sha256_hex(b"original")) is False


def test_source_is_intact_false_when_missing(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(settings, "SOURCE_STORAGE_DIR", str(tmp_path))
    assert source_store.source_is_intact("nope", source_store.sha256_hex(b"x")) is False


def test_remove_sources_missing_is_noop(monkeypatch, tmp_path: Path) -> None:
    monkeypatch.setattr(settings, "SOURCE_STORAGE_DIR", str(tmp_path))
    source_store.write_source("keep", b"x")
    source_store.remove_sources(["keep", "never-existed"])
    assert source_store.source_exists("keep") is False
