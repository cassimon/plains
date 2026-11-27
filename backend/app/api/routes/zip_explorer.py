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
from urllib.parse import quote

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from fastapi.responses import Response
from sqlmodel import select

from app.api.deps import CurrentUser, SessionDep
from app.models import Experiment, ImportedSourceFile
from app.services import source_store
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
    stage: bool = Form(True),
    paths: list[str] = Form(default=[]),
) -> dict[str, Any]:
    """Parse uploaded files (ZIP archives and/or individual CHOSE text files)
    into structured measurements. Read-only — never persists Results.

    ZIP archives are expanded in memory (secure limits apply). When ``stage`` is
    true (the default), original raw files (CHOSE JV plus other recognised text
    entries) are staged into the caller's temporary NOMAD upload archive,
    *appending* to ``archive_path`` when one is given so successive drops
    preserve every file. When ``stage`` is false this is a pure exploratory
    parse: no NOMAD archive is created or modified, and basename collisions are
    returned as warnings instead of a hard error.

    ``paths`` optionally carries the client-side relative path for each entry in
    ``files`` (e.g. files selected from a directory), preserving the original
    relative location for provenance. It is ignored for ZIP archives, whose
    entries already carry their own paths.
    """
    if not files:
        raise HTTPException(status_code=400, detail="No files provided.")

    measurements: list[dict[str, Any]] = []
    other_files: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    warnings: list[str] = []
    raw_files: list[tuple[str, bytes]] = []
    inventory: list[dict[str, Any]] = []

    for idx, f in enumerate(files):
        if not f.filename:
            continue
        content = await f.read()
        # Client-provided relative path (directory imports) wins for provenance;
        # the upload filename is otherwise just the basename.
        source_name = (
            paths[idx] if idx < len(paths) and paths[idx].strip() else f.filename
        )
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
                # Full inventory (directories + all files, recognised or not).
                info = inspect_zip(content)
                inventory.extend(
                    {
                        "name": e["name"],
                        "directory": e["directory"],
                        "size": e["size"],
                        "type": e["type"],
                        "recognized": e["recognized"],
                    }
                    for e in info["entries"]
                )
            else:
                rows = measurements_from_jv_file(content, source_name)
                if rows:
                    measurements.extend(rows)
                    raw_files.append((_basename(source_name), content))
                else:
                    skipped.append(
                        {
                            "file": source_name,
                            "reason": "Not a supported CHOSE JV file.",
                        }
                    )
                inventory.append(
                    {
                        "name": source_name,
                        "directory": False,
                        "size": len(content),
                        "type": "stability-jv" if rows else "unknown",
                        "recognized": bool(rows),
                    }
                )
        except (InvalidZipError, UnsafeZipError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except ResourceLimitError as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from exc

    # Basename collisions with distinct content. When staging into the flat
    # NOMAD archive they are a hard error (the archive cannot represent them);
    # in exploratory mode (stage=False) they are surfaced as warnings so the
    # researcher can still inspect the dataset before deciding.
    by_basename: dict[str, str] = {}
    for name, data in raw_files:
        base = _basename(name)
        digest = hashlib.sha256(data).hexdigest()
        existing = by_basename.get(base)
        if existing is not None and existing != digest:
            if stage:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"Collision: two distinct files share the basename "
                        f"{base!r} and cannot be represented safely in the flat "
                        f"NOMAD archive. Rename one of them or import them separately."
                    ),
                )
            warnings.append(
                f"Distinct files share the basename {base!r}; kept separate "
                f"during preview but they cannot be staged into a single NOMAD archive."
            )
            continue
        by_basename.setdefault(base, digest)

    archive_result: str | None = None
    if stage and raw_files:
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
        "original_file_count": len(
            [e for e in inventory if not e["directory"]]
        ),
        "recognized_file_count": len(
            [e for e in inventory if e["recognized"]]
        ),
        "inventory": inventory,
    }


def _basename(name: str) -> str:
    return name.replace("\\", "/").rstrip("/").split("/")[-1]


def _zip_source_files(data: bytes) -> list[tuple[str, str, bytes]]:
    """Return ``(relative_path, basename, bytes)`` for every non-directory
    entry of a validated ZIP archive (safe read, no extraction to disk)."""
    info = inspect_zip(data)  # raises on unsafe/invalid/over-limit input
    out: list[tuple[str, str, bytes]] = []
    with zipfile.ZipFile(io.BytesIO(data)) as zf:
        for entry in info["entries"]:
            if entry["directory"]:
                continue
            name = entry["name"]
            out.append((name, _basename(name), zf.read(name)))
    return out


