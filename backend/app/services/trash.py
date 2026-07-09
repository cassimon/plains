"""Soft-delete (trash) service.

A trashed entity keeps its row; a `TrashEntry` just flags its id. Deleting
cascades DOWN (process → experiments → results); restoring cascades UP
(result → experiment → process). Finished NOMAD uploads
(`ExperimentResults.has_completed_upload`) are never trashed — the caller
(frontend) detaches and surfaces them instead.

Placement on the canvas (which plane/collection a restored entity lands on) is
NOT decided here — that lives in the frontend collection-ref layer. This module
only tracks which ids are trashed and applies the dependency closures.
"""

import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlmodel import Session, col, select

from app.core.config import settings
from app.models import (
    Analysis,
    AnalysisRef,
    DataCollection,
    Experiment,
    ExperimentResults,
    Plane,
    Process,
    TrashEntry,
    TrashRestoredItem,
    TrashRootPublic,
    User,
)

# entity_type → table model. Analysis is registry-ready but the UI keeps it
# disabled for now (see docs/plans/trash-soft-delete.md).
MODEL_BY_TYPE: dict[str, Any] = {
    "process": Process,
    "experiment": Experiment,
    "result": ExperimentResults,
    "analysis": Analysis,
    "plane": Plane,
    "collection": DataCollection,
}

# Entity types that carry a collection_id / plane_id and can be grouped on a plane.
_PLACEABLE = (
    ("process", Process),
    ("experiment", Experiment),
    ("result", ExperimentResults),
    ("analysis", Analysis),
)

_ANALYSIS_REF_KIND_TO_TYPE = {
    "process": "process",
    "experiment": "experiment",
    "result": "result",
    "analysis": "analysis",
}


def is_finished_upload(obj: Any) -> bool:
    """A results row that carries a completed NOMAD upload — never trashed.

    On the backend a finished upload is a result with a NOMAD upload id whose
    status is SUCCESS (the experiment-level ``has_completed_upload`` flag is a
    separate, per-experiment marker and does not live on the results row).
    """
    return (
        isinstance(obj, ExperimentResults)
        and obj.nomad_upload_id is not None
        and (obj.nomad_upload_status or "").upper() == "SUCCESS"
    )


def _entity_name(entity_type: str, obj: Any) -> str:
    name = getattr(obj, "name", None)
    if name:
        return str(name)[:255]
    if entity_type == "result":
        return "Results"
    return f"{entity_type} {str(obj.id)[:8]}"


# ── Dependency closures ──────────────────────────────────────────────────────


def _children(session: Session, entity_type: str, obj: Any) -> list[tuple[str, Any]]:
    """Direct downward dependents of one entity."""
    if entity_type == "process":
        exps = session.exec(
            select(Experiment).where(Experiment.process_id == obj.id)
        ).all()
        return [("experiment", e) for e in exps]
    if entity_type == "experiment":
        res = session.exec(
            select(ExperimentResults).where(ExperimentResults.experiment_id == obj.id)
        ).all()
        return [("result", r) for r in res]
    if entity_type == "collection":
        out: list[tuple[str, Any]] = []
        for t, model in _PLACEABLE:
            rows = session.exec(
                select(model).where(model.collection_id == obj.id)
            ).all()
            out += [(t, r) for r in rows]
        return out
    if entity_type == "plane":
        out = []
        for t, model in _PLACEABLE:
            rows = session.exec(select(model).where(model.plane_id == obj.id)).all()
            out += [(t, r) for r in rows]
        cols = session.exec(
            select(DataCollection).where(DataCollection.plane_id == obj.id)
        ).all()
        out += [("collection", c) for c in cols]
        return out
    return []


