"""Durable original source-file storage for confirmed imports.

Original bytes are written to ``SOURCE_STORAGE_DIR`` under an internal UUID
filename. The original relative path, basename, size and SHA-256 live in the
``imported_source_file`` table (see ``app.models``). Nothing here trusts a
user-supplied path as a filesystem location.

Deletion semantics: physical bytes are removed by the *caller* only after the
database transaction that deletes the owning rows has committed successfully.
This module never removes bytes on its own from a model event, so a rolled-back
delete can never strand a database row without its bytes.
"""

import hashlib
from pathlib import Path

from sqlmodel import select

from app.core.config import settings
from app.models import ImportedSourceFile


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


def source_is_intact(source_id: str, expected_sha256: str) -> bool:
    """True when the stored bytes exist and match the recorded SHA-256."""
    try:
        data = read_source(source_id)
    except OSError:
        return False
    return sha256_hex(data) == expected_sha256


def remove_source(source_id: str) -> None:
    """Delete a stored source file's bytes (best-effort, missing = ok)."""
    try:
        source_path(source_id).unlink(missing_ok=True)
    except OSError:
        pass


def remove_sources(source_ids: list[str]) -> None:
    """Best-effort removal of several stored source files (missing = ok)."""
    for source_id in source_ids:
        remove_source(source_id)


def collect_source_ids(session, experiment_ids) -> list[str]:
    """Stored source ids tied to the given experiment ids.

    The caller collects these *before* deleting the experiments and removes the
    bytes *after* the delete transaction commits, so cascade deletes (which do
    not fire ORM per-row events) still clean up their physical files.
    """
    ids = list(experiment_ids)
    if not ids:
        return []
    rows = session.exec(
        select(ImportedSourceFile.id).where(ImportedSourceFile.experiment_id.in_(ids))
    ).all()
    return [str(r) for r in rows]


def sha256_hex(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()
