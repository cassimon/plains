import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import col, func, select

from app.api.deps import CurrentUser, SessionDep
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
    base = select(ExperimentResults)
    count_base = select(func.count()).select_from(ExperimentResults)
    if not current_user.is_superuser:
        base = base.where(ExperimentResults.owner_id == current_user.id)
        count_base = count_base.where(ExperimentResults.owner_id == current_user.id)
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
    for f in list(result.measurement_files):
        session.delete(f)
    session.flush()
    created = [MeasurementFile(**f.model_dump(), results_id=id) for f in body]
    for f in created:
        session.add(f)
    session.commit()
    for f in created:
        session.refresh(f)
    return created


@router.put("/{id}/device-groups", response_model=list[DeviceGroupPublic])
def replace_device_groups(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    body: list[DeviceGroupCreate],
) -> Any:
    """Replace all device groups of a result (used by the snapshot sync)."""
    result = _owned_result(session, current_user, id)
    for g in list(result.device_groups):
        session.delete(g)
    session.flush()
    created = [DeviceGroup(**g.model_dump(), results_id=id) for g in body]
    for g in created:
        session.add(g)
    session.commit()
    for g in created:
        session.refresh(g)
    return created
