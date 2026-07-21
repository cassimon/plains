import type { ProcessSolute, ProcessSolutionRecipe } from "../store/AppContext"

// ── Volume / mole helpers ─────────────────────────────────────────────────────

export function soluteVolumeMl(s: ProcessSolute): number | null {
  const amt = Number(s.amount)
  if (!amt) return null
  if (s.unit === "ml") return amt
  if (s.unit === "mg" && s.density) return amt / (s.density * 1000)
  if (s.unit === "mol" && s.molarMass && s.density)
    return (amt * s.molarMass) / (s.density * 1000)
  return null
}

export function soluteMoles(s: ProcessSolute): number | null {
  const amt = Number(s.amount)
  if (!amt) return null
  if (s.unit === "mol") return amt
  if (s.unit === "mg" && s.molarMass) return amt / 1000 / s.molarMass
  if (s.unit === "ml" && s.density && s.molarMass)
    return (amt * s.density) / s.molarMass
  return null
}

export function soluteMassG(s: ProcessSolute): number | null {
  const amt = Number(s.amount)
  if (!amt) return null
  if (s.unit === "mg") return amt / 1000
  if (s.unit === "mol" && s.molarMass) return amt * s.molarMass
  if (s.unit === "ml" && s.density) return amt * s.density
  return null
}

// ── Concentration summary ─────────────────────────────────────────────────────

/** One solute of a solution, after stock solutions have been folded in. */
export type ResolvedComponent = {
  name: string
  pubchemCid: string
  /** null when the amount cannot be converted to moles (e.g. missing molar mass). */
  mol: number | null
  massG: number | null
}

// PubChem CIDs for the three lead(II) halides (PbI2, PbBr2, PbCl2) — the
// "PbX2" precursors whose combined molarity is the standard way perovskite
// literature reports precursor-solution concentration. Kept in sync with the
// matching entries in PEROVSKITE_MATERIAL_SUGGESTIONS (-Processes.chemistry.tsx).
const LEAD_HALIDE_PUBCHEM_CIDS = new Set(["24931", "139549", "24459"])
const LEAD_HALIDE_NAME_RE = /^pb(i2|br2|cl2)\b/i

/** Whether a component is a lead(II) halide (PbI2 / PbBr2 / PbCl2) precursor. */
function isLeadHalide(c: ResolvedComponent): boolean {
  if (c.pubchemCid && LEAD_HALIDE_PUBCHEM_CIDS.has(c.pubchemCid)) return true
  return LEAD_HALIDE_NAME_RE.test(c.name.trim())
}

/**
 * A solution reduced to absolute quantities, following `addedSolutions` down
 * into the stock solutions it is mixed from.
 */
export type ResolvedSolution = {
  /** As-prepared volume: solvent + the volume the solutes occupy + stock volumes. */
  totalVolMl: number
  /** Solvent volume, including the solvent inherited from non-commercial stocks. */
  solventVolMl: number
  /** Mass of the whole solution, or null if any density / molar mass is missing. */
  massG: number | null
  components: Map<string, ResolvedComponent>
  /** Volume of commercial product inside, whose composition is unknown by nature. */
  commercialVolMl: number
  /** Some content could not be quantified, so the totals below are a lower bound. */
  incomplete: boolean
}

function addComponent(
  map: Map<string, ResolvedComponent>,
  name: string,
  pubchemCid: string,
  mol: number | null,
  massG: number | null,
) {
  const prev = map.get(name)
  if (!prev) {
    map.set(name, { name, pubchemCid, mol, massG })
    return
  }
  prev.mol = prev.mol === null || mol === null ? null : prev.mol + mol
  prev.massG = prev.massG === null || massG === null ? null : prev.massG + massG
}

/**
 * Resolve a recipe into absolute amounts. Stock solutions contribute a fraction
 * `volume taken / volume as prepared` of everything they contain — their solutes
 * *and* their solvent — which is what makes the concentration of a solution mixed
 * from stocks come out right. Commercial products carry no amounts, so their
 * volume counts toward the mixture but nothing can be attributed to it; such a
 * mixture is described by its dilution instead of by a molarity.
 */
