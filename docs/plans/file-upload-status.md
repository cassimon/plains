# Plan: "File Upload" Critical Status in the Top Bar

## Goal

Add a new app-wide feature: a **File Upload** critical status, shown as a red
bubble in the top bar (`AppLayout`), centered between the path (left) and the
login/user info (right). When an upload flow is active, the bubble appears and,
when expanded, shows a 3-step progress tracker:

1. **Process** — are files mapped to the target Process and is it fully specified?
2. **Experiment** — are files mapped to target Experiment (derived from the Process) and is it fully specified?
3. **Upload** — did the NOMAD upload succeed?

Only **one** upload flow may exist at a time.

The flow can be started two ways:

1. **From "Add Results"** on an Experiment (Experiments page). Already gated to
   fully-specified experiments. This starts a flow with **step 3 (Upload) as the
   only remaining step** (Process + Experiment already satisfied). The completion of the flow is modal at the moment. This can be dropped. However, through the status bar, the user should be reminded that they have an open flow and if they logout, they should be asked if they want to complete it. Incomplete flows and adata are deleted after inactivity or logout-. 
2. **Drag & drop files into the Organization canvas.** Opens a modal asking
   (a) which Process, then (b) which Experiment the files belong to. The user
   can also **create** an Experiment inline (only once the Process is chosen).

The same Process/Experiment selection + create controls must also be available
inside the **expanded top-bar status**.

Future (out of scope, but design for it): autofilling Process/Experiment from
attached files, and auto-creating substrates.

---

## Current-state findings (where things live)

- **Top bar**: `frontend/src/components/AppLayout.tsx`. Header is a Mantine
  `Group justify="space-between"`: left `Group` = plane/collection/entity
  breadcrumb; right `Group` = color toggle + user menu. The new bubble goes as a
  **third child centered between them** (switch to a 3-slot layout).
- **Central store**: `frontend/src/store/AppContext.tsx`. `AppContextValue`
  (line ~1030) is the single surface all pages consume. It already holds
  `experiments`, `processes`, `results`, `planes`, and cross-page hand-off state
  (`pendingCollectionLink`, `activeEntity`). This is where the new upload-flow
  state belongs.
- **Completeness helpers** (already exist, reuse them):
  - Process: `getProcessStatus(process) => "incomplete" | "complete"`
    (AppContext ~line 268).
  - Experiment (basic): `getExperimentStatus` / `getExperimentMissingFields`
    (~line 475) — only checks `name` + `date`.
  - Experiment (**"all steps done"** — the stronger gate used by Add Results):
    computed in `Experiments.page.tsx` as `expAllStepsDoneMap` (~line 2178):
    `chemDone && procDone && summaryDone` (chemicals prep complete, ≥1 substrate,
    description + date). **This is the real "completely specified" definition and
    should be extracted into AppContext so both the Experiments page and the new
    status bubble can share it.**
- **Add Results wiring**: `Experiments.page.tsx` `handleAddResultsForExperiment`
  (~line 2306) sets `pendingCollectionLink` with `openAddResults: true` and
  navigates to `/results`. The Results page consumes it (~line 3988) to preselect
  the experiment and open the add-results UI. The upload button itself is
  `handleUploadToNomad` in `Results.page.tsx` (~line 2259); NOMAD status polling
  already lives there and writes `results.nomad.status`.
- **Organization drop handling**: `Organization.page.tsx` currently handles drops
  of **collection refs** only (`handleDropToCell` ~3742, `onDrop` ~4257 keyed on
  the custom MIME types `COLLECTION_REF_DRAG_MIME` /
  `COLLECTION_ELEMENT_DRAG_MIME`). There is **no file-drop handling yet** — we add
  a file-drop path (`e.dataTransfer.files`) at the canvas level.
- **Results data model**: `ExperimentResults` (AppContext ~767) holds `files`,
  `deviceGroups`, and `nomad: NomadUploadInfo` (with `status`). Upload success =
  `nomad.status` reaching a terminal success value (the polling logic in
  `Results.page.tsx` already normalizes this).

---

## Data model / store changes (`AppContext.tsx`)

### 1. Shared "experiment fully specified" helper
Extract the `expAllStepsDoneMap` logic into an exported pure function so it's the
single source of truth:

```ts
export function getExperimentAllStepsDone(
  exp: Experiment,
  process: Process | undefined,
): boolean
```

It needs `collectChemicals` / `computeChemsDone` — move those helpers (currently
local to `Experiments.page.tsx`) into AppContext (or a shared module) and have the
page import them. Update `expAllStepsDoneMap` to call the shared function.

