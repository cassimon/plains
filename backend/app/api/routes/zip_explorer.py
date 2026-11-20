"""Read-only ZIP archive inspection endpoint.

This endpoint only *describes* an uploaded archive (directory inventory,
recognised file types by filename convention, and a bounded text preview). It
never writes to the database, never extracts to disk, never creates/updates any
Plains entity, and never uploads to NOMAD.
"""

import logging
from typing import Any

from fastapi import APIRouter, File, HTTPException, UploadFile

from app.api.deps import CurrentUser
from app.services.zip_explorer import (
    InvalidZipError,
    ResourceLimitError,
    UnsafeZipError,
    inspect_zip,
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
