import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import col, func, select

from app import crud
from app.api.deps import CurrentUser, SessionDep
from app.models import (
    LabMaterial,
    LabMaterialCreate,
    LabMaterialPublic,
    LabMaterialsPublic,
    LabMaterialUpdate,
)

router = APIRouter(prefix="/materials", tags=["materials"])


@router.get("/", response_model=LabMaterialsPublic)
def read_materials(
    session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100
) -> Any:
    """Retrieve materials."""
    base = select(LabMaterial)
    count_base = select(func.count()).select_from(LabMaterial)
    if not current_user.is_superuser:
        base = base.where(LabMaterial.owner_id == current_user.id)
        count_base = count_base.where(LabMaterial.owner_id == current_user.id)
    count = session.exec(count_base).one()
    statement = base.order_by(col(LabMaterial.created_at).desc()).offset(skip).limit(limit)
    items = session.exec(statement).all()
    return LabMaterialsPublic(data=items, count=count)


@router.get("/{id}", response_model=LabMaterialPublic)
def read_material(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """Get material by ID."""
    material = session.get(LabMaterial, id)
    if not material:
        raise HTTPException(status_code=404, detail="LabMaterial not found")
    if not current_user.is_superuser and (material.owner_id != current_user.id):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return material


@router.post("/", response_model=LabMaterialPublic)
def create_material(
    *, session: SessionDep, current_user: CurrentUser, material_in: LabMaterialCreate
) -> Any:
    """Create new material."""
    return crud.create_material(
        session=session, material_in=material_in, owner_id=current_user.id
    )


@router.put("/{id}", response_model=LabMaterialPublic)
def update_material(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    material_in: LabMaterialUpdate,
) -> Any:
    """Update material."""
    material = session.get(LabMaterial, id)
    if not material:
        raise HTTPException(status_code=404, detail="LabMaterial not found")
    if not current_user.is_superuser and (material.owner_id != current_user.id):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return crud.update_material(
        session=session, db_material=material, material_in=material_in
    )


@router.delete("/{id}")
def delete_material(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Any:
    """Delete material."""
    material = session.get(LabMaterial, id)
    if not material:
        raise HTTPException(status_code=404, detail="LabMaterial not found")
    if not current_user.is_superuser and (material.owner_id != current_user.id):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    session.delete(material)
    session.commit()
    return {"ok": True}
