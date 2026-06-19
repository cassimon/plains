import { summariseQuenchingValue } from "@/components/QuenchingModal"
import {
  PROCESS_PARAMETER_DEFINITIONS,
  type Process,
  type ProcessSolute,
  type ProcessSolutionRecipe,
  type ProcessSolvent,
  type ProcessStep,
} from "@/store/AppContext"

// ─────────────────────────────────────────────────────────────────────────────
// Public input type (unchanged — call sites in Processes.page.tsx stay the same)
// ─────────────────────────────────────────────────────────────────────────────

type NamedEntity = { id: string; name: string }

type ProcessExportInput = {
  process: Process
  materials: NamedEntity[]
  solutions: NamedEntity[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal model types
// ─────────────────────────────────────────────────────────────────────────────

type SolventRow = { name: string; volumeMl: number }
type SoluteRow = {
  name: string
  amount: string
  unit: string
  concentrationMolL: string | null
}
type AddedSolutionRow = { name: string; volumeMl: string }

type ChemistrySection = {
  index: number
  name: string
  type?: string
  isCommercial: boolean
  commercialName?: string
  supplierNumber?: string
  handlingPreparation?: string
  handlingBeforeUse?: string
  totalSolventVolumeMl: number
  solvents: SolventRow[]
  solutes: SoluteRow[]
  addedSolutions: AddedSolutionRow[]
}

type ParamRow = { label: string; value: string; unit?: string }

type StepSection = {
  altLabel: string
  depositionMethod: string
  category: string
  materialLabel: string
  recipeRef: string | null
  params: ParamRow[]
  notes?: string
}

type StageSection = {
  stageNumber: number
  hasMultipleAlts: boolean
  alternatives: StepSection[]
}

type SubstrateRow = {
  name: string
  rigidity: string
  size: string
  heightMm: string
  roughnessNm: string
}

type StackLayer = {
  name: string
  type: string
  thicknessNm: string
  bandgapEv: string
  perovskiteComposition: string
}

type DeviceStackSection = {
  index: number
  architecture: string
  pixelAreaCm2: string
  numberOfPixels: string
  layers: StackLayer[]
  hasPerovskite: boolean
}

type ProcessExportModel = {
  processName: string
  description: string
  exportDate: string
  stageCount: number
  substrates: SubstrateRow[]
  chemistry: ChemistrySection[]
  stages: StageSection[]
  deviceStacks: DeviceStackSection[]
}

// ─────────────────────────────────────────────────────────────────────────────
// Label maps
// ─────────────────────────────────────────────────────────────────────────────

const STEP_CATEGORY_LABELS: Record<string, string> = {
  wet_deposition: "Wet Deposition",
  dry_deposition: "Dry Deposition",
  surface_treatment: "Surface Treatment",
  doping_aging: "Doping / Aging",
  substrate_preparation: "Substrate Preparation",
}

const LAYER_TYPE_LABELS: Record<string, string> = {
  etl: "ETL",
  htl: "HTL",
  perovskite: "Perovskite",
  additional: "Additional",
  back_contact: "Back Contact",
}

// ─────────────────────────────────────────────────────────────────────────────
// Calculation helpers
// ─────────────────────────────────────────────────────────────────────────────

function computeMolarConcentration(
  solute: ProcessSolute,
  totalSolventVolumeMl: number,
): string | null {
  if (!solute.molarMass || totalSolventVolumeMl <= 0) return null
  const amount = parseFloat(solute.amount)
  if (Number.isNaN(amount) || amount <= 0) return null
  const solventL = totalSolventVolumeMl / 1000
  let moles: number
  if (solute.unit === "mg") {
    moles = amount / 1000 / solute.molarMass
  } else if (solute.unit === "mol") {
    moles = amount
  } else {
    // "ml" — needs density
    if (!solute.density) return null
    moles = (amount * solute.density) / solute.molarMass
  }
  return `${(moles / solventL).toFixed(3)} M`
}

function distributeSolventVolumes(
  solvents: ProcessSolvent[],
  totalVolumeMl: number,
): SolventRow[] {
  const totalRatio = solvents.reduce((s, v) => s + (v.volumeRatio || 0), 0) || 1
  return solvents.map((sv) => ({
    name: sv.name || "Solvent",
    volumeMl: (sv.volumeRatio / totalRatio) * totalVolumeMl,
  }))
}

function buildParamRows(
  step: ProcessStep,
  materials: NamedEntity[],
  solutions: NamedEntity[],
): ParamRow[] {
  return PROCESS_PARAMETER_DEFINITIONS.flatMap(({ key, label, unit }) => {
    if (
      key === "depositionMethod" ||
      key === "depositionStartTime" ||
      key === "annealingStartTime"
    ) {
      return []
    }
    const value = step[key]?.value?.trim()
    if (!value) return []
    if (key === "dryingMethod") {
      const summary = summariseQuenchingValue(value, materials, solutions)
      const display = summary
        ? summary.replace(/^D\/Q:\s*/, "").replace(/\s*\|\s*/g, ", ")
        : value
      return [{ label: "Drying / Quenching", value: display }]
    }
    return [{ label, value, unit: unit || undefined }]
  })
}

function resolveStepMaterialLabel(
  step: ProcessStep,
  recipes: ProcessSolutionRecipe[],
  materialNameById: Map<string, string>,
  solutionNameById: Map<string, string>,
  recipeIndexById: Map<string, number>,
): { label: string; recipeRef: string | null } {
  if (step.chemRecipeId) {
    const recipe = recipes.find((r) => r.id === step.chemRecipeId)
    const label = recipe?.name || "Unknown recipe"
    const idx = recipeIndexById.get(step.chemRecipeId)
    return {
      label,
      recipeRef: idx !== undefined ? `Chemistry §1.${idx + 1}` : null,
    }
  }
  if (step.inlineMaterial) {
    return {
      label: step.inlineMaterial.name || "Inline material",
      recipeRef: null,
    }
  }
  if (step.materialId) {
    return {
      label: materialNameById.get(step.materialId) || "Unknown material",
      recipeRef: null,
    }
  }
  if (step.solutionId) {
    return {
      label: solutionNameById.get(step.solutionId) || "Unknown solution",
      recipeRef: null,
    }
  }
  return { label: "—", recipeRef: null }
}

function alphabeticLabel(index: number): string {
  let n = index
  let label = ""
  do {
    label = String.fromCharCode(65 + (n % 26)) + label
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return label
}

function sanitizeFileBaseName(rawName: string): string {
  const raw = rawName.trim().toLowerCase()
  const sanitized = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return sanitized || "process-summary"
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

// ─────────────────────────────────────────────────────────────────────────────
// Build export model (pure data extraction + calculations)
// ─────────────────────────────────────────────────────────────────────────────

function buildProcessExportModel({
  process,
  materials,
  solutions,
}: ProcessExportInput): ProcessExportModel {
  const materialNameById = new Map(materials.map((m) => [m.id, m.name]))
  const solutionNameById = new Map(solutions.map((s) => [s.id, s.name]))
  const recipes = process.solutionRecipes ?? []

  // Collect recipe IDs referenced by any step, in stage order, deduped
  const referencedRecipeIds: string[] = []
  const seenIds = new Set<string>()
  for (const stage of process.stages) {
    for (const step of stage.alternatives) {
      if (step.chemRecipeId && !seenIds.has(step.chemRecipeId)) {
        seenIds.add(step.chemRecipeId)
        referencedRecipeIds.push(step.chemRecipeId)
      }
    }
  }

  const recipeIndexById = new Map(referencedRecipeIds.map((id, i) => [id, i]))

  // Chemistry sections
  const chemistry: ChemistrySection[] = referencedRecipeIds.map((id, i) => {
    const recipe = recipes.find((r) => r.id === id)
    if (!recipe) {
      return {
        index: i + 1,
        name: "Unknown Recipe",
        isCommercial: false,
        totalSolventVolumeMl: 0,
        solvents: [],
        solutes: [],
        addedSolutions: [],
      }
    }
    const totalMl = parseFloat(recipe.totalSolventVolumeMl) || 0
    return {
      index: i + 1,
      name: recipe.name,
      type: recipe.type || undefined,
      isCommercial: recipe.isCommercial ?? false,
      commercialName: recipe.commercialName || undefined,
      supplierNumber: recipe.supplierNumber || undefined,
      handlingPreparation: recipe.handlingPreparation?.trim() || undefined,
      handlingBeforeUse: recipe.handlingBeforeUse?.trim() || undefined,
      totalSolventVolumeMl: totalMl,
      solvents: distributeSolventVolumes(recipe.solvents, totalMl),
      solutes: recipe.solutes.map((sl) => ({
        name: sl.name || "Solute",
        amount: sl.amount,
        unit: sl.unit,
        concentrationMolL: computeMolarConcentration(sl, totalMl),
      })),
      addedSolutions: (recipe.addedSolutions ?? []).map((as) => ({
        name: recipes.find((r) => r.id === as.recipeId)?.name || "Unknown",
        volumeMl: as.volumeMl,
      })),
    }
  })

  // Stage sections
  const stages: StageSection[] = process.stages.map((stage, stageIdx) => ({
    stageNumber: stageIdx + 1,
    hasMultipleAlts: stage.alternatives.length > 1,
    alternatives: stage.alternatives.map((step, altIdx) => {
      const { label, recipeRef } = resolveStepMaterialLabel(
        step,
        recipes,
        materialNameById,
        solutionNameById,
        recipeIndexById,
      )
      return {
        altLabel:
          stage.alternatives.length > 1
            ? `Alternative ${alphabeticLabel(altIdx)}`
            : "Route",
        depositionMethod:
          step.depositionMethod?.value?.trim() || step.name || "Deposition",
        category: STEP_CATEGORY_LABELS[step.stepCategory] || step.stepCategory,
        materialLabel: label,
        recipeRef,
        params: buildParamRows(step, materials, solutions),
        notes: step.notes?.trim() || undefined,
      }
    }),
  }))

  // Substrates
  const substrates: SubstrateRow[] = (process.inlineSubstrates ?? []).map(
    (s) => ({
      name: s.name || "Substrate",
      rigidity:
        s.rigidity === "rigid"
          ? "Rigid"
          : s.rigidity === "flexible"
            ? "Flexible"
            : "—",
      size: s.lengthCm && s.widthCm ? `${s.lengthCm} × ${s.widthCm}` : "—",
      heightMm: s.heightMm || "—",
      roughnessNm: s.surfaceRoughnessRmsNm || "—",
    }),
  )

  // Device stacks
  const deviceStacks: DeviceStackSection[] = (
    process.generatedStacks ?? []
  ).map((stack, i) => {
    const hasPerovskite = stack.layers.some(
      (l) => l.perovskiteA || l.perovskiteB || l.perovskiteX,
    )
    return {
      index: i + 1,
      architecture: stack.architecture || "—",
      pixelAreaCm2: stack.pixelAreaCm2 || "—",
      numberOfPixels: stack.numberOfPixels || "—",
      layers: [...stack.layers].reverse().map((l) => ({
        name: l.name || "Layer",
        type: LAYER_TYPE_LABELS[l.layerType] || l.layerType || "—",
        thicknessNm: l.thicknessNm || "—",
        bandgapEv: l.bandgapEv || "—",
        perovskiteComposition:
          [l.perovskiteA, l.perovskiteB, l.perovskiteX]
            .filter(Boolean)
            .join(" / ") || "—",
      })),
      hasPerovskite,
    }
  })

  return {
    processName: process.name || "Untitled Process",
    description: process.description?.trim() || "",
    exportDate: new Date().toLocaleDateString("en-GB", {
      year: "numeric",
      month: "long",
      day: "numeric",
    }),
    stageCount: process.stages.length,
    substrates,
    chemistry,
    stages,
    deviceStacks,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF rendering
// ─────────────────────────────────────────────────────────────────────────────

function drawPdfTable(
  doc: any,
  headers: string[],
  rows: string[][],
  colWidths: number[],
  x: number,
  startY: number,
  margin: number,
  pageHeight: number,
): number {
  const cellPadH = 5
  const cellPadV = 5
  const fontSize = 9
  const lineH = 12
  doc.setFontSize(fontSize)

  const computeRowHeight = (cells: string[]) => {
    const maxLines = Math.max(
      1,
      ...cells.map((cell, i) => {
        const w = (colWidths[i] ?? 80) - cellPadH * 2
        return doc.splitTextToSize(String(cell), w).length
      }),
    )
    return maxLines * lineH + cellPadV * 2
  }

  const totalWidth = colWidths.reduce((s, w) => s + w, 0)
  let y = startY

  const drawRow = (
    cells: string[],
    rowY: number,
    bold: boolean,
    fillRgb: [number, number, number],
  ) => {
    const rowHeight = computeRowHeight(cells)
    doc.setFillColor(...fillRgb)
    doc.rect(x, rowY, totalWidth, rowHeight, "F")
    doc.setDrawColor(190, 190, 190)
    doc.setLineWidth(0.3)
    doc.rect(x, rowY, totalWidth, rowHeight, "S")

    doc.setFont("helvetica", bold ? "bold" : "normal")
    doc.setFontSize(fontSize)
    doc.setTextColor(30, 30, 30)

    let cellX = x
    cells.forEach((cell, i) => {
      const cellWidth = colWidths[i] ?? 80
      const textWidth = cellWidth - cellPadH * 2
      const lines: string[] = doc.splitTextToSize(String(cell), textWidth)
      lines.forEach((line: string, lineIdx: number) => {
        doc.text(
          line,
          cellX + cellPadH,
          rowY + cellPadV + lineH * 0.82 + lineIdx * lineH,
        )
      })
      // inner vertical divider
      if (i < cells.length - 1) {
        doc.setDrawColor(210, 210, 210)
        doc.line(cellX + cellWidth, rowY, cellX + cellWidth, rowY + rowHeight)
      }
      cellX += cellWidth
    })
    return rowHeight
  }

  // header row
  const headerHeight = computeRowHeight(headers)
  if (y + headerHeight > pageHeight - margin) {
    doc.addPage()
    y = margin
  }
  drawRow(headers, y, true, [224, 231, 245])
  y += headerHeight

  // data rows
  rows.forEach((row, rowIdx) => {
    const rowHeight = computeRowHeight(row)
    if (y + rowHeight > pageHeight - margin) {
      doc.addPage()
      y = margin
    }
    const fill: [number, number, number] =
      rowIdx % 2 === 0 ? [255, 255, 255] : [248, 249, 251]
    drawRow(row, y, false, fill)
    y += rowHeight
  })

  return y
}

async function renderPdfFromModel(
  model: ProcessExportModel,
  doc: any,
): Promise<void> {
  const margin = 50
  const pageWidth: number = doc.internal.pageSize.getWidth()
  const pageHeight: number = doc.internal.pageSize.getHeight()
  const contentWidth = pageWidth - margin * 2
  let y = margin

  function ensureSpace(needed: number) {
    if (y + needed > pageHeight - margin) {
      doc.addPage()
      y = margin
    }
  }

  function writeTitle(text: string) {
    ensureSpace(32)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(18)
    doc.setTextColor(25, 25, 60)
    doc.text(text, margin, y)
    y += 26
  }

  function writeSectionHeading(num: string, text: string) {
    ensureSpace(34)
    y += 10
    doc.setFont("helvetica", "bold")
    doc.setFontSize(13)
    doc.setTextColor(30, 80, 180)
    doc.text(`${num}  ${text}`, margin, y)
    y += 5
    doc.setDrawColor(30, 80, 180)
    doc.setLineWidth(0.6)
    doc.line(margin, y, margin + contentWidth, y)
    doc.setLineWidth(0.2)
    y += 9
  }

  function writeSubHeading(text: string) {
    ensureSpace(22)
    y += 4
    doc.setFont("helvetica", "bold")
    doc.setFontSize(11)
    doc.setTextColor(40, 40, 40)
    doc.text(text, margin, y)
    y += 14
  }

  function writeMiniHeading(text: string) {
    ensureSpace(14)
    doc.setFont("helvetica", "bold")
    doc.setFontSize(9)
    doc.setTextColor(80, 80, 80)
    doc.text(text, margin, y)
    y += 11
  }

  function writeLabelValue(label: string, value: string) {
    ensureSpace(14)
    doc.setFontSize(10)
    doc.setFont("helvetica", "bold")
    doc.setTextColor(50, 50, 50)
    const labelText = `${label}: `
    const labelWidth = doc.getTextWidth(labelText)
    doc.text(labelText, margin, y)
    doc.setFont("helvetica", "normal")
    const valueLines: string[] = doc.splitTextToSize(
      value,
      contentWidth - labelWidth,
    )
    doc.text(valueLines[0] ?? "", margin + labelWidth, y)
    y += 13
    for (let i = 1; i < valueLines.length; i++) {
      ensureSpace(13)
      doc.text(valueLines[i], margin + labelWidth, y)
      y += 13
    }
  }

  function writeBullet(text: string) {
    ensureSpace(13)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(10)
    doc.setTextColor(50, 50, 50)
    const bulletWidth = doc.getTextWidth("  • ")
    doc.text("  •", margin, y)
    const lines: string[] = doc.splitTextToSize(
      text,
      contentWidth - bulletWidth,
    )
    lines.forEach((line: string, i: number) => {
      ensureSpace(13)
      doc.text(line, margin + bulletWidth, y + i * 13)
    })
    y += lines.length * 13
  }

  function writeNote(text: string) {
    ensureSpace(13)
    doc.setFont("helvetica", "italic")
    doc.setFontSize(9)
    doc.setTextColor(90, 90, 90)
    const lines: string[] = doc.splitTextToSize(text, contentWidth)
    lines.forEach((line: string) => {
      ensureSpace(12)
      doc.text(line, margin, y)
      y += 12
    })
  }

  // ── Title block ──────────────────────────────────────────────────────────────
  writeTitle(model.processName)
  if (model.description) {
    writeNote(model.description)
    y += 2
  }
  writeLabelValue("Export Date", model.exportDate)
  writeLabelValue(
    "Process",
    `${model.stageCount} stage${model.stageCount !== 1 ? "s" : ""}${model.chemistry.length > 0 ? `, ${model.chemistry.length} solution recipe${model.chemistry.length !== 1 ? "s" : ""}` : ""}`,
  )
  y += 4

  // ── Section 1: Chemistry ─────────────────────────────────────────────────────
  if (model.chemistry.length > 0) {
    writeSectionHeading("1.", "Chemistry — Solution Preparation")

    for (const chem of model.chemistry) {
      const badge = chem.isCommercial ? "[COMMERCIAL]" : "[LAB PREPARED]"
      writeSubHeading(`1.${chem.index}  ${chem.name}  ${badge}`)

      if (chem.type) writeLabelValue("Type", chem.type)

      if (chem.isCommercial) {
        if (chem.commercialName)
          writeLabelValue("Commercial Name", chem.commercialName)
        if (chem.supplierNumber)
          writeLabelValue("Supplier / Ref.", chem.supplierNumber)
      } else {
        // Solvents table
        if (chem.solvents.length > 0) {
          writeLabelValue(
            "Total Solvent Volume",
            `${chem.totalSolventVolumeMl} mL`,
          )
          y += 2
          writeMiniHeading("Solvents")
          const solventColW = [
            contentWidth * 0.55,
            contentWidth * 0.25,
            contentWidth * 0.2,
          ]
          y = drawPdfTable(
            doc,
            ["Solvent", "Volume (mL)", "Ratio"],
            chem.solvents.map((sv) => [
              sv.name,
              sv.volumeMl.toFixed(2),
              String(
                Math.round(
                  (sv.volumeMl / (chem.totalSolventVolumeMl || 1)) *
                    chem.solvents.reduce((s, v) => s + v.volumeMl, 0),
                ),
              ),
            ]),
            solventColW,
            margin,
            y,
            margin,
            pageHeight,
          )
          y += 6
        }

        // Solutes table
        if (chem.solutes.length > 0) {
          writeMiniHeading("Solutes")
          const hasConcData = chem.solutes.some(
            (sl) => sl.concentrationMolL !== null,
          )
          const soluteHeaders = hasConcData
            ? ["Compound", "Amount", "Unit", "Concentration (mol/L)"]
            : ["Compound", "Amount", "Unit"]
          const soluteRows = chem.solutes.map((sl) =>
            hasConcData
              ? [sl.name, sl.amount, sl.unit, sl.concentrationMolL ?? "—"]
              : [sl.name, sl.amount, sl.unit],
          )
          const soluteColW = hasConcData
            ? [
                contentWidth * 0.38,
                contentWidth * 0.14,
                contentWidth * 0.14,
                contentWidth * 0.34,
              ]
            : [contentWidth * 0.55, contentWidth * 0.25, contentWidth * 0.2]
          y = drawPdfTable(
            doc,
            soluteHeaders,
            soluteRows,
            soluteColW,
            margin,
            y,
            margin,
            pageHeight,
          )
          y += 6
        }

        // Added solutions
        if (chem.addedSolutions.length > 0) {
          writeMiniHeading("Added Solutions (pre-mixed)")
          for (const as of chem.addedSolutions) {
            writeBullet(`${as.name}: ${as.volumeMl} mL`)
          }
          y += 2
        }
      }

      if (chem.handlingPreparation) {
        writeLabelValue("Preparation Notes", chem.handlingPreparation)
      }
      if (chem.handlingBeforeUse) {
        writeLabelValue("Notes Before Use", chem.handlingBeforeUse)
      }
      y += 6
    }
  }

  // ── Section 2: Process Steps ─────────────────────────────────────────────────
  const stepsSection = model.chemistry.length > 0 ? "2." : "1."
  writeSectionHeading(
    stepsSection,
    `Process Steps  (${model.stageCount} stage${model.stageCount !== 1 ? "s" : ""})`,
  )

  for (const stage of model.stages) {
    const altCount = stage.alternatives.length
    const stageLabel = `Step ${stage.stageNumber} of ${model.stageCount}${altCount > 1 ? `  [${altCount} alternatives]` : ""}`
    writeSubHeading(stageLabel)

    for (const alt of stage.alternatives) {
      if (stage.hasMultipleAlts) {
        ensureSpace(14)
        doc.setFont("helvetica", "bold")
        doc.setFontSize(10)
        doc.setTextColor(60, 80, 140)
        doc.text(`${alt.altLabel}:`, margin, y)
        y += 13
      }

      writeLabelValue("Deposition Method", alt.depositionMethod)
      writeLabelValue("Category", alt.category)
      const matLine = alt.recipeRef
        ? `${alt.materialLabel}  (→ ${alt.recipeRef})`
        : alt.materialLabel
      writeLabelValue("Material / Solution", matLine)

      if (alt.params.length > 0) {
        y += 2
        writeMiniHeading("Process Parameters")
        const paramRows = alt.params.map((p) => [
          p.label,
          `${p.value}${p.unit ? ` ${p.unit}` : ""}`,
        ])
        y = drawPdfTable(
          doc,
          ["Parameter", "Value"],
          paramRows,
          [contentWidth * 0.42, contentWidth * 0.58],
          margin,
          y,
          margin,
          pageHeight,
        )
        y += 4
      }

      if (alt.notes) {
        writeLabelValue("Notes", alt.notes)
      }

      if (stage.hasMultipleAlts) y += 4
    }
    y += 4
  }

  // ── Section 3: Substrates ────────────────────────────────────────────────────
  if (model.substrates.length > 0) {
    const subsSection =
      model.chemistry.length > 0 ? "3." : model.stages.length > 0 ? "2." : "1."
    writeSectionHeading(subsSection, "Substrate Specifications")
    y = drawPdfTable(
      doc,
      ["Name", "Rigidity", "Size (cm)", "Height (mm)", "Roughness (RMS nm)"],
      model.substrates.map((s) => [
        s.name,
        s.rigidity,
        s.size,
        s.heightMm,
        s.roughnessNm,
      ]),
      [
        contentWidth * 0.3,
        contentWidth * 0.12,
        contentWidth * 0.18,
        contentWidth * 0.15,
        contentWidth * 0.25,
      ],
      margin,
      y,
      margin,
      pageHeight,
    )
    y += 8
  }

  // ── Section 4: Device Stacks ─────────────────────────────────────────────────
  if (model.deviceStacks.length > 0) {
    let sectionN = 1
    if (model.chemistry.length > 0) sectionN++
    if (model.stages.length > 0) sectionN++
    if (model.substrates.length > 0) sectionN++
    writeSectionHeading(`${sectionN}.`, "Device Stacks")

    for (const stack of model.deviceStacks) {
      writeSubHeading(`Stack ${stack.index}`)
      writeLabelValue("Architecture", stack.architecture)
      if (stack.pixelAreaCm2 !== "—")
        writeLabelValue("Pixel Area", `${stack.pixelAreaCm2} cm²`)
      if (stack.numberOfPixels !== "—")
        writeLabelValue("Number of Pixels", stack.numberOfPixels)
      y += 2

      const stackHeaders = stack.hasPerovskite
        ? [
            "Layer",
            "Type",
            "Thickness (nm)",
            "Bandgap (eV)",
            "Perovskite (A/B/X)",
          ]
        : ["Layer", "Type", "Thickness (nm)", "Bandgap (eV)"]
      const stackRows = stack.layers.map((l) =>
        stack.hasPerovskite
          ? [
              l.name,
              l.type,
              l.thicknessNm,
              l.bandgapEv,
              l.perovskiteComposition,
            ]
          : [l.name, l.type, l.thicknessNm, l.bandgapEv],
      )
      const stackColW = stack.hasPerovskite
        ? [
            contentWidth * 0.25,
            contentWidth * 0.15,
            contentWidth * 0.15,
            contentWidth * 0.15,
            contentWidth * 0.3,
          ]
        : [
            contentWidth * 0.35,
            contentWidth * 0.2,
            contentWidth * 0.22,
            contentWidth * 0.23,
          ]
      y = drawPdfTable(
        doc,
        stackHeaders,
        stackRows,
        stackColW,
        margin,
        y,
        margin,
        pageHeight,
      )
      y += 8
    }
  }

  // ── Page numbers ─────────────────────────────────────────────────────────────
  const totalPages: number = doc.internal.getNumberOfPages()
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i)
    doc.setFont("helvetica", "normal")
    doc.setFontSize(8)
    doc.setTextColor(160, 160, 160)
    if (i > 1) {
      // header: process name on continuation pages
      doc.text(model.processName, margin, margin - 12)
    }
    // footer: page N of M, export date
    doc.text(`Page ${i} of ${totalPages}`, margin, pageHeight - 20)
    doc.text(model.exportDate, pageWidth - margin, pageHeight - 20, {
      align: "right",
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// DOCX rendering
// ─────────────────────────────────────────────────────────────────────────────

type DocxModule = typeof import("docx") & Record<string, any>

async function buildDocxChildren(
  model: ProcessExportModel,
  docx: DocxModule,
): Promise<any[]> {
  const {
    Paragraph,
    TextRun,
    HeadingLevel,
    Table,
    TableRow,
    TableCell,
    WidthType,
    BorderStyle,
    ShadingType,
  } = docx

  const children: any[] = []

  function labelValuePara(label: string, value: string): any {
    return new Paragraph({
      children: [
        new TextRun({ text: `${label}: `, bold: true, size: 20 }),
        new TextRun({ text: value, size: 20 }),
      ],
      spacing: { before: 20, after: 20 },
    })
  }

  function makeTable(
    headers: string[],
    rows: string[][],
    _colWidths?: number[],
  ): any {
    const pct = WidthType.PERCENTAGE
    const totalPct = 100

    const makeCell = (text: string, isHeader: boolean, rowIdx?: number): any =>
      new TableCell({
        children: [
          new Paragraph({
            children: [
              new TextRun({ text, bold: isHeader, size: isHeader ? 18 : 18 }),
            ],
            spacing: { before: 60, after: 60 },
          }),
        ],
        shading: isHeader
          ? { type: ShadingType.SOLID, fill: "E0E7F5", color: "auto" }
          : (rowIdx ?? 0) % 2 === 0
            ? { type: ShadingType.SOLID, fill: "FFFFFF", color: "auto" }
            : { type: ShadingType.SOLID, fill: "F8F9FB", color: "auto" },
        margins: { top: 60, bottom: 60, left: 120, right: 120 },
      })

    const tableBorders = {
      top: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
      bottom: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
      left: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
      right: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
      insideH: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
      insideV: { style: BorderStyle.SINGLE, size: 4, color: "CCCCCC" },
    }

    return new Table({
      rows: [
        new TableRow({
          children: headers.map((h) => makeCell(h, true)),
          tableHeader: true,
        }),
        ...rows.map(
          (row, rowIdx) =>
            new TableRow({
              children: row.map((cell) => makeCell(cell, false, rowIdx)),
            }),
        ),
      ],
      width: { size: totalPct, type: pct },
      borders: tableBorders,
    })
  }

  function spacer(): any {
    return new Paragraph({ text: "", spacing: { before: 60, after: 60 } })
  }

  function hRule(): any {
    return new Paragraph({
      text: "",
      border: {
        bottom: { style: BorderStyle.SINGLE, size: 6, color: "1E50B4" },
      },
      spacing: { before: 120, after: 120 },
    })
  }

  // ── Title block ────────────────────────────────────────────────────────────
  children.push(
    new Paragraph({ text: model.processName, heading: HeadingLevel.TITLE }),
  )
  if (model.description) {
    children.push(
      new Paragraph({
        children: [
          new TextRun({ text: model.description, italics: true, size: 20 }),
        ],
        spacing: { before: 60, after: 60 },
      }),
    )
  }
  children.push(labelValuePara("Export Date", model.exportDate))
  children.push(
    labelValuePara(
      "Process",
      `${model.stageCount} stage${model.stageCount !== 1 ? "s" : ""}${model.chemistry.length > 0 ? `, ${model.chemistry.length} solution recipe${model.chemistry.length !== 1 ? "s" : ""}` : ""}`,
    ),
  )
  children.push(hRule())

  // ── Section 1: Chemistry ───────────────────────────────────────────────────
  if (model.chemistry.length > 0) {
    children.push(
      new Paragraph({
        text: "1. Chemistry — Solution Preparation",
        heading: HeadingLevel.HEADING_1,
      }),
    )

    for (const chem of model.chemistry) {
      const badge = chem.isCommercial ? " [COMMERCIAL]" : " [LAB PREPARED]"
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: `1.${chem.index}  ${chem.name}`,
              bold: true,
              size: 24,
            }),
            new TextRun({
              text: badge,
              bold: false,
              size: 20,
              color: chem.isCommercial ? "1A7F3C" : "1E50B4",
            }),
          ],
          heading: HeadingLevel.HEADING_2,
          spacing: { before: 200, after: 80 },
        }),
      )

      if (chem.type) children.push(labelValuePara("Type", chem.type))

      if (chem.isCommercial) {
        if (chem.commercialName)
          children.push(labelValuePara("Commercial Name", chem.commercialName))
        if (chem.supplierNumber)
          children.push(labelValuePara("Supplier / Ref.", chem.supplierNumber))
      } else {
        if (chem.solvents.length > 0) {
          children.push(
            labelValuePara(
              "Total Solvent Volume",
              `${chem.totalSolventVolumeMl} mL`,
            ),
          )
          children.push(
            new Paragraph({
              children: [
                new TextRun({ text: "Solvents", bold: true, size: 20 }),
              ],
              spacing: { before: 80, after: 40 },
            }),
          )
          children.push(
            makeTable(
              ["Solvent", "Volume (mL)", "Ratio"],
              chem.solvents.map((sv) => [
                sv.name,
                sv.volumeMl.toFixed(2),
                String(
                  Math.round(
                    (sv.volumeMl / (chem.totalSolventVolumeMl || 1)) *
                      chem.solvents.reduce((s, v) => s + v.volumeMl, 0),
                  ),
                ),
              ]),
            ),
          )
          children.push(spacer())
        }

        if (chem.solutes.length > 0) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({ text: "Solutes", bold: true, size: 20 }),
              ],
              spacing: { before: 80, after: 40 },
            }),
          )
          const hasConcData = chem.solutes.some(
            (sl) => sl.concentrationMolL !== null,
          )
          const soluteHeaders = hasConcData
            ? ["Compound", "Amount", "Unit", "Concentration (mol/L)"]
            : ["Compound", "Amount", "Unit"]
          const soluteRows = chem.solutes.map((sl) =>
            hasConcData
              ? [sl.name, sl.amount, sl.unit, sl.concentrationMolL ?? "—"]
              : [sl.name, sl.amount, sl.unit],
          )
          children.push(makeTable(soluteHeaders, soluteRows))
          children.push(spacer())
        }

        if (chem.addedSolutions.length > 0) {
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: "Added Solutions (pre-mixed)",
                  bold: true,
                  size: 20,
                }),
              ],
              spacing: { before: 80, after: 40 },
            }),
          )
          for (const as of chem.addedSolutions) {
            children.push(
              new Paragraph({
                children: [
                  new TextRun({
                    text: `${as.name}: ${as.volumeMl} mL`,
                    size: 20,
                  }),
                ],
                bullet: { level: 0 },
                spacing: { before: 20, after: 20 },
              }),
            )
          }
          children.push(spacer())
        }
      }

      if (chem.handlingPreparation) {
        children.push(
          labelValuePara("Preparation Notes", chem.handlingPreparation),
        )
      }
      if (chem.handlingBeforeUse) {
        children.push(
          labelValuePara("Notes Before Use", chem.handlingBeforeUse),
        )
      }
      children.push(spacer())
    }

    children.push(hRule())
  }

  // ── Section 2: Process Steps ───────────────────────────────────────────────
  const stepsNum = model.chemistry.length > 0 ? "2" : "1"
  children.push(
    new Paragraph({
      text: `${stepsNum}. Process Steps`,
      heading: HeadingLevel.HEADING_1,
    }),
  )

  for (const stage of model.stages) {
    const altCount = stage.alternatives.length
    const stageTitle = `Step ${stage.stageNumber} of ${model.stageCount}${altCount > 1 ? `  [${altCount} alternatives]` : ""}`
    children.push(
      new Paragraph({ text: stageTitle, heading: HeadingLevel.HEADING_2 }),
    )

    for (const alt of stage.alternatives) {
      if (stage.hasMultipleAlts) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({
                text: `${alt.altLabel}`,
                bold: true,
                color: "3C5099",
                size: 22,
              }),
            ],
            spacing: { before: 100, after: 60 },
          }),
        )
      }

      children.push(labelValuePara("Deposition Method", alt.depositionMethod))
      children.push(labelValuePara("Category", alt.category))
      const matLine = alt.recipeRef
        ? `${alt.materialLabel}  (→ ${alt.recipeRef})`
        : alt.materialLabel
      children.push(labelValuePara("Material / Solution", matLine))

      if (alt.params.length > 0) {
        children.push(
          new Paragraph({
            children: [
              new TextRun({ text: "Process Parameters", bold: true, size: 20 }),
            ],
            spacing: { before: 80, after: 40 },
          }),
        )
        children.push(
          makeTable(
            ["Parameter", "Value"],
            alt.params.map((p) => [
              p.label,
              `${p.value}${p.unit ? ` ${p.unit}` : ""}`,
            ]),
          ),
        )
        children.push(spacer())
      }

      if (alt.notes) {
        children.push(labelValuePara("Notes", alt.notes))
      }

      if (stage.hasMultipleAlts) children.push(spacer())
    }
    children.push(spacer())
  }

  children.push(hRule())

  // ── Section 3: Substrates ──────────────────────────────────────────────────
  if (model.substrates.length > 0) {
    let subsNum = 1
    if (model.chemistry.length > 0) subsNum++
    if (model.stages.length > 0) subsNum++
    children.push(
      new Paragraph({
        text: `${subsNum}. Substrate Specifications`,
        heading: HeadingLevel.HEADING_1,
      }),
    )
    children.push(
      makeTable(
        ["Name", "Rigidity", "Size (cm)", "Height (mm)", "Roughness (RMS nm)"],
        model.substrates.map((s) => [
          s.name,
          s.rigidity,
          s.size,
          s.heightMm,
          s.roughnessNm,
        ]),
      ),
    )
    children.push(hRule())
  }

  // ── Section 4: Device Stacks ───────────────────────────────────────────────
  if (model.deviceStacks.length > 0) {
    let stacksNum = 1
    if (model.chemistry.length > 0) stacksNum++
    if (model.stages.length > 0) stacksNum++
    if (model.substrates.length > 0) stacksNum++
    children.push(
      new Paragraph({
        text: `${stacksNum}. Device Stacks`,
        heading: HeadingLevel.HEADING_1,
      }),
    )

    for (const stack of model.deviceStacks) {
      children.push(
        new Paragraph({
          text: `Stack ${stack.index}`,
          heading: HeadingLevel.HEADING_2,
        }),
      )
      children.push(labelValuePara("Architecture", stack.architecture))
      if (stack.pixelAreaCm2 !== "—")
        children.push(labelValuePara("Pixel Area", `${stack.pixelAreaCm2} cm²`))
      if (stack.numberOfPixels !== "—")
        children.push(labelValuePara("Number of Pixels", stack.numberOfPixels))

      const stackHeaders = stack.hasPerovskite
        ? [
            "Layer",
            "Type",
            "Thickness (nm)",
            "Bandgap (eV)",
            "Perovskite (A/B/X)",
          ]
        : ["Layer", "Type", "Thickness (nm)", "Bandgap (eV)"]
      const stackRows = stack.layers.map((l) =>
        stack.hasPerovskite
          ? [
              l.name,
              l.type,
              l.thicknessNm,
              l.bandgapEv,
              l.perovskiteComposition,
            ]
          : [l.name, l.type, l.thicknessNm, l.bandgapEv],
      )
      children.push(spacer())
      children.push(makeTable(stackHeaders, stackRows))
      children.push(spacer())
    }
  }

  return children
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry points
// ─────────────────────────────────────────────────────────────────────────────

export async function exportProcessProtocolAsPdf(
  input: ProcessExportInput,
): Promise<void> {
  const model = buildProcessExportModel(input)
  const { jsPDF } = await import("jspdf")
  const doc = new jsPDF({ unit: "pt", format: "a4" })
  await renderPdfFromModel(model, doc)
  doc.save(`${sanitizeFileBaseName(model.processName)}.pdf`)
}

export async function exportProcessProtocolAsDocx(
  input: ProcessExportInput,
): Promise<void> {
  const model = buildProcessExportModel(input)
  const docx = (await import("docx")) as DocxModule
  const children = await buildDocxChildren(model, docx)
  const document = new docx.Document({ sections: [{ children }] })
  const blob = await docx.Packer.toBlob(document)
  triggerDownload(blob, `${sanitizeFileBaseName(model.processName)}.docx`)
}
