import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import col, func, or_, select

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
    PlaneShare,
    PlaneShareCreate,
    PlaneUpdate,
    User,
    UserPublic,
)

router = APIRouter(prefix="/planes", tags=["planes"])


def _has_plane_access(plane: Plane, user: User) -> bool:
    """Check if user has access to plane (owner or shared with)."""
    if user.is_superuser or plane.owner_id == user.id:
        return True
    # Check if plane is shared with user
    for share in plane.shared_with:
        if share.user_id == user.id:
            return True
    return False


def _populate_shared_with(plane: Plane) -> PlanePublic:
    """Convert Plane to PlanePublic with shared_with users populated."""
    shared_users = [UserPublic.model_validate(share.user) for share in plane.shared_with]
    plane_dict = plane.model_dump()
    plane_dict["shared_with"] = shared_users
    return PlanePublic.model_validate(plane_dict)


@router.get("/", response_model=PlanesPublic)
def read_planes(
    session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100
) -> Any:
    """Retrieve planes owned by or shared with current user."""
    if current_user.is_superuser:
        count_statement = select(func.count()).select_from(Plane)
        count = session.exec(count_statement).one()
        statement = (
            select(Plane).order_by(col(Plane.created_at).desc()).offset(skip).limit(limit)
        )
        planes = session.exec(statement).all()
    else:
        # Get planes owned by user OR shared with user
        count_statement = (
            select(func.count())
            .select_from(Plane)
            .outerjoin(PlaneShare, Plane.id == PlaneShare.plane_id)
            .where(
                or_(
                    Plane.owner_id == current_user.id,
                    PlaneShare.user_id == current_user.id,
                )
            )
        )
        count = session.exec(count_statement).one()
        statement = (
            select(Plane)
            .outerjoin(PlaneShare, Plane.id == PlaneShare.plane_id)
            .where(
                or_(
                    Plane.owner_id == current_user.id,
                    PlaneShare.user_id == current_user.id,
                )
            )
            .order_by(col(Plane.created_at).desc())
            .offset(skip)
            .limit(limit)
        )
        planes = session.exec(statement).all()
    planes_public = [_populate_shared_with(plane) for plane in planes]
    return PlanesPublic(data=planes_public, count=count)


@router.get("/{id}", response_model=PlanePublic)
def read_plane(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """Get plane by ID with elements."""
    plane = session.get(Plane, id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    if not _has_plane_access(plane, current_user):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return _populate_shared_with(plane)


@router.post("/", response_model=PlanePublic)
def create_plane(
    *, session: SessionDep, current_user: CurrentUser, plane_in: PlaneCreate
) -> Any:
    """Create new plane with optional elements (private by default)."""
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
    return _populate_shared_with(plane)


@router.put("/{id}", response_model=PlanePublic)
def update_plane(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    plane_in: PlaneUpdate,
) -> Any:
    """Update plane name (owner only)."""
    plane = session.get(Plane, id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    # Only owner can update plane name
    if not current_user.is_superuser and plane.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    
    update_data = plane_in.model_dump(exclude_unset=True)
    plane.sqlmodel_update(update_data)
    session.add(plane)
    session.commit()
    session.refresh(plane)
    return _populate_shared_with(plane)


@router.delete("/{id}")
def delete_plane(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """Delete plane and all its elements (owner only)."""
    plane = session.get(Plane, id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    # Only owner can delete
    if not current_user.is_superuser and plane.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    session.delete(plane)
    session.commit()
    return {"ok": True}


# ── Plane Sharing Routes ─────────────────────────────────────────────────────

@router.post("/{id}/share", response_model=PlanePublic)
def share_plane(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    share_in: PlaneShareCreate,
) -> Any:
    """Share plane with another user (owner only)."""
    plane = session.get(Plane, id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    # Only owner can share
    if not current_user.is_superuser and plane.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the owner can share this plane")
    
    # Check if target user exists
    target_user = session.get(User, share_in.user_id)
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")
    
    # Cannot share with self
    if target_user.id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot share plane with yourself")
    
    # Check if already shared
    existing_share = session.exec(
        select(PlaneShare).where(
            PlaneShare.plane_id == id, PlaneShare.user_id == share_in.user_id
        )
    ).first()
    if existing_share:
        raise HTTPException(status_code=400, detail="Plane already shared with this user")
    
    # Create share
    share = PlaneShare(plane_id=id, user_id=share_in.user_id)
    session.add(share)
    session.commit()
    session.refresh(plane)
    return _populate_shared_with(plane)


@router.delete("/{id}/share/{user_id}", response_model=PlanePublic)
def unshare_plane(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    user_id: uuid.UUID,
) -> Any:
    """Remove user from plane sharing (owner only)."""
    plane = session.get(Plane, id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    # Only owner can unshare
    if not current_user.is_superuser and plane.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the owner can unshare this plane")
    
    # Find and delete share
    share = session.exec(
        select(PlaneShare).where(PlaneShare.plane_id == id, PlaneShare.user_id == user_id)
    ).first()
    if not share:
        raise HTTPException(status_code=404, detail="Share not found")
    
    session.delete(share)
    session.commit()
    session.refresh(plane)
    return _populate_shared_with(plane)


@router.get("/search-users/", response_model=list[UserPublic])
def search_users(
    session: SessionDep,
    current_user: CurrentUser,
    q: str = "",
    limit: int = 10,
) -> Any:
    """Search users by email or full name for sharing."""
    if len(q) < 2:
        return []
    
    # Search in email or full_name
    search_pattern = f"%{q}%"
    statement = (
        select(User)
        .where(
            or_(
                col(User.email).ilike(search_pattern),
                col(User.full_name).ilike(search_pattern),
            )
        )
        .where(User.id != current_user.id)  # Exclude current user
        .limit(limit)
    )
    users = session.exec(statement).all()
    return [UserPublic.model_validate(user) for user in users]


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
    """Delete canvas element (owner or shared user)."""
    plane = session.get(Plane, plane_id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    if not _has_plane_access(plane, current_user):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    
    element = session.get(CanvasElement, element_id)
    if not element or element.plane_id != plane_id:
        raise HTTPException(status_code=404, detail="Element not found")
    
    session.delete(element)
    session.commit()
    return {"ok": True}
