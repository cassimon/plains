import math
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, field_validator
from pydantic import Field as PydanticField
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
    # Same provenance contract as the snapshot-replace path: nested source
    # references must belong to this experiment.
    _validate_source_references(session, experiment_id, results_in.measurement_files)
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


def _validate_source_references(
    session: SessionDep, experiment_id: uuid.UUID, files: list[MeasurementFileCreate]
) -> None:
    """Reject measurements whose ``source_file_id`` references a source that does
    not exist or belongs to a different experiment.

    Shared by result create and the measurement-files snapshot replace so both
    write paths enforce cross-user/cross-experiment provenance rejection.
    Historical records with a null ``source_file_id`` remain valid.
    """
    referenced_source_ids = {
        f.source_file_id for f in files if f.source_file_id is not None
    }
    if not referenced_source_ids:
        return
    sources = session.exec(
        select(ImportedSourceFile).where(ImportedSourceFile.id.in_(referenced_source_ids))
    ).all()
    found_ids = {s.id for s in sources}
    missing = referenced_source_ids - found_ids
    if missing:
        raise HTTPException(
            status_code=409,
            detail="Measurement references a source file that does not exist",
        )
    wrong_experiment = [s.id for s in sources if s.experiment_id != experiment_id]
    if wrong_experiment:
        raise HTTPException(
            status_code=409,
            detail="Measurement references a source file from another experiment",
        )


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

    _validate_source_references(session, result.experiment_id, body)

    for f in body:
        if f.device_group_id is not None and f.device_group_id not in valid_group_ids:
            raise HTTPException(
                status_code=409,
                detail="Measurement references a device group outside this result",
            )
    # Lock the rows being upserted so a concurrent correction (which locks a
    # single row) serialises with this snapshot: corrected_fields and the value
    # are read post-lock, so a snapshot can never overwrite a correction that
    # committed just before it.
    existing_by_id = {
        f.id: f
        for f in session.exec(
            select(MeasurementFile)
            .where(MeasurementFile.results_id == id)
            .with_for_update()
        ).all()
    }
    # Upsert by stable id so correction history, exclusions and provenance
    # survive ordinary snapshot saves (never delete-and-recreate).
    #
    # Measurements absent from an incoming snapshot are intentionally NOT
    # deleted: a save snapshot is the *authoritative full* list, but it can be
    # transiently stale/incomplete during navigation or multi-experiment sync,
    # and hard-deleting the missing rows (plus their correction history) on such
    # a snapshot loses durable user data. Individual measurements are removed
    # only by deleting/trashing the whole result (which cascades).
    upserted: list[MeasurementFile] = []
    for f_in in body:
        if f_in.id in existing_by_id:
            db_f = existing_by_id[f_in.id]
            corrected = set(db_f.corrected_fields or [])
            for field, value in f_in.model_dump().items():
                if field == "corrected_fields":
                    continue  # server-authoritative, never overwritten by a snapshot
                if field in corrected:
                    continue  # corrected value wins over a stale pre-correction snapshot
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


@router.delete("/{id}/measurement-files/{file_id}")
def delete_measurement_file(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    file_id: uuid.UUID,
) -> Any:
    """Explicitly delete one measurement (its correction history cascades).

    The snapshot replace is upsert-only (never deletes), so removing individual
    measurements requires this explicit, authorized operation. It never touches
    the result's NOMAD upload history or the original imported source files.
    """
    _owned_result(session, current_user, id)
    measurement = session.get(MeasurementFile, file_id)
    if not measurement or measurement.results_id != id:
        raise HTTPException(status_code=404, detail="Measurement not found")
    session.delete(measurement)
    session.commit()
    return {"ok": True}


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


def _mark_corrected(measurement: MeasurementFile, field: str) -> None:
    """Record a field as authoritatively corrected so snapshot syncs never
    revert it with a stale pre-correction value."""
    fields = list(measurement.corrected_fields or [])
    if field not in fields:
        fields.append(field)
        measurement.corrected_fields = fields


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
    # Client-supplied idempotency key: retrying the same correction intent with
    # the same key is rejected instead of applying the factor a second time.
    request_id: str | None = None

    @field_validator("reason")
    @classmethod
    def _reason_not_blank(cls, v: str) -> str:
        if not v.strip():
            raise ValueError("Reason must not be blank")
        return v


_SCALEABLE = ("value", "voc", "jsc", "ff")
_EDITABLE = ("device_name", "cell", "pixel_label", "measurement_date", "measurement_user")


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
    # Lock the measurement row for the duration of the transaction so two
    # concurrent corrections to the same measurement serialise (each sees the
    # other's committed value) instead of losing an update.
    measurement = session.exec(
        select(MeasurementFile)
        .where(MeasurementFile.id == body.measurement_id)
        .with_for_update()
    ).first()
    if not measurement or measurement.results_id != result.id:
        raise HTTPException(status_code=404, detail="Measurement not found")

    # Idempotency: a repeated request with the same key must not double-apply.
    if body.request_id:
        existing = session.exec(
            select(MeasurementCorrection).where(
                MeasurementCorrection.request_id == body.request_id
            )
        ).first()
        if existing:
            raise HTTPException(
                status_code=409,
                detail="Duplicate correction request (already applied)",
            )

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
        if not math.isfinite(new_val):
            raise HTTPException(
                status_code=400,
                detail="Resulting value is non-finite — correction rejected",
            )
        previous = str(old)
        new = str(new_val)
        setattr(measurement, body.field, new_val)
        _mark_corrected(measurement, body.field)

    elif op == "edit":
        if body.field not in _EDITABLE:
            raise HTTPException(status_code=400, detail="Field is not editable")
        if body.value is None or not body.value.strip():
            raise HTTPException(status_code=400, detail="New value must not be blank")
        previous = str(getattr(measurement, body.field))
        new = body.value
        setattr(measurement, body.field, body.value)
        _mark_corrected(measurement, body.field)

    elif op == "exclude":
        if measurement.excluded:
            raise HTTPException(status_code=409, detail="Already excluded")
        previous = "false"
        new = "true"
        measurement.excluded = True
        _mark_corrected(measurement, "excluded")

    elif op == "restore":
        if not measurement.excluded:
            raise HTTPException(status_code=409, detail="Already included")
        previous = "true"
        new = "false"
        measurement.excluded = False
        _mark_corrected(measurement, "excluded")

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
        request_id=body.request_id,
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
