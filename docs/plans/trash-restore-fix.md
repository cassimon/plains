# Trash Restore — Failure Analysis & Fix Plan (Increment 2, revised)

Builds on `docs/plans/trash-soft-delete.md` (Increment 1). Increment 1 shipped the trash
table, the down/up closures, the universal `visible()` filter, explicit `trashEntity`
delete handlers and the Trash page. **Deletion works; restore does not.** This document
analyses why restore fails, revises the design so it cannot fail the same way again, and
specifies the end-to-end equality tests that prove it.

## Symptoms (reported 2026-07-09)

- A trashed **collection** restores on the backend, but never reappears on its plane.
- Trashed **processes / experiments** restore, but do not return into their previous
  dependency branch (plane → collection → process → experiment); they float invisibly.
- Required behaviour (product owner): the Trash shows only the highest-level deleted
  object; restoring it restores all dependents **back into the previous dependency
  branch**; if that branch is gone (e.g. the containing plane was itself deleted), **ask
  the user** which plane/collection to place it on. Deleted objects must never appear in
  any list or selection proposal anywhere in the app.

---

## Failure analysis — why Increment 1's restore self-destructs

The backend restore (`app/services/trash.py::restore` + `_reattach_placement`) is
essentially correct: it clears the trash rows for the whole deletion batch and re-points
each entity's `collection_id`/`plane_id` at its original home when that home survives.
The frontend then destroys that work within the same user action. Four compounding flaws:

### F1 — `reloadFromBackend` flushes the *stale pre-restore snapshot* AFTER the restore

`AppContext.restoreTrash` (`AppContext.tsx:1593`) runs:

```
backend.restoreTrash(...)      // server state now correct
reloadFromBackend()            // ← but this FIRST does:
  dirtyRef.current = true
  await persistDirtyState()    // backend.save(stateRef.current)  ← STALE snapshot
  await backend.load()
```

`stateRef.current` still lacks the restored entities and the restored collection element
(they were removed from local state at delete time). So the flush pushes the pre-restore
world back to the server *after* the server was restored. The "flush so nothing is lost"
ordering is right for a plain reload, fatal for restore.

### F2 — `replace_collections` is delete-and-recreate, which SET-NULLs member FKs

`PUT /planes/{id}/collections` (`planes.py:458`) deletes **every** non-trashed
`DataCollection` row of the plane and recreates rows from the request body.
Two consequences during the F1 flush:

- **Restored collection:** its trash row is already gone (restore ran first), so it is no
  longer protected; it is not in the (stale) request body either → **the row is
  hard-deleted** and its members' `collection_id` is SET NULL. The restored collection is
  physically destroyed seconds after being restored.
- **Restored process/experiment/result:** even when its original collection *is* in the
  body (still on the canvas), delete-and-recreate of that collection row SET-NULLs
  `collection_id` of **all** members. Members present in the client snapshot get their FK
  re-written by their own upsert in sync steps 2–4 (`derivePlacement`); the just-restored
  entities are **not in the snapshot**, are never upserted, and stay `collection_id=NULL`.

Since `bulkToSnapshot` (`backendMapping.ts:76`) reconstructs canvas refs purely from the
entities' `collection_id` FKs, a NULLed FK = invisible on every plane, while the entity
still appears in flat lists. This is exactly the reported "restored but not in the
dependency structure".

### F3 — `needs_placement` gap: plane survives, collection gone → never placed

When only the collection is gone, `_reattach_placement` sets `plane_id`, returns
`needs_placement=True`, and expects the frontend to drop the item into a collection. But
the Trash page only opens the destination picker when the **original plane** is missing
from local state (`Trash.page.tsx:124-135`), and `AppContext.restoreTrash` only places
orphans **if a `destinationPlaneId` was passed** (`AppContext.tsx:1608`). Plane alive +
collection gone → no picker, no destination, `placeItemsOnPlane` never runs → the item is
restored but never joins any collection. (Canvas placement requires a collection ref;
a bare `plane_id` renders nothing.)

### F4 — debounce race

