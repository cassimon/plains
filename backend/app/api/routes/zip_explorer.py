"""Read-only ZIP inspection + explicit, confirmed ZIP import endpoints.

``/inspect`` only *describes* an uploaded archive (directory inventory,
recognised file types, bounded previews) and never persists anything.

``/import`` parses supported measurement files server-side and, only when the
caller explicitly confirms (``dry_run=false``) and owns the destination
experiment, creates a single native ``ExperimentResults`` with the parsed
``MeasurementFile`` rows.
"""

import logging
import uuid
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile

from app.api.deps import CurrentUser, SessionDep
from app.crud import create_experiment, create_experiment_results
from app.models import (
    Experiment,
    ExperimentCreate,
    ExperimentResultsCreate,
    MeasurementFileCreate,
)
from app.services.zip_explorer import (
    InvalidZipError,
    ResourceLimitError,
    UnsafeZipError,
    inspect_zip,
)
from app.services.zip_import import extract_importable_measurements

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


@router.post("/import")
async def import_zip_archive(
    session: SessionDep,
    current_user: CurrentUser,
    file: UploadFile = File(...),
    experiment_id: str | None = Form(None),
    experiment_name: str | None = Form(None),
    dry_run: bool = Form(False),
) -> dict[str, Any]:
    """Parse supported ZIP measurements and, unless ``dry_run``, persist them.

    The destination is either an existing owned experiment (``experiment_id``)
    or a new, process-less experiment created from ``experiment_name`` (the
    data-first path: imported measurements do not imply a known fabrication
    process). The archive is validated server-side (reusing the Explorer's
    safety checks) and parsed before any persistence.
    """
    if not file.filename:
        raise HTTPException(status_code=400, detail="A file is required.")

    content = await file.read()

    try:
        extracted = extract_importable_measurements(content)
    except InvalidZipError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except UnsafeZipError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except ResourceLimitError as exc:
        raise HTTPException(status_code=413, detail=str(exc)) from exc

    measurements = extracted["measurements"]
    response: dict[str, Any] = {
        "dry_run": dry_run,
        "measurements": measurements,
        "skipped": extracted["skipped"],
        "warnings": extracted["warnings"],
        "imported": 0,
        "result_id": None,
        "experiment_id": None,
        "created_experiment": False,
    }

    if not measurements or dry_run:
        return response

    new_name = (experiment_name or "").strip()
    if new_name:
        # Data-first import: a new experiment with no linked process. The
        # measurement is not evidence of a known preparation protocol, so no
        # fictional process is created.
        experiment = create_experiment(
            session=session,
            experiment_in=ExperimentCreate(name=new_name),
            owner_id=current_user.id,
        )
        exp_id = experiment.id
        response["created_experiment"] = True
    else:
        # Resolve and authorize the existing destination (no IDOR via client ids).
        if not experiment_id:
            raise HTTPException(
                status_code=400, detail="An experiment id or a new experiment name is required."
            )
        try:
            exp_id = uuid.UUID(experiment_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid experiment id.") from None
        existing = session.get(Experiment, exp_id)
        if not existing:
            raise HTTPException(status_code=404, detail="Experiment not found")
        if not current_user.is_superuser and existing.owner_id != current_user.id:
            raise HTTPException(status_code=403, detail="Not enough permissions")

    files_in = [
        MeasurementFileCreate(
            filename=m["file"],
            file_type="JV",
            device_name=m["file"],
            voc=m["voc"],
            jsc=m["jsc"],
            ff=m["ff"],
            value=m["eff"],
            notes=(
                f"Imported from ZIP: {m['source']}"
                + (f" ({m['direction']})" if m.get("direction") else "")
            ),
        )
        for m in measurements
    ]

    result = create_experiment_results(
        session=session,
        results_in=ExperimentResultsCreate(measurement_files=files_in),
        owner_id=current_user.id,
        experiment_id=exp_id,
    )

    response["imported"] = len(files_in)
    response["result_id"] = str(result.id)
    response["experiment_id"] = str(exp_id)
    return response
