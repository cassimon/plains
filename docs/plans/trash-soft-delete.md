# Trash Can / Soft-Delete — Implementation Plan

## Problem statement

1. **Plane deletes don't stick.** Deleting a plane in the Organization flow is not
   reliably synced to the DB and the plane can reappear. Root cause: top-level deletion
   is *diff-based* — `HttpBackend.syncToBackend()` (`frontend/src/store/backend.ts`)
   computes deletions by diffing `serverIds` against the current snapshot and issues hard
   `DELETE`s. With two sessions / a stale `serverIds` this races and resurrects rows
   (same delete-reconciliation race already flagged in `CLAUDE.md`).
2. **Planes can't be deleted from the Organization page** (no wired delete action).
3. **All deletion is permanent and unintuitive.** There is no undo.

## Goal

Introduce a **soft-delete "Trash"**: deleting anything moves it to a trash table (row kept,
flagged). Users get a **Trash page** (sidebar icon pinned to the bottom, always visible) to
**restore**, **permanently delete single items**, or **empty** the trash. A **login-time
sweep** hard-deletes trash entries older than **one month**. Deleted items must **never**
appear in any picker/list, via **one universal filter** at the most general level.

---

## Confirmed decisions (from product owner)

- **Trashable now:** Planes, Collections, Experiments, Processes. **Analyses:** trashable
  *later* (design the registry to include it, wire the UI when ready).
- **Folders are NOT trashable** and keep current behaviour: deleting a folder only
  un-groups its planes (`folder_id → NULL`), never deletes sub-planes. (Leave
  `plane_folders.py` delete + `deleteFolder` untouched.)
- **Delete cascades DOWN** (process → its experiments → their results); **restore cascades
  UP** (result → experiment → process — "reinstate upward").
- **Finished uploads are not trashable.** A "finished upload" = an `ExperimentResults` with
  `hasCompletedUpload === true` (`has_completed_upload` server-side). They are never sent to
  trash. When their container (plane / experiment) is trashed they are **kept alive** and
  surfaced in a **general list (with links) on the Organization/overview page**.
- **Trashing a plane that contains finished uploads** must **warn the user** and offer a
  choice: *really trash* vs *shift the uploads (and all dependent elements) to another
  plane*. On shift, place them on **FREE fields** of the target plane.
- **Placement uses the existing free-field packer.** Restoring a single item or shifting
  items onto a plane must place them on free grid cells, and every restored/shifted item
  **must belong to a collection**. Reuse the collection-division free-field logic
  (`firstFreeSpanCell` / `nextFreeCell` / `occupiedCellKeys` in `Organization.page.tsx`).
- **Restore target:** a single destination plane for the whole restore set.

---

## Crucial architecture fact: placement lives in the FRONTEND as collection refs

On the canvas, an entity's "location" is **not** primarily its backend `plane_id`/
`collection_id`. It is a **ref inside a collection element**:
`CanvasCollectionElement.refs: { kind: process|experiment|result|analysis, id }[]`
(`AppContext.tsx`). `backendMapping` then derives each entity's `plane_id`/`collection_id`
from which collection ref contains it (`derivePlacement`).

**Consequence:** the "shift to another plane / place on free fields / must belong to a
collection" behaviour is implemented by manipulating **collection refs on the frontend**
(reusing `moveRefsToNewCollection` / `copyRefsToNewCollection` / `addCollectionElement` +
the free-field packer), which then syncs down to `plane_id`/`collection_id`. The backend
trash table only tracks *which ids are trashed*; it does not compute canvas placement.

---

## Key design decisions

### D1 — Separate trash table, entity rows stay put
`trash_entry (entity_type, entity_id, owner_id, name, deleted_at, original_plane_id)`. The
real row stays in its table; existing cascade FKs remain valid. Restore = delete the trash
row. Purge/empty/TTL-sweep call `session.delete(entity)` so cascades clean up children.
Matches the user's "set of deleted IDs" idea.

### D2 — Universal filter is SERVER-SIDE at query level
`/state/bulk` (the single login bootstrap) and the list routes exclude ids present in
`trash_entry`. Because the loaded snapshot already omits trashed rows, **no existing
picker/choice-list changes** — they read from `AppContext`, which never contains trashed
items. Implemented once via a shared helper (W2). This is the "most general level."

### D3 — Deletion becomes EXPLICIT, killing the diff-delete
Stop diff-deleting top-level entities in `syncToBackend`; a delete action calls the new
`POST /trash/` directly and drops the row locally. Fixes **bug #1** (no more racy
resurrection) and **bug #2** (wire the Organization plane delete). Plane-scoped child
replaces (`PUT /planes/{id}/collections|sticky-notes|text-fields`) stay.

### D4 — Cascade down on delete, up on restore, **protecting finished uploads**
- Delete process → also trash its experiments → their results, **except** any result with
  `has_completed_upload=true`, which is detached and kept alive (see D6).
- Restore result → also restore its experiment and process.

