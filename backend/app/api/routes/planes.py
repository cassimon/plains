import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import col, func, select

from app.api.deps import CurrentUser, SessionDep
from app.models import (
    CanvasElement,
    CanvasElementCreate,
    CanvasElementPublic,
    Message,
    Plane,
    PlaneCreate,
    PlanePublic,
    PlanesPublic,
    PlaneUpdate,
)

router = APIRouter(prefix="/planes", tags=["planes"])


@router.get("/", response_model=PlanesPublic)
def read_planes(
    session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100
) -> Any:
    """Retrieve planes for current user."""
    if current_user.is_superuser:
        count_statement = select(func.count()).select_from(Plane)
        count = session.exec(count_statement).one()
        statement = (
            select(Plane).order_by(col(Plane.created_at).desc()).offset(skip).limit(limit)
        )
        planes = session.exec(statement).all()
    else:
        count_statement = (
            select(func.count())
            .select_from(Plane)
            .where(Plane.owner_id == current_user.id)
        )
        count = session.exec(count_statement).one()
        statement = (
            select(Plane)
            .where(Plane.owner_id == current_user.id)
            .order_by(col(Plane.created_at).desc())
            .offset(skip)
            .limit(limit)
        )
        planes = session.exec(statement).all()
    planes_public = [PlanePublic.model_validate(plane) for plane in planes]
    return PlanesPublic(data=planes_public, count=count)


@router.get("/{id}", response_model=PlanePublic)
def read_plane(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """Get plane by ID with elements."""
    plane = session.get(Plane, id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    if not current_user.is_superuser and plane.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return plane


@router.post("/", response_model=PlanePublic)
def create_plane(
    *, session: SessionDep, current_user: CurrentUser, plane_in: PlaneCreate
) -> Any:
    """Create new plane with optional elements."""
    plane = Plane(
        name=plane_in.name,
        owner_id=current_user.id,
    )
    session.add(plane)
    session.flush()  # Get plane.id
    
    for elem_in in plane_in.elements:
        elem = CanvasElement(
            plane_id=plane.id,
            element_type=elem_in.element_type,
            x=elem_in.x,
            y=elem_in.y,
            width=elem_in.width,
            height=elem_in.height,
            content=elem_in.content,
            color=elem_in.color,
        )
        session.add(elem)
    
    session.commit()
    session.refresh(plane)
    return plane


@router.put("/{id}", response_model=PlanePublic)
def update_plane(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    plane_in: PlaneUpdate,
) -> Any:
    """Update plane name."""
    plane = session.get(Plane, id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    if not current_user.is_superuser and plane.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    
    update_data = plane_in.model_dump(exclude_unset=True)
    plane.sqlmodel_update(update_data)
    session.add(plane)
    session.commit()
    session.refresh(plane)
    return plane


@router.delete("/{id}")
def delete_plane(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """Delete plane and all its elements."""
    plane = session.get(Plane, id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    if not current_user.is_superuser and plane.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    session.delete(plane)
    session.commit()
    return {"ok": True}


# ── Canvas Element Sub-routes ────────────────────────────────────────────────

@router.post("/{plane_id}/elements", response_model=CanvasElementPublic)
def create_element(
    *, session: SessionDep, current_user: CurrentUser, plane_id: uuid.UUID, element_in: CanvasElementCreate
) -> Any:
    """Add element to plane."""
    plane = session.get(Plane, plane_id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    if not current_user.is_superuser and plane.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    
    element = CanvasElement(
        plane_id=plane_id,
        element_type=element_in.element_type,
        x=element_in.x,
        y=element_in.y,
        width=element_in.width,
        height=element_in.height,
        content=element_in.content,
        color=element_in.color,
    )
    session.add(element)
    session.commit()
    session.refresh(element)
    return element


@router.put("/{plane_id}/elements/{element_id}", response_model=CanvasElementPublic)
def update_element(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    plane_id: uuid.UUID,
    element_id: uuid.UUID,
    element_in: CanvasElementCreate,
) -> Any:
    """Update canvas element."""
    plane = session.get(Plane, plane_id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    if not current_user.is_superuser and plane.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    
    element = session.get(CanvasElement, element_id)
    if not element or element.plane_id != plane_id:
        raise HTTPException(status_code=404, detail="Element not found")
    
    element.element_type = element_in.element_type
    element.x = element_in.x
    element.y = element_in.y
    element.width = element_in.width
    element.height = element_in.height
    element.content = element_in.content
    element.color = element_in.color
    
    session.add(element)
    session.commit()
    session.refresh(element)
    return element


@router.delete("/{plane_id}/elements/{element_id}")
def delete_element(
    session: SessionDep, current_user: CurrentUser, plane_id: uuid.UUID, element_id: uuid.UUID
) -> Any:
    """Delete canvas element."""
    plane = session.get(Plane, plane_id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    if not current_user.is_superuser and plane.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    
    element = session.get(CanvasElement, element_id)
    if not element or element.plane_id != plane_id:
        raise HTTPException(status_code=404, detail="Element not found")
    
    session.delete(element)
    session.commit()
    return {"ok": True}
