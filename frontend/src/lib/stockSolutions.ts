import type {
  ProcessAddedSolution,
  ProcessSolutionRecipe,
} from "../store/AppContext"

// ─────────────────────────────────────────────────────────────────────────────
// Stock-solution volume model.
//
// A solution's stock solutions ("Add Stock Solutions") mirror its solvents: the
// recipe carries one editable total volume (`totalStockSolutionVolumeMl`) plus a
// volume ratio per stock, and each stock's absolute volume is *derived* from the
// two. `volumeMl` stays the authoritative persisted quantity — it is what the
// backend stores and what the concentration math and exports read — so these
// helpers keep it in sync with the total/ratio inputs and can rebuild the
// total/ratio inputs from `volumeMl` for data that predates the ratio model.
// ─────────────────────────────────────────────────────────────────────────────

/** Round a derived mL amount to a tidy string (max 4 decimals, no trailing 0s). */
function mlToString(ml: number): string {
  if (!Number.isFinite(ml) || ml <= 0) return "0"
  return String(Number(ml.toFixed(4)))
}

/**
 * Recompute each stock solution's absolute `volumeMl` from the recipe's total
 * stock volume and the per-stock ratios. When no ratio is set (all zero) the
 * total is split evenly, so the sum of the derived volumes always equals the
 * total the user typed.
 */
export function deriveStockVolumes(
  totalStockVolumeMl: string,
  entries: ProcessAddedSolution[],
): ProcessAddedSolution[] {
  const total = Number(totalStockVolumeMl) || 0
  const n = entries.length
  const ratioSum = entries.reduce((s, e) => s + (e.volumeRatio || 0), 0)
  return entries.map((e) => {
    const ml =
      ratioSum > 0
        ? (total * (e.volumeRatio || 0)) / ratioSum
        : n > 0
          ? total / n
          : 0
    return { ...e, volumeMl: mlToString(ml) }
  })
}

/**
 * Ensure a recipe carries the total-stock-volume / per-stock-ratio inputs.
 * Recipes loaded from the backend or imported from an older PDF only have each
 * stock's absolute `volumeMl`; reconstruct the total as their sum and each ratio
 * as its own volume, which reproduces the same absolute volumes exactly.
 */
export function reconstructStockModel(
  recipe: ProcessSolutionRecipe,
): ProcessSolutionRecipe {
  const entries = recipe.addedSolutions ?? []
  if (entries.length === 0) {
    return { ...recipe, totalStockSolutionVolumeMl: "" }
  }
  // Already in the ratio model (e.g. duplicated within the session): keep as-is.
  const alreadyModelled =
    recipe.totalStockSolutionVolumeMl != null &&
    recipe.totalStockSolutionVolumeMl !== "" &&
    entries.every((e) => e.volumeRatio != null)
  if (alreadyModelled) return recipe

  const total = entries.reduce((s, e) => s + (Number(e.volumeMl) || 0), 0)
  return {
    ...recipe,
    totalStockSolutionVolumeMl: mlToString(total),
    addedSolutions: entries.map((e) => ({
      ...e,
      volumeRatio: Number(e.volumeMl) || 0,
    })),
  }
}