def _parents(session: Session, entity_type: str, obj: Any) -> list[tuple[str, Any]]:
    """Direct upward dependencies an entity needs to be valid."""
    if entity_type == "result" and obj.experiment_id:
        exp = session.get(Experiment, obj.experiment_id)
        return [("experiment", exp)] if exp else []
    if entity_type == "experiment" and obj.process_id:
        proc = session.get(Process, obj.process_id)
        return [("process", proc)] if proc else []
    if entity_type == "analysis":
        out: list[tuple[str, Any]] = []
        refs = session.exec(
            select(AnalysisRef).where(AnalysisRef.analysis_id == obj.id)
        ).all()
        for ref in refs:
            t = _ANALYSIS_REF_KIND_TO_TYPE.get(ref.kind)
            model = MODEL_BY_TYPE.get(t) if t else None
            if t is None or model is None:
                continue
            target = session.get(model, ref.entity_id)
            if target:
                out.append((t, target))
        return out
    return []


def _closure(
    session: Session,
    entity_type: str,
    obj: Any,
    edge_fn: Any,
) -> list[tuple[str, Any]]:
    """Breadth-first transitive closure over edge_fn, including the root."""
    seen: dict[tuple[str, uuid.UUID], tuple[str, Any]] = {
        (entity_type, obj.id): (entity_type, obj)
    }
    stack = [(entity_type, obj)]
    while stack:
        t, o = stack.pop()
        for nt, no in edge_fn(session, t, o):
            key = (nt, no.id)
            if key in seen:
                continue
            seen[key] = (nt, no)
            stack.append((nt, no))
    return list(seen.values())


def downward_closure(
    session: Session, entity_type: str, obj: Any
) -> list[tuple[str, Any]]:
    return _closure(session, entity_type, obj, _children)


def upward_closure(
    session: Session, entity_type: str, obj: Any
) -> list[tuple[str, Any]]:
    return _closure(session, entity_type, obj, _parents)


# ── Operations ───────────────────────────────────────────────────────────────


def _existing_entry(
    session: Session, user: User, entity_type: str, entity_id: uuid.UUID
) -> TrashEntry | None:
    return session.exec(
        select(TrashEntry).where(
            TrashEntry.owner_id == user.id,
            TrashEntry.entity_type == entity_type,
            TrashEntry.entity_id == entity_id,
        )
    ).first()


def soft_delete(
    session: Session, user: User, entity_type: str, entity_id: uuid.UUID
) -> list[TrashEntry]:
    """Trash an entity and its downward closure. Finished uploads are skipped.

    Idempotent: re-trashing an already-trashed id is a no-op for that id.
    """
    model = MODEL_BY_TYPE[entity_type]
    obj = session.get(model, entity_id)
    if not obj:
        return []
    created: list[TrashEntry] = []
    for t, o in downward_closure(session, entity_type, obj):
        if is_finished_upload(o):
            continue
        if _existing_entry(session, user, t, o.id):
            continue
        entry = TrashEntry(
            owner_id=user.id,
            entity_type=t,
            entity_id=o.id,
            name=_entity_name(t, o),
            original_plane_id=getattr(o, "plane_id", None),
            original_collection_id=getattr(o, "collection_id", None),
            # Every entry in this closure points back to the originally-deleted
            # root so the Trash page can list one row per user action.
            root_entity_type=entity_type,
            root_entity_id=entity_id,
        )
        session.add(entry)
        created.append(entry)
    session.commit()
    for entry in created:
        session.refresh(entry)
    return created


