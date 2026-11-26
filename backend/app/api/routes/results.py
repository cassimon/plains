import math
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import col, func, select

from app.api.deps import CurrentUser, SessionDep
from app.api.query import visible
from app.crud import create_experiment_results, update_experiment_results
from app.models import (
    DeviceGroup,
    DeviceGroupCreate,
    DeviceGroupPublic,
    Experiment,
    ExperimentResults,
    ExperimentResultsCreate,
    ExperimentResultsListPublic,
    ExperimentResultsPublic,
    ExperimentResultsUpdate,
    ImportedSourceFile,
    MeasurementCorrection,
    MeasurementCorrectionPublic,
    MeasurementFile,
    MeasurementFileCreate,
    MeasurementFilePublic,
)
from pydantic import BaseModel, Field as PydanticField

router = APIRouter(prefix="/results", tags=["results"])


@router.get("/", response_model=ExperimentResultsListPublic)
def read_results(
    session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100
) -> Any:
    """Retrieve experiment results."""
    base = visible(
        select(ExperimentResults), ExperimentResults, current_user, entity_type="result"
    )
    count_base = visible(
        select(func.count()).select_from(ExperimentResults),
        ExperimentResults,
        current_user,
        entity_type="result",
    )
    count = session.exec(count_base).one()
    statement = (
        base.order_by(col(ExperimentResults.created_at).desc())
        .offset(skip)
        .limit(limit)
    )
    items = session.exec(statement).all()
    return ExperimentResultsListPublic(data=items, count=count)


