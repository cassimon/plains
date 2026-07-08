import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter
from sqlalchemy.orm.attributes import flag_modified
from sqlmodel import col, or_, select

from app.api.deps import CurrentUser, SessionDep
from app.api.query import trashed_ids, visible
from app.api.routes.planes import _populate as _populate_plane
from app.models import (
    Analysis,
    BulkStateResponse,
    Experiment,
    ExperimentResults,
    LabMaterial,
    LabSolution,
    Plane,
    PlaneFolder,
    PlaneFolderPublic,
    PlaneShare,
    Process,
    UiPrefsUpdate,
    UserState,
    UserStatePublic,
)
from app.services.trash import sweep_expired_trash

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
    """Load all user entities in a single request.

    This is the single login bootstrap, so it also runs the trash TTL sweep
    (cheap thanks to the deleted_at/owner_id indexes) and excludes every
    soft-deleted row via ``visible()`` — trashed items must never reach a
    picker, and the snapshot is where they'd otherwise leak in.
    """
    uid = current_user.id
    sweep_expired_trash(session, current_user)

    # Planes carry a share join, so the owner filter can't come from visible();
    # apply owner-or-shared here and exclude trashed planes explicitly.
    trashed_planes = trashed_ids(session, current_user, "plane")
    plane_stmt = (
        select(Plane)
        .outerjoin(PlaneShare, Plane.id == PlaneShare.plane_id)
        .where(or_(Plane.owner_id == uid, PlaneShare.user_id == uid))
        .distinct()
    )
    if trashed_planes:
        plane_stmt = plane_stmt.where(col(Plane.id).not_in(trashed_planes))
    planes = session.exec(plane_stmt).all()
    trashed_collections = trashed_ids(session, current_user, "collection")

    folders = session.exec(select(PlaneFolder).where(PlaneFolder.owner_id == uid)).all()
    return BulkStateResponse(
        materials=session.exec(
            visible(
                select(LabMaterial), LabMaterial, current_user, entity_type="material"
            )
        ).all(),
        solutions=session.exec(
            visible(
                select(LabSolution), LabSolution, current_user, entity_type="solution"
            )
        ).all(),
        processes=session.exec(
            visible(select(Process), Process, current_user, entity_type="process")
        ).all(),
        experiments=session.exec(
            visible(
                select(Experiment), Experiment, current_user, entity_type="experiment"
            )
        ).all(),
        results=session.exec(
            visible(
                select(ExperimentResults),
                ExperimentResults,
                current_user,
                entity_type="result",
            )
        ).all(),
        analyses=session.exec(
            visible(select(Analysis), Analysis, current_user, entity_type="analysis")
        ).all(),
        planes=[_populate_plane(p, trashed_collections) for p in planes],
        folders=[PlaneFolderPublic.model_validate(f) for f in folders],
    )
