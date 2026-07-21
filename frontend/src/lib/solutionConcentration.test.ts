import { describe, expect, test } from "bun:test"
import type {
  ProcessSolute,
  ProcessSolutionRecipe,
  ProcessSolvent,
} from "../store/AppContext"
import { concentrationSummary } from "./solutionConcentration"

const solvent = (
  p: Partial<ProcessSolvent> & { name: string },
): ProcessSolvent => ({
  id: p.name,
  pubchemCid: "",
  color: "#000",
  volumeRatio: 1,
  ...p,
})

const solute = (
  p: Partial<ProcessSolute> & { name: string },
): ProcessSolute => ({
  id: p.name,
  pubchemCid: "",
  color: "#000",
  amount: "0",
  unit: "mg",
  ...p,
})

const recipe = (
  p: Partial<ProcessSolutionRecipe> & { id: string },
): ProcessSolutionRecipe => ({
  name: p.id,
  totalSolventVolumeMl: "0",
  solvents: [],
  solutes: [],
  ...p,
})

/** Molarity (mol/L) of a named solute, on the total-volume basis. */
const molarity = (s: ReturnType<typeof concentrationSummary>, name: string) => {
  const e = s.entries.find((x) => x.name === name)
  return e?.molPerMlTotal === null || e === undefined
    ? null
    : e.molPerMlTotal * 1000
}
const totalMolarity = (s: ReturnType<typeof concentrationSummary>) =>
  s.total?.molPerMlTotal === null || s.total == null
    ? null
    : s.total.molPerMlTotal * 1000
const totalPbX2Molarity = (s: ReturnType<typeof concentrationSummary>) =>
  s.totalPbX2?.molPerMlTotal === null || s.totalPbX2 == null
    ? null
    : s.totalPbX2.molPerMlTotal * 1000

describe("single solute", () => {
  // 461 mg PbI2 (M = 461 g/mol) = 1 mmol, in 1 mL DMF. PbI2 density 6.16 g/mL
  // → the solid occupies 461e-3 / 6.16 = 0.0748 mL, so total volume = 1.0748 mL.
  const r = recipe({
    id: "a",
    totalSolventVolumeMl: "1",
    solvents: [solvent({ name: "DMF", density: 0.944, molarMass: 73.09 })],
    solutes: [
      solute({
        name: "PbI2",
        amount: "461",
        unit: "mg",
        molarMass: 461,
        density: 6.16,
      }),
    ],
  })
  const s = concentrationSummary(r, [r])

  test("solvent-basis molarity is 1 mol/L", () => {
    expect(s.entries[0].molPerMlSolvent! * 1000).toBeCloseTo(1.0, 6)
  })

  test("total-basis molarity accounts for the volume the solid occupies", () => {
    expect(molarity(s, "PbI2")!).toBeCloseTo(1 / (1 + 0.461 / 6.16), 9)
  })

  test("%w/w = 461 mg solute / (461 mg + 944 mg DMF)", () => {
    expect(s.entries[0].wPercent!).toBeCloseTo(
      (0.461 / (0.461 + 0.944)) * 100,
      4,
    )
  })

  test("total equals the one component", () => {
    expect(totalMolarity(s)!).toBeCloseTo(molarity(s, "PbI2")!, 9)
  })
})

describe("multiple solvents", () => {
  // 4:1 DMF:DMSO, 5 mL total → 4 mL DMF + 1 mL DMSO. The sum of the individual
  // solvent volumes must equal the declared total.
  const r = recipe({
    id: "a",
    totalSolventVolumeMl: "5",
    solvents: [
      solvent({ name: "DMF", density: 1.0, volumeRatio: 4 }),
      solvent({ name: "DMSO", density: 2.0, volumeRatio: 1 }),
    ],
    solutes: [solute({ name: "X", amount: "1", unit: "mol", molarMass: 100 })],
  })
  const s = concentrationSummary(r, [r])

  test("solvent basis uses the summed solvent volume (5 mL, not 4 or 1)", () => {
    expect(s.entries[0].molPerMlSolvent! * 1000).toBeCloseTo(1000 / 5, 6)
  })

  test("solvent mass is ratio-weighted: 4 mL × 1.0 + 1 mL × 2.0 = 6 g", () => {
    // solute mass = 1 mol × 100 g/mol = 100 g; total mass = 106 g
    expect(s.entries[0].wPercent!).toBeCloseTo((100 / 106) * 100, 6)
  })
})