export function resolveSolution(
  recipe: ProcessSolutionRecipe,
  byId: Map<string, ProcessSolutionRecipe>,
  seen: ReadonlySet<string> = new Set(),
): ResolvedSolution {
  const out: ResolvedSolution = {
    totalVolMl: 0,
    solventVolMl: 0,
    massG: 0,
    components: new Map(),
    commercialVolMl: 0,
    incomplete: false,
  }
  // A commercial product has a composition but no amounts and no volume: it is
  // only ever meaningful as the thing a dilution is made from.
  if (recipe.isCommercial) {
    out.incomplete = true
    out.massG = null
    return out
  }

  // Solvents. The recipe stores one total solvent volume plus a volume ratio per
  // solvent, so the sum of the individual solvent volumes *is* totalSolventVolumeMl.
  const ownSolventVolMl = Number(recipe.totalSolventVolumeMl) || 0
  out.solventVolMl += ownSolventVolMl
  out.totalVolMl += ownSolventVolMl
  const totalRatio = recipe.solvents.reduce(
    (s, v) => s + (v.volumeRatio || 0),
    0,
  )
  for (const sv of recipe.solvents) {
    if (!sv.density || totalRatio <= 0) {
      out.massG = null
      continue
    }
    const volMl = (sv.volumeRatio / totalRatio) * ownSolventVolMl
    if (out.massG !== null) out.massG += volMl * sv.density
  }

  // Solutes weighed directly into this solution.
  for (const s of recipe.solutes) {
    if (!Number(s.amount)) continue
    const mol = soluteMoles(s)
    const massG = soluteMassG(s)
    if (mol === null) out.incomplete = true
    addComponent(out.components, s.name || "?", s.pubchemCid, mol, massG)
    out.totalVolMl += soluteVolumeMl(s) ?? 0
    if (massG === null) out.massG = null
    else if (out.massG !== null) out.massG += massG
  }

  // Stock solutions mixed in.
  for (const entry of recipe.addedSolutions ?? []) {
    const takenMl = Number(entry.volumeMl) || 0
    if (takenMl <= 0) continue
    out.totalVolMl += takenMl // the liquid is in the mixture either way

    const ref = byId.get(entry.recipeId)
    const sub =
      ref && !seen.has(ref.id)
        ? resolveSolution(ref, byId, new Set([...seen, recipe.id]))
        : null

    // Commercial product, dangling reference, or a reference cycle: real volume,
    // unattributable content.
    if (!ref || ref.isCommercial || sub === null || sub.totalVolMl <= 0) {
      if (ref?.isCommercial) out.commercialVolMl += takenMl
      out.incomplete = true
      out.massG = null
      continue
    }

    const fraction = takenMl / sub.totalVolMl
    out.solventVolMl += sub.solventVolMl * fraction
    out.commercialVolMl += sub.commercialVolMl * fraction
    for (const c of sub.components.values())
      addComponent(
        out.components,
        c.name,
        c.pubchemCid,
        c.mol === null ? null : c.mol * fraction,
        c.massG === null ? null : c.massG * fraction,
      )
    if (sub.massG === null) out.massG = null
    else if (out.massG !== null) out.massG += sub.massG * fraction
    if (sub.incomplete) out.incomplete = true
  }

  return out
}

export type ConcentrationEntry = {
  name: string
  molPerMlSolvent: number | null
  molPerMlTotal: number | null
  wPercent: number | null // %w/w: mass of solute / total solution mass × 100
}

export type ConcentrationSummary = {
  /** Per-solute concentrations, including solutes inherited from stock solutions. */
  entries: ConcentrationEntry[]
  /** All solutes summed — the concentration of the solution as a whole. */
  total: ConcentrationEntry | null
  /**
   * Sum of only the lead(II) halide (PbI2/PbBr2/PbCl2) components — the "total
   * mols of perovskite unit cells" molarity standard in perovskite literature,
   * as opposed to `total`'s sum over every solute. Null when the solution
   * contains no lead halide precursor.
   */
  totalPbX2: ConcentrationEntry | null
  /** Set when commercial product is mixed in: how far it has been diluted. */
  dilution: { factor: number; percentVv: number } | null
  /** Some content is unquantifiable, so the figures shown are a lower bound. */
  incomplete: boolean
}

export function concentrationSummary(
  recipe: ProcessSolutionRecipe,
  allRecipes: ProcessSolutionRecipe[],
): ConcentrationSummary {
  const byId = new Map(allRecipes.map((r) => [r.id, r]))
  const r = resolveSolution(recipe, byId)

  // Solvent-basis molarity needs a known solvent volume; commercial product
  // contributes liquid of unknown solvent content, so that basis is off the table.
  const solventBasisMl =
    r.commercialVolMl === 0 && r.solventVolMl > 0 ? r.solventVolMl : null

  const conc = (
    mol: number | null,
    massG: number | null,
  ): ConcentrationEntry => ({
    name: "",
    molPerMlSolvent:
      mol !== null && solventBasisMl !== null ? mol / solventBasisMl : null,
    molPerMlTotal: mol !== null && r.totalVolMl > 0 ? mol / r.totalVolMl : null,
    wPercent:
      massG !== null && r.massG !== null && r.massG > 0
        ? (massG / r.massG) * 100
        : null,
  })

  const components = [...r.components.values()]
  const entries = components
    .map((c) => ({ ...conc(c.mol, c.massG), name: c.name }))
    .filter(
      (e) =>
        e.molPerMlSolvent !== null ||
        e.molPerMlTotal !== null ||
        e.wPercent !== null,
    )

  const sumOf = (
    comps: ResolvedComponent[],
    pick: (c: ResolvedComponent) => number | null,
  ) =>
    comps.reduce<number | null>(
      (acc, c) => {
        const v = pick(c)
        return acc === null || v === null ? null : acc + v
      },
      comps.length > 0 ? 0 : null,
    )
  const sum = (pick: (c: ResolvedComponent) => number | null) =>
    sumOf(components, pick)
  const totalEntry = {
    ...conc(
      sum((c) => c.mol),
      sum((c) => c.massG),
    ),
    name: "Total",
  }
  const total =
    totalEntry.molPerMlSolvent !== null ||
    totalEntry.molPerMlTotal !== null ||
    totalEntry.wPercent !== null
      ? totalEntry
      : null

  const pbHalideComponents = components.filter(isLeadHalide)
  const totalPbX2Entry = {
    ...conc(
      sumOf(pbHalideComponents, (c) => c.mol),
      sumOf(pbHalideComponents, (c) => c.massG),
    ),
    name: "Total (PbX2)",
  }
  const totalPbX2 =
    pbHalideComponents.length > 0 &&
    (totalPbX2Entry.molPerMlSolvent !== null ||
      totalPbX2Entry.molPerMlTotal !== null ||
      totalPbX2Entry.wPercent !== null)
      ? totalPbX2Entry
      : null

  const dilution =
    r.commercialVolMl > 0 && r.totalVolMl > 0
      ? {
          factor: r.totalVolMl / r.commercialVolMl,
          percentVv: (r.commercialVolMl / r.totalVolMl) * 100,
        }
      : null

  return { entries, total, totalPbX2, dilution, incomplete: r.incomplete }
}
