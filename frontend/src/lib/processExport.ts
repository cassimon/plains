import {
  type PDFDocument,
  type PDFFont,
  type PDFForm,
  type PDFPage,
  rgb,
  StandardFonts,
} from "pdf-lib"
import {
  type QuenchingField,
  quenchingFields,
} from "@/components/QuenchingModal"
import type {
  ChemicalExportRow,
  SolutionExportRow,
} from "@/routes/-Experiments.chemicals"
import {
  type Experiment,
  PROCESS_PARAMETER_DEFINITIONS,
  type Process,
  type ProcessSolute,
  type ProcessSolutionRecipe,
  type ProcessSolvent,
  type ProcessStep,
  type Substrate,
} from "@/store/AppContext"
import {
  type EntityRefs,
  embedPayload,
  encodeFieldName,
  type FieldPath,
  type FieldSnapshot,
  serializeExperiment,
  serializeProcess,
} from "./pdfSchema"
import {
  buildStageStepOptions,
  resolveStageSelection,
  SKIP_STEP,
} from "./stageStepChoices"

// ─────────────────────────────────────────────────────────────────────────────
// Public input types
// ─────────────────────────────────────────────────────────────────────────────

type NamedEntity = { id: string; name: string }

type ProcessExportInput = {
  process: Process
  materials: NamedEntity[]
  solutions: NamedEntity[]
}

type ExperimentExportInput = {
  experiment: Experiment
  process: Process
  materials: NamedEntity[]
  solutions: NamedEntity[]
  /** Chemicals/solutions compiled by buildChemicalsExport in the caller. */
  chemicals: ChemicalExportRow[]
  solutionRows: SolutionExportRow[]
  /** Prepend the full Process protocol pages before the experiment section. */
  includeFullProcess: boolean
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal model types (rows carry entity ids so form fields can be addressed)
// ─────────────────────────────────────────────────────────────────────────────

type SolventRow = {
  id: string
  name: string
  volumeRatio: number
  volumeMl: number
}
type SoluteRow = {
  id: string
  name: string
  amount: string
  unit: string
  concentrationMolL: string | null
}
type AddedSolutionRow = { name: string; volumeMl: string }

type ChemistrySection = {
  index: number
  recipeId: string
  name: string
  type?: string
  isCommercial: boolean
  commercialName?: string
  supplierNumber?: string
  handlingPreparation?: string
  handlingBeforeUse?: string
  totalSolventVolumeMl: number
  totalSolventVolumeRaw: string
  solvents: SolventRow[]
  solutes: SoluteRow[]
  addedSolutions: AddedSolutionRow[]
}

type ParamRow = {
  key: string
  editable: boolean
  label: string
  value: string
  unit?: string
}

/** Drying / Quenching, decoded into individually-editable scalar parameters. */
type QuenchingSection = {
  type: string
  fields: QuenchingField[]
}

type StepSection = {
  stepId: string
  altLabel: string
  depositionMethod: string
  category: string
  materialLabel: string
  recipeRef: string | null
  params: ParamRow[]
  quenching?: QuenchingSection
  notes?: string
}

type StageSection = {
  stageNumber: number
  hasMultipleAlts: boolean
  alternatives: StepSection[]
}

type SubstrateRow = {
  id: string
  name: string
  rigidity: string
  lengthCm: string
  widthCm: string
  heightMm: string
  roughnessNm: string
}

type StackLayer = {
  id: string
  name: string
  type: string
  color: string
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
  processId: string
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

const SOLUTE_UNITS = ["mg", "ml", "mol"]

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
    id: sv.id,
    name: sv.name || "Solvent",
    volumeRatio: sv.volumeRatio || 0,
    volumeMl: (sv.volumeRatio / totalRatio) * totalVolumeMl,
  }))
}

/**
 * All process parameters are editable EXCEPT Drying/Quenching, which is a
 * composite string handled separately (see buildStepQuenching). Numeric-typed
 * parameters are validated as numbers on import; the rest are free text.
 */
function buildParamRows(step: ProcessStep): ParamRow[] {
  return PROCESS_PARAMETER_DEFINITIONS.flatMap(
    ({ key, label, unit }): ParamRow[] => {
      if (key === "dryingMethod") return [] // rendered as editable quench fields
      const value = step[key]?.value?.trim()
      if (!value) return []
      return [{ key, editable: true, label, value, unit: unit || undefined }]
    },
  )
}

