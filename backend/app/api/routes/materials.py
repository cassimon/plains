import uuid
from typing import Any

from fastapi import APIRouter, BackgroundTasks, HTTPException
from sqlmodel import col, func, select

from app import crud
from app.api.deps import CurrentUser, SessionDep
from app.api.query import visible
from app.models import (
    LabMaterial,
    LabMaterialCreate,
    LabMaterialPublic,
    LabMaterialsPublic,
    LabMaterialUpdate,
)
from app.services.pubchem_enrichment import enrich_material_by_id, enrich_materials

router = APIRouter(prefix="/materials", tags=["materials"])


@router.get("/", response_model=LabMaterialsPublic)
def read_materials(
    session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100
) -> Any:
    """Retrieve materials."""
    base = visible(
        select(LabMaterial), LabMaterial, current_user, entity_type="material"
    )
    count_base = visible(
        select(func.count()).select_from(LabMaterial),
        LabMaterial,
        current_user,
        entity_type="material",
    )
    count = session.exec(count_base).one()
    statement = (
        base.order_by(col(LabMaterial.created_at).desc()).offset(skip).limit(limit)
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
    *,
    session: SessionDep,
    current_user: CurrentUser,
    material_in: LabMaterialCreate,
    background_tasks: BackgroundTasks,
) -> Any:
    """Create new material."""
    material = crud.create_material(
        session=session, material_in=material_in, owner_id=current_user.id
    )
    # Cached in the background: a PubChem round-trip must not add latency to --
    # or be able to fail -- the user's save. The data simply appears on the
    # next read.
    background_tasks.add_task(enrich_material_by_id, material.id)
    return material


@router.put("/{id}", response_model=LabMaterialPublic)
def update_material(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    material_in: LabMaterialUpdate,
    background_tasks: BackgroundTasks,
) -> Any:
    """Update material."""
    material = session.get(LabMaterial, id)
    if not material:
        raise HTTPException(status_code=404, detail="LabMaterial not found")
    if not current_user.is_superuser and (material.owner_id != current_user.id):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    previous_cid = material.pubchem_cid
    previous_name = material.name
    updated = crud.update_material(
        session=session, db_material=material, material_in=material_in
    )
    # Only the identity fields can invalidate the cache; re-fetching on every
    # unrelated edit (purity, supplier, notes) would hammer PubChem for nothing.
    if updated.pubchem_cid != previous_cid or updated.name != previous_name:
        background_tasks.add_task(enrich_material_by_id, updated.id, force=True)
    return updated


@router.post("/enrich-pubchem")
def enrich_materials_from_pubchem(
    session: SessionDep, current_user: CurrentUser, force: bool = False
) -> Any:
    """Backfill cached PubChem data across the caller's materials.

    Idempotent: rows already synced from their current CID are skipped unless
    `force` is set, so this is safe to re-run to pick up earlier failures.
    """
    materials = list(
        session.exec(
            visible(
                select(LabMaterial), LabMaterial, current_user, entity_type="material"
            )
        ).all()
    )
    changed = enrich_materials(session, materials, force=force)
    session.commit()
    return {"ok": True, "considered": len(materials), "updated": changed}


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