A pending debounced save (`scheduleSave`, 
`AppContext.tsx:1487`) can fire between `backend.restoreTrash()` and the state-setters in
`reloadFromBackend()` (timers run between awaits), pushing the stale snapshot even if F1
is fixed. The pending timer must be cancelled/flushed *before* the restore call.

### L — list/selection hygiene gaps (deleted objects still visible locally)

Server-side, `visible()` filters trashed rows out of `/state/bulk` — pickers that read
from `AppContext` arrays are clean **after a reload**. But between the delete click and
the next reload, local state diverges from the server's down-cascade:

- **L1** Deleting an **experiment** trashes its results server-side, but
  `handleDeleteExperiment` (`Experiments.page.tsx:3043`) only removes the experiment
  locally — its results stay in the local `results` array (Results page, upload flow)
  until the next full reload. Same class of gap for any cascade child not explicitly
  removed (the Organization collection delete removes only *directly ref'd* members,
  `Organization.page.tsx:1779` — results of member experiments that live in another
  collection are trashed server-side but survive locally).
- **L2** Selection state can keep pointing at trashed ids: `lastSelectedByKind`,
  `activeEntity`, page-local `selectedProcess`/`selectedExpId`, and the Experiments
  page's process picker if the array wasn't pruned.

### Root cause in one sentence

**Restore mutates placement on the server, but the client immediately re-asserts its
stale pre-restore world over it** (F1+F4), through an endpoint whose replace semantics
destroy FKs as collateral (F2), and the one case where the client *is* supposed to act
(F3) has no trigger.

---

## Revised design principle

> **Restore is atomic on the server. The client's job is only: flush real edits →
> restore → reload without flushing → cosmetic position fixup.**

Increment 1 already learned this lesson for *deletes* (flush first, then `POST /trash/`,
then prune local state). Restore gets the mirrored discipline. Concretely, the backend
becomes the single authority for re-attaching the dependency branch — including re-homing
a collection onto a user-chosen destination plane — so a plain `/state/bulk` reload
renders the restored branch with **zero** client-side placement writes in the common
path. Client-side placement (the fragile part) remains only for truly loose entities
that need a brand-new collection, and runs *after* the reload on clean state.

---

## Workstreams

### R1 (backend) — `replace_collections` becomes an in-place diff, never delete-and-recreate

`planes.py::replace_collections`: for ids present in both DB and body → **UPDATE** the
row (name, color, i/j) in place; ids only in body → INSERT; ids only in DB → DELETE
**unless trashed** (keep the existing protection). Same-id rows are never deleted, so
member `collection_id` FKs are never SET-NULLed by a routine canvas save.

This fixes F2 for *every* flow (restore, finished-upload detach, two-tab races), not just
this bug. Add a pytest asserting: members of a collection keep their `collection_id`
across a `PUT /planes/{id}/collections` that contains the same collection id.

### R2 (backend) — restore accepts a destination and re-homes server-side

- `TrashRestore` gains `destination_plane_id: uuid.UUID | None = None` (and, optional
  nicety, `destination_collection_id`).
- `trash.restore()` placement ladder, per restored item:
  1. Original collection alive (or leaving trash in this batch) and its plane available →
     re-point entity (current behaviour, keep).
  2. Original collection gone but original plane available → **create** (or reuse, once
     per restore call) a `DataCollection` named after the trash root (e.g.
     `"Restored: <root name>"`) on that plane, `i=j=0` sentinel, and point the entity at
     it. `needs_placement` now means only "position needs fixup", not "invisible".
  3. Original plane gone + `destination_plane_id` given →
     - restored **collection** rows: re-point `DataCollection.plane_id` to the
       destination (keeps identity, name and members — no more dumping members into an
       anonymous "Restored items" bucket);
     - loose entities: same as (2) but on the destination plane.
  4. Original plane gone + no destination → leave unplaced, return
     `needs_placement=True, plane_id=None` (frontend safety-net picker, R4).
- `TrashRestoredItem` gains `position_fixup: bool` so the client knows which collections
  landed on the `0,0` sentinel and need packing (R5).
