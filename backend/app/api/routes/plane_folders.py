import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import col, func, select

from app import crud
from app.api.deps import CurrentUser, SessionDep
from app.models import (
    Plane,
    PlaneFolder,
    PlaneFolderCreate,
    PlaneFolderPublic,
    PlaneFoldersPublic,
    PlaneFolderUpdate,
)

router = APIRouter(prefix="/plane-folders", tags=["plane-folders"])


def _owned_folder(
    session: SessionDep, current_user: CurrentUser, folder_id: uuid.UUID
) -> PlaneFolder:
    folder = session.get(PlaneFolder, folder_id)
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    if not current_user.is_superuser and folder.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return folder


@router.get("/", response_model=PlaneFoldersPublic)
def read_plane_folders(
    session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100
) -> Any:
    if current_user.is_superuser:
        cond = None
    else:
        cond = PlaneFolder.owner_id == current_user.id
    count_stmt = select(func.count()).select_from(PlaneFolder)
    stmt = select(PlaneFolder).order_by(
        col(PlaneFolder.position), col(PlaneFolder.created_at)
    )
    if cond is not None:
        count_stmt = count_stmt.where(cond)
        stmt = stmt.where(cond)
    count = session.exec(count_stmt).one()
    folders = session.exec(stmt.offset(skip).limit(limit)).all()
    return PlaneFoldersPublic(
        data=[PlaneFolderPublic.model_validate(f) for f in folders], count=count
    )


@router.post("/", response_model=PlaneFolderPublic)
def create_plane_folder(
    *, session: SessionDep, current_user: CurrentUser, folder_in: PlaneFolderCreate
) -> Any:
    folder = crud.create_plane_folder(
        session=session, folder_in=folder_in, owner_id=current_user.id
    )
    return PlaneFolderPublic.model_validate(folder)


@router.put("/{id}", response_model=PlaneFolderPublic)
def update_plane_folder(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    folder_in: PlaneFolderUpdate,
) -> Any:
    folder = _owned_folder(session, current_user, id)
    folder = crud.update_plane_folder(
        session=session, db_folder=folder, folder_in=folder_in
    )
    return PlaneFolderPublic.model_validate(folder)


@router.delete("/{id}")
def delete_plane_folder(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Any:
    folder = _owned_folder(session, current_user, id)
    # Un-folder any planes still pointing here so they survive as ungrouped.
    # (The DB FK is ON DELETE SET NULL, but do it explicitly for immediacy.)
    planes = session.exec(select(Plane).where(Plane.folder_id == id)).all()
    for plane in planes:
        plane.folder_id = None
        session.add(plane)
    session.delete(folder)
    session.commit()
    return {"ok": True}
