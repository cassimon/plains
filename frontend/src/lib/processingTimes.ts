// ─────────────────────────────────────────────────────────────────────────────
// Processing-time "stacks" — pure selectors shared by the Experiments page
// (Processing tab table) and the upload-flow completeness gate.
//
// A substrate follows one alternative step per process stage (stored as
// `stageSelection:${idx}` in its `parameterValues`, defaulting to the first
// alternative — see `ExperimentGrid`'s `getStageSelection` in Experiments.page).
// When every substrate in an experiment agrees on every stage, there is a
// single "Processing Times" row. The moment two substrates pick different
// alternatives at some stage, everything from that stage onward legitimately
// needs its own timing per distinct path ("stack") — earlier stages stay
// shared since they are, by definition, identical up to that point.
// ─────────────────────────────────────────────────────────────────────────────

import type { Experiment, Process } from "@/store/AppContext"

export type ProcessingStack = {
  /** Stable identity = every stage's selected step id (or "SKIP"), joined. */
  key: string
  /** Per-stage selected step id (or "SKIP"), aligned with `process.stages`. */
  selections: string[]
  substrateIds: string[]
}

function stageSelectionFor(
  exp: Experiment,
  substrateId: string,
  stageIdx: number,
  process: Process,
): string {
  const substrate = exp.substrates.find((s) => s.id === substrateId)
  const stored = substrate?.parameterValues?.[`stageSelection:${stageIdx}`]
  return stored || process.stages[stageIdx]?.alternatives[0]?.id || "SKIP"
}

/** Group this experiment's substrates by the exact alternative path they follow. */
export function buildProcessingStacks(
  exp: Experiment,
  process: Process,
): ProcessingStack[] {
  const map = new Map<string, ProcessingStack>()
  for (const sub of exp.substrates) {
    const selections = process.stages.map((_stage, idx) =>
      stageSelectionFor(exp, sub.id, idx, process),
    )
    const key = selections.join("|")
    const existing = map.get(key)
    if (existing) {
      existing.substrateIds.push(sub.id)
    } else {
      map.set(key, { key, selections, substrateIds: [sub.id] })
    }
  }
  // Stable order: first-appearance among the experiment's substrates, so rows
  // don't reshuffle as unrelated edits happen elsewhere.
  const order = exp.substrates.map((s) => s.id)
  return [...map.values()].sort(
    (a, b) =>
      order.indexOf(a.substrateIds[0]) - order.indexOf(b.substrateIds[0]),
  )
}

/** First stage index where the stacks disagree, or -1 when there's only one path. */
export function findDivergeIdx(stacks: ProcessingStack[]): number {
  if (stacks.length <= 1) return -1
  const stageCount = stacks[0]?.selections.length ?? 0
  for (let idx = 0; idx < stageCount; idx += 1) {
    if (new Set(stacks.map((s) => s.selections[idx])).size > 1) return idx
  }
  return -1
}

/** Stage indices (>= divergeIdx) where the stacks actually differ — used for row labels. */
export function findDecisiveStageIndices(
  stacks: ProcessingStack[],
  divergeIdx: number,
): number[] {
  if (divergeIdx < 0) return []
  const stageCount = stacks[0]?.selections.length ?? 0
  const result: number[] = []
  for (let idx = divergeIdx; idx < stageCount; idx += 1) {
    if (new Set(stacks.map((s) => s.selections[idx])).size > 1) result.push(idx)
  }
  return result
}

/** Human label for a stack row, naming only the layers that actually differ. */
export function stackRowLabel(
  stack: ProcessingStack,
  process: Process,
  decisiveStageIndices: number[],
): string {
  const parts = decisiveStageIndices
    .map((idx) => {
      const stepId = stack.selections[idx]
      if (!stepId || stepId === "SKIP") return null
      return (
        process.stages[idx]?.alternatives.find((a) => a.id === stepId)?.name ||
        null
      )
    })
    .filter((s): s is string => Boolean(s))
  return parts.length > 0 ? parts.join(" / ") : "Skip"
}

export function processingTimeKey(
  stageIdx: number,
  stackKey: string | null,
): string {
  return stackKey ? `stage:${stageIdx}:stack:${stackKey}` : `stage:${stageIdx}`
}

export function processingAsAboveKey(
  stageIdx: number,
  stackKey: string,
): string {
  return `asAbove:stage:${stageIdx}:stack:${stackKey}`
}

export type ProcessingTimesCtx = {
  processingTimes: Record<string, string>
  /** -1 means "no divergence" — every stage uses the shared row. */
  divergeIdx: number
  /** Stack keys top-to-bottom, in the order rows are rendered. */
  stackOrder: string[]
}

/**
 * The effective time for (stageIdx, stackKey), applying — in order — the
 * "As above" toggle (copy the row above, same stage), the cell's own stored
 * value (falling back to a stale shared-row value if the stage only just
 * became divergent), and finally the previous stage's resolved value in the
 * same row ("same date as the step before"). Returns "" if nothing resolves.
 */