### 2. Upload-flow state on the context
Add a new typed slice to `AppContextValue`:

```ts
export type UploadFlowStep = "process" | "experiment" | "upload"

export type UploadFlow = {
  id: string
  origin: "add-results" | "drag-drop"
  processId: string | null
  experimentId: string | null
  /** Files dropped in Organization, staged until an experiment is chosen. */
  pendingFiles?: { name: string; size: number; content?: string }[]
  createdAt: string
}

// on AppContextValue:
uploadFlow: UploadFlow | null
startUploadFlow: (init: Partial<UploadFlow> & { origin: UploadFlow["origin"] }) => boolean // false if one already exists
updateUploadFlow: (patch: Partial<UploadFlow>) => void
cancelUploadFlow: () => void
```

- `startUploadFlow` returns `false` (and no-ops) if `uploadFlow` is already set —
  this enforces the **single active flow** rule.
- Provide the state via `useState` in the provider, same pattern as
  `activeEntity` / `pendingCollectionLink`.
- **Persistence**: follow whatever `pendingCollectionLink`/`activeEntity` do. If
  those are ephemeral (not persisted), keep `uploadFlow` ephemeral too for v1 —
  simplest and avoids migration. (Staged file `content` can be large; do not
  persist it.)

### 3. Derived step status (selector, not stored)
A small helper (in AppContext or a new `frontend/src/lib/uploadFlow.ts`) computes
per-step status from the flow + live data, so the UI never stores stale booleans:

```ts
type StepState = "pending" | "active" | "done" | "error"

function getUploadFlowSteps(flow, { processes, experiments, results }): {
  process: StepState
  experiment: StepState
  upload: StepState
}
```

Rules:
- **process**: `done` if `flow.processId` set and `getProcessStatus === "complete"`.
- **experiment**: `done` if `flow.experimentId` set and
  `getExperimentAllStepsDone(exp, process)`. `pending` until process is done.
- **upload**: `done` if an `ExperimentResults` for `flow.experimentId` has
  `nomad.status` terminal-success; `error` on terminal-failure; `active` while a
  flow is progressing but upload not yet complete.

---

## UI changes

### A. Top-bar bubble — `AppLayout.tsx`
1. Restructure the header into **3 slots** so the bubble is centered: either a
   3-child `Group justify="space-between"` (left breadcrumb / center bubble /
   right user menu) or absolute-center the bubble over the existing 2-slot
   `Group`. Prefer the 3-child approach for simplicity.
2. Read `uploadFlow` + `getUploadFlowSteps` from context.
3. Render the bubble **only when `uploadFlow` is not null**:
   - Collapsed: a red Mantine `Badge`/pill (`color="red"`, `variant="filled"`)
     labeled e.g. `File Upload · 2/3`, with a subtle pulse to read as "critical".
   - Expanded (Popover on click): a 3-step tracker (Mantine `Stepper` vertical, or
     a custom row of 3 step chips using the `StepState` → icon/color mapping:
     done=green check, active=red spinner/dot, pending=gray, error=red X).
   - The expanded panel embeds the **Process/Experiment selector + create
     controls** (shared component, see C) and a **Cancel** action
     (`cancelUploadFlow`).
   - When on the Upload step, an affordance to **jump to the Results page** for
     the experiment (reuse the `handleAddResultsForExperiment` hand-off pattern:
     set `activeEntity` + navigate to `/results`).

### B. Organization file drop — `Organization.page.tsx`
1. In the canvas-level `onDragOver`/`onDrop` (~4234/4257), detect **file drags**:
   `e.dataTransfer.types.includes("Files")`. Keep the existing ref-drag path
   untouched; branch on files first.
2. On file drop: read `e.dataTransfer.files`, stage them (name/size; optionally
   base64 `content` for small files), then:
   - If a flow already exists → show a notification "An upload is already in
     progress" and do nothing (single-flow rule), **or** append files to the
     existing flow's `pendingFiles` (decide during impl; default: block, to match
     the "cannot start a second flow" requirement).
   - Else → `startUploadFlow({ origin: "drag-drop", pendingFiles })` and open the
     **selection modal** (component C) to choose Process → Experiment.

### C. Shared selection/create component — new `UploadFlowTargetPicker.tsx`
A reusable component used by **both** the Organization drop modal and the
expanded top-bar bubble:
- **Process select**: dropdown of `processes`, showing complete/incomplete badge
  (`getProcessStatus`). Required first.
- **Experiment select**: dropdown of `experiments` filtered to the chosen
  `processId`, with complete/incomplete badge. **Disabled until a Process is
  chosen.**
