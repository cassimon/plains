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
    DataCollection,
    DeviceGroupCreate,
    Experiment,
    ExperimentCreate,
    ExperimentResultsCreate,
    MeasurementFileCreate,
    Plane,
    Process,
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


def _can_access_plane(plane: Plane, user: Any) -> bool:
    """True when the user owns the plane, is a superuser, or the plane is shared."""
    if user.is_superuser or plane.owner_id == user.id:
        return True
    return any(share.user_id == user.id for share in plane.shared_with)


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
    plane_id: str | None = Form(None),
    collection_id: str | None = Form(None),
    process_id: str | None = Form(None),
    dry_run: bool = Form(False),
) -> dict[str, Any]:
    """Parse supported ZIP measurements and, unless ``dry_run``, persist them.

    The destination is either an existing owned experiment (``experiment_id``)
    or a new experiment created from ``experiment_name`` (the data-first path: a
    new experiment may be created without a process; ``plane_id`` and
    ``process_id`` are optional and only honoured for a *new* experiment, after
    ownership validation). The archive is validated server-side and parsed
    before any persistence.
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

    # Optional organization, honoured only for a NEW experiment. Ownership is
    # checked server-side; these are never applied to an existing experiment.
    resolved_plane_id: uuid.UUID | None = None
    resolved_collection_id: uuid.UUID | None = None
    resolved_process_id: uuid.UUID | None = None
    if new_name and collection_id:
        # A collection places the experiment on a plane's canvas; its plane
        # takes precedence over any separate plane_id.
        try:
            resolved_collection_id = uuid.UUID(collection_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid collection id.") from None
        collection = session.get(DataCollection, resolved_collection_id)
        if not collection:
            raise HTTPException(status_code=404, detail="Collection not found")
        plane = session.get(Plane, collection.plane_id)
        if not plane or (
            not current_user.is_superuser and not _can_access_plane(plane, current_user)
        ):
            raise HTTPException(status_code=403, detail="Not enough permissions")
        resolved_plane_id = collection.plane_id
    elif new_name and plane_id:
        try:
            resolved_plane_id = uuid.UUID(plane_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid plane id.") from None
        plane = session.get(Plane, resolved_plane_id)
        if not plane:
            raise HTTPException(status_code=404, detail="Plane not found")
        if not current_user.is_superuser and not _can_access_plane(plane, current_user):
            raise HTTPException(status_code=403, detail="Not enough permissions")
    if new_name and process_id:
        try:
            resolved_process_id = uuid.UUID(process_id)
        except ValueError:
            raise HTTPException(status_code=400, detail="Invalid process id.") from None
        proc = session.get(Process, resolved_process_id)
        if not proc:
            raise HTTPException(status_code=404, detail="Process not found")
        if not current_user.is_superuser and proc.owner_id != current_user.id:
            raise HTTPException(status_code=403, detail="Not enough permissions")

    if new_name:
        # Data-first import: a new experiment. A process is linked only when the
        # user explicitly selected one; otherwise the experiment stays
        # process-less (no fictional process is created).
        experiment = create_experiment(
            session=session,
            experiment_in=ExperimentCreate(
                name=new_name,
                plane_id=resolved_plane_id,
                collection_id=resolved_collection_id,
                process_id=resolved_process_id,
            ),
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

    # Conservative device grouping: one DeviceGroup per device name. A device
    # measured forward and reverse yields two MeasurementFiles under the SAME
    # group (they share device_name), which is the correct native grouping.
    grouped_names: dict[str, list[str]] = {}
    for f in files_in:
        grouped_names.setdefault(f.device_name or f.filename, []).append(f.filename)
    device_groups = [
        DeviceGroupCreate(name=name) for name in sorted(grouped_names)
    ]

    result = create_experiment_results(
        session=session,
        results_in=ExperimentResultsCreate(
            measurement_files=files_in,
            device_groups=device_groups,
            plane_id=resolved_plane_id,
            collection_id=resolved_collection_id,
        ),
        owner_id=current_user.id,
        experiment_id=exp_id,
    )

    response["imported"] = len(files_in)
    response["result_id"] = str(result.id)
    response["experiment_id"] = str(exp_id)
    return response
