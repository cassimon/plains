import { describe, expect, test } from "bun:test"
import type {
  ProcessAddedSolution,
  ProcessSolutionRecipe,
} from "../store/AppContext"
import { deriveStockVolumes, reconstructStockModel } from "./stockSolutions"

const recipe = (
  partial: Partial<ProcessSolutionRecipe>,
): ProcessSolutionRecipe => ({
  id: "r",
  name: "r",
  totalSolventVolumeMl: "1",
  solvents: [],
  solutes: [],
  ...partial,
})

describe("deriveStockVolumes", () => {
  test("splits the total by ratio", () => {
    const out = deriveStockVolumes("3", [
      { recipeId: "a", volumeRatio: 1, volumeMl: "" },
      { recipeId: "b", volumeRatio: 2, volumeMl: "" },
    ])
    expect(out.map((e) => e.volumeMl)).toEqual(["1", "2"])
  })

  test("derived volumes sum to the total", () => {
    const out = deriveStockVolumes("10", [
      { recipeId: "a", volumeRatio: 1, volumeMl: "" },
      { recipeId: "b", volumeRatio: 1, volumeMl: "" },
      { recipeId: "c", volumeRatio: 1, volumeMl: "" },
    ])
    const sum = out.reduce((s, e) => s + Number(e.volumeMl), 0)
    // Per-stock volumes are rounded to 4 decimals, so an unevenly divisible
    // total lands within a sub-microliter of the typed total.
    expect(sum).toBeCloseTo(10, 3)
  })

  test("splits evenly when no ratios are set", () => {
    const out = deriveStockVolumes("4", [
      { recipeId: "a", volumeRatio: 0, volumeMl: "" },
      { recipeId: "b", volumeRatio: 0, volumeMl: "" },
    ])
    expect(out.map((e) => e.volumeMl)).toEqual(["2", "2"])
  })
})

describe("reconstructStockModel", () => {
  test("rebuilds total + ratios from legacy volumeMl and preserves volumes", () => {
    const legacy: ProcessAddedSolution[] = [
      { recipeId: "a", volumeMl: "0.5" },
      { recipeId: "b", volumeMl: "1.5" },
    ]
    const out = reconstructStockModel(recipe({ addedSolutions: legacy }))
    expect(out.totalStockSolutionVolumeMl).toBe("2")
    // Re-deriving from the reconstructed model reproduces the original volumes.
    const rederived = deriveStockVolumes(
      out.totalStockSolutionVolumeMl ?? "",
      out.addedSolutions ?? [],
    )
    expect(rederived.map((e) => Number(e.volumeMl))).toEqual([0.5, 1.5])
  })

  test("leaves an empty total for a recipe with no stocks", () => {
    const out = reconstructStockModel(recipe({ addedSolutions: [] }))
    expect(out.totalStockSolutionVolumeMl).toBe("")
  })

  test("is a no-op when the ratio model is already present", () => {
    const modelled = recipe({
      totalStockSolutionVolumeMl: "3",
      addedSolutions: [{ recipeId: "a", volumeRatio: 1, volumeMl: "3" }],
    })
    expect(reconstructStockModel(modelled)).toBe(modelled)
  })
})