- Down-cascade bookkeeping already records `original_collection_id` /
  `original_plane_id` per entry — unchanged.

Backend pytest can now verify the **entire** dependency-branch restoration without a
browser (see T-B below).

### R3 (frontend) — fix the restore call sequence (F1, F4)

`AppContext.restoreTrash` becomes:

```ts
// 1. Flush REAL pending edits and cancel the debounce timer.
if (saveTimeoutRef.current) { clearTimeout(saveTimeoutRef.current); saveTimeoutRef.current = null }
await persistDirtyState()                    // no forced dirty=true — only real edits
// 2. Server-atomic restore.
const restored = await backend.restoreTrash(type, id, destinationPlaneId)
// 3. Reload WITHOUT flushing (new option), clearing dirty state first.
await reloadFromBackend({ flush: false })
await refreshTrash()
// 4. Cosmetic fixup + safety net (R4/R5), then scheduleSave() only if something changed.
```

`reloadFromBackend(opts)`: the current forced `dirtyRef.current = true; await
persistDirtyState()` prelude runs only when `opts.flush !== false`; in all cases it
clears any pending timer and resets `dirtyRef` before applying the server snapshot, so a
queued stale save can never fire mid-restore.

### R4 (frontend) — destination picker driven by prediction + server truth (F3)

- **Prediction (before restore, keeps current UX):** show the plane picker when
  `entry.originalPlaneId` is null/absent from local `planes` — as today
  (`Trash.page.tsx:handleRestore`) — for collections *and* loose types.
- **Safety net (after restore):** if the response contains items with
  `needsPlacement && planeId == null` (prediction missed, e.g. plane trashed by another
  session), open the picker *then* place via `placeItemsOnPlane` + `scheduleSave` — now
  safe because state is post-reload clean. If the user cancels, fall back to the first
  plane rather than leaving invisible floaters.
- The "plane alive, collection gone" case needs **no picker and no client placement** at
  all anymore — R2 step 2 handled it server-side.

### R5 (frontend) — position fixup pass

