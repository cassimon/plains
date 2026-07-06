// ─────────────────────────────────────────────────────────────────────────────
// Import of edited Process / Experiment PDFs produced by processExport.ts.
//
// Reads the canonical payload (hidden `plains:payload` field) + every editable
// AcroForm field, migrates by schema version, diffs the live field values against
// the exported snapshot to detect user edits, validates them, and applies the
// valid ones to a clone of the entity. Invalid edits are reported and skipped
// (the field is left blank on a new entity / unchanged on an existing one — that
// blank-vs-keep policy is applied by the caller when it decides modify vs new).
//
// See docs/plans/process-experiment-pdf-import.md.
// ─────────────────────────────────────────────────────────────────────────────

import type { PDFForm } from "pdf-lib"
import {
  type Experiment,
  PROCESS_PARAMETER_DEFINITIONS,
  type Process,
  type ProcessParameterKey,
} from "@/store/AppContext"
import {
  decodeFieldName,
  type EntityRefs,
  type FieldPath,
  PAYLOAD_FIELD_NAME,
  readPayload,
} from "./pdfSchema"

const SOLUTE_UNITS = ["mg", "ml", "mol"]
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export type FieldEdit = {
  name: string
  path: FieldPath
  oldValue: string
  newValue: string
}

export type FieldError = {
  name: string
  path: FieldPath
  value: string
  reason: string
}

export type ImportResult = {
  kind: "process" | "experiment"
  schemaVersion: number
  refs: EntityRefs
  /** The entity exactly as exported (canonical payload). */
  original: { process: Process; experiment?: Experiment }
  /** Clone of the entity with all VALID edits applied. */
  edited: { process: Process; experiment?: Experiment }
  edits: FieldEdit[]
  errors: FieldError[]
}

export class NotAPlainsPdfError extends Error {}

// ─────────────────────────────────────────────────────────────────────────────
// Field reading
// ─────────────────────────────────────────────────────────────────────────────

function readFieldValue(form: PDFForm, name: string): string {
  try {
    return form.getTextField(name).getText() ?? ""
  } catch {
    // not a text field
  }
  try {
    return form.getDropdown(name).getSelected()[0] ?? ""
  } catch {
    // not a dropdown
  }
  return ""
}

// ─────────────────────────────────────────────────────────────────────────────
// Validation — returns an error reason, or null when the value is acceptable.
// ─────────────────────────────────────────────────────────────────────────────

const NUMERIC_KINDS = new Set<FieldPath["kind"]>([
  "recipeTotalSolvent",
  "soluteAmount",
  "substrateLength",
  "substrateWidth",
  "substrateHeight",
  "substrateRoughness",
  "stackPixelArea",
  "stackNumPixels",
  "stackLayerThickness",
  "stackLayerBandgap",
])

function isNumeric(value: string): boolean {
  if (value.trim() === "") return true // empty clears the value — allowed
  return !Number.isNaN(Number(value))
}

export function validateEdit(path: FieldPath, value: string): string | null {
  if (NUMERIC_KINDS.has(path.kind)) {
    return isNumeric(value) ? null : "must be a number"
  }
  if (path.kind === "soluteUnit") {
    return value === "" || SOLUTE_UNITS.includes(value)
      ? null
      : `unit must be one of ${SOLUTE_UNITS.join(", ")}`
  }
  if (path.kind === "experimentDate" || path.kind === "experimentEndDate") {
    return value === "" || DATE_RE.test(value)
      ? null
      : "must be a date (YYYY-MM-DD)"
  }
  if (path.kind === "stepParam") {
    const def = PROCESS_PARAMETER_DEFINITIONS.find(
      (d) => d.key === path.paramKey,
    )
    if (def?.type === "number")
      return isNumeric(value) ? null : "must be a number"
  }
  return null // free-text fields
}

// ─────────────────────────────────────────────────────────────────────────────
// Applying an edited value back onto the entity (inverse of the export codec).
// ─────────────────────────────────────────────────────────────────────────────

function findStep(process: Process, stepId: string) {
  for (const stage of process.stages) {
    for (const step of stage.alternatives) {
      if (step.id === stepId) return step
    }
  }
  return undefined
}