def restore(
    session: Session, user: User, entity_type: str, entity_id: uuid.UUID
) -> list[TrashRestoredItem]:
    """Un-trash a deletion root along with its whole batch.

    Restoring the root brings back everything that was trashed together with it
    (its downward closure, recorded via ``root_entity_id`` at delete time) so a
    plane/collection revives all its contents at once. The upward closure is
    also cleared so a restored child always has the ancestors it needs. Returns
    the restored entities with their current placement for canvas re-attachment.
    """
    entries = _batch_entries(session, user, entity_type, entity_id)

    # Also clear ancestors the (possibly child) target needs to be valid.
    model = MODEL_BY_TYPE.get(entity_type)
    obj = session.get(model, entity_id) if model else None
    if obj:
        for t, o in upward_closure(session, entity_type, obj):
            anc = _existing_entry(session, user, t, o.id)
            if anc and anc.id not in {e.id for e in entries}:
                entries.append(anc)

    # Ids leaving trash in this call — used to tell whether an original
    # container is itself being restored (so it counts as "available").
    leaving = {(e.entity_type, e.entity_id) for e in entries}

    restored: list[TrashRestoredItem] = []
    for entry in entries:
        emodel = MODEL_BY_TYPE.get(entry.entity_type)
        eobj = session.get(emodel, entry.entity_id) if emodel else None
        needs_placement = False
        if eobj is not None and entry.entity_type in {
            "process",
            "experiment",
            "result",
            "analysis",
        }:
            needs_placement = _reattach_placement(session, user, entry, eobj, leaving)
        restored.append(
            TrashRestoredItem(
                entity_type=entry.entity_type,
                entity_id=entry.entity_id,
                plane_id=getattr(eobj, "plane_id", None) if eobj else None,
                collection_id=getattr(eobj, "collection_id", None)
                if eobj
                else None,
                original_plane_id=entry.original_plane_id,
                original_collection_id=entry.original_collection_id,
                needs_placement=needs_placement,
            )
        )
        session.delete(entry)
    session.commit()
    return restored


def _is_trashed(
    session: Session,
    user: User,
    entity_type: str,
    entity_id: uuid.UUID,
    leaving: set[tuple[str, uuid.UUID]],
) -> bool:
    """True if the target is (still) trashed and not being restored right now."""
    if (entity_type, entity_id) in leaving:
        return False
    return _existing_entry(session, user, entity_type, entity_id) is not None


def _reattach_placement(
    session: Session,
    user: User,
    entry: TrashEntry,
    eobj: Any,
    leaving: set[tuple[str, uuid.UUID]],
) -> bool:
    """Restore the entity to where it was, if that place still exists.

    ``replace_collections`` nulls a member's ``collection_id`` while it is
    trashed, so we re-point it at its original collection/plane here. Returns
    True when the original home is gone/trashed and the frontend must ask the
    user for a new destination plane.
    """
    coll_id = entry.original_collection_id
    plane_id = entry.original_plane_id
    if coll_id is not None:
        coll = session.get(DataCollection, coll_id)
        if (
            coll is not None
            and not _is_trashed(session, user, "collection", coll_id, leaving)
            and _plane_available(session, user, coll.plane_id, leaving)
        ):
            eobj.collection_id = coll_id
            eobj.plane_id = coll.plane_id
            session.add(eobj)
            return False
    if plane_id is not None and _plane_available(session, user, plane_id, leaving):
        # Plane survives but the collection is gone — land on the plane; the
        # frontend will drop it into a (new) collection on free cells.
        eobj.plane_id = plane_id
        eobj.collection_id = None
        session.add(eobj)
        return True
    # Nowhere to go — frontend must prompt for a destination plane.
    return True


def _plane_available(
    session: Session,
    user: User,
    plane_id: uuid.UUID | None,
    leaving: set[tuple[str, uuid.UUID]],
) -> bool:
    if plane_id is None:
        return False
    plane = session.get(Plane, plane_id)
    return plane is not None and not _is_trashed(
        session, user, "plane", plane_id, leaving
    )


def _batch_entries(
    session: Session, user: User, entity_type: str, entity_id: uuid.UUID
) -> list[TrashEntry]:
    """All trash entries deleted together with this root (root + descendants).

    Falls back to just the single entry for legacy rows written before batch
    tracking existed (``root_entity_id is None``).
    """
    root = _existing_entry(session, user, entity_type, entity_id)
    batch = list(
        session.exec(
            select(TrashEntry).where(
                TrashEntry.owner_id == user.id,
                TrashEntry.root_entity_type == entity_type,
                TrashEntry.root_entity_id == entity_id,
            )
        ).all()
    )
    if root and root.id not in {e.id for e in batch}:
        batch.append(root)
    return batch