After reload, for every restored item with `position_fixup` (and generally: any
collection element whose cell collides with another element on the same plane), move that
collection element to `firstFreeSpanCell(...)` (`lib/gridPacking.ts` — extract per the
original plan's W0 if not yet done) and `scheduleSave()`. Pure cosmetics; correctness no
longer depends on it.

### R6 (frontend) — local down-cascade + selection scrub on delete (L1, L2)

- Extend `POST /trash/` to return the **created batch** (`[{entity_type, entity_id}]`)
  alongside the roots list, so the client knows exactly what the server cascaded.
- New `AppContext.applyLocalTrashCascade(trashedIds)`: remove those ids from
  `processes/experiments/results`, strip their collection refs on all planes, and scrub
  selections — `lastSelectedByKind`, `activeEntity`, and (via existing setters) any
  page-level selection pointing at a removed id. `trashEntity` calls it with the server's
  batch; delete handlers in `Processes.page` / `Experiments.page` / `Organization.page`
  drop their hand-rolled partial pruning in favour of it.
- **Picker/list audit** (verify each reads only from the pruned AppContext arrays; fix
  any that cache):
  | Surface | Source to verify |
  |---|---|
  | Experiments page process picker / spawn flow | `processes` array |
  | Results page + UploadFlowPanel experiment/result lists | `results`, `experiments` |
  | Analysis page ref pickers | `processes/experiments/results` |
  | Organization canvas + reference-follow (cross-collection jump) | plane refs |
  | Export page entity lists | arrays |
  | `lastSelectedByKind` restore-on-navigation | scrub in R6 |

### R7 — tests (the acceptance gate)

**T-B: backend pytest (`tests/api/routes/test_trash.py` additions)**

1. **Round-trip equality:** build plane→collection→process→experiment→result; snapshot
   `/state/bulk`; `POST /trash/` on each root type in turn; assert children hidden;
   restore; snapshot again; **assert deep equality** of the two bulk snapshots modulo
   volatile fields (`updated_at`, trash bookkeeping). This is cheap and pins the
   server-atomic guarantee of R2.
2. Restore with `destination_plane_id`: trashed collection whose plane was also trashed →
   collection row re-pointed to destination, members intact under it.
3. Plane-alive/collection-gone → auto-created `"Restored: …"` collection on the original
   plane, members attached, `position_fixup=True`.
4. R1 regression: `PUT /planes/{id}/collections` with unchanged ids never NULLs member
   FKs; still deletes rows genuinely removed; still preserves trashed rows.
5. No-destination orphan restore → `needs_placement=True, plane_id=None`, entity row
   alive.

**T-E2E: frontend integration (real stack, serial — see
`frontend/tests/integration/` harness; two-session caveat in CLAUDE.md applies)**

New spec `frontend/tests/integration/trash-restore-roundtrip.spec.ts`:

- **State-equality helper:** capture app state twice — (a) `GET /state/bulk` via API
  request from the test, (b) a dev-only `window.__plainsSnapshot()` hook on AppContext
  (guarded by `import.meta.env.DEV || PLAYWRIGHT_INTEGRATION`) returning
  `{processes, experiments, results, planes}`. Normalise: sort arrays by id, drop
  timestamps/undefined, keep collection element `{id, name, refs(sorted), position}`.
  `expect(after).toEqual(before)`.
- **T1 process round-trip:** create plane + collection + process + 2 experiments +
  result via UI; capture; delete process (UI); **assert hygiene while deleted:** process
  absent from Processes list, its experiments absent from Experiments page *and* from the
  process/experiment pickers, result absent from Results page, canvas shows no refs,
  Trash page shows exactly one root row ("1 process" summary with children counts);
  restore from Trash; capture; assert equality (canvas: same collection, same refs).
- **T2 experiment round-trip** (restores under the same process + same collection).
- **T3 collection round-trip:** collection element reappears on the same plane with same
  id, name, position and refs; members back in all lists.
- **T4 plane round-trip:** all elements + entities return; plane picker/tabs show it.
- **T5 orphan flow:** delete collection → delete its plane → restore collection → picker
  appears → choose plane B → the *original* collection (same name) lands on B's free
  cells with all members; state equality checked against a re-parented expectation.
- **T6 reload persistence:** after each restore, `page.reload()` and re-assert — this is
  the regression trap for F1/F2 (pre-fix, the corruption only shows after the flush+reload).
- Run tests serially, one browser session (delete-reconciliation race, see CLAUDE.md).

**Definition of done:** all T-B green; T-E2E green twice in a row (flake check);
`bash backend/scripts/lint.sh` + `bun run lint` + `tsc` clean.

---

## Rollout order

1. **R1** (`replace_collections` diff) + pytest #4 — independently shippable, fixes a
   corruption class beyond trash.
2. **R2** (server-atomic restore + destination) + pytest #1–3, #5.
3. **R3 + R4** together (client sequence + picker) — restore path switched over.
4. **R5** position fixup.
5. **R6** local cascade + selection scrub + picker audit.
6. **T-E2E** last, as the acceptance gate for the whole increment.

## Known limitation (unchanged from Increment 1)

A *second* stale session can still re-trash restored items via `deleteRemoved`'s
diff-to-trash (`backend.ts:668`) until it reloads. Single-session behaviour is fully
covered by this plan; the multi-session reconciliation story (e.g. server-side version
stamps) stays out of scope, as in Increment 1.

## Superseded items from the Increment 1 plan

- Old W5 "restore places items client-side via `placeItemsOnPlane`" → replaced by R2
  (server-side) + R5 (cosmetic fixup only). `placeItemsOnPlane` survives solely as the
  R4 safety net.
- The "Restored items N" anonymous bucket → replaced by named `"Restored: <root>"`
  collections created server-side, and by re-homing the original collection row when one
  exists.
- Still pending & untouched by this plan: finished-upload prompts on plane trash,
  Organization overview "Finished uploads" list, Analyses UI enablement (backend ready).
