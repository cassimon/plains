import { describe, expect, test } from "bun:test"
import type {
  Experiment,
  Process,
  ProcessStep,
  Substrate,
} from "../store/AppContext"
import {
  buildProcessingStacks,
  datePart,
  endStageIdx,
  experimentProcessingTimesDone,
  findDivergeIdx,
  findProcessingTimeRegressions,
  hasTime,
  processingAsAboveKey,
  processingTimeKey,
  resolveProcessingAsAboveToggle,
  resolveProcessingTime,
  resolveProcessingTimeEdit,
  timeCellCount,
  timePart,
} from "./processingTimes"

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
//
// A `Process` here is just a list of stages, each a list of alternative step
// ids. A substrate opts into a specific alternative at stage `i` by storing
// `stageSelection:i` in its `parameterValues`; leaving it unset means "the
// first alternative" (see `stageSelectionFor` in processingTimes.ts). That is
// the only lever these tests need to create — or avoid — a divergence.
// ─────────────────────────────────────────────────────────────────────────────

const step = (id: string): ProcessStep =>
  ({
    id,
    name: id,
    stepCategory: "wet_deposition",
    color: "#000",
  }) as ProcessStep

const makeProcess = (stageAlternatives: string[][]): Process =>
  ({
    id: "p",
    name: "P",
    substrateIds: [],
    stages: stageAlternatives.map((alts, index) => ({
      index,
      alternatives: alts.map(step),
    })),
  }) as Process

const sub = (
  id: string,
  stageSelections: Record<number, string> = {},
): Substrate => ({
  id,
  name: id,
  parameterValues: Object.fromEntries(
    Object.entries(stageSelections).map(([idx, stepId]) => [
      `stageSelection:${idx}`,
      stepId,
    ]),
  ),
})

const makeExperiment = (
  substrates: Substrate[],
  processingTimes: Record<string, string> = {},
): Experiment =>
  ({
    id: "e",
    name: "E",
    description: "",
    date: "",
    substrates,
    processingTimes,
  }) as Experiment

/** Convenience: build the (stacks, divergeIdx) a Process+Experiment produces. */
const analyze = (exp: Experiment, process: Process) => {
  const stacks = buildProcessingStacks(exp, process)
  return { stacks, divergeIdx: findDivergeIdx(stacks) }
}

// ─────────────────────────────────────────────────────────────────────────────

