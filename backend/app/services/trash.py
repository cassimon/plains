"""Soft-delete (trash) service.

A trashed entity keeps its row; a `TrashEntry` just flags its id. Deleting
cascades DOWN (process → experiments → results); restoring cascades UP
(result → experiment → process). Finished NOMAD uploads
(`ExperimentResults.has_completed_upload`) are never trashed — the caller
(frontend) detaches and surfaces them instead.

Placement on the canvas (which plane/collection a restored entity lands on) IS
decided here: ``restore`` re-attaches the whole dependency branch server-side so
a plain ``/state/bulk`` reload renders it, with no client-side placement writes.
The client only picks a destination plane when the original one is gone, and
nudges freshly created collections onto a free grid cell (cosmetic). Restore used
to be a client concern; that is what made it lose placement — see
``docs/plans/trash-restore-fix.md``.
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
) -> list[tuple[str, uuid.UUID]]:
    """Trash an entity and its downward closure. Finished uploads are skipped.

    Idempotent: re-trashing an already-trashed id is a no-op for that id.

    Returns **every** (entity_type, entity_id) now trashed as part of this
    cascade — including ids that were already trashed — so the caller can prune
    exactly those from its local state. (Callers need the closure, not just the
    rows this call happened to insert.)
    """
    model = MODEL_BY_TYPE[entity_type]
    obj = session.get(model, entity_id)
    if not obj:
        return []
    batch: list[tuple[str, uuid.UUID]] = []
    created: list[TrashEntry] = []
    for t, o in downward_closure(session, entity_type, obj):
        if is_finished_upload(o):
            continue
        batch.append((t, o.id))
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
    return batch


def restore(
    session: Session,
    user: User,
    entity_type: str,
    entity_id: uuid.UUID,
    destination_plane_id: uuid.UUID | None = None,
    destination_collection_id: uuid.UUID | None = None,
) -> list[TrashRestoredItem]:
    """Un-trash a deletion root along with its whole batch, **atomically
    re-attaching the dependency branch it came from**.

    Restoring the root brings back everything that was trashed together with it
    (its downward closure, recorded via ``root_entity_id`` at delete time) so a
    plane/collection revives all its contents at once. The upward closure is
    also cleared so a restored child always has the ancestors it needs.

    Placement is decided here, not on the client: a plain ``/state/bulk`` reload
    must render the restored branch with zero client-side placement writes. The
    ladder per restored entity is

    1. its original collection is alive (or coming back in this batch) → re-point;
    2. the collection is gone but its plane is alive → a ``"Restored: <root>"``
       collection is created on that plane (once per plane per call);
    3. the plane is gone too and ``destination_plane_id`` is given → restored
       collection rows are re-homed onto it (keeping their identity, name and
       members), loose entities land in a ``"Restored: <root>"`` collection there;
    4. otherwise → left unplaced with ``needs_placement=True``.

    Entities that carried no placement before being trashed stay unplaced.
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

    root_entry = _existing_entry(session, user, entity_type, entity_id)
    ctx = _Placement(
        session=session,
        user=user,
        leaving=leaving,
        destination_plane_id=destination_plane_id,
        destination_collection_id=destination_collection_id,
        root_name=root_entry.name if root_entry else _entity_name(entity_type, obj),
    )

    # Pass 1: collections first, so the entities that live in them (pass 2) see
    # a collection that already sits on a live plane.
    fixups: dict[uuid.UUID, bool] = {}
    for entry in entries:
        if entry.entity_type != "collection":
            continue
        coll = session.get(DataCollection, entry.entity_id)
        if coll is not None:
            fixups[entry.entity_id] = ctx.rehome_collection(coll)

    # Pass 2: everything that carries a collection_id / plane_id.
    placeable_types = {t for t, _ in _PLACEABLE}
    restored: list[TrashRestoredItem] = []
    for entry in entries:
        emodel = MODEL_BY_TYPE.get(entry.entity_type)
        eobj = session.get(emodel, entry.entity_id) if emodel else None
        needs_placement = False
        position_fixup = fixups.get(entry.entity_id, False)
        if eobj is not None and entry.entity_type in placeable_types:
            needs_placement, position_fixup = ctx.reattach(entry, eobj)
        restored.append(
            TrashRestoredItem(
                entity_type=entry.entity_type,
                entity_id=entry.entity_id,
                plane_id=getattr(eobj, "plane_id", None) if eobj else None,
                collection_id=getattr(eobj, "collection_id", None) if eobj else None,
                original_plane_id=entry.original_plane_id,
                original_collection_id=entry.original_collection_id,
                needs_placement=needs_placement,
                position_fixup=position_fixup,
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


class _Placement:
    """Per-restore-call placement authority (the ladder in ``restore``).

    Holds the lazily-created ``"Restored: <root>"`` collections so one restore
    never scatters its items across several new buckets on the same plane.
    """

    def __init__(
        self,
        session: Session,
        user: User,
        leaving: set[tuple[str, uuid.UUID]],
        destination_plane_id: uuid.UUID | None,
        destination_collection_id: uuid.UUID | None,
        root_name: str,
    ) -> None:
        self.session = session
        self.user = user
        self.leaving = leaving
        self.destination_plane_id = destination_plane_id
        self.destination_collection_id = destination_collection_id
        self.root_name = root_name
        self._buckets: dict[uuid.UUID, DataCollection] = {}

    # ── availability ─────────────────────────────────────────────────────────

    def plane_available(self, plane_id: uuid.UUID | None) -> bool:
        if plane_id is None:
            return False
        plane = self.session.get(Plane, plane_id)
        return plane is not None and not _is_trashed(
            self.session, self.user, "plane", plane_id, self.leaving
        )

    def collection_available(self, coll_id: uuid.UUID | None) -> DataCollection | None:
        """The collection, iff it exists, is not trashed, and sits on a live plane."""
        if coll_id is None:
            return None
        coll = self.session.get(DataCollection, coll_id)
        if coll is None:
            return None
        if _is_trashed(self.session, self.user, "collection", coll_id, self.leaving):
            return None
        return coll if self.plane_available(coll.plane_id) else None

    def destination(self) -> uuid.UUID | None:
        return (
            self.destination_plane_id
            if self.plane_available(self.destination_plane_id)
            else None
        )

    # ── placement ────────────────────────────────────────────────────────────

    def bucket_for(self, plane_id: uuid.UUID) -> DataCollection:
        """The (lazily created) "Restored: <root>" collection on a given plane.

        Parked on the ``0,0`` sentinel cell; the client moves it to a free cell
        as a purely cosmetic fixup (``position_fixup``).
        """
        existing = self._buckets.get(plane_id)
        if existing is not None:
            return existing
        coll = DataCollection(
            plane_id=plane_id,
            i=0,
            j=0,
            name=f"Restored: {self.root_name}"[:255],
        )
        self.session.add(coll)
        self.session.flush()
        self._buckets[plane_id] = coll
        return coll

    def rehome_collection(self, coll: DataCollection) -> bool:
        """Make sure a restored collection sits on a live plane.

        Keeps the row's identity (id, name, members) — re-homing beats dumping
        its members into an anonymous bucket. Returns True when its grid
        position needs a client-side fixup (it may collide on the new plane).
        """
        if self.plane_available(coll.plane_id):
            return False
        dest = self.destination()
        if dest is None:
            return False  # nowhere to go; members fall through to needs_placement
        coll.plane_id = dest
        self.session.add(coll)
        return True

    def reattach(self, entry: TrashEntry, eobj: Any) -> tuple[bool, bool]:
        """Place one restored entity. Returns (needs_placement, position_fixup)."""
        # It was never on a canvas — restoring must not invent a placement.
        if entry.original_plane_id is None and entry.original_collection_id is None:
            return False, False

        # 1. Original collection alive (or coming back with us).
        coll = self.collection_available(entry.original_collection_id)
        if coll is not None:
            eobj.collection_id = coll.id
            eobj.plane_id = coll.plane_id
            self.session.add(eobj)
            return False, False

        # 2/3. Collection gone → a "Restored: …" bucket on the original plane if
        # it survives, else on the destination plane the user picked.
        target_plane = (
            entry.original_plane_id
            if self.plane_available(entry.original_plane_id)
            else self.destination()
        )
        if target_plane is not None:
            explicit = self.collection_available(self.destination_collection_id)
            bucket = (
                explicit
                if explicit is not None and explicit.plane_id == target_plane
                else self.bucket_for(target_plane)
            )
            eobj.collection_id = bucket.id
            eobj.plane_id = bucket.plane_id
            self.session.add(eobj)
            return False, explicit is None

        # 4. Nowhere to go — the frontend must prompt for a destination plane.
        eobj.collection_id = None
        eobj.plane_id = None
        self.session.add(eobj)
        return True, False


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
