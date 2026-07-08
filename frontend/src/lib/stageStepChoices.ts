// ─────────────────────────────────────────────────────────────────────────────
// Shared helpers for describing a process stage's alternative "step choices".
//
// A stage may offer several alternative steps; an experiment records, per
// substrate, which alternative was used for each stage (stored under the
// `stageSelection:{stageIndex}` key on `Substrate.parameterValues`, whose value
// is the chosen step id — or the literal `"SKIP"`).
//
// The option list must be built the SAME way everywhere it is shown or parsed —
// the Experiments page dropdowns, and the PDF export/import round-trip — so it
// lives here rather than being duplicated. Labels are de-duplicated so that a
// label uniquely identifies a step id within its stage (the PDF dropdown stores
// the visible label, so import maps label → id and that mapping must be 1:1).
// ─────────────────────────────────────────────────────────────────────────────

import type { ProcessSolutionRecipe, ProcessStep } from "@/store/AppContext"

/** Literal option value meaning "this stage was skipped for this substrate". */
export const SKIP_STEP = "SKIP"

export type StageStepOption = { value: string; label: string }

function alphabeticSuffix(index: number): string {
  let n = index
  let suffix = ""
  do {
    suffix = String.fromCharCode(65 + (n % 26)) + suffix
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return suffix
}

/** Human label for a single step, e.g. "Spin coating: Perovskite Ink". */
export function buildStepBaseLabel(
  step: ProcessStep,
  solutionRecipes: ProcessSolutionRecipe[] = [],
): string {
  const depositionMethod = step.depositionMethod?.value?.trim() || "Deposition"
  const materialName =
    step.inlineMaterial?.name ||
    (step.chemRecipeId
      ? (solutionRecipes.find((r) => r.id === step.chemRecipeId)?.name ?? null)
      : null)
  return materialName
    ? `${depositionMethod}: ${materialName}`
    : depositionMethod
}

/**
 * Options for a stage's step choice: one per alternative (value = step id),
 * with a trailing "Skip step" (value = SKIP_STEP). Duplicate labels are
 * disambiguated with an (A)/(B)/… suffix so each label maps to exactly one id.
 */
export function buildStageStepOptions(
  alternatives: ProcessStep[],
  solutionRecipes: ProcessSolutionRecipe[] = [],
): StageStepOption[] {
  const options = alternatives.map((step) => ({
    value: step.id,
    label: buildStepBaseLabel(step, solutionRecipes),
  }))

  const totalByLabel = new Map<string, number>()
  for (const option of options) {
    totalByLabel.set(option.label, (totalByLabel.get(option.label) ?? 0) + 1)
  }

  const seenByLabel = new Map<string, number>()
  const deduped = options.map((option) => {
    const total = totalByLabel.get(option.label) ?? 0
    if (total <= 1) {
      return option
    }
    const seen = seenByLabel.get(option.label) ?? 0
    seenByLabel.set(option.label, seen + 1)
    return { ...option, label: `${option.label} (${alphabeticSuffix(seen)})` }
  })

  return [...deduped, { value: SKIP_STEP, label: "Skip step" }]
}

/** Resolve the currently-selected step id for a substrate/stage (default = first alt). */
export function resolveStageSelection(
  parameterValues: Record<string, string> | undefined,
  stageIndex: number,
  alternatives: ProcessStep[],
): string {
  const stored = parameterValues?.[`stageSelection:${stageIndex}`]
  if (stored) return stored
  return alternatives[0]?.id ?? SKIP_STEP
}