def purge(session: Session, user: User, entity_type: str, entity_id: uuid.UUID) -> None:
    """Permanently delete a trashed deletion root (cascades) + its batch rows.

    Deleting the root entity cascades to its children via DB FKs; we also drop
    every trash row in the batch so no orphaned flags remain.
    """
    batch = _batch_entries(session, user, entity_type, entity_id)
    model = MODEL_BY_TYPE.get(entity_type)
    obj = session.get(model, entity_id) if model else None
    if obj is not None:
        session.delete(obj)
    for entry in batch:
        session.delete(entry)
    session.commit()


def empty(session: Session, user: User) -> int:
    """Permanently delete everything in the user's trash. Returns the count."""
    entries = session.exec(
        select(TrashEntry).where(TrashEntry.owner_id == user.id)
    ).all()
    count = 0
    for entry in entries:
        model = MODEL_BY_TYPE.get(entry.entity_type)
        obj = session.get(model, entry.entity_id) if model else None
        if obj is not None:
            session.delete(obj)
        session.delete(entry)
        count += 1
    if count:
        session.commit()
    return count


def sweep_expired_trash(session: Session, user: User) -> int:
    """Hard-delete trash entries older than TRASH_TTL_DAYS (+ their entities).

    Called opportunistically from the login bootstrap; cheap thanks to the
    deleted_at / owner_id indexes. Returns the number of entries swept.
    """
    ttl_days = getattr(settings, "TRASH_TTL_DAYS", 30)
    cutoff = datetime.now(timezone.utc) - timedelta(days=ttl_days)
    stale = session.exec(
        select(TrashEntry).where(
            TrashEntry.owner_id == user.id,
            col(TrashEntry.deleted_at) < cutoff,
        )
    ).all()
    swept = 0
    for entry in stale:
        model = MODEL_BY_TYPE.get(entry.entity_type)
        obj = session.get(model, entry.entity_id) if model else None
        if obj is not None:
            session.delete(obj)
        session.delete(entry)
        swept += 1
    if swept:
        session.commit()
    return swept


# Human-readable, pluralised labels for the deletion-content summary.
_TYPE_PLURAL = {
    "process": ("process", "processes"),
    "experiment": ("experiment", "experiments"),
    "result": ("result", "results"),
    "analysis": ("analysis", "analyses"),
    "plane": ("plane", "planes"),
    "collection": ("collection", "collections"),
}

# Default ordering of categories on the Trash page (issue: sort by category).
_TYPE_ORDER = {t: i for i, t in enumerate(_TYPE_PLURAL)}


def _summarise(child_counts: dict[str, int]) -> str:
    parts = []
    for t in _TYPE_PLURAL:
        n = child_counts.get(t, 0)
        if n:
            singular, plural = _TYPE_PLURAL[t]
            parts.append(f"{n} {plural if n != 1 else singular}")
    return " · ".join(parts)


def list_roots(session: Session, user: User) -> list[TrashRootPublic]:
    """One row per deletion action (the root), each carrying a summary of the
    descendants trashed with it. Sorted by category, then most-recent first."""
    entries = session.exec(
        select(TrashEntry).where(TrashEntry.owner_id == user.id)
    ).all()

    # Group descendant counts by their root (type, id). Legacy rows without a
    # recorded root are treated as their own root.
    child_counts: dict[tuple[str, uuid.UUID], dict[str, int]] = {}
    roots: list[TrashEntry] = []
    for e in entries:
        root_key = (
            (e.root_entity_type, e.root_entity_id)
            if e.root_entity_id
            else (e.entity_type, e.entity_id)
        )
        is_root = (e.entity_type, e.entity_id) == root_key
        if is_root:
            roots.append(e)
        else:
            child_counts.setdefault(root_key, {})
            child_counts[root_key][e.entity_type] = (
                child_counts[root_key].get(e.entity_type, 0) + 1
            )

    out: list[TrashRootPublic] = []
    for e in roots:
        counts = child_counts.get((e.entity_type, e.entity_id), {})
        public = TrashRootPublic.model_validate(e)
        public.child_counts = counts
        public.child_count = sum(counts.values())
        public.summary = _summarise(counts)
        out.append(public)

    out.sort(
        key=lambda r: (
            _TYPE_ORDER.get(r.entity_type, 99),
            -r.deleted_at.timestamp(),
        )
    )
    return out