export function resolveProcessingTime(
  stageIdx: number,
  stackKey: string | null,
  ctx: ProcessingTimesCtx,
): string {
  if (stageIdx < 0) return ""
  const effectiveStackKey =
    ctx.divergeIdx >= 0 && stageIdx >= ctx.divergeIdx ? stackKey : null

  if (effectiveStackKey) {
    const asAboveKey = processingAsAboveKey(stageIdx, effectiveStackKey)
    if (ctx.processingTimes[asAboveKey] === "true") {
      const rowIdx = ctx.stackOrder.indexOf(effectiveStackKey)
      const aboveKey = rowIdx > 0 ? ctx.stackOrder[rowIdx - 1] : null
      if (aboveKey) return resolveProcessingTime(stageIdx, aboveKey, ctx)
    }
  }

  const own =
    ctx.processingTimes[processingTimeKey(stageIdx, effectiveStackKey)] ||
    (effectiveStackKey
      ? ctx.processingTimes[processingTimeKey(stageIdx, null)]
      : "")
  if (own) return own

  return resolveProcessingTime(stageIdx - 1, stackKey, ctx)
}

function rowKeysFor(stacks: ProcessingStack[], divergeIdx: number) {
  return divergeIdx < 0 || stacks.length === 0
    ? [null as string | null]
    : stacks.map((s) => s.key)
}

/**
 * Composite keys whose own explicit value is earlier than the resolved time
 * of the previous stage in the same row — i.e. times that don't increase.
 * A defaulted/inherited cell can never trip this (it equals the previous
 * resolved value by construction), so only genuine typos are flagged.
 */
export function findProcessingTimeRegressions(
  process: Process,
  stacks: ProcessingStack[],
  divergeIdx: number,
  processingTimes: Record<string, string>,
): Set<string> {
  const ctx: ProcessingTimesCtx = {
    processingTimes,
    divergeIdx,
    stackOrder: stacks.map((s) => s.key),
  }
  const flagged = new Set<string>()
  for (const rowKey of rowKeysFor(stacks, divergeIdx)) {
    let prev = ""
    for (let idx = 0; idx < process.stages.length; idx += 1) {
      const effectiveStackKey =
        divergeIdx >= 0 && idx >= divergeIdx ? rowKey : null
      const value = resolveProcessingTime(idx, rowKey, ctx)
      if (value && prev && value < prev) {
        flagged.add(processingTimeKey(idx, effectiveStackKey))
      }
      if (value) prev = value
    }
  }
  return flagged
}

/**
 * Whether a diverged cell has actually been addressed — an explicit own
 * value, an "As above" pointing at a row that was itself addressed, or
 * cascaded forward from an earlier stage *within the diverged region*.
 * Deliberately does NOT fall back across the divergence boundary into the
 * shared prefix the way `resolveProcessingTime` does for display: a stack
 * row that was never touched must not silently count as answered just
 * because the shared prefix has a time — the new per-stack lines are
 * mandatory in their own right.
 */
function isStackCellSeeded(
  stageIdx: number,
  stackKey: string,
  ctx: ProcessingTimesCtx,
): boolean {
  if (stageIdx < ctx.divergeIdx) return false
  const asAboveKey = processingAsAboveKey(stageIdx, stackKey)
  if (ctx.processingTimes[asAboveKey] === "true") {
    const rowIdx = ctx.stackOrder.indexOf(stackKey)
    const aboveKey = rowIdx > 0 ? ctx.stackOrder[rowIdx - 1] : null
    return aboveKey ? isStackCellSeeded(stageIdx, aboveKey, ctx) : false
  }
  if (ctx.processingTimes[processingTimeKey(stageIdx, stackKey)]) return true
  return isStackCellSeeded(stageIdx - 1, stackKey, ctx)
}

/**
 * Step 2 (Processing) is done only once every stage resolves to a non-empty
 * time: the shared prefix (which may cascade from an earlier shared stage),
 * plus — for every diverged stack — a value the user actually seeded for
 * that row (see `isStackCellSeeded`).
 */
export function experimentProcessingDone(
  exp: Experiment,
  process: Process | undefined,
): boolean {
  if (!process || exp.substrates.length === 0) return false
  const stacks = buildProcessingStacks(exp, process)
  const divergeIdx = findDivergeIdx(stacks)
  const ctx: ProcessingTimesCtx = {
    processingTimes: exp.processingTimes ?? {},
    divergeIdx,
    stackOrder: stacks.map((s) => s.key),
  }
  return process.stages.every((_stage, idx) => {
    if (divergeIdx < 0 || idx < divergeIdx) {
      return resolveProcessingTime(idx, null, ctx).trim() !== ""
    }
    return stacks.every((stack) => isStackCellSeeded(idx, stack.key, ctx))
  })
}

/**
 * Earliest and latest resolved processing time across every row, used to
 * suggest the experiment's start/end dates in the Summary tab. `datetime-local`
 * values ("YYYY-MM-DDTHH:mm") sort and slice correctly as plain strings.
 */
export function computeProcessingTimeRange(
  exp: Experiment,
  process: Process,
): { start: string; end: string } | null {
  if (exp.substrates.length === 0 || process.stages.length === 0) return null
  const stacks = buildProcessingStacks(exp, process)
  const divergeIdx = findDivergeIdx(stacks)
  const ctx: ProcessingTimesCtx = {
    processingTimes: exp.processingTimes ?? {},
    divergeIdx,
    stackOrder: stacks.map((s) => s.key),
  }
  let min: string | null = null
  let max: string | null = null
  for (const rowKey of rowKeysFor(stacks, divergeIdx)) {
    for (let idx = 0; idx < process.stages.length; idx += 1) {
      const value = resolveProcessingTime(idx, rowKey, ctx)
      if (!value) continue
      if (min === null || value < min) min = value
      if (max === null || value > max) max = value
    }
  }
  if (min === null || max === null) return null
  return { start: min, end: max }
}
