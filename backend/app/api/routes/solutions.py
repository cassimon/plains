import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import col, func, select

from app.api.deps import CurrentUser, SessionDep
from app.crud import create_solution, update_solution
from app.models import (
    Solution,
    SolutionCreate,
    SolutionPublic,
    SolutionsPublic,
    SolutionUpdate,
)

router = APIRouter(prefix="/solutions", tags=["solutions"])


@router.get("/", response_model=SolutionsPublic)
def read_solutions(
    session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100
) -> Any:
    """Retrieve solutions."""
    if current_user.is_superuser:
        count_statement = select(func.count()).select_from(Solution)
        count = session.exec(count_statement).one()
        statement = (
            select(Solution)
            .order_by(col(Solution.created_at).desc())
            .offset(skip)
            .limit(limit)
        )
        items = session.exec(statement).all()
    else:
        count_statement = (
            select(func.count())
            .select_from(Solution)
            .where(Solution.owner_id == current_user.id)
        )
        count = session.exec(count_statement).one()
        statement = (
            select(Solution)
            .where(Solution.owner_id == current_user.id)
            .order_by(col(Solution.created_at).desc())
            .offset(skip)
            .limit(limit)
        )
        items = session.exec(statement).all()
    return SolutionsPublic(data=items, count=count)


@router.get("/{id}", response_model=SolutionPublic)
def read_solution(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """Get solution by ID."""
    solution = session.get(Solution, id)
    if not solution:
        raise HTTPException(status_code=404, detail="Solution not found")
    if not current_user.is_superuser and (solution.owner_id != current_user.id):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return solution


@router.post("/", response_model=SolutionPublic)
def create_item(
    *, session: SessionDep, current_user: CurrentUser, solution_in: SolutionCreate
) -> Any:
    """Create new solution."""
    solution = create_solution(
        session=session, solution_in=solution_in, owner_id=current_user.id
    )
    return solution


@router.put("/{id}", response_model=SolutionPublic)
def update_item(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    solution_in: SolutionUpdate,
) -> Any:
    """Update solution."""
    solution = session.get(Solution, id)
    if not solution:
        raise HTTPException(status_code=404, detail="Solution not found")
    if not current_user.is_superuser and (solution.owner_id != current_user.id):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    solution = update_solution(
        session=session, db_solution=solution, solution_in=solution_in
    )
    return solution


@router.delete("/{id}")
def delete_solution(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Any:
    """Delete solution."""
    solution = session.get(Solution, id)
    if not solution:
        raise HTTPException(status_code=404, detail="Solution not found")
    if not current_user.is_superuser and (solution.owner_id != current_user.id):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    session.delete(solution)
    session.commit()
    return {"ok": True}
