# Plan: Improved Process Export (PDF & DOCX)

## Goal

Transform the export from a plain-text dump into a well-structured laboratory protocol that a
researcher can pick up and follow at the bench. The document should read as three clearly
delineated sections: chemistry preparation, deposition steps, and device stacks.

---

## Current State

`frontend/src/lib/processExport.ts` builds both formats from the same plain-text string
(`buildProcessProtocolText`). The PDF renders that string with `splitTextToSize`; the DOCX
converts each line to an unstyled `Paragraph`. Neither output uses tables, calculated values,
or visual hierarchy.

**What is missing:**
- Concentration calculations for each solution recipe
- Solvent volume breakdown per total batch volume
- Preparation and handling instructions (`handlingPreparation`, `handlingBeforeUse`)
- Commercial-product vs. lab-prepared distinction
- Solution recipe referenced by each step (with a cross-reference)
- Proper parameter tables (deposition method, atmosphere, spin speed, annealing, etc.)
- Inline substrate specifications (dimensions, rigidity)
- Device stack layers printed as a readable table
- Any visual styling: bold headers, tables, shading, page numbers

---

## Data Available (key fields)

### `ProcessSolutionRecipe`
```
id, name, type
isCommercial, commercialName, supplierNumber
handlingPreparation, handlingBeforeUse
totalSolventVolumeMl
solvents[]: { name, volumeRatio, molarMass?, density? }
solutes[]:  { name, amount, unit ("mg"|"mL"|"mol"), molarMass?, density? }
addedSolutions[]: { recipeId, volumeMl }
```

### `ProcessStep`
```
depositionMethod, depositionAtmosphere, depositionParameters
substrateTemp, solutionVolume
dryingMethod (encoded quenching value)
annealingTime, annealingTemp, annealingAtmosphere
chemRecipeId → links to ProcessSolutionRecipe
inlineMaterial → { name, type, molarMass?, density? }
stepCategory, notes
```

### `ProcessGeneratedStack`
```
architecture ("n-i-p" | "p-i-n")
pixelAreaCm2, numberOfPixels
layers[]: { name, layerType, thicknessNm, bandgapEv,
            perovskiteA, perovskiteB, perovskiteX, isSubstrate }
```

### `ProcessInlineSubstrate`
```
name, rigidity, lengthCm, widthCm, heightMm, surfaceRoughnessRmsNm
```

---

## Document Structure

### Cover / Header
- Process name (title)
- Description
- Export date
- Number of process stages, number of solution recipes

---

### Section 1 — Chemistry: Solution Preparation

One subsection per `ProcessSolutionRecipe` referenced by any step.

#### 1a. Commercial product
```
Recipe name          [badge: COMMERCIAL]
Commercial name:     <commercialName>
Supplier / Ref.:     <supplierNumber>
Preparation notes:   <handlingPreparation>
Notes before use:    <handlingBeforeUse>
```

#### 1b. Lab-prepared solution
```
Recipe name          [badge: LAB PREPARED]
Type:                <type>

Solvents (total volume: X mL)
┌──────────────┬─────────────┬──────────────┐
│ Solvent      │ Volume (mL) │ Ratio        │
├──────────────┼─────────────┼──────────────┤
│ DMF          │  800        │ 4            │
│ DMSO         │  200        │ 1            │
└──────────────┴─────────────┴──────────────┘

Solutes
┌────────────────────────┬──────────┬────────────┬──────────────────────┐
│ Compound               │ Amount   │ Unit       │ Concentration (mol/L)│
├────────────────────────┼──────────┼────────────┼──────────────────────┤
│ FAI                    │ 172.2    │ mg         │ 1.00 M               │
│ PbI₂                  │ 461.0    │ mg         │ 1.00 M               │
│ MACl                   │  17.2    │ mg         │ 0.20 M               │
└────────────────────────┴──────────┴────────────┴──────────────────────┘

Added solutions (pre-mixed):
  - <OtherRecipeName>: X mL

Preparation notes:  <handlingPreparation>
Notes before use:   <handlingBeforeUse>
```