describe("stock solution", () => {
  // Stock: 1 mmol PbI2 in 1 mL DMF (no density → occupies no modelled volume,
  // so the stock's as-prepared volume is exactly 1 mL).
  const stock = recipe({
    id: "stock",
    totalSolventVolumeMl: "1",
    solvents: [solvent({ name: "DMF", density: 1.0 })],
    solutes: [
      solute({ name: "PbI2", amount: "1", unit: "mol", molarMass: 461 }),
    ],
  })
  // Take 0.5 mL of the stock (→ 0.5 mol PbI2, 0.5 mL DMF) and add 1.5 mL DMF.
  // Final: 2.0 mL total, 2.0 mL solvent, 0.5 mol PbI2 → 0.25 mol/mL = 250 mol/L.
  const mix = recipe({
    id: "mix",
    totalSolventVolumeMl: "1.5",
    solvents: [solvent({ name: "DMF", density: 1.0 })],
    addedSolutions: [{ recipeId: "stock", volumeMl: "0.5" }],
  })
  const s = concentrationSummary(mix, [stock, mix])

  test("the stock's solute shows up in the mixture", () => {
    expect(s.entries.map((e) => e.name)).toEqual(["PbI2"])
  })

  test("moles are scaled by the fraction of stock taken", () => {
    expect(molarity(s, "PbI2")!).toBeCloseTo(250, 6)
  })

  test("solvent basis includes the solvent carried in by the stock", () => {
    // 1.5 mL own + 0.5 mL from the stock = 2.0 mL, not 1.5
    expect(s.entries[0].molPerMlSolvent! * 1000).toBeCloseTo(
      0.5 / 2.0 / 0.001,
      6,
    )
  })

  test("total mass includes the stock's mass", () => {
    // solvent 2.0 mL × 1.0 = 2.0 g; solute 0.5 mol × 461 = 230.5 g
    expect(s.entries[0].wPercent!).toBeCloseTo((230.5 / 232.5) * 100, 4)
  })
})

describe("multi-solute total", () => {
  // 1 mmol PbI2 + 3 mmol MAI in 1 mL → total 4 mmol/mL = 4 mol/L.
  const r = recipe({
    id: "a",
    totalSolventVolumeMl: "1",
    solvents: [solvent({ name: "DMF", density: 1.0 })],
    solutes: [
      solute({ name: "PbI2", amount: "0.001", unit: "mol", molarMass: 461 }),
      solute({ name: "MAI", amount: "0.003", unit: "mol", molarMass: 158.97 }),
    ],
  })
  const s = concentrationSummary(r, [r])

  test("total is the sum of the components", () => {
    expect(totalMolarity(s)!).toBeCloseTo(
      molarity(s, "PbI2")! + molarity(s, "MAI")!,
      9,
    )
    expect(totalMolarity(s)!).toBeCloseTo(4, 6)
  })

  test("total %w/w is the sum of the component %w/w", () => {
    const sum = s.entries.reduce((a, e) => a + e.wPercent!, 0)
    expect(s.total!.wPercent!).toBeCloseTo(sum, 6)
  })
})

describe("PbX2 total", () => {
  // 1 mmol PbI2 + 3 mmol MAI in 1 mL → PbX2-only total is just the PbI2, 1 mol/L,
  // whereas the plain Total sums all solutes to 4 mol/L.
  const r = recipe({
    id: "a",
    totalSolventVolumeMl: "1",
    solvents: [solvent({ name: "DMF", density: 1.0 })],
    solutes: [
      solute({ name: "PbI2", amount: "0.001", unit: "mol", molarMass: 461 }),
      solute({ name: "MAI", amount: "0.003", unit: "mol", molarMass: 158.97 }),
    ],
  })
  const s = concentrationSummary(r, [r])

  test("counts only the lead halide, not the organic salt", () => {
    expect(totalPbX2Molarity(s)!).toBeCloseTo(1, 6)
    expect(totalPbX2Molarity(s)!).not.toBeCloseTo(totalMolarity(s)!, 6)
  })

  test("is labelled 'Total (PbX2)'", () => {
    expect(s.totalPbX2!.name).toBe("Total (PbX2)")
  })

  test("mixed lead halides (PbI2 + PbBr2) are both counted", () => {
    const mixed = recipe({
      id: "b",
      totalSolventVolumeMl: "1",
      solvents: [solvent({ name: "DMF", density: 1.0 })],
      solutes: [
        solute({ name: "PbI2", amount: "0.0007", unit: "mol", molarMass: 461 }),
        solute({
          name: "PbBr2",
          amount: "0.0003",
          unit: "mol",
          molarMass: 367,
        }),
        solute({
          name: "MAI",
          amount: "0.003",
          unit: "mol",
          molarMass: 158.97,
        }),
      ],
    })
    const sMixed = concentrationSummary(mixed, [mixed])
    expect(totalPbX2Molarity(sMixed)!).toBeCloseTo(1, 6)
  })

  test("recognizes a lead halide via pubchemCid even with a nonstandard name", () => {
    const r2 = recipe({
      id: "c",
      totalSolventVolumeMl: "1",
      solvents: [solvent({ name: "DMF", density: 1.0 })],
      solutes: [
        solute({
          name: "Lead iodide",
          pubchemCid: "24931",
          amount: "0.001",
          unit: "mol",
          molarMass: 461,
        }),
      ],
    })
    const s2 = concentrationSummary(r2, [r2])
    expect(totalPbX2Molarity(s2)!).toBeCloseTo(1, 6)
  })

  test("no lead halide present → totalPbX2 is null", () => {
    const noLead = recipe({
      id: "d",
      totalSolventVolumeMl: "1",
      solvents: [solvent({ name: "DMF", density: 1.0 })],
      solutes: [
        solute({
          name: "MAI",
          amount: "0.003",
          unit: "mol",
          molarMass: 158.97,
        }),
      ],
    })
    const sNoLead = concentrationSummary(noLead, [noLead])
    expect(sNoLead.totalPbX2).toBeNull()
  })
})

