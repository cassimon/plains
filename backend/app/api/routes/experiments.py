import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import col, func, select

from app.api.deps import CurrentUser, SessionDep
from app.crud import create_experiment, update_experiment
from app.models import (
    EntityRefList,
    Experiment,
    ExperimentCreate,
    ExperimentMaterial,
    ExperimentPublic,
    ExperimentSolution,
    ExperimentsPublic,
    ExperimentUpdate,
    LabSubstrate,
    LabSubstrateCreate,
    LabSubstratePublic,
)

router = APIRouter(prefix="/experiments", tags=["experiments"])


@router.get("/", response_model=ExperimentsPublic)
def read_experiments(
    session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100
) -> Any:
    """Retrieve experiments."""
    if current_user.is_superuser:
        count_statement = select(func.count()).select_from(Experiment)
        count = session.exec(count_statement).one()
        statement = (
            select(Experiment)
            .order_by(col(Experiment.created_at).desc())
            .offset(skip)
            .limit(limit)
        )
        items = [
            ExperimentPublic.model_validate(item)
            for item in session.exec(statement).all()
        ]
    else:
        count_statement = (
            select(func.count())
            .select_from(Experiment)
            .where(Experiment.owner_id == current_user.id)
        )
        count = session.exec(count_statement).one()
        statement = (
            select(Experiment)
            .where(Experiment.owner_id == current_user.id)
            .order_by(col(Experiment.created_at).desc())
            .offset(skip)
            .limit(limit)
        )
        items = [
            ExperimentPublic.model_validate(item)
            for item in session.exec(statement).all()
        ]
    return ExperimentsPublic(data=items, count=count)


@router.get("/{id}", response_model=ExperimentPublic)
def read_experiment(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Any:
    """Get experiment by ID."""
    experiment = session.get(Experiment, id)
    if not experiment:
        raise HTTPException(status_code=404, detail="Experiment not found")
    if not current_user.is_superuser and (experiment.owner_id != current_user.id):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return experiment


@router.post("/", response_model=ExperimentPublic)
def create_item(
    *, session: SessionDep, current_user: CurrentUser, experiment_in: ExperimentCreate
) -> Any:
    """Create new experiment."""
    experiment = create_experiment(
        session=session, experiment_in=experiment_in, owner_id=current_user.id
    )
    return experiment


@router.put("/{id}", response_model=ExperimentPublic)
def update_item(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    experiment_in: ExperimentUpdate,
) -> Any:
    """Update experiment."""
    experiment = session.get(Experiment, id)
    if not experiment:
        raise HTTPException(status_code=404, detail="Experiment not found")
    if not current_user.is_superuser and (experiment.owner_id != current_user.id):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    experiment = update_experiment(
        session=session, db_experiment=experiment, experiment_in=experiment_in
    )
    return experiment


@router.delete("/{id}")
def delete_experiment(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Any:
    """Delete experiment."""
    experiment = session.get(Experiment, id)
    if not experiment:
        raise HTTPException(status_code=404, detail="Experiment not found")
    if not current_user.is_superuser and (experiment.owner_id != current_user.id):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    session.delete(experiment)
    session.commit()
    return {"ok": True}


def _get_owned_experiment(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Experiment:
    experiment = session.get(Experiment, id)
    if not experiment:
        raise HTTPException(status_code=404, detail="Experiment not found")
    if not current_user.is_superuser and (experiment.owner_id != current_user.id):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return experiment


@router.put("/{id}/materials", response_model=ExperimentPublic)
def set_experiment_materials(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    body: EntityRefList,
) -> Any:
    """Replace the set of LabMaterials referenced by an experiment."""
    experiment = _get_owned_experiment(session, current_user, id)
    for ref in list(experiment.material_refs):
        session.delete(ref)
    session.flush()
    for material_id in dict.fromkeys(body.ids):
        session.add(ExperimentMaterial(experiment_id=id, material_id=material_id))
    session.commit()
    session.refresh(experiment)
    return experiment


@router.put("/{id}/solutions", response_model=ExperimentPublic)
def set_experiment_solutions(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    body: EntityRefList,
) -> Any:
    """Replace the set of LabSolutions referenced by an experiment."""
    experiment = _get_owned_experiment(session, current_user, id)
    for ref in list(experiment.solution_refs):
        session.delete(ref)
    session.flush()
    for solution_id in dict.fromkeys(body.ids):
        session.add(ExperimentSolution(experiment_id=id, solution_id=solution_id))
    session.commit()
    session.refresh(experiment)
    return experiment


@router.put("/{id}/substrates", response_model=list[LabSubstratePublic])
def replace_experiment_substrates(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    body: list[LabSubstrateCreate],
) -> Any:
    """Replace all substrates of an experiment (used by the snapshot sync)."""
    experiment = _get_owned_experiment(session, current_user, id)
    for substrate in list(experiment.substrates):
        session.delete(substrate)
    session.flush()
    created = [LabSubstrate(**s.model_dump(), experiment_id=id) for s in body]
    for substrate in created:
        session.add(substrate)
    session.commit()
    for substrate in created:
        session.refresh(substrate)
    return created
