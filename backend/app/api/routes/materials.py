import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import col, func, select

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
    if current_user.is_superuser:
        count_statement = select(func.count()).select_from(LabMaterial)
        count = session.exec(count_statement).one()
        statement = (
            select(LabMaterial)
            .order_by(col(LabMaterial.created_at).desc())
            .offset(skip)
            .limit(limit)
        )
        items = session.exec(statement).all()
    else:
        count_statement = (
            select(func.count())
            .select_from(LabMaterial)
            .where(LabMaterial.owner_id == current_user.id)
        )
        count = session.exec(count_statement).one()
        statement = (
            select(LabMaterial)
            .where(LabMaterial.owner_id == current_user.id)
            .order_by(col(LabMaterial.created_at).desc())
            .offset(skip)
            .limit(limit)
        )
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
    material = LabMaterial.model_validate(
        material_in, update={"owner_id": current_user.id}
    )
    session.add(material)
    session.commit()
    session.refresh(material)
    return material


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
    update_data = material_in.model_dump(exclude_unset=True)
    material.sqlmodel_update(update_data)
    session.add(material)
    session.commit()
    session.refresh(material)
    return material


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