@router.post("/import")
async def import_measurement_sources(
    session: SessionDep,
    current_user: CurrentUser,
    experiment_id: uuid.UUID = Form(...),
    import_id: uuid.UUID = Form(...),
    files: list[UploadFile] = File(default=[]),
    paths: list[str] = Form(default=[]),
) -> dict[str, Any]:
    """Confirm an import: persist original source files and return structured
    measurements linked to their source evidence.

    The operation is bound to ``(import_id, experiment_id)`` and the
    authorized owner. Retrying the same operation reuses the already-stored
    sources after verifying the incoming dataset is equivalent (same relative
    paths, sizes and SHA-256); a conflicting or cross-experiment reuse is
    rejected.
    """
    if not files:
        raise HTTPException(status_code=400, detail="No files provided.")

    experiment = session.get(Experiment, experiment_id)
    if not experiment:
        raise HTTPException(status_code=404, detail="Experiment not found")
    if not current_user.is_superuser and experiment.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")

    limits = DEFAULT_LIMITS
    sources: list[tuple[str, str, bytes]] = []
    measurements: list[dict[str, Any]] = []
    skipped: list[dict[str, Any]] = []
    warnings: list[str] = []
    cumulative_bytes = 0
    seen_relative_paths: set[str] = set()

    for idx, f in enumerate(files):
        if not f.filename:
            continue
        content = await f.read()
        source_name = (
            paths[idx] if idx < len(paths) and paths[idx].strip() else f.filename
        )
        is_zip = f.filename.lower().endswith(".zip") or content[:4] == b"PK\x03\x04"
        try:
            if is_zip:
                extracted_sources = _zip_source_files(content)
                sources.extend(extracted_sources)
                incoming_bytes = sum(len(data) for _, _, data in extracted_sources)
                extracted = extract_importable_measurements(content)
                measurements.extend(extracted["measurements"])
                skipped.extend(extracted["skipped"])
                warnings.extend(extracted["warnings"])
            else:
                sources.append((source_name, _basename(source_name), content))
                incoming_bytes = len(content)
                rows = measurements_from_jv_file(content, source_name)
                if rows:
                    measurements.extend(rows)
                else:
                    skipped.append(
                        {"file": source_name, "reason": "Not a supported CHOSE JV file."}
                    )
            # Bound the cumulative total as files arrive, so a multi-file import
            # can never accumulate unboundedly in memory before being rejected.
            cumulative_bytes += incoming_bytes
            if cumulative_bytes > limits.max_total_uncompressed:
                raise HTTPException(
                    status_code=413,
                    detail="Import expands beyond the safe total size.",
                )
        except (InvalidZipError, UnsafeZipError) as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except ResourceLimitError as exc:
            raise HTTPException(status_code=413, detail=str(exc)) from exc

    # Cross-archive duplicate exact-path rejection + file-count cap.
    for rel, _name, _data in sources:
        if rel in seen_relative_paths:
            raise HTTPException(
                status_code=409,
                detail=(
                    f"Duplicate source path {rel!r} across the selected files; "
                    f"import each dataset separately to keep sources distinct."
                ),
            )
        seen_relative_paths.add(rel)
    if len(sources) > limits.max_files:
        raise HTTPException(
            status_code=413,
            detail=f"Import contains too many files ({len(sources)} > {limits.max_files}).",
        )

    incoming = {
        rel: (name, len(data), source_store.sha256_hex(data))
        for rel, name, data in sources
    }

    # Idempotent, ownership-bound reuse.
    existing = session.exec(
        select(ImportedSourceFile).where(
            ImportedSourceFile.import_id == import_id
        )
    ).all()

    stored: list[ImportedSourceFile]
    if existing:
        # The operation must belong to this experiment (and its owner).
        if any(s.experiment_id != experiment_id for s in existing):
            raise HTTPException(
                status_code=409,
                detail="Import operation belongs to a different experiment.",
            )
        # The incoming dataset must be equivalent to what was stored.
        existing_map = {
            (s.relative_path or s.original_filename): s for s in existing
        }
        if set(existing_map) != set(incoming):
            raise HTTPException(
                status_code=409,
                detail="Import operation reused with a different dataset.",
            )
        for rel, s in existing_map.items():
            name, size, digest = incoming[rel]
            if s.size != size or s.sha256 != digest:
                raise HTTPException(
                    status_code=409,
                    detail=f"Import operation reused with different bytes for {rel!r}.",
                )
            if not source_store.source_is_intact(str(s.id), s.sha256):
                raise HTTPException(
                    status_code=409,
                    detail=f"Stored source bytes are missing or corrupted for {rel!r}.",
                )
        stored = list(existing)
    else:
        stored = []
        written_ids: list[str] = []
        try:
            for rel, (name, size, digest) in incoming.items():
                data = next(d for r, _n, d in sources if r == rel)
                sid = uuid.uuid4()
                source_store.write_source(str(sid), data)
                written_ids.append(str(sid))
                row = ImportedSourceFile(
                    id=sid,
                    experiment_id=experiment_id,
                    import_id=import_id,
                    original_filename=name,
                    relative_path=rel,
                    size=size,
                    sha256=digest,
                    file_type=classify_entry(rel),
                )
                session.add(row)
                stored.append(row)
            session.commit()
        except Exception:
            # A failed transaction must not leave orphan physical files behind.
            source_store.remove_sources(written_ids)
            raise
        for row in stored:
            session.refresh(row)

    source_map = {
        (s.relative_path or s.original_filename): s.id for s in stored
    }

    # Durable provenance: deterministic record-level locator that distinguishes
    # multiple observations from the same source (direction + summary row).
    for m in measurements:
        m["source_file_id"] = (
            str(source_map[m["source"]]) if m["source"] in source_map else None
        )
        loc = m["direction"] or "?"
        if m["file"] != m["source"]:
            loc = f"{loc}:{m['filename']}"
        m["source_record_locator"] = loc
        m["source_path"] = m["source"]

    return {
        "import_id": str(import_id),
        "experiment_id": str(experiment_id),
        "measurements": measurements,
        "skipped": skipped,
        "warnings": warnings,
        "source_files": [
            {
                "id": str(s.id),
                "relative_path": s.relative_path,
                "original_filename": s.original_filename,
                "size": s.size,
                "sha256": s.sha256,
                "file_type": s.file_type,
            }
            for s in stored
        ],
    }


