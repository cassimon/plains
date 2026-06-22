import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import col, func, select

from app import crud
from app.api.deps import CurrentUser, SessionDep
from app.models import (
    Process,
    ProcessCreate,
    ProcessesPublic,
    ProcessPublic,
    ProcessUpdate,
)

router = APIRouter(prefix="/processes", tags=["processes"])


@router.get("/", response_model=ProcessesPublic)
def read_processes(
    session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100
) -> Any:
    """Retrieve processes."""
    base = select(Process)
    count_base = select(func.count()).select_from(Process)
    if not current_user.is_superuser:
        base = base.where(Process.owner_id == current_user.id)
        count_base = count_base.where(Process.owner_id == current_user.id)
    count = session.exec(count_base).one()
    statement = base.order_by(col(Process.created_at).desc()).offset(skip).limit(limit)
    items = session.exec(statement).all()
    return ProcessesPublic(data=items, count=count)


@router.get("/{id}", response_model=ProcessPublic)
def read_process(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """Get process by ID."""
    process = session.get(Process, id)
    if not process:
        raise HTTPException(status_code=404, detail="Process not found")
    if not current_user.is_superuser and process.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return process


@router.post("/", response_model=ProcessPublic)
def create_process(
    *, session: SessionDep, current_user: CurrentUser, process_in: ProcessCreate
) -> Any:
    """Create new process."""
    return crud.create_process(
        session=session, process_in=process_in, owner_id=current_user.id
    )


@router.put("/{id}", response_model=ProcessPublic)
def update_process(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    process_in: ProcessUpdate,
) -> Any:
    """Update process."""
    process = session.get(Process, id)
    if not process:
        raise HTTPException(status_code=404, detail="Process not found")
    if not current_user.is_superuser and process.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return crud.update_process(
        session=session, db_process=process, process_in=process_in
    )


@router.delete("/{id}")
def delete_process(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Any:
    """Delete process and all sub-resources."""
    process = session.get(Process, id)
    if not process:
        raise HTTPException(status_code=404, detail="Process not found")
    if not current_user.is_superuser and process.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    session.delete(process)
    session.commit()
    return {"ok": True}


def _owned_process(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Process:
    process = session.get(Process, id)
    if not process:
        raise HTTPException(status_code=404, detail="Process not found")
    if not current_user.is_superuser and process.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return process


@router.get("/{id}/recipes/")
def read_process_recipes(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Any:
    """List solution recipes for a process."""
    process = _owned_process(session, current_user, id)
    return process.recipes


@router.get("/{id}/steps/")
def read_process_steps(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Any:
    """List deposition steps for a process."""
    process = _owned_process(session, current_user, id)
    return process.steps


@router.get("/{id}/stacks/")
def read_process_stacks(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Any:
    """List generated device stacks for a process."""
    process = _owned_process(session, current_user, id)
    return process.stacks