describe("commercial solutions", () => {
  const commercial = recipe({
    id: "c",
    name: "PEDOT:PSS",
    isCommercial: true,
    solutes: [solute({ name: "PEDOT:PSS" })],
  })

  test("a commercial product on its own yields no concentration", () => {
    const s = concentrationSummary(commercial, [commercial])
    expect(s.entries).toEqual([])
    expect(s.total).toBeNull()
    expect(s.dilution).toBeNull()
  })

  test("a dilution of it reports the dilution level, not a molarity", () => {
    // 1 mL commercial + 4 mL water → 5 mL total → 1:5, 20 % v/v
    const dil = recipe({
      id: "d",
      totalSolventVolumeMl: "4",
      solvents: [solvent({ name: "Water", density: 1.0 })],
      addedSolutions: [{ recipeId: "c", volumeMl: "1" }],
    })
    const s = concentrationSummary(dil, [commercial, dil])
    expect(s.dilution!.factor).toBeCloseTo(5, 6)
    expect(s.dilution!.percentVv).toBeCloseTo(20, 6)
    expect(s.entries).toEqual([])
    expect(s.incomplete).toBe(true)
  })

  test("a known solute alongside commercial product keeps its total-basis molarity", () => {
    const mix = recipe({
      id: "m",
      totalSolventVolumeMl: "4",
      solvents: [solvent({ name: "Water", density: 1.0 })],
      solutes: [
        solute({ name: "X", amount: "0.005", unit: "mol", molarMass: 50 }),
      ],
      addedSolutions: [{ recipeId: "c", volumeMl: "1" }],
    })
    const s = concentrationSummary(mix, [commercial, mix])
    // 5 mL total (the solute has no density, so it adds no volume)
    expect(molarity(s, "X")!).toBeCloseTo(1, 6)
    // solvent basis is unknowable: the commercial mL is of unknown solvent content
    expect(s.entries[0].molPerMlSolvent).toBeNull()
    expect(s.dilution!.factor).toBeCloseTo(5, 6)
  })
})

describe("degenerate input", () => {
  test("a reference cycle terminates instead of overflowing the stack", () => {
    const a = recipe({
      id: "a",
      totalSolventVolumeMl: "1",
      addedSolutions: [{ recipeId: "b", volumeMl: "1" }],
    })
    const b = recipe({
      id: "b",
      totalSolventVolumeMl: "1",
      addedSolutions: [{ recipeId: "a", volumeMl: "1" }],
    })
    const s = concentrationSummary(a, [a, b])
    expect(s.incomplete).toBe(true)
  })

  test("a solute with no molar mass marks the summary incomplete", () => {
    const r = recipe({
      id: "a",
      totalSolventVolumeMl: "1",
      solvents: [solvent({ name: "DMF", density: 1.0 })],
      solutes: [solute({ name: "X", amount: "10", unit: "mg" })],
    })
    const s = concentrationSummary(r, [r])
    expect(s.incomplete).toBe(true)
    expect(s.entries[0].molPerMlTotal).toBeNull()
    expect(s.entries[0].wPercent).toBeCloseTo((0.01 / 1.01) * 100, 6)
  })
})