**Concentration calculation** (implemented in a new helper `computeMolarConcentration`):
- Unit `mg`:   `c = (amount_mg / 1000 / molarMass_g_per_mol) / (totalSolventVolumeMl / 1000)`
- Unit `mol`:  `c = amount_mol / (totalSolventVolumeMl / 1000)`
- Unit `mL`:   `c = (amount_mL * density_g_per_mL / molarMass_g_per_mol) / (totalSolventVolumeMl / 1000)` (only when both density and molarMass are set)
- Show `—` when molarMass is absent.

**Solvent volume distribution:**
- `volumeForSolvent_i = (volumeRatio_i / sumOfAllRatios) * totalSolventVolumeMl`

---

### Section 2 — Process Steps

One subsection per process stage; each alternative step is a distinct sub-section.

#### Stage heading
```
Step 1 of N — [3 alternatives]
```

#### Per alternative
```
Alternative A (or the only route):
  Deposition Method:  Spin Coating
  Category:           Wet Deposition
  Material / Solution: FAPbI₃ Precursor   → see Chemistry §1.2
  
  Process Parameters
  ┌─────────────────────────────┬────────────────────────────────┐
  │ Parameter                   │ Value                          │
  ├─────────────────────────────┼────────────────────────────────┤
  │ Substrate Temperature       │ 70 °C                          │
  │ Deposition Atmosphere       │ N₂ glovebox                    │
  │ Deposition Parameters       │ 4000 rpm × 30 s                │
  │ Solution Volume             │ 50 µL                          │
  │ Drying / Quenching          │ Antisolvent: CB (150 µL @ 10 s)│
  │ Annealing Time              │ 20 min                         │
  │ Annealing Temperature       │ 150 °C                         │
  │ Annealing Atmosphere        │ N₂                             │
  └─────────────────────────────┴────────────────────────────────┘
  
  Notes: <step.notes>
```

Notes:
- Skip parameters with empty values.
- Skip `depositionStartTime` / `annealingStartTime` (timestamps, not useful in a printed protocol).
- `dryingMethod` is decoded via the existing `summariseQuenchingValue` helper and displayed in human-readable form.
- If the step uses a `chemRecipeId`, append "→ see Chemistry §X.Y" after the solution name.
- If the step uses an `inlineMaterial` (no recipe), show compound name and type only.

---

### Section 3 — Substrate Specifications

One row per inline substrate:

```
Substrates
┌───────────────────┬──────────┬────────────────┬──────────┬─────────────────────────┐
│ Name              │ Rigidity │ Size (cm×cm)   │ Height   │ Surface Roughness (RMS) │
├───────────────────┼──────────┼────────────────┼──────────┼─────────────────────────┤
│ ITO glass 1.1 mm  │ Rigid    │ 2.5 × 2.5      │ 1.1 mm   │ —                       │
└───────────────────┴──────────┴────────────────┴──────────┴─────────────────────────┘
```

---

### Section 4 — Device Stacks

One subsection per `ProcessGeneratedStack`. Stacks are ordered by `combination` index.

```
Stack 1
  Architecture:     n-i-p
  Pixel area:       0.10 cm²   |   Number of pixels: 6

  Layer Stack (top to bottom)
  ┌──────────────────────┬──────────────┬─────────────┬───────────────┬───────────────────────┐
  │ Layer                │ Type         │ Thickness   │ Bandgap (eV)  │ Perovskite (A/B/X)    │
  ├──────────────────────┼──────────────┼─────────────┼───────────────┼───────────────────────┤
  │ Ag back contact      │ Back Contact │ 100 nm      │ —             │ —                     │
  │ Spiro-OMeTAD         │ HTL          │  80 nm      │ 3.0           │ —                     │
  │ FAPbI₃               │ Perovskite   │ 500 nm      │ 1.55          │ FA / Pb / I           │
  │ SnO₂                 │ ETL          │  20 nm      │ 3.6           │ —                     │
  │ ITO glass            │ Substrate    │  —          │ —             │ —                     │
  └──────────────────────┴──────────────┴─────────────┴───────────────┴───────────────────────┘
```