describe("date / time cell helpers", () => {
  test("datePart / timePart split a datetime-local value", () => {
    expect(datePart("2024-01-02T09:30")).toBe("2024-01-02")
    expect(timePart("2024-01-02T09:30")).toBe("09:30")
  })

  test("a bare date has a date but no time", () => {
    expect(datePart("2024-01-02")).toBe("2024-01-02")
    expect(timePart("2024-01-02")).toBe("")
    expect(hasTime("2024-01-02")).toBe(false)
  })

  test("empty is empty", () => {
    expect(datePart("")).toBe("")
    expect(timePart("")).toBe("")
    expect(hasTime("")).toBe(false)
  })

  test("hasTime is true only with both a date and a time", () => {
    expect(hasTime("2024-01-02T09:30")).toBe(true)
  })

  test("datetime-local strings sort chronologically as plain strings", () => {
    expect("2024-01-02T09:00" < "2024-01-02T10:00").toBe(true)
    expect("2024-01-02T23:59" < "2024-01-03T00:00").toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Single-row (undiverged) ordering
// ─────────────────────────────────────────────────────────────────────────────

describe("findProcessingTimeRegressions — single row", () => {
  // 2 real stages → cells: stage:0, stage:1, and the end cell (idx 2).
  const process = makeProcess([["a"], ["b"]])
  const { stacks, divergeIdx } = analyze(makeExperiment([sub("s1")]), process)

  const flag = (times: Record<string, string>) =>
    findProcessingTimeRegressions(process, stacks, divergeIdx, times)

  test("end cell is one past the last stage", () => {
    expect(endStageIdx(process)).toBe(2)
    expect(timeCellCount(process)).toBe(3)
  })

  test("a strictly increasing timeline has no regressions", () => {
    expect(
      flag({
        "stage:0": "2024-01-01T09:00",
        "stage:1": "2024-01-01T10:00",
        "stage:2": "2024-01-01T11:00",
      }).size,
    ).toBe(0)
  })

  test("equal successive times are allowed (steps may start together)", () => {
    expect(
      flag({
        "stage:0": "2024-01-01T10:00",
        "stage:1": "2024-01-01T10:00",
        "stage:2": "2024-01-01T10:00",
      }).size,
    ).toBe(0)
  })

  test("a step earlier than the one before it is flagged", () => {
    const flagged = flag({
      "stage:0": "2024-01-01T10:00",
      "stage:1": "2024-01-01T09:00",
    })
    expect(flagged.has("stage:1")).toBe(true)
    expect(flagged.size).toBe(1)
  })

  test("the end cell earlier than the last step is flagged", () => {
    const flagged = flag({
      "stage:0": "2024-01-01T09:00",
      "stage:1": "2024-01-01T11:00",
      "stage:2": "2024-01-01T10:00",
    })
    expect(flagged.has("stage:2")).toBe(true)
  })

  test("date-only cells never participate — they can't false-flag", () => {
    // stage:1 is a bare date (an auto-filled cascade), so even though it reads
    // as an earlier calendar moment it is skipped entirely.
    expect(
      flag({
        "stage:0": "2024-01-01T10:00",
        "stage:1": "2024-01-01",
        "stage:2": "2024-01-01T11:00",
      }).size,
    ).toBe(0)
  })

  test("only the offending cell (not everything after it) is flagged", () => {
    const flagged = flag({
      "stage:0": "2024-01-01T10:00",
      "stage:1": "2024-01-01T08:00", // dips below stage 0
      "stage:2": "2024-01-01T12:00", // recovers above the running max
    })
    expect(flagged.has("stage:1")).toBe(true)
    expect(flagged.has("stage:2")).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// experimentProcessingTimesDone — the green gate
// ─────────────────────────────────────────────────────────────────────────────

describe("experimentProcessingTimesDone", () => {
  const process = makeProcess([["a"], ["b"]])

  test("false with no process or no substrates", () => {
    expect(experimentProcessingTimesDone(makeExperiment([]), process)).toBe(
      false,
    )
    expect(
      experimentProcessingTimesDone(makeExperiment([sub("s1")]), undefined),
    ).toBe(false)
  })

  test("green once every cell (incl. the end) carries a full time, in order", () => {
    const exp = makeExperiment([sub("s1")], {
      "stage:0": "2024-01-01T09:00",
      "stage:1": "2024-01-01T10:00",
      "stage:2": "2024-01-01T11:00",
    })
    expect(experimentProcessingTimesDone(exp, process)).toBe(true)
  })

  test("not green while any cell is missing its time", () => {
    const exp = makeExperiment([sub("s1")], {
      "stage:0": "2024-01-01T09:00",
      "stage:1": "2024-01-01", // date only — still buzzing
      "stage:2": "2024-01-01T11:00",
    })
    expect(experimentProcessingTimesDone(exp, process)).toBe(false)
  })

  test("not green when a regression is present even though all cells are filled", () => {
    // This is the core fix: a fully-specified-but-out-of-order timeline must
    // never read as done.
    const exp = makeExperiment([sub("s1")], {
      "stage:0": "2024-01-01T10:00",
      "stage:1": "2024-01-01T09:00", // earlier than stage 0
      "stage:2": "2024-01-01T11:00",
    })
    expect(experimentProcessingTimesDone(exp, process)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// resolveProcessingTimeEdit — the input gatekeeper
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveProcessingTimeEdit — single row", () => {
  const process = makeProcess([["a"], ["b"]])
  const { stacks, divergeIdx } = analyze(makeExperiment([sub("s1")]), process)

  const edit = (
    times: Record<string, string>,
    stageIdx: number,
    proposed: string,
  ) =>
    resolveProcessingTimeEdit(
      process,
      stacks,
      divergeIdx,
      times,
      stageIdx,
      null,
      proposed,
    )

  test("a later-or-equal time is accepted verbatim", () => {
    const clean = { "stage:0": "2024-01-01T09:00" }
    expect(edit(clean, 1, "2024-01-01T10:00")).toEqual({
      storedValue: "2024-01-01T10:00",
      rejected: false,
    })
    // equal is allowed
    expect(edit(clean, 1, "2024-01-01T09:00")).toEqual({
      storedValue: "2024-01-01T09:00",
      rejected: false,
    })
  })

  test("a time earlier than the previous step is rejected and reverts to that step's date, blank", () => {
    const result = edit(
      { "stage:0": "2024-01-01T10:00" },
      1,
      "2024-01-01T09:00",
    )
    expect(result.rejected).toBe(true)
    // Re-imposes the previous step's DATE with no time → keeps buzzing.
    expect(result.storedValue).toBe("2024-01-01")
    expect(hasTime(result.storedValue)).toBe(false)
    expect(result.message).toBeTruthy()
    expect(result.message).not.toMatch(/end of the experiment/i)
  })

  test("a blank or date-only proposal is always accepted (it just keeps buzzing)", () => {
    const clean = { "stage:0": "2024-01-01T10:00" }
    expect(edit(clean, 1, "")).toEqual({ storedValue: "", rejected: false })
    expect(edit(clean, 1, "2024-01-01")).toEqual({
      storedValue: "2024-01-01",
      rejected: false,
    })
  })

  test("forward chain: raising an early step above a later one is rejected", () => {
    // t0 < t1 < t2 established, then the user drags t0 up past t1.
    const chain = {
      "stage:0": "2024-01-01T10:00",
      "stage:1": "2024-01-01T11:00",
      "stage:2": "2024-01-01T12:00",
    }
    const result = edit(chain, 0, "2024-01-01T11:30")
    expect(result.rejected).toBe(true)
    // No previous step before stage 0 → nothing to cascade, blank it out.
    expect(result.storedValue).toBe("")
  })

  test("the end cell earlier than the last step is rejected with an end-specific message", () => {
    const times = {
      "stage:0": "2024-01-01T09:00",
      "stage:1": "2024-01-01T11:00",
    }
    const result = edit(times, endStageIdx(process), "2024-01-01T10:00")
    expect(result.rejected).toBe(true)
    expect(result.message).toMatch(/end of the experiment/i)
  })

  test("an edit that leaves a pre-existing (unrelated) regression alone is still accepted", () => {
    // stage:1 already dips below stage:0 (legacy/imported bad data). Editing the
    // END cell to a valid value must not be blocked by that older problem.
    const legacy = {
      "stage:0": "2024-01-01T10:00",
      "stage:1": "2024-01-01T09:00", // pre-existing regression, untouched
    }
    const result = edit(legacy, endStageIdx(process), "2024-01-01T12:00")
    expect(result.rejected).toBe(false)
    expect(result.storedValue).toBe("2024-01-01T12:00")
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Diverged stacks: shared prefix + per-stack rows
// ─────────────────────────────────────────────────────────────────────────────

describe("diverged stacks", () => {
  // stage 0 shared (c1), stage 1 diverges (a1 vs a2), stage 2 shared step (b1).
  const process = makeProcess([["c1"], ["a1", "a2"], ["b1"]])
  const s1 = sub("s1", { 1: "a1" })
  const s2 = sub("s2", { 1: "a2" })
  const exp0 = makeExperiment([s1, s2])
  const { stacks, divergeIdx } = analyze(exp0, process)

  const KEY1 = "c1|a1|b1" // first stack (row above)
  const KEY2 = "c1|a2|b1" // second stack

  test("divergence is detected at stage 1 with two stacks in substrate order", () => {
    expect(divergeIdx).toBe(1)
    expect(stacks.map((s) => s.key)).toEqual([KEY1, KEY2])
  })

  test("stage 0 stays shared; stage 1 onward is per-stack", () => {
    expect(processingTimeKey(0, null)).toBe("stage:0")
    expect(processingTimeKey(1, KEY2)).toBe(`stage:1:stack:${KEY2}`)
  })

  test("a per-stack cell cascades only the DATE from the shared prefix", () => {
    const ctx = {
      processingTimes: { "stage:0": "2024-01-01T08:00" },
      divergeIdx,
      stackOrder: stacks.map((s) => s.key),
    }
    // stage 1 (diverged, no own value) inherits the date but not the time.
    expect(resolveProcessingTime(1, KEY2, ctx)).toBe("2024-01-01")
  })

  test("done requires an explicit time in every stack's diverged cells", () => {
    const times: Record<string, string> = {
      "stage:0": "2024-01-01T08:00",
      // stack 1 fully specified (incl. its end-of-experiment cell, idx 3)
      [`stage:1:stack:${KEY1}`]: "2024-01-01T09:00",
      [`stage:2:stack:${KEY1}`]: "2024-01-01T10:00",
      [`stage:3:stack:${KEY1}`]: "2024-01-01T11:00",
      // stack 2 fully specified
      [`stage:1:stack:${KEY2}`]: "2024-01-01T09:30",
      [`stage:2:stack:${KEY2}`]: "2024-01-01T10:30",
      [`stage:3:stack:${KEY2}`]: "2024-01-01T11:30",
    }
    expect(
      experimentProcessingTimesDone(makeExperiment([s1, s2], times), process),
    ).toBe(true)

    // Drop stack 2's stage-1 time → back to buzzing, not done.
    const { [`stage:1:stack:${KEY2}`]: _dropped, ...missing } = times
    expect(
      experimentProcessingTimesDone(makeExperiment([s1, s2], missing), process),
    ).toBe(false)
  })

  test("a regression inside one stack blocks done", () => {
    const times: Record<string, string> = {
      "stage:0": "2024-01-01T08:00",
      [`stage:1:stack:${KEY1}`]: "2024-01-01T09:00",
      [`stage:2:stack:${KEY1}`]: "2024-01-01T10:00",
      [`stage:3:stack:${KEY1}`]: "2024-01-01T11:00",
      [`stage:1:stack:${KEY2}`]: "2024-01-01T09:30",
      [`stage:2:stack:${KEY2}`]: "2024-01-01T09:00", // dips below its own stage 1
      [`stage:3:stack:${KEY2}`]: "2024-01-01T11:30",
    }
    // Every cell is filled, so the ONLY reason this isn't done is the regression.
    expect(
      experimentProcessingTimesDone(makeExperiment([s1, s2], times), process),
    ).toBe(false)
  })

  test("editing a diverged cell honors the shared-prefix previous step", () => {
    const times = { "stage:0": "2024-01-01T10:00" }
    // stack 2's stage 1 must be >= the shared stage-0 time.
    const bad = resolveProcessingTimeEdit(
      process,
      stacks,
      divergeIdx,
      times,
      1,
      KEY2,
      "2024-01-01T09:00",
    )
    expect(bad.rejected).toBe(true)
    expect(bad.storedValue).toBe("2024-01-01") // reimpose shared date

    const ok = resolveProcessingTimeEdit(
      process,
      stacks,
      divergeIdx,
      times,
      1,
      KEY2,
      "2024-01-01T11:00",
    )
    expect(ok.rejected).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// "As above" toggle
// ─────────────────────────────────────────────────────────────────────────────

describe("resolveProcessingAsAboveToggle", () => {
  const process = makeProcess([["c1"], ["a1", "a2"], ["b1"]])
  const s1 = sub("s1", { 1: "a1" })
  const s2 = sub("s2", { 1: "a2" })
  const { stacks, divergeIdx } = analyze(makeExperiment([s1, s2]), process)
  const KEY2 = "c1|a2|b1"

  test("un-ticking is always allowed and clears the flag", () => {
    const result = resolveProcessingAsAboveToggle(
      process,
      stacks,
      divergeIdx,
      {},
      1,
      KEY2,
      false,
    )
    expect(result).toEqual({ asAboveValue: "", rejected: false })
  })

  test("ticking is accepted when the copied time keeps the row in order", () => {
    const times: Record<string, string> = {
      "stage:0": "2024-01-01T08:00",
      "stage:1:stack:c1|a1|b1": "2024-01-01T09:00", // row above, valid
      [`stage:2:stack:${KEY2}`]: "2024-01-01T10:00", // this row's later step
    }
    const result = resolveProcessingAsAboveToggle(
      process,
      stacks,
      divergeIdx,
      times,
      1,
      KEY2,
      true,
    )
    expect(result.asAboveValue).toBe("true")
    expect(result.rejected).toBe(false)
  })

  test("ticking is refused (with a message) when it would force a later step out of order", () => {
    const times: Record<string, string> = {
      "stage:0": "2024-01-01T08:00",
      "stage:1:stack:c1|a1|b1": "2024-01-01T12:00", // row above starts late
      [`stage:2:stack:${KEY2}`]: "2024-01-01T11:00", // this row's next step is earlier
    }
    const result = resolveProcessingAsAboveToggle(
      process,
      stacks,
      divergeIdx,
      times,
      1,
      KEY2,
      true,
    )
    // Refused: box stays unchecked, subsequent fields are NOT clobbered.
    expect(result.asAboveValue).toBe("")
    expect(result.rejected).toBe(true)
    expect(result.message).toBeTruthy()
    // The already-entered later time is left untouched in the store.
    expect(times[`stage:2:stack:${KEY2}`]).toBe("2024-01-01T11:00")
  })

  test("the As-above key is the stage/stack composite the store persists", () => {
    expect(processingAsAboveKey(1, KEY2)).toBe(`asAbove:stage:1:stack:${KEY2}`)
  })
})
