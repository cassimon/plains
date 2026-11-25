"""Read-only ZIP inspection and structured measurement parsing.

``/inspect`` only *describes* an uploaded archive (directory inventory,
recognised file types, bounded previews) and never persists anything.

``/parse`` expands ZIP archives and/or individual CHOSE text files into
structured measurements for the native upload flow; it never persists Results.
"""

import hashlib
import io
import logging
import uuid
import zipfile
from pathlib import Path
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.api.deps import CurrentUser
from app.services.nomad import (
    TEMP_UPLOAD_DIR,
    RawFileConflictError,
    append_files_to_zip,
    create_secure_zip,
)
from app.services.zip_explorer import (
    DEFAULT_LIMITS,
    InvalidZipError,
    ResourceLimitError,
    UnsafeZipError,
    classify_entry,
    inspect_zip,
)
from app.services.zip_import import (
    extract_importable_measurements,
    measurements_from_jv_file,
)

# CHOSE text entries the client parses natively (kept as raw files and handed
# back as text so the native scanner, not the JV parser, handles them).
_NATIVE_TEXT_TYPES = frozenset(
    {"stability-parameters", "stability-tracking", "uv-vis", "text"}
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/zip-explorer", tags=["zip-explorer"])


@router.post("/inspect")
async def inspect_zip_archive(
    _current_user: CurrentUser,
    file: UploadFile = File(...),
) -> dict[str, Any]:
    """Inspect a single ZIP archive in memory (read-only).

    Authentication is required; the archive is never persisted and no Plains
    data is modified. Returns a bounded inventory + previews for text files.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="A file is required.")

    content = await file.read()

    try:
        return inspect_zip(content)
    except InvalidZipError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except UnsafeZipError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ResourceLimitError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc
    except Exception as exc:  # pragma: no cover - defensive
        logger.exception("Unexpected ZIP inspection failure")
        raise HTTPException(
            status_code=500, detail="Could not inspect the archive."
        ) from exc


@router.post("/parse")
async def parse_measurement_files(
    current_user: CurrentUser,
    files: list[UploadFile] = File(default=[]),
    archive_path: str | None = Form(None),
) -> dict[str, Any]:
    """Parse uploaded files (ZIP archives and/or individual CHOSE text files)
    into structured measurements. Read-only — never persists Results.

    ZIP archives are expanded in memory (secure limits apply). Original raw
    files (CHOSE JV plus other recognised text entries) are staged into the
    caller's temporary NOMAD upload archive, *appending* to ``archive_path``
    when one is given so successive drops preserve every file.

    Distinct files that flatten to the same basename are rejected rather than
    silently overwritten.
    """
    if not files:
        raise HTTPException(status_code=400, detail="No files provided.")

    measurements: list[dict[str, Any]] = []
    other_files: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    warnings: list[str] = []
    raw_files: list[tuple[str, bytes]] = []

    for f in files:
        if not f.filename:
            continue
        content = await f.read()
        is_zip = f.filename.lower().endswith(".zip") or content[:4] == b"PK\x03\x04"
        try:
            if is_zip:
                extracted = extract_importable_measurements(content)
                measurements.extend(extracted["measurements"])
                skipped.extend(extracted["skipped"])
                warnings.extend(extracted["warnings"])
                raw, native = _expand_zip(content)
                raw_files.extend(raw)
                other_files.extend(native)
            else:
                rows = measurements_from_jv_file(content, f.filename)
                if rows:
                    measurements.extend(rows)
                    raw_files.append((_basename(f.filename), content))
                else:
                    skipped.append(
                        {
                            "file": f.filename,
                            "reason": "Not a supported CHOSE JV file.",
                        }
                    )
        except (InvalidZipError, UnsafeZipError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except ResourceLimitError as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from exc

    # Reject basename collisions with distinct content (never silently discard
    # or overwrite a scientific file).
    by_basename: dict[str, str] = {}
    for name, data in raw_files:
        base = _basename(name)
        digest = hashlib.sha256(data).hexdigest()
        if base in by_basename and by_basename[base] != digest:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Collision: two distinct files share the basename "
                    f"{base!r} and cannot be represented safely in the flat "
                    f"NOMAD archive. Rename one of them or import them separately."
                ),
            )
        by_basename.setdefault(base, digest)

    archive_result: str | None = None
    if raw_files:
        # Deduplicate identical basenames (same bytes) before staging.
        seen: set[str] = set()
        deduped: list[tuple[str, bytes]] = []
        for name, data in raw_files:
            base = _basename(name)
            if base in seen:
                continue
            seen.add(base)
            deduped.append((base, data))

        target_dir = TEMP_UPLOAD_DIR / str(current_user.id)
        if archive_path:
            candidate = Path(archive_path).resolve()
            allowed_root = target_dir.resolve()
            if not str(candidate).startswith(str(allowed_root)):
                raise HTTPException(status_code=400, detail="Invalid archive path.")
            if candidate.exists():
                try:
                    archive_result = str(append_files_to_zip(candidate, deduped))
                except RawFileConflictError as exc:
                    raise HTTPException(status_code=409, detail=str(exc)) from exc
            else:
                archive_result = str(
                    create_secure_zip(
                        files=deduped,
                        archive_name=candidate.name,
                        target_dir=target_dir,
                    )
                )
        else:
            archive_name = f"parse_{uuid.uuid4().hex[:8]}.zip"
            archive_result = str(
                create_secure_zip(
                    files=deduped,
                    archive_name=archive_name,
                    target_dir=target_dir,
                )
            )

    return {
        "measurements": measurements,
        "other_files": other_files,
        "skipped": skipped,
        "warnings": warnings,
        "archive_path": archive_result,
        "raw_file_count": len(by_basename),
    }


def _basename(name: str) -> str:
    return name.replace("\\", "/").rstrip("/").split("/")[-1]


def _expand_zip(
    data: bytes,
) -> tuple[list[tuple[str, bytes]], list[dict[str, Any]]]:
    """Extract original text entries from a ZIP.

    Returns ``(raw_files, other_files)`` where ``raw_files`` are ``(basename,
    bytes)`` for every recognised text entry (for NOMAD staging) and
    ``other_files`` are ``{filename, content}`` for non-CHOSE text entries the
    client parses natively.
    """
    raw: list[tuple[str, bytes]] = []
    other: list[dict[str, Any]] = []
    limits = DEFAULT_LIMITS
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for info in zf.infolist():
            if info.is_dir():
                continue
            entry_type = classify_entry(info.filename)
            if entry_type not in {"stability-jv"} | _NATIVE_TEXT_TYPES:
                continue
            content = zf.read(info)
            base = _basename(info.filename)
            raw.append((base, content))
            if entry_type in _NATIVE_TEXT_TYPES and len(content) <= limits.max_text_bytes:
                other.append(
                    {
                        "filename": base,
                        "content": content.decode("utf-8", errors="replace"),
                    }
                )
    return raw, other
