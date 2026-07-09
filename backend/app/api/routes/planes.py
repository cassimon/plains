import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import col, func, or_, select

from app import crud
from app.api.deps import CurrentUser, SessionDep
from app.models import (
    DataCollection,
    DataCollectionCreate,
    DataCollectionPublic,
    DataCollectionUpdate,
    Plane,
    PlaneCreate,
    PlanePublic,
    PlaneShare,
    PlaneShareCreate,
    PlanesPublic,
    PlaneUpdate,
    StickyNote,
    StickyNoteCreate,
    StickyNotePublic,
    StickyNoteUpdate,
    TextField,
    TextFieldCreate,
    TextFieldPublic,
    TextFieldUpdate,
    TrashEntry,
    User,
    UserPublic,
)

router = APIRouter(prefix="/planes", tags=["planes"])


def _has_plane_access(plane: Plane, user: User) -> bool:
    if user.is_superuser or plane.owner_id == user.id:
        return True
    for share in plane.shared_with:
        if share.user_id == user.id:
            return True
    return False


def _populate(
    plane: Plane, trashed_collection_ids: set[uuid.UUID] | None = None
) -> PlanePublic:
    excluded = trashed_collection_ids or set()
    return PlanePublic(
        id=plane.id,
        name=plane.name,
        folder_id=plane.folder_id,
        position=plane.position,
        owner_id=plane.owner_id,
        owner=UserPublic.model_validate(plane.owner),
        created_at=plane.created_at,
        sticky_notes=[StickyNotePublic.model_validate(n) for n in plane.sticky_notes],
        text_fields=[TextFieldPublic.model_validate(t) for t in plane.text_fields],
        collections=[
            DataCollectionPublic.model_validate(c)
            for c in plane.collections
            if c.id not in excluded
        ],
        shared_with=[UserPublic.model_validate(s.user) for s in plane.shared_with],
    )


@router.get("/", response_model=PlanesPublic)
def read_planes(
    session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100
) -> Any:
    if current_user.is_superuser:
        count = session.exec(select(func.count()).select_from(Plane)).one()
        statement = (
            select(Plane)
            .order_by(col(Plane.position), col(Plane.created_at).desc())
            .offset(skip)
            .limit(limit)
        )
        planes = session.exec(statement).all()
    else:
        cond = or_(
            Plane.owner_id == current_user.id,
            PlaneShare.user_id == current_user.id,
        )
        count = session.exec(
            select(func.count(Plane.id.distinct()))
            .select_from(Plane)
            .outerjoin(PlaneShare, Plane.id == PlaneShare.plane_id)
            .where(cond)
        ).one()
        statement = (
            select(Plane)
            .outerjoin(PlaneShare, Plane.id == PlaneShare.plane_id)
            .where(cond)
            .order_by(col(Plane.position), col(Plane.created_at).desc())
            .offset(skip)
            .limit(limit)
        )
        planes = session.exec(statement).all()
    return PlanesPublic(data=[_populate(p) for p in planes], count=count)