### D5 — Collections are trashable (members cascade)
A collection = a `DataCollection` grid element with refs. Trashing a collection trashes the
grid element **and cascades to its referenced entities** (down-cascade, finished uploads
protected). Restoring a collection restores it + brings its refs' entities back onto a plane
(free-field placement).

### D6 — Finished-upload protection & surfacing
When a cascade would trash a finished upload, instead:
1. do **not** create a trash entry for it;
2. detach it from the trashed container (its collection ref is removed from the dead plane);
3. surface it in the **Organization overview "Finished uploads" list** (name + link to
   `/results`), so it is never lost.
For an explicit **plane** trash containing finished uploads, prompt first (warn + trash-vs-shift).

---

## Data model (backend) — `backend/app/models.py`

```python
class TrashEntry(SQLModel, table=True):
    __tablename__ = "trash_entry"
    __table_args__ = (UniqueConstraint("entity_type", "entity_id"),)
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    owner_id: uuid.UUID = Field(foreign_key="user.id", nullable=False,
                                ondelete="CASCADE", index=True)
    entity_type: str = Field(max_length=32, index=True)   # process|experiment|result|analysis|plane|collection
    entity_id: uuid.UUID = Field(index=True)
    name: str = Field(default="", max_length=255)          # denormalised for the list
    original_plane_id: uuid.UUID | None = None             # drives the plane-exception prompt
    deleted_at: datetime = Field(default_factory=get_datetime_utc,
                                 sa_type=DateTime(timezone=True), index=True)

class TrashEntryPublic(SQLModel):
    entity_type: str
    entity_id: uuid.UUID
    name: str
    deleted_at: datetime

class TrashListPublic(SQLModel):
    data: list[TrashEntryPublic]
    count: int
```

`entity_id` is intentionally not a FK (spans tables), mirroring `NomadUploadLog`. Created by
`SQLModel.metadata.create_all` in `init_db()`.

---

## Workstreams

### W0 — Extract the free-field packer into a shared lib
Move `occupiedCellKeys` / `spanFits` / `firstFreeSpanCell` / `nextFreeCell` (currently
module-local in `Organization.page.tsx`) into `frontend/src/lib/gridPacking.ts` and import
them back. The trash restore/shift flows (W5) reuse them so items land on free cells.

### W1 — Trash service + routes (backend)
`backend/app/services/trash.py` + `backend/app/api/routes/trash.py` (register in
`api/main.py`). Registry maps type → model so cascade is table-agnostic:
`{"process": Process, "experiment": Experiment, "result": ExperimentResults,
"analysis": Analysis, "plane": Plane, "collection": DataCollection}`.

| Method & path | Purpose |
|---|---|
| `GET  /trash/` | List trashed entries (Name, Deletion date); runs the TTL sweep opportunistically (W4). |
| `POST /trash/` | Soft-delete `{entity_type, entity_id}` + **down-closure**, skipping finished uploads. Record `original_plane_id`. |
| `POST /trash/restore` | Restore `{entity_type, entity_id}` + **up-closure**. Returns the restored ids so the frontend can re-place them (W5). |
| `POST /trash/{type}/{id}/purge` | Permanent single delete: `session.delete(entity)` + drop trash row. |
| `POST /trash/empty` | Permanent delete of all trashed items for the user (behind the warning). |

Cascade helpers: `downward_closure`, `upward_closure`, `is_finished_upload(result)`. All
owner/superuser scoped per the `materials.py` pattern. Note the backend does **not** set
`plane_id`/`collection_id` on restore — placement is the frontend's job (see the crucial
fact above); backend restore only removes trash rows.

### W2 — Universal server-side filter + ownership centralisation
`backend/app/api/query.py`:
```python
def visible(statement, model, user, session, *, entity_type):
    if not user.is_superuser:
        statement = statement.where(model.owner_id == user.id)
    sub = select(TrashEntry.entity_id).where(TrashEntry.entity_type == entity_type,
                                             TrashEntry.owner_id == user.id)
    return statement.where(col(model.id).not_in(sub))
```
- **Answer to the second question:** owner-filtering is already API-level but *duplicated*
  in every `read_*` route. Since the trash exclusion needs the same injection point, fold
  both into `visible()`. Adopt in `get_bulk_state()` first (the only login-critical path),
  then opportunistically in the per-entity list routes. Planes keep their share-join.
- Collections are filtered where they are emitted (inside `_populate(plane)` /
  `PlanePublic.collections`): drop collection elements whose id is in the collection trash set.

### W3 — Convert deletion to soft-delete + neutralise diff-delete (frontend)
`frontend/src/store/backend.ts`:
- Remove the top-level `deleteRemoved(...)` calls from `syncToBackend` (keep plane-scoped
  replaces). This alone stops the resurrection bug.
- Add adapter methods `softDelete(type,id)`, `restore(type,id)`, `purge(type,id)`,
  `emptyTrash()`, `getTrash()`.

