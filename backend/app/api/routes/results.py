import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import col, func, select

from app.api.deps import CurrentUser, SessionDep
from app.crud import create_experiment_results, update_experiment_results
from app.models import (
    ExperimentResults,
    ExperimentResultsCreate,
    ExperimentResultsListPublic,
    ExperimentResultsPublic,
    ExperimentResultsUpdate,
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
    statement = base.order_by(col(ExperimentResults.created_at).desc()).offset(skip).limit(limit)
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
