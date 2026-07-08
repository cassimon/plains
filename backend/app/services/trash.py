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
    TrashEntryPublic,
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
            rows = session.exec(select(model).where(model.collection_id == obj.id)).all()
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
    seen: dict[tuple[str, uuid.UUID], tuple[str, Any]] = {(entity_type, obj.id): (entity_type, obj)}
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
        )
        session.add(entry)
        created.append(entry)
    session.commit()
    for entry in created:
        session.refresh(entry)
    return created


def restore(
    session: Session, user: User, entity_type: str, entity_id: uuid.UUID
) -> list[TrashEntryPublic]:
    """Un-trash an entity and its upward closure (ancestors it needs)."""
    targets: set[tuple[str, uuid.UUID]] = {(entity_type, entity_id)}
    model = MODEL_BY_TYPE.get(entity_type)
    obj = session.get(model, entity_id) if model else None
    if obj:
        for t, o in upward_closure(session, entity_type, obj):
            targets.add((t, o.id))
    removed: list[TrashEntryPublic] = []
    for t, eid in targets:
        entry = _existing_entry(session, user, t, eid)
        if entry:
            removed.append(TrashEntryPublic.model_validate(entry))
            session.delete(entry)
    session.commit()
    return removed


def purge(
    session: Session, user: User, entity_type: str, entity_id: uuid.UUID
) -> None:
    """Permanently delete a single trashed entity (cascades) + its trash row."""
    entry = _existing_entry(session, user, entity_type, entity_id)
    model = MODEL_BY_TYPE.get(entity_type)
    obj = session.get(model, entity_id) if model else None
    if obj is not None:
        session.delete(obj)
    if entry is not None:
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


def list_trash(session: Session, user: User) -> list[TrashEntry]:
    return list(
        session.exec(
            select(TrashEntry)
            .where(TrashEntry.owner_id == user.id)
            .order_by(col(TrashEntry.deleted_at).desc())
        ).all()
    )
