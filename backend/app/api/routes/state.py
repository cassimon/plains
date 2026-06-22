import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter
from sqlalchemy.orm.attributes import flag_modified
from sqlmodel import or_, select

from app.api.deps import CurrentUser, SessionDep
from app.api.routes.planes import _populate as _populate_plane
from app.models import (
    Analysis,
    BulkStateResponse,
    Experiment,
    ExperimentResults,
    LabMaterial,
    LabSolution,
    Plane,
    PlaneShare,
    Process,
    UiPrefsUpdate,
    UserState,
    UserStatePublic,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/state", tags=["state"])


def _get_or_create_state(session: SessionDep, uid: Any) -> UserState:
    us = session.exec(select(UserState).where(UserState.owner_id == uid)).first()
    if not us:
        us = UserState(owner_id=uid, data={})
        session.add(us)
        session.commit()
        session.refresh(us)
    return us


@router.get("/", response_model=UserStatePublic)
def read_state(session: SessionDep, current_user: CurrentUser) -> Any:
    """Return persisted UI-only preferences."""
    us = session.exec(
        select(UserState).where(UserState.owner_id == current_user.id)
    ).first()
    data = us.data if us and isinstance(us.data, dict) else {}
    return UserStatePublic(data=data, updated_at=us.updated_at if us else None)


@router.put("/", response_model=UserStatePublic)
def update_state(
    session: SessionDep, current_user: CurrentUser, *, body: UiPrefsUpdate
) -> Any:
    """Persist UI-only preferences. Only ``ui_prefs`` is accepted."""
    us = _get_or_create_state(session, current_user.id)
    now = datetime.now(timezone.utc)
    us.data = {"ui_prefs": body.ui_prefs}
    us.updated_at = now
    flag_modified(us, "data")
    session.add(us)
    session.commit()
    return UserStatePublic(data=us.data, updated_at=now)


@router.get("/bulk", response_model=BulkStateResponse)
def get_bulk_state(session: SessionDep, current_user: CurrentUser) -> Any:
    """Load all user entities in a single request."""
    uid = current_user.id
    planes = session.exec(
        select(Plane)
        .outerjoin(PlaneShare, Plane.id == PlaneShare.plane_id)
        .where(or_(Plane.owner_id == uid, PlaneShare.user_id == uid))
    ).all()
    return BulkStateResponse(
        materials=session.exec(
            select(LabMaterial).where(LabMaterial.owner_id == uid)
        ).all(),
        solutions=session.exec(
            select(LabSolution).where(LabSolution.owner_id == uid)
        ).all(),
        processes=session.exec(select(Process).where(Process.owner_id == uid)).all(),
        experiments=session.exec(
            select(Experiment).where(Experiment.owner_id == uid)
        ).all(),
        results=session.exec(
            select(ExperimentResults).where(ExperimentResults.owner_id == uid)
        ).all(),
        analyses=session.exec(select(Analysis).where(Analysis.owner_id == uid)).all(),
        planes=[_populate_plane(p) for p in planes],
    )