Show layers ordered from top to bottom (reverse of the `layers[]` array which is bottom-up).
Omit perovskite columns entirely if no stack has a perovskite layer with a composition set.

---

## Implementation Plan

### 1. New shared data-shaping function

Add `buildProcessExportModel(input: ProcessExportInput): ProcessExportModel` to
`processExport.ts`. This separates "what to show" from "how to render it":

```ts
type ProcessExportModel = {
  meta: { name: string; description: string; exportDate: string; stageCount: number }
  substrates: SubstrateRow[]
  chemistryRecipes: ChemistrySection[]
  stages: StageSection[]
  deviceStacks: DeviceStackSection[]
}
```

All calculation helpers (concentrations, solvent volumes, quenching summary) run here once
and feed both the PDF and DOCX renderers.

### 2. New calculation helpers (all pure functions, no side effects)

```ts
// Returns "1.00 M" or null if molarMass is unavailable
function computeMolarConcentration(
  solute: ProcessSolute,
  totalSolventVolumeMl: number,
): string | null

// Returns each solvent's absolute volume in mL
function distributeSolventVolumes(
  solvents: ProcessSolvent[],
  totalVolumeMl: number,
): Array<{ name: string; volumeMl: number }>

// Resolves the human-readable label for a step's material/solution
function resolveStepMaterialLabel(
  step: ProcessStep,
  recipes: ProcessSolutionRecipe[],
): { label: string; recipeIndex: number | null }
```

### 3. PDF rendering (`exportProcessProtocolAsPdf`)

Replace `splitTextToSize` with structured rendering using jsPDF's drawing API:

- **Title block**: 16pt bold, process name; 10pt description below
- **Section headings**: 13pt bold, left-aligned, followed by a horizontal rule
- **Subsection headings**: 11pt bold
- **Tables**: drawn with `doc.rect()` lines, alternating gray fill on even rows
- **Parameter key–value pairs**: key in bold, value in regular weight
- **Page header**: process name + page number on every page after the first
- **Page footer**: export date, right-aligned

PDF table helper:
```ts
function drawTable(
  doc: jsPDF,
  headers: string[],
  rows: string[][],
  colWidths: number[],
  startX: number,
  startY: number,
  lineHeight: number,
): number // returns Y position after table
```

### 4. DOCX rendering (`exportProcessProtocolAsDocx`)

- **Title**: `HeadingLevel.TITLE`
- **Section headings**: `HeadingLevel.HEADING_1` with numbering
- **Subsection headings**: `HeadingLevel.HEADING_2`
- **Step alternative headings**: `HeadingLevel.HEADING_3`
- **Tables**: `docx.Table` with `docx.TableRow` / `docx.TableCell`; header row uses shaded fill (`#E8EAED`)
- **Bold labels** (`TextRun({ bold: true })`) for key fields
- **Horizontal rules** between major sections via `docx.Paragraph` with bottom border

### 5. `ProcessExportInput` extension

The existing input type passes only `{ id, name }` for materials and solutions. It does not
pass the full `Process.solutionRecipes` (those are embedded in `process` itself) so no
change is needed for chemistry. But the input should also include the full `Material[]` and
`Solution[]` objects (not just `NamedEntity[]`) so that `molarMass` and `density` fields on
materials can be used if the user has linked a library material instead of an inline one.

**Change:** Extend `ProcessExportInput.materials` to pass the full `Material[]`.
Update the two call sites in `Processes.page.tsx` (lines ~3359, ~3376) accordingly.

---

## Files Changed

| File | Change |
|------|--------|
| `frontend/src/lib/processExport.ts` | Rewrite export logic; add model builder + helpers |
| `frontend/src/routes/Processes.page.tsx` | Pass full `Material[]` to export functions |

No new dependencies needed — `jspdf` and `docx` are already installed.

---

## Out of Scope (not in this plan)

- Exporting a single experiment (not the process template)
- Exporting multiple processes at once
- CSV / Excel export
- Adding a print stylesheet for the web UI
- NOMAD integration changes
