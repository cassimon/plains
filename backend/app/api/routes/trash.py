import uuid
from typing import Any

from fastapi import APIRouter, HTTPException

from app.api.deps import CurrentUser, SessionDep
from app.models import (
    TRASHABLE_TYPES,
    DataCollection,
    Message,
    Plane,
    TrashEntryPublic,
    TrashListPublic,
    TrashRestore,
    TrashRestoreResult,
)
from app.services import trash as trash_svc

router = APIRouter(prefix="/trash", tags=["trash"])


def _validate_type(entity_type: str) -> None:
    if entity_type not in TRASHABLE_TYPES:
        raise HTTPException(
            status_code=422, detail=f"Not a trashable type: {entity_type}"
        )


def _verify_owner(
    session: SessionDep,
    current_user: CurrentUser,
    entity_type: str,
    entity_id: uuid.UUID,
) -> None:
    """404 if the entity is missing, 403 if it isn't the caller's.

    Collections are owned transitively through their plane; everything else
    carries owner_id directly.
    """
    if current_user.is_superuser:
        return
    model = trash_svc.MODEL_BY_TYPE[entity_type]
    obj = session.get(model, entity_id)
    if obj is None:
        # Nothing to own — allow (restore/purge of an already-gone row is a no-op).
        return
    if isinstance(obj, DataCollection):
        plane = session.get(Plane, obj.plane_id)
        owner_id = plane.owner_id if plane else None
    else:
        owner_id = getattr(obj, "owner_id", None)
    if owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")


@router.get("/", response_model=TrashListPublic)
def list_trash(session: SessionDep, current_user: CurrentUser) -> Any:
    """List the user's trashed items (also runs the TTL sweep)."""
    trash_svc.sweep_expired_trash(session, current_user)
    entries = trash_svc.list_trash(session, current_user)
    return TrashListPublic(
        data=[TrashEntryPublic.model_validate(e) for e in entries],
        count=len(entries),
    )


@router.post("/", response_model=TrashListPublic)
def trash_entity(
    *, session: SessionDep, current_user: CurrentUser, body: TrashRestore
) -> Any:
    """Soft-delete an entity + its downward closure (finished uploads skipped)."""
    _validate_type(body.entity_type)
    _verify_owner(session, current_user, body.entity_type, body.entity_id)
    created = trash_svc.soft_delete(
        session, current_user, body.entity_type, body.entity_id
    )
    return TrashListPublic(
        data=[TrashEntryPublic.model_validate(e) for e in created],
        count=len(created),
    )


@router.post("/restore", response_model=TrashRestoreResult)
def restore_entity(
    *, session: SessionDep, current_user: CurrentUser, body: TrashRestore
) -> Any:
    """Restore an entity + its upward closure. Returns the un-trashed ids so the
    frontend can re-place them on a plane."""
    _validate_type(body.entity_type)
    _verify_owner(session, current_user, body.entity_type, body.entity_id)
    removed = trash_svc.restore(session, current_user, body.entity_type, body.entity_id)
    return TrashRestoreResult(restored=removed)


@router.post("/{entity_type}/{entity_id}/purge", response_model=Message)
def purge_entity(
    session: SessionDep,
    current_user: CurrentUser,
    entity_type: str,
    entity_id: uuid.UUID,
) -> Any:
    """Permanently delete a single trashed entity (cascades)."""
    _validate_type(entity_type)
    _verify_owner(session, current_user, entity_type, entity_id)
    trash_svc.purge(session, current_user, entity_type, entity_id)
    return Message(message="Permanently deleted")


@router.post("/empty", response_model=Message)
def empty_trash(session: SessionDep, current_user: CurrentUser) -> Any:
    """Permanently delete everything in the user's trash."""
    count = trash_svc.empty(session, current_user)
    return Message(message=f"Permanently deleted {count} item(s)")