@router.get("/{id}", response_model=ExperimentResultsPublic)
def read_result(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """Get experiment results by ID."""
    result = session.get(ExperimentResults, id)
    if not result:
        raise HTTPException(status_code=404, detail="Results not found")
    if not current_user.is_superuser and (result.owner_id != current_user.id):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return result


@router.post("/", response_model=ExperimentResultsPublic)
def create_result(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    experiment_id: uuid.UUID,
    results_in: ExperimentResultsCreate,
) -> Any:
    """Create new experiment results."""
    # Prevent attaching results to another user's experiment (IDOR): the caller
    # must own (or be a superuser over) the target experiment.
    experiment = session.get(Experiment, experiment_id)
    if not experiment:
        raise HTTPException(status_code=404, detail="Experiment not found")
    if not current_user.is_superuser and experiment.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    result = create_experiment_results(
        session=session,
        results_in=results_in,
        owner_id=current_user.id,
        experiment_id=experiment_id,
    )
    return result


@router.put("/{id}", response_model=ExperimentResultsPublic)
def update_result(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    results_in: ExperimentResultsUpdate,
) -> Any:
    """Update experiment results."""
    result = session.get(ExperimentResults, id)
    if not result:
        raise HTTPException(status_code=404, detail="Results not found")
    if not current_user.is_superuser and (result.owner_id != current_user.id):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    result = update_experiment_results(
        session=session, db_results=result, results_in=results_in
    )
    return result


@router.delete("/{id}")
def delete_result(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """Delete experiment results."""
    result = session.get(ExperimentResults, id)
    if not result:
        raise HTTPException(status_code=404, detail="Results not found")
    if not current_user.is_superuser and (result.owner_id != current_user.id):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    session.delete(result)
    session.commit()
    return {"ok": True}


def _owned_result(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> ExperimentResults:
    result = session.get(ExperimentResults, id)
    if not result:
        raise HTTPException(status_code=404, detail="Results not found")
    if not current_user.is_superuser and (result.owner_id != current_user.id):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return result


@router.put("/{id}/measurement-files", response_model=list[MeasurementFilePublic])
def replace_measurement_files(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    body: list[MeasurementFileCreate],
) -> Any:
    """Replace all measurement files of a result (used by the snapshot sync)."""
    result = _owned_result(session, current_user, id)
    valid_group_ids = {g.id for g in result.device_groups}

    # Provenance validation: a non-null source_file_id must reference a stored
    # source belonging to the SAME experiment (never another user's/experiment's
    # evidence). Historical records with null provenance remain valid.
    referenced_source_ids = {
        f.source_file_id for f in body if f.source_file_id is not None
    }
    if referenced_source_ids:
        sources = session.exec(
            select(ImportedSourceFile).where(
                ImportedSourceFile.id.in_(referenced_source_ids)
            )
        ).all()
        found_ids = {s.id for s in sources}
        missing = referenced_source_ids - found_ids
        if missing:
            raise HTTPException(
                status_code=409,
                detail="Measurement references a source file that does not exist",
            )
        wrong_experiment = [
            s.id for s in sources if s.experiment_id != result.experiment_id
        ]
        if wrong_experiment:
            raise HTTPException(
                status_code=409,
                detail="Measurement references a source file from another experiment",
            )

    for f in body:
        if f.device_group_id is not None and f.device_group_id not in valid_group_ids:
            raise HTTPException(
                status_code=409,
                detail="Measurement references a device group outside this result",
            )
    existing_by_id = {f.id: f for f in result.measurement_files}
    incoming_ids = {f.id for f in body}
    # Delete removed files (their correction history cascades).
    for f in list(result.measurement_files):
        if f.id not in incoming_ids:
            session.delete(f)
    # Upsert by stable id so correction history, exclusions and provenance
    # survive ordinary snapshot saves (never delete-and-recreate).
    upserted: list[MeasurementFile] = []
    for f_in in body:
        if f_in.id in existing_by_id:
            db_f = existing_by_id[f_in.id]
            for field, value in f_in.model_dump().items():
                setattr(db_f, field, value)
            upserted.append(db_f)
        else:
            db_f = MeasurementFile(**f_in.model_dump(), results_id=id)
            session.add(db_f)
            upserted.append(db_f)
    session.commit()
    for f in upserted:
        session.refresh(f)
    return upserted


@router.put("/{id}/device-groups", response_model=list[DeviceGroupPublic])
def replace_device_groups(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    body: list[DeviceGroupCreate],
) -> Any:
    """Replace all device groups of a result (used by the snapshot sync).

    Upserts by id: existing groups are updated in place (preserving the
    ``MeasurementFile.device_group_id`` references on unchanged groups), new
    groups are created, and removed groups are deleted (their measurements
    survive, becoming unassigned via ``ON DELETE SET NULL``).
    """
    result = _owned_result(session, current_user, id)
    existing = {g.id: g for g in result.device_groups}
    incoming_ids = {g.id for g in body}

    for g in list(result.device_groups):
        if g.id not in incoming_ids:
            session.delete(g)

    upserted: list[DeviceGroup] = []
    for g in body:
        if g.id in existing:
            db_g = existing[g.id]
            for field, value in g.model_dump().items():
                setattr(db_g, field, value)
            upserted.append(db_g)
        else:
            db_g = DeviceGroup(**g.model_dump(), results_id=id)
            session.add(db_g)
            upserted.append(db_g)

    session.commit()
    for g in upserted:
        session.refresh(g)
    return upserted


class CorrectionIn(BaseModel):
    measurement_id: uuid.UUID
    # "scale" | "exclude" | "restore" | "edit"
    operation: str
    # For "scale": metric to scale (value/voc/jsc/ff). For "edit": field name.
    field: str | None = None
    # For "scale": finite, non-zero factor. For "edit": new string value.
    factor: float | None = None
    value: str | None = None
    reason: str = PydanticField(min_length=1, max_length=500)


_SCALEABLE = ("value", "voc", "jsc", "ff")
_EDITABLE = ("device_name", "cell", "pixel", "measurement_date", "measurement_user")


@router.post("/{id}/corrections", response_model=MeasurementCorrectionPublic)
def apply_measurement_correction(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    body: CorrectionIn,
) -> Any:
    """Apply one correction to a measurement and record its traceable history.

    Atomic: the effective value/exclusion changes in the same transaction as the
    history row. Original source bytes and hashes are never modified.
    """
    result = _owned_result(session, current_user, id)
    measurement = session.get(MeasurementFile, body.measurement_id)
    if not measurement or measurement.results_id != result.id:
        raise HTTPException(status_code=404, detail="Measurement not found")

    previous: str | None = None
    new: str | None = None
    op = body.operation

    if op == "scale":
        if body.field not in _SCALEABLE:
            raise HTTPException(status_code=400, detail="Field is not scaleable")
        if body.factor is None or not math.isfinite(body.factor) or body.factor == 0:
            raise HTTPException(status_code=400, detail="Factor must be finite and non-zero")
        old = getattr(measurement, body.field)
        if old is None:
            raise HTTPException(status_code=400, detail="Nothing to scale: value is missing")
        new_val = old * body.factor
        previous = str(old)
        new = str(new_val)
        setattr(measurement, body.field, new_val)

    elif op == "edit":
        if body.field not in _EDITABLE:
            raise HTTPException(status_code=400, detail="Field is not editable")
        if body.value is None:
            raise HTTPException(status_code=400, detail="New value is required")
        previous = str(getattr(measurement, body.field))
        new = body.value
        setattr(measurement, body.field, body.value)

    elif op == "exclude":
        if measurement.excluded:
            raise HTTPException(status_code=409, detail="Already excluded")
        previous = "false"
        new = "true"
        measurement.excluded = True

    elif op == "restore":
        if not measurement.excluded:
            raise HTTPException(status_code=409, detail="Already included")
        previous = "true"
        new = "false"
        measurement.excluded = False

    else:
        raise HTTPException(status_code=400, detail="Unknown operation")

    correction = MeasurementCorrection(
        measurement_id=measurement.id,
        field=body.field or "",
        operation=op,
        previous_value=previous,
        new_value=new,
        reason=body.reason,
        actor_email=current_user.email,
    )
    session.add(correction)
    session.add(measurement)
    session.commit()
    session.refresh(correction)
    return correction


@router.get("/{id}/corrections", response_model=list[MeasurementCorrectionPublic])
def list_measurement_corrections(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
) -> Any:
    """List the correction history for a result's measurements (newest first)."""
    result = _owned_result(session, current_user, id)
    ids = [m.id for m in result.measurement_files]
    if not ids:
        return []
    corrections = session.exec(
        select(MeasurementCorrection)
        .where(MeasurementCorrection.measurement_id.in_(ids))
        .order_by(MeasurementCorrection.created_at.desc())
    ).all()
    return corrections