/** Decode a step's Drying/Quenching value into editable scalar fields. */
function buildStepQuenching(
  step: ProcessStep,
  resolveMedia: (raw: string) => string,
): QuenchingSection | undefined {
  const value = step.dryingMethod?.value?.trim()
  if (!value) return undefined
  const { type, fields } = quenchingFields(value, resolveMedia)
  if (!type || fields.length === 0) return undefined
  return { type, fields }
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
  return { label: "-", recipeRef: null }
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
// WinAnsi sanitisation — StandardFonts.Helvetica can only encode the WinAnsi
// character set. Replace known specials and drop anything else so pdf-lib never
// throws when generating text / field appearances.
// ─────────────────────────────────────────────────────────────────────────────

const WINANSI_EXTRA = new Set<number>([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030,
  0x0160, 0x2039, 0x0152, 0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022,
  0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a, 0x0153, 0x017e, 0x0178,
])

const SPECIAL_REPLACEMENTS: Record<string, string> = {
  "→": "->",
  "←": "<-",
  "⟶": "->",
  "≥": ">=",
  "≤": "<=",
  "≈": "~",
  "‑": "-",
}

function sanitize(input: string): string {
  let out = ""
  for (const ch of input) {
    const repl = SPECIAL_REPLACEMENTS[ch]
    if (repl !== undefined) {
      out += repl
      continue
    }
    const cp = ch.codePointAt(0) ?? 0
    if (cp >= 0x20 && cp <= 0x7e) out += ch
    else if (cp >= 0xa0 && cp <= 0xff) out += ch
    else if (WINANSI_EXTRA.has(cp)) out += ch
    else out += "?"
  }
  return out
}

// ─────────────────────────────────────────────────────────────────────────────
// Build export model (pure data extraction + calculations)
// ─────────────────────────────────────────────────────────────────────────────

function buildProcessExportModel({
  process,
  materials,
  solutions,
}: {
  process: Process
  materials: NamedEntity[]
  solutions: NamedEntity[]
}): ProcessExportModel {
  const materialNameById = new Map(materials.map((m) => [m.id, m.name]))
  const solutionNameById = new Map(solutions.map((s) => [s.id, s.name]))
  const recipes = process.solutionRecipes ?? []

  // Antisolvent-quenching media is stored as a `kind:id` reference; resolve it to
  // a human name for the read-only media field (falls back to the raw value).
  const resolveMedia = (raw: string): string => {
    const idx = raw.indexOf(":")
    if (idx === -1) return raw
    const kind = raw.slice(0, idx)
    const id = raw.slice(idx + 1)
    if (kind === "material") return materialNameById.get(id) ?? raw
    if (kind === "solution") return solutionNameById.get(id) ?? raw
    if (kind === "recipe") return recipes.find((r) => r.id === id)?.name ?? raw
    return raw
  }

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
        recipeId: id,
        name: "Unknown Recipe",
        isCommercial: false,
        totalSolventVolumeMl: 0,
        totalSolventVolumeRaw: "",
        solvents: [],
        solutes: [],
        addedSolutions: [],
      }
    }
    const totalMl = parseFloat(recipe.totalSolventVolumeMl) || 0
    return {
      index: i + 1,
      recipeId: recipe.id,
      name: recipe.name,
      type: recipe.type || undefined,
      isCommercial: recipe.isCommercial ?? false,
      commercialName: recipe.commercialName || undefined,
      supplierNumber: recipe.supplierNumber || undefined,
      handlingPreparation: recipe.handlingPreparation?.trim() || undefined,
      handlingBeforeUse: recipe.handlingBeforeUse?.trim() || undefined,
      totalSolventVolumeMl: totalMl,
      totalSolventVolumeRaw: recipe.totalSolventVolumeMl,
      solvents: distributeSolventVolumes(recipe.solvents, totalMl),
      solutes: recipe.solutes.map((sl) => ({
        id: sl.id,
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
        stepId: step.id,
        altLabel:
          stage.alternatives.length > 1
            ? `Alternative ${alphabeticLabel(altIdx)}`
            : "Route",
        depositionMethod:
          step.depositionMethod?.value?.trim() || step.name || "Deposition",
        category: STEP_CATEGORY_LABELS[step.stepCategory] || step.stepCategory,
        materialLabel: label,
        recipeRef,
        params: buildParamRows(step),
        quenching: buildStepQuenching(step, resolveMedia),
        notes: step.notes?.trim() || undefined,
      }
    }),
  }))

  // Substrates
  const substrates: SubstrateRow[] = (process.inlineSubstrates ?? []).map(
    (s) => ({
      id: s.id,
      name: s.name || "Substrate",
      rigidity:
        s.rigidity === "rigid"
          ? "Rigid"
          : s.rigidity === "flexible"
            ? "Flexible"
            : "-",
      lengthCm: s.lengthCm || "",
      widthCm: s.widthCm || "",
      heightMm: s.heightMm || "",
      roughnessNm: s.surfaceRoughnessRmsNm || "",
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
      architecture: stack.architecture || "-",
      pixelAreaCm2: stack.pixelAreaCm2 || "",
      numberOfPixels: stack.numberOfPixels || "",
      layers: [...stack.layers].reverse().map((l) => ({
        id: l.id,
        name: l.name || "Layer",
        type: LAYER_TYPE_LABELS[l.layerType] || l.layerType || "-",
        color: l.color || "#cccccc",
        thicknessNm: l.thicknessNm || "",
        bandgapEv: l.bandgapEv || "",
        perovskiteComposition:
          [l.perovskiteA, l.perovskiteB, l.perovskiteX]
            .filter(Boolean)
            .join(" / ") || "-",
      })),
      hasPerovskite,
    }
  })

  return {
    processId: process.id,
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
// PDF layout engine (pdf-lib). Origin is bottom-left; `y` tracks the top of the
// next content line and decreases as we move down the page.
// ─────────────────────────────────────────────────────────────────────────────

const MARGIN = 50
const PAGE_W = 595.28 // A4 in pt
const PAGE_H = 841.89

function c(r: number, g: number, b: number) {
  return rgb(r / 255, g / 255, b / 255)
}

const COLORS = {
  title: c(25, 25, 60),
  section: c(30, 80, 180),
  sub: c(40, 40, 40),
  mini: c(80, 80, 80),
  label: c(50, 50, 50),
  note: c(90, 90, 90),
  id: c(150, 150, 150),
  altLabel: c(60, 80, 140),
  headerFill: c(224, 231, 245),
  altRowFill: c(248, 249, 251),
  border: c(190, 190, 190),
  divider: c(210, 210, 210),
  fieldBg: c(0.97 * 255, 0.98 * 255, 255),
  fieldBorder: c(150, 170, 210),
  pageNum: c(160, 160, 160),
}

type EditableCell = { field: FieldPath; value: string; options?: string[] }
type TableCell = string | EditableCell

function edit(
  field: FieldPath,
  value: string,
  options?: string[],
): EditableCell {
  return { field, value, options }
}

function isEditable(cell: TableCell): cell is EditableCell {
  return typeof cell !== "string"
}

class PdfLayout {
  page!: PDFPage
  y = 0
  readonly contentWidth = PAGE_W - MARGIN * 2
  /** Exported value of every editable field, keyed by field name (for import diffing). */
  readonly fieldSnapshot: FieldSnapshot = {}

  constructor(
    readonly doc: PDFDocument,
    readonly form: PDFForm,
    readonly font: PDFFont,
    readonly fontBold: PDFFont,
    readonly fontOblique: PDFFont,
  ) {
    this.newPage()
  }

  newPage() {
    this.page = this.doc.addPage([PAGE_W, PAGE_H])
    this.y = PAGE_H - MARGIN
  }

  ensureSpace(needed: number) {
    if (this.y - needed < MARGIN) this.newPage()
  }

  private drawText(
    text: string,
    x: number,
    size: number,
    font: PDFFont,
    color: ReturnType<typeof rgb>,
  ) {
    this.page.drawText(sanitize(text), {
      x,
      y: this.y - size,
      size,
      font,
      color,
    })
  }

  wrap(text: string, maxWidth: number, size: number, font: PDFFont): string[] {
    const clean = sanitize(text)
    const words = clean.split(/\s+/)
    const lines: string[] = []
    let cur = ""
    const widthOf = (s: string) => font.widthOfTextAtSize(s, size)
    for (const word of words) {
      let w = word
      // hard-break tokens longer than the line
      while (widthOf(w) > maxWidth && w.length > 1) {
        let i = 1
        while (i < w.length && widthOf(w.slice(0, i + 1)) <= maxWidth) i++
        if (cur) {
          lines.push(cur)
          cur = ""
        }
        lines.push(w.slice(0, i))
        w = w.slice(i)
      }
      const candidate = cur ? `${cur} ${w}` : w
      if (widthOf(candidate) <= maxWidth) {
        cur = candidate
      } else {
        if (cur) lines.push(cur)
        cur = w
      }
    }
    if (cur) lines.push(cur)
    return lines.length ? lines : [""]
  }

  writeTitle(text: string) {
    this.ensureSpace(32)
    this.drawText(text, MARGIN, 18, this.fontBold, COLORS.title)
    this.y -= 26
  }

  writeSectionHeading(num: string, text: string) {
    this.ensureSpace(40)
    this.y -= 10
    this.drawText(`${num}  ${text}`, MARGIN, 13, this.fontBold, COLORS.section)
    this.y -= 18
    this.page.drawLine({
      start: { x: MARGIN, y: this.y + 4 },
      end: { x: MARGIN + this.contentWidth, y: this.y + 4 },
      thickness: 0.6,
      color: COLORS.section,
    })
    this.y -= 9
  }

  writeSubHeading(text: string) {
    this.ensureSpace(24)
    this.y -= 4
    this.drawText(text, MARGIN, 11, this.fontBold, COLORS.sub)
    this.y -= 14
  }

  writeMiniHeading(text: string) {
    this.ensureSpace(14)
    this.drawText(text, MARGIN, 9, this.fontBold, COLORS.mini)
    this.y -= 11
  }

  /** Small, unremarkable grey line for machine identifiers. */
  writeId(text: string) {
    this.ensureSpace(11)
    this.drawText(text, MARGIN, 7, this.font, COLORS.id)
    this.y -= 10
  }

  writeLabelValue(label: string, value: string) {
    this.ensureSpace(14)
    const labelText = `${label}: `
    const labelWidth = this.fontBold.widthOfTextAtSize(sanitize(labelText), 10)
    this.drawText(labelText, MARGIN, 10, this.fontBold, COLORS.label)
    const valueLines = this.wrap(
      value,
      this.contentWidth - labelWidth,
      10,
      this.font,
    )
    // first line sits on the label baseline
    this.page.drawText(valueLines[0] ?? "", {
      x: MARGIN + labelWidth,
      y: this.y - 10,
      size: 10,
      font: this.font,
      color: COLORS.label,
    })
    this.y -= 13
    for (let i = 1; i < valueLines.length; i++) {
      this.ensureSpace(13)
      this.page.drawText(valueLines[i], {
        x: MARGIN + labelWidth,
        y: this.y - 10,
        size: 10,
        font: this.font,
        color: COLORS.label,
      })
      this.y -= 13
    }
  }

  writeBullet(text: string) {
    const bulletWidth = this.font.widthOfTextAtSize("  - ", 10)
    const lines = this.wrap(
      text,
      this.contentWidth - bulletWidth,
      10,
      this.font,
    )
    this.ensureSpace(13)
    this.drawText("  -", MARGIN, 10, this.font, COLORS.label)
    lines.forEach((line, i) => {
      this.ensureSpace(13)
      this.page.drawText(line, {
        x: MARGIN + bulletWidth,
        y: this.y - 10,
        size: 10,
        font: this.font,
        color: COLORS.label,
      })
      if (i < lines.length - 1) this.y -= 13
    })
    this.y -= 13
  }

  writeNote(text: string) {
    const lines = this.wrap(text, this.contentWidth, 9, this.fontOblique)
    for (const line of lines) {
      this.ensureSpace(12)
      this.drawText(line, MARGIN, 9, this.fontOblique, COLORS.note)
      this.y -= 12
    }
  }

  spacer(h: number) {
    this.y -= h
  }

  private placeField(
    cell: EditableCell,
    rect: {
      x: number
      y: number
      width: number
      height: number
    },
  ) {
    const name = encodeFieldName(cell.field)
    if (cell.options) {
      const dd = this.form.createDropdown(name)
      const opts = cell.options.map(sanitize)
      dd.setOptions(opts)
      const val = sanitize(cell.value)
      const stored = val && opts.includes(val) ? val : ""
      if (stored) dd.select(stored)
      dd.addToPage(this.page, {
        ...rect,
        font: this.font,
        textColor: COLORS.label,
        backgroundColor: COLORS.fieldBg,
        borderColor: COLORS.fieldBorder,
        borderWidth: 0.5,
      })
      dd.setFontSize(9)
      this.fieldSnapshot[name] = stored
    } else {
      const stored = sanitize(cell.value)
      const tf = this.form.createTextField(name)
      tf.setText(stored)
      tf.addToPage(this.page, {
        ...rect,
        font: this.font,
        textColor: COLORS.label,
        backgroundColor: COLORS.fieldBg,
        borderColor: COLORS.fieldBorder,
        borderWidth: 0.5,
      })
      tf.setFontSize(9)
      this.fieldSnapshot[name] = stored
    }
  }

  drawTable(
    headers: string[],
    rows: TableCell[][],
    colWidths: number[],
    size = 9,
  ) {
    const cellPadH = 5
    const cellPadV = 4
    const lineH = size + 3
    const totalWidth = colWidths.reduce((s, w) => s + w, 0)

    // Measure with the font the cell will actually be drawn in — headers are
    // bold (wider), so measuring them with the regular font under-counts lines
    // and clips wrapped headers.
    const rowHeight = (cells: TableCell[], bold: boolean) => {
      const font = bold ? this.fontBold : this.font
      const maxLines = Math.max(
        1,
        ...cells.map((cell, i) => {
          if (isEditable(cell)) return 1
          const w = (colWidths[i] ?? 80) - cellPadH * 2
          return this.wrap(cell, w, size, font).length
        }),
      )
      return maxLines * lineH + cellPadV * 2
    }

    const drawRow = (
      cells: TableCell[],
      bold: boolean,
      fill: ReturnType<typeof rgb>,
    ) => {
      const h = rowHeight(cells, bold)
      const top = this.y
      const bottom = top - h
      this.page.drawRectangle({
        x: MARGIN,
        y: bottom,
        width: totalWidth,
        height: h,
        color: fill,
        borderColor: COLORS.border,
        borderWidth: 0.3,
      })
      let cellX = MARGIN
      const font = bold ? this.fontBold : this.font
      cells.forEach((cell, i) => {
        const cw = colWidths[i] ?? 80
        if (isEditable(cell)) {
          this.placeField(cell, {
            x: cellX + 2,
            y: bottom + 2,
            width: cw - 4,
            height: h - 4,
          })
        } else {
          const lines = this.wrap(cell, cw - cellPadH * 2, size, font)
          lines.forEach((line, li) => {
            this.page.drawText(line, {
              x: cellX + cellPadH,
              y: top - cellPadV - size - li * lineH,
              size,
              font,
              color: c(30, 30, 30),
            })
          })
        }
        if (i < cells.length - 1) {
          this.page.drawLine({
            start: { x: cellX + cw, y: top },
            end: { x: cellX + cw, y: bottom },
            thickness: 0.3,
            color: COLORS.divider,
          })
        }
        cellX += cw
      })
      this.y = bottom
    }

    // header (repeat when a page break splits the table)
    this.ensureSpace(rowHeight(headers, true))
    drawRow(headers, true, COLORS.headerFill)

    rows.forEach((row, idx) => {
      const h = rowHeight(row, false)
      if (this.y - h < MARGIN) {
        this.newPage()
        this.ensureSpace(rowHeight(headers, true))
        drawRow(headers, true, COLORS.headerFill)
      }
      drawRow(row, false, idx % 2 === 0 ? c(255, 255, 255) : COLORS.altRowFill)
    })
  }

  /** Hex string (#rrggbb) → pdf-lib color, with a grey fallback. */
  private hexColor(hex: string) {
    const m = /^#?([0-9a-f]{6})$/i.exec((hex ?? "").trim())
    if (!m) return c(204, 204, 204)
    const n = parseInt(m[1], 16)
    return c((n >> 16) & 255, (n >> 8) & 255, n & 255)
  }

  /**
   * Draw a device stack as a real stack of colored layer bands (top layer first,
   * substrate at the bottom), each labelled with name + type/thickness/bandgap.
   */
  drawStackDiagram(layers: StackLayer[]) {
    const bandH = 26
    const barW = 150
    const totalH = layers.length * bandH
    this.ensureSpace(totalH + 6)
    const topY = this.y
    layers.forEach((layer, i) => {
      const bandTop = topY - i * bandH
      this.page.drawRectangle({
        x: MARGIN,
        y: bandTop - bandH + 3,
        width: barW,
        height: bandH - 3,
        color: this.hexColor(layer.color),
        borderColor: c(120, 120, 120),
        borderWidth: 0.5,
      })
      const labelX = MARGIN + barW + 12
      this.page.drawText(sanitize(layer.name), {
        x: labelX,
        y: bandTop - 11,
        size: 9,
        font: this.fontBold,
        color: COLORS.sub,
      })
      const detail = [
        layer.type,
        layer.thicknessNm ? `${layer.thicknessNm} nm` : "",
        layer.bandgapEv ? `${layer.bandgapEv} eV` : "",
        layer.perovskiteComposition !== "-" ? layer.perovskiteComposition : "",
      ]
        .filter(Boolean)
        .join("   ·   ")
      this.page.drawText(sanitize(detail), {
        x: labelX,
        y: bandTop - 21,
        size: 8,
        font: this.font,
        color: COLORS.mini,
      })
    })
    this.y = topY - totalH - 6
  }

  finalizeFooters(footerLeft: string) {
    const pages = this.doc.getPages()
    const total = pages.length
    pages.forEach((page, i) => {
      page.drawText(sanitize(`Page ${i + 1} of ${total}`), {
        x: MARGIN,
        y: 20,
        size: 8,
        font: this.font,
        color: COLORS.pageNum,
      })
      const right = sanitize(footerLeft)
      const w = this.font.widthOfTextAtSize(right, 8)
      page.drawText(right, {
        x: PAGE_W - MARGIN - w,
        y: 20,
        size: 8,
        font: this.font,
        color: COLORS.pageNum,
      })
    })
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Section renderers
// ─────────────────────────────────────────────────────────────────────────────

function renderProcessSections(L: PdfLayout, model: ProcessExportModel) {
  const cw = L.contentWidth

  // ── Chemistry ────────────────────────────────────────────────────────────
  if (model.chemistry.length > 0) {
    L.writeSectionHeading("1.", "Chemistry — Solution Preparation")
    for (const chem of model.chemistry) {
      const badge = chem.isCommercial ? "[COMMERCIAL]" : "[LAB PREPARED]"
      L.writeSubHeading(`1.${chem.index}  ${chem.name}  ${badge}`)
      L.writeId(`Recipe ID: ${chem.recipeId}`)

      if (chem.type) L.writeLabelValue("Type", chem.type)

      if (chem.isCommercial) {
        L.drawTable(
          ["Field", "Value"],
          [
            [
              "Commercial Name",
              edit(
                { kind: "recipeCommercialName", recipeId: chem.recipeId },
                chem.commercialName ?? "",
              ),
            ],
            [
              "Supplier / Ref.",
              edit(
                { kind: "recipeSupplierNumber", recipeId: chem.recipeId },
                chem.supplierNumber ?? "",
              ),
            ],
          ],
          [cw * 0.42, cw * 0.58],
        )
        L.spacer(6)
      } else {
        // Editable: the stored total solvent volume. The per-solvent volumes
        // below are derived (from ratios) and shown as read-only info.
        L.drawTable(
          ["Field", "Value"],
          [
            [
              "Total Solvent Volume (mL)",
              edit(
                { kind: "recipeTotalSolvent", recipeId: chem.recipeId },
                chem.totalSolventVolumeRaw || String(chem.totalSolventVolumeMl),
              ),
            ],
          ],
          [cw * 0.5, cw * 0.5],
        )
        L.spacer(4)

        if (chem.solvents.length > 0) {
          L.writeMiniHeading("Solvents")
          // Solvents are stored as VOLUME RATIOS (the mixing recipe), not
          // absolute volumes — editing the ratio is the logically-correct knob.
          // The mL column is derived (ratio ÷ total ratio × total volume) and
          // read-only, since a flat PDF cannot recompute it.
          L.drawTable(
            ["Solvent", "Volume ratio", "Volume (mL, derived)"],
            chem.solvents.map((sv): TableCell[] => [
              sv.name,
              edit(
                {
                  kind: "solventRatio",
                  recipeId: chem.recipeId,
                  solventId: sv.id,
                },
                String(sv.volumeRatio),
              ),
              sv.volumeMl.toFixed(2),
            ]),
            [cw * 0.44, cw * 0.28, cw * 0.28],
          )
          L.spacer(6)
        }

        if (chem.solutes.length > 0) {
          L.writeMiniHeading("Solutes")
          const hasConc = chem.solutes.some((s) => s.concentrationMolL !== null)
          const headers = hasConc
            ? ["Compound", "Amount", "Unit", "Concentration (mol/L)"]
            : ["Compound", "Amount", "Unit"]
          const rows = chem.solutes.map((sl): TableCell[] => {
            const base: TableCell[] = [
              sl.name,
              edit(
                {
                  kind: "soluteAmount",
                  recipeId: chem.recipeId,
                  soluteId: sl.id,
                },
                sl.amount,
              ),
              edit(
                {
                  kind: "soluteUnit",
                  recipeId: chem.recipeId,
                  soluteId: sl.id,
                },
                sl.unit,
                SOLUTE_UNITS,
              ),
            ]
            return hasConc ? [...base, sl.concentrationMolL ?? "-"] : base
          })
          const colW = hasConc
            ? [cw * 0.38, cw * 0.16, cw * 0.16, cw * 0.3]
            : [cw * 0.5, cw * 0.25, cw * 0.25]
          L.drawTable(headers, rows, colW)
          L.spacer(6)
        }

        if (chem.addedSolutions.length > 0) {
          L.writeMiniHeading("Added Solutions (pre-mixed)")
          for (const as of chem.addedSolutions) {
            L.writeBullet(`${as.name}: ${as.volumeMl} mL`)
          }
          L.spacer(2)
        }
      }

      if (chem.handlingPreparation)
        L.writeLabelValue("Preparation Notes", chem.handlingPreparation)
      if (chem.handlingBeforeUse)
        L.writeLabelValue("Notes Before Use", chem.handlingBeforeUse)
      L.spacer(6)
    }
  }

  // ── Process Steps ──────────────────────────────────────────────────────────
  const stepsSection = model.chemistry.length > 0 ? "2." : "1."
  L.writeSectionHeading(
    stepsSection,
    `Process Steps  (${model.stageCount} stage${model.stageCount !== 1 ? "s" : ""})`,
  )

  for (const stage of model.stages) {
    const altCount = stage.alternatives.length
    L.writeSubHeading(
      `Step ${stage.stageNumber} of ${model.stageCount}${altCount > 1 ? `  [${altCount} alternatives]` : ""}`,
    )

    for (const alt of stage.alternatives) {
      if (stage.hasMultipleAlts) {
        L.ensureSpace(14)
        L.page.drawText(sanitize(`${alt.altLabel}:`), {
          x: MARGIN,
          y: L.y - 10,
          size: 10,
          font: L.fontBold,
          color: COLORS.altLabel,
        })
        L.y -= 13
      }
      L.writeId(`Step ID: ${alt.stepId}`)
      L.writeLabelValue("Deposition Method", alt.depositionMethod)
      L.writeLabelValue("Category", alt.category)
      const matLine = alt.recipeRef
        ? `${alt.materialLabel}  (-> ${alt.recipeRef})`
        : alt.materialLabel
      L.writeLabelValue("Material / Solution", matLine)

      if (alt.params.length > 0) {
        L.spacer(2)
        L.writeMiniHeading("Process Parameters")
        const rows = alt.params.map((p): TableCell[] => [
          p.unit ? `${p.label} (${p.unit})` : p.label,
          p.editable
            ? edit(
                { kind: "stepParam", stepId: alt.stepId, paramKey: p.key },
                p.value,
              )
            : p.value,
        ])
        L.drawTable(["Parameter", "Value"], rows, [cw * 0.42, cw * 0.58])
        L.spacer(4)
      }

      // Drying / Quenching — each scalar parameter is individually editable; the
      // quenching TYPE and any media reference stay read-only.
      if (alt.quenching) {
        L.spacer(2)
        L.writeMiniHeading(`Drying / Quenching  (${alt.quenching.type})`)
        const rows = alt.quenching.fields.map((f): TableCell[] => [
          f.unit ? `${f.label} (${f.unit})` : f.label,
          f.editable
            ? edit(
                { kind: "stepQuench", stepId: alt.stepId, subKey: f.key },
                f.value,
              )
            : f.value,
        ])
        L.drawTable(["Parameter", "Value"], rows, [cw * 0.42, cw * 0.58])
        L.spacer(4)
      }

      if (alt.notes) {
        L.drawTable(
          ["Notes", ""],
          [["", edit({ kind: "stepNotes", stepId: alt.stepId }, alt.notes)]],
          [cw * 0.16, cw * 0.84],
        )
        L.spacer(2)
      }

      if (stage.hasMultipleAlts) L.spacer(4)
    }
    L.spacer(4)
  }

  // ── Substrates ─────────────────────────────────────────────────────────────
  if (model.substrates.length > 0) {
    const n = model.chemistry.length > 0 ? "3." : "2."
    L.writeSectionHeading(n, "Substrate Specifications")
    L.drawTable(
      [
        "Name",
        "Rigidity",
        "Length (cm)",
        "Width (cm)",
        "Height (mm)",
        "Roughness (nm)",
      ],
      model.substrates.map((s): TableCell[] => [
        s.name,
        s.rigidity,
        edit({ kind: "substrateLength", substrateId: s.id }, s.lengthCm),
        edit({ kind: "substrateWidth", substrateId: s.id }, s.widthCm),
        edit({ kind: "substrateHeight", substrateId: s.id }, s.heightMm),
        edit({ kind: "substrateRoughness", substrateId: s.id }, s.roughnessNm),
      ]),
      [cw * 0.24, cw * 0.13, cw * 0.16, cw * 0.16, cw * 0.15, cw * 0.16],
      8, // compact small font
    )
    L.spacer(8)
  }

  // ── Device Stacks ──────────────────────────────────────────────────────────
  if (model.deviceStacks.length > 0) {
    let n = 1
    if (model.chemistry.length > 0) n++
    if (model.stages.length > 0) n++
    if (model.substrates.length > 0) n++
    L.writeSectionHeading(`${n}.`, "Device Stacks")

    for (const stack of model.deviceStacks) {
      const stackIdx = stack.index - 1
      L.writeSubHeading(`Stack ${stack.index}`)
      L.writeLabelValue("Architecture", stack.architecture)
      L.drawTable(
        ["Pixel Area (cm²)", "Number of Pixels"],
        [
          [
            edit({ kind: "stackPixelArea", stackIdx }, stack.pixelAreaCm2),
            edit({ kind: "stackNumPixels", stackIdx }, stack.numberOfPixels),
          ],
        ],
        [cw * 0.5, cw * 0.5],
      )
      L.spacer(8)

      // Visual stack (top layer first, substrate at the bottom).
      L.drawStackDiagram(stack.layers)
      L.spacer(4)

      // Editable layer details (compact).
      L.writeMiniHeading("Layer details (editable)")
      const headers = stack.hasPerovskite
        ? [
            "Layer",
            "Type",
            "Thickness (nm)",
            "Bandgap (eV)",
            "Perovskite A/B/X",
          ]
        : ["Layer", "Type", "Thickness (nm)", "Bandgap (eV)"]
      const rows = stack.layers.map((l): TableCell[] => {
        const base: TableCell[] = [
          l.name,
          l.type,
          edit(
            { kind: "stackLayerThickness", stackIdx, layerId: l.id },
            l.thicknessNm,
          ),
          edit(
            { kind: "stackLayerBandgap", stackIdx, layerId: l.id },
            l.bandgapEv,
          ),
        ]
        return stack.hasPerovskite ? [...base, l.perovskiteComposition] : base
      })
      const colW = stack.hasPerovskite
        ? [cw * 0.25, cw * 0.15, cw * 0.15, cw * 0.15, cw * 0.3]
        : [cw * 0.35, cw * 0.2, cw * 0.22, cw * 0.23]
      L.drawTable(headers, rows, colW, 8)
      L.spacer(8)
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Document assembly
// ─────────────────────────────────────────────────────────────────────────────

async function createLayout(): Promise<{ doc: PDFDocument; L: PdfLayout }> {
  const { PDFDocument } = await import("pdf-lib")
  const doc = await PDFDocument.create()
  const font = await doc.embedFont(StandardFonts.Helvetica)
  const fontBold = await doc.embedFont(StandardFonts.HelveticaBold)
  const fontOblique = await doc.embedFont(StandardFonts.HelveticaOblique)
  const form = doc.getForm()
  const L = new PdfLayout(doc, form, font, fontBold, fontOblique)
  return { doc, L }
}

function renderTitleBlock(
  L: PdfLayout,
  model: ProcessExportModel,
  idLines: string[],
) {
  L.writeTitle(model.processName)
  for (const line of idLines) L.writeId(line)
  if (model.description) {
    L.writeNote(model.description)
    L.spacer(2)
  }
  L.writeLabelValue("Export Date", model.exportDate)
  L.writeLabelValue(
    "Process",
    `${model.stageCount} stage${model.stageCount !== 1 ? "s" : ""}${model.chemistry.length > 0 ? `, ${model.chemistry.length} solution recipe${model.chemistry.length !== 1 ? "s" : ""}` : ""}`,
  )
  L.spacer(4)
}

// ─────────────────────────────────────────────────────────────────────────────
// Public entry points
// ─────────────────────────────────────────────────────────────────────────────

/** Build the Process protocol PDF and return its bytes (no download). */
export async function buildProcessPdf(
  input: ProcessExportInput,
): Promise<Uint8Array> {
  const model = buildProcessExportModel(input)
  const { doc, L } = await createLayout()

  renderTitleBlock(L, model, [`Process ID: ${model.processId}`])
  renderProcessSections(L, model)
  L.finalizeFooters(model.exportDate)

  const refs: EntityRefs = {
    materials: input.materials,
    solutions: input.solutions,
  }
  await embedPayload(
    doc,
    serializeProcess(input.process, refs),
    L.fieldSnapshot,
  )
  return doc.save()
}

export async function exportProcessProtocolAsPdf(
  input: ProcessExportInput,
): Promise<void> {
  const bytes = await buildProcessPdf(input)
  triggerDownload(
    new Blob([bytes as BlobPart], { type: "application/pdf" }),
    `${sanitizeFileBaseName(input.process.name || "process-summary")}.pdf`,
  )
}

function renderExperimentSection(
  L: PdfLayout,
  input: ExperimentExportInput,
  processModel: ProcessExportModel,
) {
  const { experiment, process, chemicals, solutionRows } = input
  const cw = L.contentWidth

  L.writeTitle(experiment.name || "Untitled Experiment")
  L.writeId(`Experiment ID: ${experiment.id}`)
  L.writeId(`Process ID: ${process.id}  (${process.name || "Untitled"})`)
  if (experiment.description) {
    L.writeNote(experiment.description)
    L.spacer(2)
  }

  L.writeSectionHeading("1.", "Experiment Summary")
  L.drawTable(
    ["Field", "Value"],
    [
      // Start/end are derived from the processing times (first step / end-of-
      // experiment cell), so they are printed as plain text: an editable field
      // here would be silently re-derived away on the next edit in the app.
      ["Start", (experiment.date ?? "").replace("T", " ")],
      ["End", (experiment.endDate ?? "").replace("T", " ")],
      [
        "Intent",
        edit({ kind: "experimentDescription" }, experiment.description ?? ""),
      ],
    ],
    [cw * 0.3, cw * 0.7],
  )
  L.spacer(8)

  // ── Chemicals ──────────────────────────────────────────────────────────────
  L.writeSectionHeading("2.", "Chemicals & Solution Quantities")
  L.writeSubHeading("Chemicals")
  if (chemicals.length === 0) {
    L.writeNote("None")
  } else {
    L.drawTable(
      ["Chemical", "Source", "Inventory", "Details"],
      chemicals.map((m): TableCell[] => [
        m.name,
        m.sourceRecipeName ? `from ${m.sourceRecipeName}` : "-",
        m.inventoryLabel || "-",
        [m.purity, m.supplier, m.productId].filter(Boolean).join(", ") || "-",
      ]),
      [cw * 0.28, cw * 0.24, cw * 0.24, cw * 0.24],
    )
  }
  L.spacer(6)

  L.writeSubHeading("Solutions")
  if (solutionRows.length === 0) {
    L.writeNote("None")
  } else {
    for (const s of solutionRows) {
      if (s.mode === "take") {
        L.writeLabelValue(
          s.name,
          `reused from ${s.reusedFromName ?? "another experiment"}`,
        )
      } else {
        const at = s.preparedAt ? `, prepared ${s.preparedAt}` : ""
        const vial = s.vialLabel ? `, vial ${s.vialLabel}` : ""
        L.writeLabelValue(
          s.name,
          `${s.volumeMl ? `${s.volumeMl} mL` : "volume not set"}${at}${vial}`,
        )
        if (s.quantities.length > 0) {
          L.drawTable(
            ["Ingredient", "Amount", "Unit"],
            s.quantities.map((q): TableCell[] => [q.name, q.amount, q.unit]),
            [cw * 0.5, cw * 0.25, cw * 0.25],
          )
          L.spacer(4)
        }
      }
    }
  }
  L.spacer(6)

  // ── Substrates: names + per-substrate process step choices + variations ──────
  renderExperimentSubstrates(L, experiment, process)

  // Reference the process id in the footer marker via the process model too.
  void processModel
}

// ─────────────────────────────────────────────────────────────────────────────
// Experiment substrate rendering — an experiment is run over one or more
// substrates. Each substrate has an editable name, a per-stage "step choice"
// (which alternative of that stage it went through, or Skip), and, when the
// process marks parameters for variation, its own value for each varied
// parameter. All of these are round-trippable editable fields.
// ─────────────────────────────────────────────────────────────────────────────

type VariationColumn = {
  stepId: string
  paramKey: string
  stageIndex: number
  label: string
  /** Base (process-level) value, shown when a substrate has no override. */
  baseValue: string
}

function buildVariationColumns(
  experiment: Experiment,
  process: Process,
): VariationColumn[] {
  const recipes = process.solutionRecipes ?? []
  const columns = new Map<string, VariationColumn>()

  // Index every step by id, with its stage index and display label.
  const stepInfo = new Map<
    string,
    { stageIndex: number; label: string; step: ProcessStep }
  >()
  process.stages.forEach((stage, stageIndex) => {
    const options = buildStageStepOptions(stage.alternatives, recipes)
    for (const step of stage.alternatives) {
      const label = options.find((o) => o.value === step.id)?.label ?? step.name
      stepInfo.set(step.id, { stageIndex, label, step })
    }
  })

  for (const substrate of experiment.substrates) {
    const values = substrate.parameterValues ?? {}
    for (const key of Object.keys(values)) {
      if (key.startsWith("stageSelection:")) continue
      const [stepId, paramKey] = key.split(":")
      if (!stepId || !paramKey) continue
      const paramDef = PROCESS_PARAMETER_DEFINITIONS.find(
        (d) => d.key === paramKey,
      )
      const info = stepInfo.get(stepId)
      if (!paramDef || !info) continue
      const columnKey = `${stepId}:${paramKey}`
      if (columns.has(columnKey)) continue
      columns.set(columnKey, {
        stepId,
        paramKey,
        stageIndex: info.stageIndex,
        label: `#${info.stageIndex + 1} ${info.label} — ${paramDef.label}`,
        baseValue: info.step[paramDef.key]?.value?.trim() ?? "",
      })
    }
  }

  return Array.from(columns.values()).sort((a, b) =>
    a.stageIndex !== b.stageIndex
      ? a.stageIndex - b.stageIndex
      : a.label.localeCompare(b.label),
  )
}

function renderExperimentSubstrates(
  L: PdfLayout,
  experiment: Experiment,
  process: Process,
) {
  const substrates: Substrate[] = experiment.substrates ?? []
  if (substrates.length === 0) return
  const cw = L.contentWidth
  const recipes = process.solutionRecipes ?? []

  L.writeSectionHeading("3.", "Substrates & Process Step Choices")
  L.writeNote(
    "One block per substrate. The name and the chosen step for each stage are editable; " +
      "changes are applied to the matching substrate on import.",
  )
  L.spacer(2)

  for (let i = 0; i < substrates.length; i++) {
    const substrate = substrates[i]
    L.writeSubHeading(`Substrate ${i + 1}`)
    L.writeId(`Substrate ID: ${substrate.id}`)

    // Editable name.
    L.drawTable(
      ["Field", "Value"],
      [
        [
          "Name",
          edit(
            { kind: "experimentSubstrateName", substrateId: substrate.id },
            substrate.name ?? "",
          ),
        ],
      ],
      [cw * 0.3, cw * 0.7],
    )
    L.spacer(4)

    // Per-stage step choice (dropdown of that stage's alternatives + Skip).
    if (process.stages.length > 0) {
      L.writeMiniHeading("Process step choices")
      const rows = process.stages.map((stage, stageIndex): TableCell[] => {
        const options = buildStageStepOptions(stage.alternatives, recipes)
        const selectedId = resolveStageSelection(
          substrate.parameterValues,
          stageIndex,
          stage.alternatives,
        )
        const selectedLabel =
          options.find((o) => o.value === selectedId)?.label ??
          options.find((o) => o.value === SKIP_STEP)?.label ??
          ""
        return [
          `Step ${stageIndex + 1}`,
          edit(
            {
              kind: "experimentStageSelection",
              substrateId: substrate.id,
              stageIndex,
            },
            selectedLabel,
            options.map((o) => o.label),
          ),
        ]
      })
      L.drawTable(["Stage", "Selected step"], rows, [cw * 0.22, cw * 0.78])
      L.spacer(6)
    }
  }

  // ── Parameter variations (matrix: substrate × varied parameter) ──────────────
  const columns = buildVariationColumns(experiment, process)
  if (columns.length === 0) return

  L.writeSectionHeading("4.", "Parameter Variations")
  L.writeNote(
    "Per-substrate values for parameters the process marked as varied. Each cell is editable.",
  )
  L.spacer(2)

  const headers = ["Substrate", ...columns.map((c) => c.label)]
  const rows = substrates.map((substrate): TableCell[] => {
    const values = substrate.parameterValues ?? {}
    return [
      substrate.name || "Substrate",
      ...columns.map((col): TableCell => {
        const key = `${col.stepId}:${col.paramKey}`
        const value = values[key] ?? col.baseValue
        return edit(
          {
            kind: "experimentVariationValue",
            substrateId: substrate.id,
            stepId: col.stepId,
            paramKey: col.paramKey,
          },
          value,
        )
      }),
    ]
  })
  // First column for the substrate name, remaining width split across params.
  const nameW = cw * 0.24
  const paramW = (cw - nameW) / columns.length
  L.drawTable(headers, rows, [nameW, ...columns.map(() => paramW)], 8)
  L.spacer(8)
}

/** Build the Experiment summary PDF and return its bytes (no download). */
export async function buildExperimentPdf(
  input: ExperimentExportInput,
): Promise<Uint8Array> {
  const processModel = buildProcessExportModel({
    process: input.process,
    materials: input.materials,
    solutions: input.solutions,
  })
  const { doc, L } = await createLayout()

  if (input.includeFullProcess) {
    renderTitleBlock(L, processModel, [`Process ID: ${processModel.processId}`])
    renderProcessSections(L, processModel)
    L.newPage()
  }

  renderExperimentSection(L, input, processModel)
  L.finalizeFooters(processModel.exportDate)

  const refs: EntityRefs = {
    materials: input.materials,
    solutions: input.solutions,
  }
  await embedPayload(
    doc,
    serializeExperiment(input.experiment, input.process, refs),
    L.fieldSnapshot,
  )
  return doc.save()
}

export async function exportExperimentSummaryAsPdf(
  input: ExperimentExportInput,
): Promise<void> {
  const bytes = await buildExperimentPdf(input)
  triggerDownload(
    new Blob([bytes as BlobPart], { type: "application/pdf" }),
    `${sanitizeFileBaseName(input.experiment.name || "experiment")}.pdf`,
  )
}
