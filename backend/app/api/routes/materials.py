import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import col, func, select

from app.api.deps import CurrentUser, SessionDep
from app.models import Material, MaterialCreate, MaterialPublic, MaterialsPublic, MaterialUpdate, Message

router = APIRouter(prefix="/materials", tags=["materials"])


@router.get("/", response_model=MaterialsPublic)
def read_materials(
    session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100
) -> Any:
    """Retrieve materials."""
    if current_user.is_superuser:
        count_statement = select(func.count()).select_from(Material)
        count = session.exec(count_statement).one()
        statement = (
            select(Material).order_by(col(Material.created_at).desc()).offset(skip).limit(limit)
        )
        items = session.exec(statement).all()
    else:
        count_statement = (
            select(func.count())
            .select_from(Material)
            .where(Material.owner_id == current_user.id)
        )
        count = session.exec(count_statement).one()
        statement = (
            select(Material)
            .where(Material.owner_id == current_user.id)
            .order_by(col(Material.created_at).desc())
            .offset(skip)
            .limit(limit)
        )
        items = session.exec(statement).all()
    return MaterialsPublic(data=items, count=count)


@router.get("/{id}", response_model=MaterialPublic)
def read_material(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """Get material by ID."""
    material = session.get(Material, id)
    if not material:
        raise HTTPException(status_code=404, detail="Material not found")
    if not current_user.is_superuser and (material.owner_id != current_user.id):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return material


@router.post("/", response_model=MaterialPublic)
def create_material(
    *, session: SessionDep, current_user: CurrentUser, material_in: MaterialCreate
) -> Any:
    """Create new material."""
    material = Material.model_validate(material_in, update={"owner_id": current_user.id})
    session.add(material)
    session.commit()
    session.refresh(material)
    return material


@router.put("/{id}", response_model=MaterialPublic)
def update_material(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    material_in: MaterialUpdate,
) -> Any:
    """Update material."""
    material = session.get(Material, id)
    if not material:
        raise HTTPException(status_code=404, detail="Material not found")
    if not current_user.is_superuser and (material.owner_id != current_user.id):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    update_data = material_in.model_dump(exclude_unset=True)
    material.sqlmodel_update(update_data)
    session.add(material)
    session.commit()
    session.refresh(material)
    return material


@router.delete("/{id}")
def delete_material(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """Delete material."""
    material = session.get(Material, id)
    if not material:
        raise HTTPException(status_code=404, detail="Material not found")
    if not current_user.is_superuser and (material.owner_id != current_user.id):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    session.delete(material)
    session.commit()
    return {"ok": True}
