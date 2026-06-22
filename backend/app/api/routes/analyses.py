import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import col, func, select

from app import crud
from app.api.deps import CurrentUser, SessionDep
from app.models import (
    AnalysesPublic,
    Analysis,
    AnalysisCreate,
    AnalysisPublic,
    AnalysisUpdate,
)

router = APIRouter(prefix="/analyses", tags=["analyses"])


@router.get("/", response_model=AnalysesPublic)
def read_analyses(
    session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100
) -> Any:
    """Retrieve analyses."""
    base = select(Analysis)
    count_base = select(func.count()).select_from(Analysis)
    if not current_user.is_superuser:
        base = base.where(Analysis.owner_id == current_user.id)
        count_base = count_base.where(Analysis.owner_id == current_user.id)
    count = session.exec(count_base).one()
    statement = base.order_by(col(Analysis.created_at).desc()).offset(skip).limit(limit)
    items = session.exec(statement).all()
    return AnalysesPublic(data=items, count=count)


@router.get("/{id}", response_model=AnalysisPublic)
def read_analysis(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """Get analysis by ID."""
    analysis = session.get(Analysis, id)
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")
    if not current_user.is_superuser and analysis.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return analysis


@router.post("/", response_model=AnalysisPublic)
def create_analysis(
    *, session: SessionDep, current_user: CurrentUser, analysis_in: AnalysisCreate
) -> Any:
    """Create new analysis."""
    return crud.create_analysis(
        session=session, analysis_in=analysis_in, owner_id=current_user.id
    )


@router.put("/{id}", response_model=AnalysisPublic)
def update_analysis(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    analysis_in: AnalysisUpdate,
) -> Any:
    """Update analysis."""
    analysis = session.get(Analysis, id)
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")
    if not current_user.is_superuser and analysis.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return crud.update_analysis(
        session=session, db_analysis=analysis, analysis_in=analysis_in
    )


@router.delete("/{id}")
def delete_analysis(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Any:
    """Delete analysis and its refs."""
    analysis = session.get(Analysis, id)
    if not analysis:
        raise HTTPException(status_code=404, detail="Analysis not found")
    if not current_user.is_superuser and analysis.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    session.delete(analysis)
    session.commit()
    return {"ok": True}