export function applyFieldValue(
  process: Process,
  experiment: Experiment | undefined,
  path: FieldPath,
  value: string,
): void {
  const recipe = (id: string) =>
    process.solutionRecipes?.find((r) => r.id === id)
  switch (path.kind) {
    case "processName":
      process.name = value
      break
    case "processDescription":
      process.description = value
      break
    case "recipeCommercialName": {
      const r = recipe(path.recipeId)
      if (r) r.commercialName = value
      break
    }
    case "recipeSupplierNumber": {
      const r = recipe(path.recipeId)
      if (r) r.supplierNumber = value
      break
    }
    case "recipeTotalSolvent": {
      const r = recipe(path.recipeId)
      if (r) r.totalSolventVolumeMl = value
      break
    }
    case "soluteAmount": {
      const s = recipe(path.recipeId)?.solutes.find(
        (x) => x.id === path.soluteId,
      )
      if (s) s.amount = value
      break
    }
    case "soluteUnit": {
      const s = recipe(path.recipeId)?.solutes.find(
        (x) => x.id === path.soluteId,
      )
      if (s && (value === "mg" || value === "ml" || value === "mol"))
        s.unit = value
      break
    }
    case "stepParam": {
      const step = findStep(process, path.stepId)
      if (step) {
        const key = path.paramKey as ProcessParameterKey
        const existing = step[key]
        step[key] = { value, mode: existing?.mode ?? "constant" }
      }
      break
    }
    case "stepNotes": {
      const step = findStep(process, path.stepId)
      if (step) step.notes = value
      break
    }
    case "substrateLength":
    case "substrateWidth":
    case "substrateHeight":
    case "substrateRoughness": {
      const sub = process.inlineSubstrates?.find(
        (x) => x.id === path.substrateId,
      )
      if (sub) {
        if (path.kind === "substrateLength") sub.lengthCm = value
        else if (path.kind === "substrateWidth") sub.widthCm = value
        else if (path.kind === "substrateHeight") sub.heightMm = value
        else sub.surfaceRoughnessRmsNm = value
      }
      break
    }
    case "stackPixelArea": {
      const st = process.generatedStacks?.[path.stackIdx]
      if (st) st.pixelAreaCm2 = value
      break
    }
    case "stackNumPixels": {
      const st = process.generatedStacks?.[path.stackIdx]
      if (st) st.numberOfPixels = value
      break
    }
    case "stackLayerThickness":
    case "stackLayerBandgap": {
      const layer = process.generatedStacks?.[path.stackIdx]?.layers.find(
        (l) => l.id === path.layerId,
      )
      if (layer) {
        if (path.kind === "stackLayerThickness") layer.thicknessNm = value
        else layer.bandgapEv = value
      }
      break
    }
    case "experimentDate":
      if (experiment) experiment.date = value
      break
    case "experimentEndDate":
      if (experiment) experiment.endDate = value
      break
    case "experimentDescription":
      if (experiment) experiment.description = value
      break
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

export async function importPdf(
  bytes: Uint8Array | ArrayBuffer,
): Promise<ImportResult> {
  const { PDFDocument } = await import("pdf-lib")
  const doc = await PDFDocument.load(bytes)
  const payload = readPayload(doc)
  if (!payload) {
    throw new NotAPlainsPdfError(
      "This PDF was not generated by Plains, or was made by a newer version.",
    )
  }

  const form = doc.getForm()
  const snapshot = payload.fields ?? {}

  const originalProcess = payload.process
  const originalExperiment =
    payload.kind === "experiment" ? payload.experiment : undefined

  // Deep clones we apply valid edits to.
  const editedProcess = structuredClone(originalProcess)
  const editedExperiment = originalExperiment
    ? structuredClone(originalExperiment)
    : undefined

  const edits: FieldEdit[] = []
  const errors: FieldError[] = []

  for (const name of Object.keys(snapshot)) {
    const path = decodeFieldName(name)
    if (!path) continue
    const oldValue = snapshot[name]
    const newValue = readFieldValue(form, name)
    if (newValue === oldValue) continue // untouched

    const reason = validateEdit(path, newValue)
    if (reason) {
      errors.push({ name, path, value: newValue, reason })
      continue
    }
    edits.push({ name, path, oldValue, newValue })
    applyFieldValue(editedProcess, editedExperiment, path, newValue)
  }

  return {
    kind: payload.kind,
    schemaVersion: payload.schemaVersion,
    refs: payload.refs,
    original: { process: originalProcess, experiment: originalExperiment },
    edited: { process: editedProcess, experiment: editedExperiment },
    edits,
    errors,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utilities (import previews / tooling / tests)
// ─────────────────────────────────────────────────────────────────────────────

/** List the editable AcroForm field names in a PDF (excludes the payload field). */
export async function readFieldNames(
  bytes: Uint8Array | ArrayBuffer,
): Promise<string[]> {
  const { PDFDocument } = await import("pdf-lib")
  const doc = await PDFDocument.load(bytes)
  return doc
    .getForm()
    .getFields()
    .map((f) => f.getName())
    .filter((n) => n !== PAYLOAD_FIELD_NAME)
}

/**
 * Set raw form-field values and re-serialize — models a user editing fields in
 * an external PDF viewer. Unknown/mistyped fields are ignored.
 */
export async function writeFieldValues(
  bytes: Uint8Array | ArrayBuffer,
  values: Record<string, string>,
): Promise<Uint8Array> {
  const { PDFDocument } = await import("pdf-lib")
  const doc = await PDFDocument.load(bytes)
  const form = doc.getForm()
  for (const [name, value] of Object.entries(values)) {
    try {
      form.getTextField(name).setText(value)
      continue
    } catch {
      // not a text field
    }
    try {
      form.getDropdown(name).select(value)
    } catch {
      // unknown field — ignore
    }
  }
  return doc.save()
}
