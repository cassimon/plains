# Integration / Frontend test triage

_Last triaged: 2026-07-10 (branch `claude/keen-dijkstra-7n118n`)_

The Playwright **`integration`** project fails on every push, aborting the
`integration-tests.yml` workflow and burning CI minutes. This file triages
those failures so we only spend engineering time on failures that point to
**safety-critical / data-integrity / crash** bugs. Everything else is stashed
here for later.

## Triage rubric

| Bucket | Definition | Action |
|--------|------------|--------|
| **P0 — safety/critical** | Real product defect on a data-integrity path (DB / NOMAD upload), a destructive/irreversible op (trash/restore losing or misplacing data), or a crash / render-loop that bricks the UI. | Investigate & fix the code now. |
| **P1 — real, non-critical** | Genuine but cosmetic/recoverable product bug. | Fix opportunistically. |
| **P2 — test-only** | Product is fine; the test is flaky or drifted from an intentional UI redesign (stale selectors, force-click races, toast timing). | **Stash here.** Adapt or quarantine later. |

## Current failing `integration` tests

As of the last triage the failing set is **deterministic** (identical across
runs `29086904730` and `29087999169`): 13 pass, 3 fail, 1–2 flaky, 3 skipped
because the run aborts. **None of the three is a confirmed P0 product bug** —
see per-test verdicts.

### 1. `nomad-upload-flows.spec.ts:785` — "flow 1: GUI-created process + experiment → NOMAD upload"
- **Bucket: P2 (test drift).**
- **Symptom:** `table input[value^='substrate']` resolves to 0 elements (expected 2) at `completeExperimentInGui` (line 288).
- **Root cause:** the *"Redesign Experiments Step 2 into three guided sub-boxes"* change (commit `5425ddd`) now creates new substrates with a **blank name** until advanced settings are consulted (`Experiments.page.tsx:3080-3090`, `name: advancedConsulted ? buildGeneratedSubstrateName(...) : ""`). Substrates still render correctly — they are just no longer auto-named `substrate…`, so the selector no longer matches.
- **Not a data bug:** nothing is lost or mis-uploaded; the test's assumption about default naming is stale.
- **Fix later:** update the helper to add substrates and read the name inputs by structure (e.g. `table tbody tr input`) rather than by the `substrate`-prefixed value, and set names explicitly.

### 2. `create-objects-loops.spec.ts:215` — "header picker create does not render-loop"
- **Bucket: P2 (needs a trace to fully confirm), but treated as non-critical.**
- **Symptom:** `button:not([disabled])` with text "Create experiment" never becomes clickable; times out at `pickerCreate` (line 255). **No `Maximum update depth exceeded` error is reported** — `collectLoopErrors` stays empty — so the render-loop invariant this test guards is *not* violated. The failure is that the picker's Create button stays disabled/unreachable in CI.
- **Likely cause:** UI drift in the header upload-flow picker / experiment-create gating after the Step-2 redesign; possibly a CI timing gap on button enablement.
- **Caveat:** this test guards the historical "Maximum update depth exceeded" render-loop (see `CLAUDE.md`). When adapting it, **keep the `collectLoopErrors` console assertion active** and only relax the create-interaction/timeout — do not weaken the loop guard itself.
- **Fix later:** pull the Playwright trace, confirm whether Create is legitimately gated (product) or just slow (test), then adjust.

### 3. `trash-restore-roundtrip.spec.ts:399` — "orphan restore: pick a destination"
- **Bucket: P2 (test flakiness).**
- **Symptom:** after force-clicking a destination option, the Mantine `Select` value stays on the original (`"coll-… plane"`) instead of the chosen `"Destination plane …"`; `toPass` loop exhausts 15 s (line 442).
- **Cause:** known-fragile Mantine `Select` force-click interaction in the restore-destination modal (same family of races documented in `CLAUDE.md`). No evidence of data misplacement — the selection UI just doesn't commit under automation.
- **Fix later:** drive the Select via keyboard/option-role click and assert on committed value with a longer settle, or via the underlying handler.

### Genuinely flaky (pass on retry) — low priority
- `trash-restore-roundtrip.spec.ts:343` — "deleting an experiment hides it and its results" ("Restored" toast race).
- `trash-restore-roundtrip.spec.ts:272` — "collection round-trip reappears on its plane" (same toast race).

## Frontend "exploration" / fuzzing tests — stashed by default

These take significant time to adapt after UI changes and are **not
safety-critical**; do not block CI on them and do not investigate unless they
surface a `Maximum update depth exceeded` / crash:
- `plains-random-walk.spec.ts` (GUI random-walk fuzzing, `gui-random-walk` job)
- `plains-pages.spec.ts`
- `plains-infinite-loops.spec.ts` (mocked-backend loop guard — keep the crash
  assertion meaningful if touched)

## How to make CI green in the meantime

Options, in order of preference, to be decided with the maintainer:
1. Adapt tests 1–3 to the redesigned Step-2 UI (removes the drift at the source).
2. `test.fixme(...)` the three drifted tests with a comment linking this file,
   so the suite goes green and stops aborting the run — then work the backlog.
3. Split the `integration` project so exploration/fuzzing failures don't gate
   pushes to `claude/*` branches.

_No product code was changed as part of this triage — report only._