- **"Create Experiment"** button — enabled only once a Process is chosen. Creates
  via `newExperiment(processId)` + `setExperiments`, then selects it. (Optionally
  route to the Experiments page to finish specifying it, using the existing
  `pendingCollectionLink` return-navigation pattern.)
- Writes selections back through `updateUploadFlow({ processId, experimentId })`.
- Modal wrapper (Mantine `modals`/`Modal`) for the Organization entry point;
  inline (no modal chrome) when embedded in the bubble popover.

### D. Add-Results entry point — `Experiments.page.tsx`
In `handleAddResultsForExperiment` (~2306), also start the flow so the bubble
appears with step 3 as the only remaining step:

```ts
startUploadFlow({
  origin: "add-results",
  processId: exp.processId,
  experimentId: exp.id,
})
```

Keep the existing `pendingCollectionLink` + navigate-to-`/results` behavior.
Because Process + Experiment are already satisfied (Add Results is gated on
`expAllStepsDoneMap`), the tracker shows Process ✓, Experiment ✓, Upload ⏳.
If a flow already exists, `startUploadFlow` returns false — surface a
notification ("Finish or cancel the current upload first") and don't navigate.

### E. Upload completion — `Results.page.tsx`
The NOMAD status poller (~1359) already updates `results.nomad.status`. No new
polling needed: the bubble's `upload` step derives from that status via
`getUploadFlowSteps`. Optionally, when status becomes terminal-success for the
flow's experiment, show a success notification and auto-clear the flow after a
short delay (or leave the ✓ bubble until the user dismisses).

---

## Files touched (summary)

| File | Change |
|---|---|
| `store/AppContext.tsx` | Add `UploadFlow` types + state + `start/update/cancelUploadFlow`; extract `getExperimentAllStepsDone` (+ move `collectChemicals`/`computeChemsDone`); add `getUploadFlowSteps` selector |
| `components/AppLayout.tsx` | 3-slot header; render red **File Upload** bubble + expandable step tracker |
| `components/UploadFlowTargetPicker.tsx` (new) | Shared Process/Experiment select + create-experiment controls |
| `components/UploadFlowStatus.tsx` (new, optional) | The bubble + popover tracker, to keep `AppLayout` lean |
| `routes/Organization.page.tsx` | File-drop detection on the canvas → stage files, start flow, open picker modal |
| `routes/Experiments.page.tsx` | `handleAddResultsForExperiment` also calls `startUploadFlow`; reuse extracted helper for `expAllStepsDoneMap` |
| `routes/Results.page.tsx` | (Minor) success notification / optional auto-clear when upload terminal-success |
| `lib/uploadFlow.ts` (optional) | Home for `getUploadFlowSteps` + `StepState` types if kept out of AppContext |

No backend/API changes required for v1: the flow orchestrates existing entities
(Process, Experiment, ExperimentResults) and the existing NOMAD upload path.

---

## Edge cases & rules to enforce
- **Single flow**: `startUploadFlow` no-ops + returns false if one exists; all
  entry points must handle the `false` return (notify the user).
- **Add Results gating**: keep the existing `expAllStepsDoneMap` gate so the icon
  only shows for fully-specified experiments; the flow assumes steps 1–2 done.
- **Experiment create requires a Process**: enforce in the picker (disabled
  button + no experiment dropdown until `processId` set).
- **Deletion safety**: if the flow's Process/Experiment is deleted mid-flow,
  `getUploadFlowSteps` should degrade gracefully (step reverts to `pending`);
  consider auto-cancelling the flow if the referenced experiment disappears.
- **Strict Mode**: follow the CLAUDE.md Mantine/Strict-Mode patterns for any new
  effects (e.g., don't list `results`/`experiments` in effect deps just to read
  them — use refs; stabilize ref callbacks).
- **Abort**: The user has the option to abort / drop the upload flow
- **Inactivty drop**: Inactive Upload flows are dropped after some time or on user logout.

## Suggested build order
1. AppContext: types + state + `start/update/cancel` + extract
   `getExperimentAllStepsDone` + `getUploadFlowSteps`. (No UI yet.)
2. `UploadFlowTargetPicker` shared component.
3. Top-bar bubble + tracker in `AppLayout` (wire to context).
4. Add-Results entry point (`Experiments.page.tsx`).
5. Organization file-drop entry point.
6. Results success notification / auto-clear + polish (pulse animation, a11y).
7. Manual verification of both entry points and the single-flow rule.
8. Report progress back and status log summary to the plan, in case token limit is reached. 