@router.get("/{id}", response_model=PlanePublic)
def read_plane(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    plane = session.get(Plane, id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    if not _has_plane_access(plane, current_user):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return _populate(plane)


@router.post("/", response_model=PlanePublic)
def create_plane(
    *, session: SessionDep, current_user: CurrentUser, plane_in: PlaneCreate
) -> Any:
    plane = crud.create_plane(
        session=session, plane_in=plane_in, owner_id=current_user.id
    )
    return _populate(plane)


@router.put("/{id}", response_model=PlanePublic)
def update_plane(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    plane_in: PlaneUpdate,
) -> Any:
    plane = session.get(Plane, id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    if not current_user.is_superuser and plane.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    plane = crud.update_plane(session=session, db_plane=plane, plane_in=plane_in)
    return _populate(plane)


@router.delete("/{id}")
def delete_plane(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    plane = session.get(Plane, id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
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
    plane = session.get(Plane, id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    if not current_user.is_superuser and plane.owner_id != current_user.id:
        raise HTTPException(
            status_code=403, detail="Only the owner can share this plane"
        )
    target_user = session.get(User, share_in.user_id)
    if not target_user:
        raise HTTPException(status_code=404, detail="User not found")
    if target_user.id == current_user.id:
        raise HTTPException(status_code=400, detail="Cannot share plane with yourself")
    existing_share = session.exec(
        select(PlaneShare).where(
            PlaneShare.plane_id == id, PlaneShare.user_id == share_in.user_id
        )
    ).first()
    if existing_share:
        raise HTTPException(
            status_code=400, detail="Plane already shared with this user"
        )
    session.add(PlaneShare(plane_id=id, user_id=share_in.user_id))
    session.commit()
    session.refresh(plane)
    return _populate(plane)


@router.delete("/{id}/share/{user_id}", response_model=PlanePublic)
def unshare_plane(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    user_id: uuid.UUID,
) -> Any:
    plane = session.get(Plane, id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    if not current_user.is_superuser and plane.owner_id != current_user.id:
        raise HTTPException(
            status_code=403, detail="Only the owner can unshare this plane"
        )
    share = session.exec(
        select(PlaneShare).where(
            PlaneShare.plane_id == id, PlaneShare.user_id == user_id
        )
    ).first()
    if not share:
        raise HTTPException(status_code=404, detail="Share not found")
    session.delete(share)
    session.commit()
    session.refresh(plane)
    return _populate(plane)


@router.get("/search-users/", response_model=list[UserPublic])
def search_users(
    session: SessionDep,
    current_user: CurrentUser,
    q: str = "",
    limit: int = 10,
) -> Any:
    if len(q) < 2:
        return []
    search_pattern = f"%{q}%"
    statement = (
        select(User)
        .where(
            or_(
                col(User.email).ilike(search_pattern),
                col(User.full_name).ilike(search_pattern),
            )
        )
        .where(User.id != current_user.id)
        .limit(limit)
    )
    users = session.exec(statement).all()
    return [UserPublic.model_validate(user) for user in users]


# ── Canvas element helpers ───────────────────────────────────────────────────


def _owned_plane(
    session: SessionDep, current_user: CurrentUser, plane_id: uuid.UUID
) -> Plane:
    plane = session.get(Plane, plane_id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    if not _has_plane_access(plane, current_user):
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return plane


# ── Sticky notes ─────────────────────────────────────────────────────────────


@router.post("/{plane_id}/sticky-notes", response_model=StickyNotePublic)
def create_sticky_note(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    plane_id: uuid.UUID,
    note_in: StickyNoteCreate,
) -> Any:
    _owned_plane(session, current_user, plane_id)
    return crud.create_sticky_note(session=session, note_in=note_in, plane_id=plane_id)


@router.put("/{plane_id}/sticky-notes/{note_id}", response_model=StickyNotePublic)
def update_sticky_note(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    plane_id: uuid.UUID,
    note_id: uuid.UUID,
    note_in: StickyNoteUpdate,
) -> Any:
    _owned_plane(session, current_user, plane_id)
    note = session.get(StickyNote, note_id)
    if not note or note.plane_id != plane_id:
        raise HTTPException(status_code=404, detail="Sticky note not found")
    return crud.update_sticky_note(session=session, db_note=note, note_in=note_in)


@router.delete("/{plane_id}/sticky-notes/{note_id}")
def delete_sticky_note(
    session: SessionDep,
    current_user: CurrentUser,
    plane_id: uuid.UUID,
    note_id: uuid.UUID,
) -> Any:
    _owned_plane(session, current_user, plane_id)
    note = session.get(StickyNote, note_id)
    if not note or note.plane_id != plane_id:
        raise HTTPException(status_code=404, detail="Sticky note not found")
    session.delete(note)
    session.commit()
    return {"ok": True}


# ── Text fields ──────────────────────────────────────────────────────────────


@router.post("/{plane_id}/text-fields", response_model=TextFieldPublic)
def create_text_field(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    plane_id: uuid.UUID,
    field_in: TextFieldCreate,
) -> Any:
    _owned_plane(session, current_user, plane_id)
    return crud.create_text_field(session=session, field_in=field_in, plane_id=plane_id)


@router.put("/{plane_id}/text-fields/{field_id}", response_model=TextFieldPublic)
def update_text_field(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    plane_id: uuid.UUID,
    field_id: uuid.UUID,
    field_in: TextFieldUpdate,
) -> Any:
    _owned_plane(session, current_user, plane_id)
    field = session.get(TextField, field_id)
    if not field or field.plane_id != plane_id:
        raise HTTPException(status_code=404, detail="Text field not found")
    return crud.update_text_field(session=session, db_field=field, field_in=field_in)


@router.delete("/{plane_id}/text-fields/{field_id}")
def delete_text_field(
    session: SessionDep,
    current_user: CurrentUser,
    plane_id: uuid.UUID,
    field_id: uuid.UUID,
) -> Any:
    _owned_plane(session, current_user, plane_id)
    field = session.get(TextField, field_id)
    if not field or field.plane_id != plane_id:
        raise HTTPException(status_code=404, detail="Text field not found")
    session.delete(field)
    session.commit()
    return {"ok": True}


# ── Collections ──────────────────────────────────────────────────────────────


@router.post("/{plane_id}/collections", response_model=DataCollectionPublic)
def create_collection(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    plane_id: uuid.UUID,
    collection_in: DataCollectionCreate,
) -> Any:
    _owned_plane(session, current_user, plane_id)
    return crud.create_collection(
        session=session, collection_in=collection_in, plane_id=plane_id
    )


@router.put(
    "/{plane_id}/collections/{collection_id}", response_model=DataCollectionPublic
)
def update_collection(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    plane_id: uuid.UUID,
    collection_id: uuid.UUID,
    collection_in: DataCollectionUpdate,
) -> Any:
    _owned_plane(session, current_user, plane_id)
    collection = session.get(DataCollection, collection_id)
    if not collection or collection.plane_id != plane_id:
        raise HTTPException(status_code=404, detail="Collection not found")
    return crud.update_collection(
        session=session, db_collection=collection, collection_in=collection_in
    )


@router.delete("/{plane_id}/collections/{collection_id}")
def delete_collection(
    session: SessionDep,
    current_user: CurrentUser,
    plane_id: uuid.UUID,
    collection_id: uuid.UUID,
) -> Any:
    _owned_plane(session, current_user, plane_id)
    collection = session.get(DataCollection, collection_id)
    if not collection or collection.plane_id != plane_id:
        raise HTTPException(status_code=404, detail="Collection not found")
    session.delete(collection)
    session.commit()
    return {"ok": True}


# ── Bulk canvas-element replace (used by the frontend snapshot sync) ─────────
#
# Each endpoint replaces the entire canvas-element collection of a plane in one
# transaction. Client-supplied UUIDs are honoured so element identity is stable
# across saves. Collections are replaced first by the frontend, before it sets
# the collection_id FK on member entities.


@router.put("/{plane_id}/sticky-notes", response_model=list[StickyNotePublic])
def replace_sticky_notes(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    plane_id: uuid.UUID,
    body: list[StickyNoteCreate],
) -> Any:
    """Replace all sticky notes of a plane."""
    plane = _owned_plane(session, current_user, plane_id)
    for note in list(plane.sticky_notes):
        session.delete(note)
    session.flush()
    created = [StickyNote(**n.model_dump(), plane_id=plane_id) for n in body]
    for note in created:
        session.add(note)
    session.commit()
    for note in created:
        session.refresh(note)
    return created


@router.put("/{plane_id}/text-fields", response_model=list[TextFieldPublic])
def replace_text_fields(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    plane_id: uuid.UUID,
    body: list[TextFieldCreate],
) -> Any:
    """Replace all text fields of a plane."""
    plane = _owned_plane(session, current_user, plane_id)
    for field in list(plane.text_fields):
        session.delete(field)
    session.flush()
    created = [TextField(**f.model_dump(), plane_id=plane_id) for f in body]
    for field in created:
        session.add(field)
    session.commit()
    for field in created:
        session.refresh(field)
    return created


def _adoptable_collection(
    session: SessionDep, current_user: CurrentUser, collection_id: uuid.UUID
) -> DataCollection | None:
    """An existing collection row of the caller's, living on another plane."""
    collection = session.get(DataCollection, collection_id)
    if collection is None:
        return None
    plane = session.get(Plane, collection.plane_id)
    if plane is None or not _has_plane_access(plane, current_user):
        return None
    return collection


@router.put("/{plane_id}/collections", response_model=list[DataCollectionPublic])
def replace_collections(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    plane_id: uuid.UUID,
    body: list[DataCollectionCreate],
) -> Any:
    """Reconcile the data collections of a plane against the request body.

    This is an **in-place diff**, never a delete-and-recreate: a collection id
    present in both the DB and the body is UPDATED. Deleting and re-inserting a
    row under the same id would ``SET NULL`` the ``collection_id`` of every
    member entity (processes/experiments/results/analyses), silently unplacing
    anything the client did not re-upsert in the same save — the corruption that
    made Trash restore lose its placement (see docs/plans/trash-restore-fix.md).

    Trashed collections are preserved (neither updated nor deleted) so they stay
    restorable, and rows genuinely dropped from the body are deleted.
    """
    plane = _owned_plane(session, current_user, plane_id)
    trashed_ids = set(
        session.exec(
            select(TrashEntry.entity_id).where(
                TrashEntry.owner_id == current_user.id,
                TrashEntry.entity_type == "collection",
            )
        ).all()
    )
    existing = {c.id: c for c in plane.collections}
    body_by_id = {c.id: c for c in body if c.id not in trashed_ids}

    # Rows only in the DB (and not trashed) were removed by the client.
    for cid, collection in existing.items():
        if cid not in body_by_id and cid not in trashed_ids:
            session.delete(collection)

    out: list[DataCollection] = []
    for cid, payload in body_by_id.items():
        # A row may already live on another of the caller's planes (a restore
        # re-homed it): adopt it rather than colliding on its primary key.
        found: DataCollection | None = existing.get(cid) or _adoptable_collection(
            session, current_user, cid
        )
        if found is None:
            found = DataCollection(**payload.model_dump(), plane_id=plane_id)
        else:
            for field, value in payload.model_dump(exclude={"id"}).items():
                setattr(found, field, value)
            found.plane_id = plane_id
        session.add(found)
        out.append(found)

    session.commit()
    for collection in out:
        session.refresh(collection)
    return out