`frontend/src/store/AppContext.tsx`:
- Hold `deletedIds: Set<string>` + `trashEntries` (loaded on login).
- Rewrite `deletePlane`/`deleteProcess`/`deleteExperiment`/`deleteResults`/collection-delete
  to: run the pre-checks (finished-upload prompt for planes, W5), call `backend.softDelete`,
  add id(s) to `deletedIds`, remove from local arrays / strip collection refs. Keep the
  last-plane guard. Leave `deleteFolder` unchanged (folders not trashable).
- Expose `filterOutDeleted(list) = list.filter(x => !deletedIds.has(x.id))` as the single
  client-side choke point (optimistic hiding between the click and the next reload; the
  server snapshot is already filtered).

### W4 — Login-time TTL sweep (backend)
`sweep_expired_trash(session, user)`: for entries with `deleted_at < now-30d`, `session.delete`
the entity (cascades) + the trash row. Called from `GET /trash/` and `GET /state/bulk`
(runs once per login) — **not** from `get_current_user` (per-request). `TRASH_TTL_DAYS`
config (default 30).

### W5 — Placement-aware flows (frontend, the hard part)

**Trash a plane (with finished-upload guard).** In the Organization delete handler:
1. If the plane has finished uploads (any `result` ref whose result `hasCompletedUpload`),
   open a modal: **"This plane has finished uploads. Trash anyway, or move them to another
   plane?"** (Mantine `modals`).
   - *Move*: pick a target plane; for the finished uploads **and their dependent elements**,
     `moveRefsToNewCollection` into a new collection on the target plane, positioned with
     `firstFreeSpanCell` (free fields). Then trash the (now upload-free) plane.
   - *Trash anyway*: detach finished uploads (remove their refs), surface them in the
     overview "Finished uploads" list, then trash the plane and its remaining members.
2. No finished uploads → trash directly (down-cascade).

**Restore a single item (plane exception).** From the Trash page:
1. Call `restore(type,id)`; backend removes trash rows (item + up-closure) and returns the ids.
2. Frontend places each restored entity onto a **destination plane** (single picker if the
   original plane is gone/trashed; otherwise its original plane): create/choose a collection
   and add the entity's ref, positioning the collection via the free-field packer. Restored
   items **must belong to a collection** (per requirement).
3. Sync writes the derived `plane_id`/`collection_id`.

### W6 — Trash page + sidebar icon + overview list (frontend)
- **Sidebar:** in `AppLayout.tsx` the navbar is `<Stack align="center" justify="top">`
  mapping `pages`. Add a pinned trash `ActionIcon` after the map, pushed down with a spacer
  (`marginTop:auto`). Route `/trash`; add the icon in `AppLayout.icons.tsx`. Keep it OUT of
  the `pages` array (so collection-dimming ignores it).
- **Route:** `routes/Trash.page.tsx` + `_gui/trash.tsx`; run `bun run generate-routes`.
- **Table:** columns **Name**, **Deletion date** (reuse `Common/DataTable.tsx`); row actions
  Restore / Delete-permanently (confirm); header **Empty trash** (confirm w/ strong warning).
  Show explanatory text about the plane-exception behaviour.
- **Overview "Finished uploads" list:** on `Organization.page.tsx`, a list of finished
  uploads (name + link to `/results`), so detached uploads are always reachable.

### W7 — Tests
- **Backend** (`tests/api/routes/test_trash.py`): soft-delete hides from `/state/bulk`;
  restore up-closure (restore result → experiment+process return); down-cascade on process;
  finished upload is never trashed by a cascade; TTL sweep; purge/empty cascade.
- **Frontend integration** (real-stack harness, run serially — see `CLAUDE.md`): delete a
  plane → gone after reload (regression for bug #1); delete process → disappears from the
  Experiment process-picker; restore round-trip lands item on a free cell in a collection;
  plane-with-finished-uploads trash prompt → move places uploads on free fields.

---

## Rollout order
1. W0 extract packer; W1 model + `create_all`.
2. W2 `visible()` + `/state/bulk` (filtering live; nothing trashed yet → no behaviour change).
3. W1 routes + W4 sweep.
4. **W3 + W5 together** (frontend delete rewire) — must ship WITH W2, else a trashed item,
   now absent from `/state/bulk`, would look "removed" to the old diff-delete and get
   hard-deleted.
5. W6 Trash page + sidebar + overview list.
6. W7 tests throughout.

---

## Resolved (was open)
- **Collection trash semantics:** trashing a collection **pulls its member entities** into
  trash (down-cascade, finished uploads protected). Restore brings them back. (D5)
- **Finished uploads in the trash view:** the Trash page **also shows** detached finished
  uploads as **read-only "kept alive" rows with a link** to `/results`, in addition to the
  Organization overview "Finished uploads" list. They cannot be restored/purged from here.
- **Analyses:** **registry-ready but UI disabled** for now — backend `TRASHABLE` includes
  `"analysis"` and the closures handle it, but the Analyses page exposes no trash/restore
  action yet. Flip on later with no schema change.
