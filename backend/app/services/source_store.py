"""Durable original source-file storage for confirmed imports (WO-04).

Original bytes are written to ``SOURCE_STORAGE_DIR`` under an internal UUID
filename. The original relative path, basename, size and SHA-256 live in the
``imported_source_file`` table (see ``app.models``). Nothing here trusts a
user-supplied path as a filesystem location.
"""

import hashlib
from pathlib import Path

from app.core.config import settings


def storage_dir() -> Path:
    d = Path(settings.SOURCE_STORAGE_DIR)
    d.mkdir(parents=True, exist_ok=True)
    return d


def source_path(source_id: str) -> Path:
    return storage_dir() / source_id


def write_source(source_id: str, data: bytes) -> None:
    source_path(source_id).write_bytes(data)


def read_source(source_id: str) -> bytes:
    return source_path(source_id).read_bytes()


def source_exists(source_id: str) -> bool:
    return source_path(source_id).exists()


def remove_source(source_id: str) -> None:
    """Delete a stored source file's bytes (best-effort, missing = ok)."""
    try:
        source_path(source_id).unlink(missing_ok=True)
    except OSError:
        pass


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
