"""Read-only ZIP inspection + explicit, confirmed ZIP import endpoints.

``/inspect`` only *describes* an uploaded archive (directory inventory,
recognised file types, bounded previews) and never persists anything.

``/import`` parses supported measurement files server-side and, only when the
caller explicitly confirms (``dry_run=false``) and owns the destination
experiment, creates a single native ``ExperimentResults`` with the parsed
``MeasurementFile`` rows.
"""

import json
import logging
import uuid
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from sqlmodel import select

from app.api.deps import CurrentUser, SessionDep
from app.crud import create_experiment_results
from app.models import (
    DataCollection,
    DeviceGroupCreate,
    Experiment,
    ExperimentResults,
    ExperimentResultsCreate,
    LabSubstrate,
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
    device_names: str | None = Form(None),
    substrate_assignments: str | None = Form(None),
    selected_batches: str | None = Form(None),
    selection_mode: str | None = Form(None),
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

    inventory = extracted["measurements"]

    # Validate selection inputs (never silently coerce).
    sel_mode = (selection_mode or "").strip()
    if sel_mode not in ("", "summary", "all"):
        raise HTTPException(
            status_code=400, detail="Unsupported selection_mode."
        )
    sel_batches: list[str] | None = None
    if selected_batches is not None and selected_batches != "":
        try:
            parsed_batches = json.loads(selected_batches)
        except json.JSONDecodeError:
            raise HTTPException(
                status_code=400, detail="Invalid selected_batches JSON."
            ) from None
        if not isinstance(parsed_batches, list):
            raise HTTPException(
                status_code=400, detail="selected_batches must be a JSON list."
            )
        sel_batches = [str(b) for b in parsed_batches]
        known_batches = {m["batch"] for m in inventory}
        unknown = [b for b in sel_batches if b not in known_batches]
        if unknown:
            raise HTTPException(
                status_code=400,
                detail=f"Unknown acquisition batch: {unknown[0]}",
            )

    def _selected(m: dict[str, Any]) -> bool:
        if sel_batches is not None and m["batch"] not in sel_batches:
            return False
        if sel_mode == "summary" and not m["in_summary"]:
            return False
        return True

    response: dict[str, Any] = {
        "dry_run": dry_run,
        # Preview returns the FULL inventory; the actual import filters below.
        "measurements": inventory,
        "skipped": extracted["skipped"],
        "warnings": extracted["warnings"],
        "imported": 0,
        "result_id": None,
        "experiment_id": None,
        "created_experiment": False,
    }

    if dry_run:
        return response

    # Server-side enforcement of the selection on the actual import.
    measurements = [m for m in inventory if _selected(m)]

    # Optional user corrections: a JSON object mapping the original file name to
    # a corrected device name. Original filenames are always preserved in
    # `filename`; only `device_name` (and thus the device grouping) changes.
    device_names_map: dict[str, str] = {}
    if device_names:
        try:
            parsed_names = json.loads(device_names)
        except json.JSONDecodeError:
            raise HTTPException(status_code=400, detail="Invalid device_names JSON.") from None
        if isinstance(parsed_names, dict):
            device_names_map = {
                str(k): str(v).strip()
                for k, v in parsed_names.items()
                if str(v).strip()
            }

    if not measurements:
        return response

    new_name = (experiment_name or "").strip()

    # Optional organization, honoured only for a NEW experiment. Ownership is
    # checked server-side; these are never applied to an existing experiment.
    resolved_plane_id: uuid.UUID | None = None
    resolved_collection_id: uuid.UUID | None = None
    resolved_process_id: uuid.UUID | None = None
    if new_name and collection_id:
        # A collection places the experiment on a plane's canvas. If a plane_id
        # is also provided it must match the collection's plane — otherwise the
        # combination is inconsistent and rejected (no silent substitution).
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
        if plane_id:
            try:
                provided_plane_id = uuid.UUID(plane_id)
            except ValueError:
                raise HTTPException(status_code=400, detail="Invalid plane id.") from None
            if provided_plane_id != collection.plane_id:
                raise HTTPException(
                    status_code=400,
                    detail="The selected plane does not match the selected collection's plane.",
                )
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
        # process-less (no fictional process is created). The experiment is only
        # flushed here (not committed) so that the results commit below persists
        # experiment + results atomically.
        experiment = Experiment(
            name=new_name,
            plane_id=resolved_plane_id,
            collection_id=resolved_collection_id,
            process_id=resolved_process_id,
            owner_id=current_user.id,
        )
        session.add(experiment)
        session.flush()
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
        # The Results UI assumes a single result set per experiment, so a second
        # import would create a result that cannot be displayed. Reject it rather
        # than silently hide measurements.
        existing_results = session.exec(
            select(ExperimentResults).where(ExperimentResults.experiment_id == exp_id)
        ).all()
        if existing_results:
            raise HTTPException(
                status_code=409,
                detail="This experiment already has results. Import into a new experiment instead.",
            )

    # User-reviewed substrate assignments: a JSON list of
    # {"device": <device_name>, "substrate_name": <name|null>,
    #  "substrate_id": <uuid|null>}. For a new experiment, named substrates are
    # created (deduplicated by name); for an existing experiment, substrate_id
    # must reference a substrate of that experiment.
    substrate_map: dict[str, uuid.UUID] = {}
    if substrate_assignments:
        try:
            assignments = json.loads(substrate_assignments)
        except json.JSONDecodeError:
            raise HTTPException(
                status_code=400, detail="Invalid substrate_assignments JSON."
            ) from None
        if isinstance(assignments, list):
            created_by_name: dict[str, uuid.UUID] = {}
            for a in assignments:
                if not isinstance(a, dict):
                    continue
                device = str(a.get("device") or "").strip()
                sub_name = str(a.get("substrate_name") or "").strip()
                sub_id_raw = a.get("substrate_id")
                if not device:
                    continue
                if new_name:
                    if sub_name and device not in substrate_map:
                        sid = created_by_name.get(sub_name)
                        if sid is None:
                            substrate = LabSubstrate(name=sub_name, experiment_id=exp_id)
                            session.add(substrate)
                            session.flush()
                            sid = substrate.id
                            created_by_name[sub_name] = sid
                        substrate_map[device] = sid
                elif sub_id_raw:
                    try:
                        sid = uuid.UUID(str(sub_id_raw))
                    except ValueError:
                        raise HTTPException(status_code=400, detail="Invalid substrate id.") from None
                    existing_substrate = session.get(LabSubstrate, sid)
                    if not existing_substrate or existing_substrate.experiment_id != exp_id:
                        raise HTTPException(
                            status_code=400,
                            detail="Substrate not found in this experiment.",
                        )
                    substrate_map[device] = sid

    files_in = [
        MeasurementFileCreate(
            filename=m["filename"],
            file_type="JV",
            device_name=device_names_map.get(m["device"], m["device"]),
            cell=m["cell"],
            pixel_label=m["pixel"],
            voc=m["voc"],
            jsc=m["jsc"],
            ff=m["ff"],
            value=m["eff"],
            measurement_date=m["date"],
            measurement_user=m["user"],
            # The original ZIP file is NOT stored; provenance is kept in notes,
            # never as a fake stored file_path.
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
        DeviceGroupCreate(
            name=name,
            assigned_substrate_id=substrate_map.get(name),
        )
        for name in sorted(grouped_names)
    ]

    result = create_experiment_results(
        session=session,
        results_in=ExperimentResultsCreate(
            measurement_files=files_in,
            device_groups=device_groups,
            plane_id=resolved_plane_id,
            collection_id=resolved_collection_id,
            grouping_strategy="import",
        ),
        owner_id=current_user.id,
        experiment_id=exp_id,
    )

    response["imported"] = len(files_in)
    response["result_id"] = str(result.id)
    response["experiment_id"] = str(exp_id)
    return response
