import type {
  Process,
  ProcessParameterKey,
  ProcessStep,
} from "../store/AppContext"
import { PROCESS_PARAMETER_DEFINITIONS } from "../store/AppContext"

/**
 * Why the generated device stacks differ from one another.
 *
 * Stacks are the cartesian product of (substrate × one alternative per stage),
 * so any two of them diverge for exactly two possible reasons: a different
 * substrate, or a different alternative taken at some stage. This module names
 * that reason and enumerates the concrete field-level differences, so the same
 * summary can be shown on the Processes page and printed into the PDF export.
 *
 * The enumeration order here **must** match the order the stacks are generated
 * in (substrates outer, step combinations inner), because that order is what
 * `GeneratedStack.combination` indexes into.
 */

export type StackSubstrate = { id: string; name: string }

/**
 * The substrates a process builds stacks on, in generation order: referenced
 * Materials first, then inline substrates. `resolveName` returns undefined for a
 * dangling reference, which is skipped.
 */
export function stackSubstrates(
  process: Process,
  resolveName: (id: string) => string | undefined,
): StackSubstrate[] {
  const out: StackSubstrate[] = []
  for (const id of process.substrateIds ?? []) {
    const name = resolveName(id)
    if (name === undefined) continue
    out.push({ id, name: name || "Unnamed" })
  }
  for (const sub of process.inlineSubstrates ?? []) {
    out.push({ id: sub.id, name: sub.name || "Unnamed" })
  }
  return out
}

/** Cartesian product of the stage alternatives, in stack-generation order. */
export function stepCombinations(process: Process): ProcessStep[][] {
  let combos: ProcessStep[][] = [[]]
  for (const stage of process.stages) {
    const next: ProcessStep[][] = []
    for (const combo of combos) {
      for (const step of stage.alternatives) next.push([...combo, step])
    }
    combos = next
  }
  return combos
}

export type StackVariant = {
  combination: number
  substrate: StackSubstrate
  combo: ProcessStep[]
}

/** One entry per generated stack, aligned with `GeneratedStack.combination`. */
export function enumerateStackVariants(
  process: Process,
  substrates: StackSubstrate[],
): StackVariant[] {
  const combos = stepCombinations(process)
  const out: StackVariant[] = []
  let combination = 0
  for (const substrate of substrates) {
    for (const combo of combos) {
      out.push({ combination, substrate, combo })
      combination += 1
    }
  }
  return out
}

/** A single field on which two stacks disagree. */
export type StackDiff = {
  /** Where the difference lives, e.g. "Step #3 · Annealing Temperature". */
  label: string
  /** This stack's value. */
  value: string
  /** The reference stack's value. */
  reference: string
}

export type StackDivergence = {
  /** Heading: what makes this stack the stack it is. */
  title: string
  /** One line on how it relates to the reference stack. */
  subtitle: string
  /** Every field that differs from the reference stack. Empty for the reference. */
  diffs: StackDiff[]
  isReference: boolean
}

const EMPTY = "—"

function paramValue(step: ProcessStep, key: ProcessParameterKey): string {
  return step[key]?.value?.trim() || ""
}

/**
 * Compare two alternative steps field by field. Both are alternatives of the
 * same stage, so every difference between them is a reason the stacks diverge.
 */
function diffSteps(
  stagePos: number,
  step: ProcessStep,
  reference: ProcessStep,
  categoryLabel: (step: ProcessStep) => string,
  materialLabel: (step: ProcessStep) => string,
): StackDiff[] {
  const prefix = `Step #${stagePos + 1}`
  const diffs: StackDiff[] = []

  const push = (label: string, value: string, ref: string) => {
    if (value === ref) return
    diffs.push({
      label: `${prefix} · ${label}`,
      value: value || EMPTY,
      reference: ref || EMPTY,
    })
  }

  push("Name", step.name, reference.name)
  push("Category", categoryLabel(step), categoryLabel(reference))
  push("Material", materialLabel(step), materialLabel(reference))
  for (const def of PROCESS_PARAMETER_DEFINITIONS) {
    const unit = def.unit ? ` ${def.unit}` : ""
    const a = paramValue(step, def.key)
    const b = paramValue(reference, def.key)
    push(def.label, a ? `${a}${unit}` : "", b ? `${b}${unit}` : "")
  }
  push("Notes", step.notes ?? "", reference.notes ?? "")

  return diffs
}

/**
 * Describe each generated stack: why it exists, and everything that sets it
 * apart from the reference stack (the first one that is still present).
 *
 * `baselineCombination` should be the first stack the user can actually see, so
 * the comparison stays meaningful when earlier combinations have been deleted.
 */
export function stackDivergences(
  process: Process,
  substrates: StackSubstrate[],
  labels: {
    categoryLabel: (step: ProcessStep) => string
    materialLabel: (step: ProcessStep) => string
  },
  baselineCombination?: number,
): Map<number, StackDivergence> {
  const variants = enumerateStackVariants(process, substrates)
  const out = new Map<number, StackDivergence>()
  if (variants.length === 0) return out

  const reference =
    variants.find((v) => v.combination === baselineCombination) ?? variants[0]

  // The dimensions that actually vary. A stage with a single alternative is
  // common to every stack and so explains nothing.
  const multiSubstrate = substrates.length > 1
  const branchingStages = process.stages
    .map((stage, pos) => ({ stage, pos }))
    .filter(({ stage }) => stage.alternatives.length > 1)

  for (const variant of variants) {
    const titleParts: string[] = []
    if (multiSubstrate) titleParts.push(`Substrate: ${variant.substrate.name}`)
    for (const { stage, pos } of branchingStages) {
      const altIdx = stage.alternatives.findIndex(
        (a) => a.id === variant.combo[pos]?.id,
      )
      if (altIdx < 0) continue
      const step = stage.alternatives[altIdx]
      const label =
        step.stepCategory === "do_nothing"
          ? "skipped"
          : step.name || labels.materialLabel(step) || "Alternative"
      titleParts.push(
        `Step #${pos + 1}: Alternative ${altIdx + 1}/${stage.alternatives.length} — ${label}`,
      )
    }

    const diffs: StackDiff[] = []
    if (variant.substrate.id !== reference.substrate.id) {
      diffs.push({
        label: "Substrate",
        value: variant.substrate.name,
        reference: reference.substrate.name,
      })
    }
    for (const { pos } of branchingStages) {
      const step = variant.combo[pos]
      const refStep = reference.combo[pos]
      if (!step || !refStep || step.id === refStep.id) continue
      diffs.push(
        ...diffSteps(
          pos,
          step,
          refStep,
          labels.categoryLabel,
          labels.materialLabel,
        ),
      )
    }

    const isReference = variant.combination === reference.combination
    out.set(variant.combination, {
      title:
        titleParts.length > 0
          ? titleParts.join("  ·  ")
          : "Only combination — no alternatives defined",
      subtitle: isReference
        ? "Reference stack — other stacks are described relative to this one."
        : diffs.length === 0
          ? "Identical to the reference stack."
          : `Diverges from the reference stack in ${diffs.length} ${
              diffs.length === 1 ? "field" : "fields"
            }.`,
      diffs,
      isReference,
    })
  }

  return out
}