@router.get("/experiments/{experiment_id}/sources")
async def list_experiment_sources(
    session: SessionDep,
    current_user: CurrentUser,
    experiment_id: uuid.UUID,
) -> dict[str, Any]:
    """List original source files stored for an experiment (owner/superuser)."""
    experiment = session.get(Experiment, experiment_id)
    if not experiment:
        raise HTTPException(status_code=404, detail="Experiment not found")
    if not current_user.is_superuser and experiment.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    sources = session.exec(
        select(ImportedSourceFile)
        .where(ImportedSourceFile.experiment_id == experiment_id)
        .order_by(ImportedSourceFile.created_at)
    ).all()
    return {
        "sources": [
            {
                "id": str(s.id),
                "original_filename": s.original_filename,
                "relative_path": s.relative_path,
                "file_type": s.file_type,
                "size": s.size,
                "sha256": s.sha256,
                "import_id": str(s.import_id),
                "available": source_store.source_exists(str(s.id)),
            }
            for s in sources
        ]
    }


@router.get("/sources/{source_id}/download")
async def download_source_file(
    session: SessionDep,
    current_user: CurrentUser,
    source_id: uuid.UUID,
) -> Response:
    """Authenticated retrieval of an original source file (owner/superuser)."""
    source = session.get(ImportedSourceFile, source_id)
    if not source:
        raise HTTPException(status_code=404, detail="Source file not found")
    experiment = session.get(Experiment, source.experiment_id)
    if not experiment:
        raise HTTPException(status_code=404, detail="Experiment not found")
    if not current_user.is_superuser and experiment.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    if not source_store.source_exists(str(source_id)):
        raise HTTPException(status_code=404, detail="Source bytes are missing")
    data = source_store.read_source(str(source_id))
    # Detect corruption: the stored bytes must match the recorded SHA-256.
    if source_store.sha256_hex(data) != source.sha256:
        raise HTTPException(status_code=409, detail="Source bytes are corrupted")
    # Content-Disposition must be ASCII-safe. Keep an ASCII fallback (stripping
    # quotes/backslashes/control chars) and carry the real Unicode name via
    # RFC 5987 filename* so non-ASCII filenames round-trip without breaking the
    # header encoding.
    raw_name = source.original_filename or str(source_id)
    ascii_name = raw_name.encode("ascii", "ignore").decode("ascii")
    ascii_name = ascii_name.replace('"', "").replace("\\", "_").strip()
    ascii_name = "".join(c for c in ascii_name if ord(c) >= 32)
    if not ascii_name:
        ascii_name = str(source_id)
    encoded = quote(raw_name, safe="")
    return Response(
        content=data,
        media_type="application/octet-stream",
        headers={
            "Content-Disposition": (
                f'attachment; filename="{ascii_name}"; filename*=UTF-8\'\'{encoded}'
            )
        },
    )


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
