// ─────────────────────────────────────────────────────────────────────────────
// Versioned serialization for Process / Experiment PDF export & import.
//
// The exported PDF carries TWO representations of the entity:
//   1. a canonical JSON payload (the raw `Process` / `Experiment` at export time),
//      tagged with `PDF_SCHEMA_VERSION` and the app ids — the source of truth for
//      a later import;
//   2. AcroForm form fields, whose names are produced by the field-name codec in
//      this module so that import can decode a field back to a data path.
//
// IMPORTANT — downward compatibility: `PDF_SCHEMA_VERSION` MUST be bumped whenever
// the serialized shape below changes (including changes to `Process` / `Experiment`
// in AppContext.tsx that alter what gets serialized, or to the field-name codec).
// Each bump must add a migration entry to the import ladder so older PDFs remain
// readable. See docs/plans/process-experiment-pdf-*.md and the remark in CLAUDE.md.
// ─────────────────────────────────────────────────────────────────────────────

import type { PDFDocument } from "pdf-lib"
import type { Experiment, Process } from "@/store/AppContext"

/** Bump on ANY change to the serialized shape or the field-name codec. */
export const PDF_SCHEMA_VERSION = 1

/** Minimal name lookups so an importer can resolve ids without the whole DB. */
export type EntityRef = { id: string; name: string }
export type EntityRefs = {
  materials: EntityRef[]
  solutions: EntityRef[]
}

/**
 * Snapshot of every editable AcroForm field's exported value, keyed by field
 * name (see the codec). Import diffs the PDF's live field values against this to
 * detect user edits without having to re-derive export formatting.
 */
export type FieldSnapshot = Record<string, string>

export type SerializedProcess = {
  schemaVersion: number
  kind: "process"
  process: Process
  refs: EntityRefs
  fields?: FieldSnapshot
}

export type SerializedExperiment = {
  schemaVersion: number
  kind: "experiment"
  experiment: Experiment
  process: Process
  refs: EntityRefs
  fields?: FieldSnapshot
}

export type SerializedPayload = SerializedProcess | SerializedExperiment

export function serializeProcess(
  process: Process,
  refs: EntityRefs,
): SerializedProcess {
  return {
    schemaVersion: PDF_SCHEMA_VERSION,
    kind: "process",
    process,
    refs,
  }
}

export function serializeExperiment(
  experiment: Experiment,
  process: Process,
  refs: EntityRefs,
): SerializedExperiment {
  return {
    schemaVersion: PDF_SCHEMA_VERSION,
    kind: "experiment",
    experiment,
    process,
    refs,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Field-name codec
//
// AcroForm field names must be unique per form, and pdf-lib treats "." as a
// hierarchy separator — so we use ":" to join path segments. Ids are UUIDs and
// parameter keys are fixed identifiers, neither of which contain ":".
//
// Keep BOTH directions here so export and import can never disagree.
// ─────────────────────────────────────────────────────────────────────────────

export type FieldPath =
  | { kind: "processName" }
  | { kind: "processDescription" }
  | { kind: "recipeTotalSolvent"; recipeId: string }
  | { kind: "recipeCommercialName"; recipeId: string }
  | { kind: "recipeSupplierNumber"; recipeId: string }
  | { kind: "solventVolume"; recipeId: string; solventId: string }
  | { kind: "soluteAmount"; recipeId: string; soluteId: string }
  | { kind: "soluteUnit"; recipeId: string; soluteId: string }
  | { kind: "stepParam"; stepId: string; paramKey: string }
  | { kind: "stepNotes"; stepId: string }
  | { kind: "substrateLength"; substrateId: string }
  | { kind: "substrateWidth"; substrateId: string }
  | { kind: "substrateHeight"; substrateId: string }
  | { kind: "substrateRoughness"; substrateId: string }
  | { kind: "stackPixelArea"; stackIdx: number }
  | { kind: "stackNumPixels"; stackIdx: number }
  | { kind: "stackLayerThickness"; stackIdx: number; layerId: string }
  | { kind: "stackLayerBandgap"; stackIdx: number; layerId: string }
  | { kind: "experimentDate" }
  | { kind: "experimentEndDate" }
  | { kind: "experimentDescription" }

const SEP = ":"

export function encodeFieldName(path: FieldPath): string {
  switch (path.kind) {
    case "processName":
      return "process:name"
    case "processDescription":
      return "process:description"
    case "recipeTotalSolvent":
      return `chem${SEP}${path.recipeId}${SEP}totalSolventVolumeMl`
    case "recipeCommercialName":
      return `chem${SEP}${path.recipeId}${SEP}commercialName`
    case "recipeSupplierNumber":
      return `chem${SEP}${path.recipeId}${SEP}supplierNumber`
    case "solventVolume":
      return `chem${SEP}${path.recipeId}${SEP}solvent${SEP}${path.solventId}${SEP}volume`
    case "soluteAmount":
      return `chem${SEP}${path.recipeId}${SEP}solute${SEP}${path.soluteId}${SEP}amount`
    case "soluteUnit":
      return `chem${SEP}${path.recipeId}${SEP}solute${SEP}${path.soluteId}${SEP}unit`
    case "stepParam":
      return `step${SEP}${path.stepId}${SEP}param${SEP}${path.paramKey}`
    case "stepNotes":
      return `step${SEP}${path.stepId}${SEP}notes`
    case "substrateLength":
      return `substrate${SEP}${path.substrateId}${SEP}lengthCm`
    case "substrateWidth":
      return `substrate${SEP}${path.substrateId}${SEP}widthCm`
    case "substrateHeight":
      return `substrate${SEP}${path.substrateId}${SEP}heightMm`
    case "substrateRoughness":
      return `substrate${SEP}${path.substrateId}${SEP}roughnessNm`
    case "stackPixelArea":
      return `stack${SEP}${path.stackIdx}${SEP}pixelAreaCm2`
    case "stackNumPixels":
      return `stack${SEP}${path.stackIdx}${SEP}numberOfPixels`
    case "stackLayerThickness":
      return `stack${SEP}${path.stackIdx}${SEP}layer${SEP}${path.layerId}${SEP}thicknessNm`
    case "stackLayerBandgap":
      return `stack${SEP}${path.stackIdx}${SEP}layer${SEP}${path.layerId}${SEP}bandgapEv`
    case "experimentDate":
      return "experiment:date"
    case "experimentEndDate":
      return "experiment:endDate"
    case "experimentDescription":
      return "experiment:description"
  }
}

export function decodeFieldName(name: string): FieldPath | null {
  const parts = name.split(SEP)
  const [head] = parts
  switch (head) {
    case "process":
      if (parts[1] === "name") return { kind: "processName" }
      if (parts[1] === "description") return { kind: "processDescription" }
      return null
    case "experiment":
      if (parts[1] === "date") return { kind: "experimentDate" }
      if (parts[1] === "endDate") return { kind: "experimentEndDate" }
      if (parts[1] === "description") return { kind: "experimentDescription" }
      return null
    case "chem": {
      const recipeId = parts[1]
      if (!recipeId) return null
      if (parts[2] === "totalSolventVolumeMl")
        return { kind: "recipeTotalSolvent", recipeId }
      if (parts[2] === "commercialName")
        return { kind: "recipeCommercialName", recipeId }
      if (parts[2] === "supplierNumber")
        return { kind: "recipeSupplierNumber", recipeId }
      if (parts[2] === "solvent" && parts[4] === "volume")
        return { kind: "solventVolume", recipeId, solventId: parts[3] }
      if (parts[2] === "solute" && parts[4] === "amount")
        return { kind: "soluteAmount", recipeId, soluteId: parts[3] }
      if (parts[2] === "solute" && parts[4] === "unit")
        return { kind: "soluteUnit", recipeId, soluteId: parts[3] }
      return null
    }
    case "step": {
      const stepId = parts[1]
      if (!stepId) return null
      if (parts[2] === "param" && parts[3])
        return { kind: "stepParam", stepId, paramKey: parts[3] }
      if (parts[2] === "notes") return { kind: "stepNotes", stepId }
      return null
    }
    case "substrate": {
      const substrateId = parts[1]
      if (!substrateId) return null
      if (parts[2] === "lengthCm")
        return { kind: "substrateLength", substrateId }
      if (parts[2] === "widthCm") return { kind: "substrateWidth", substrateId }
      if (parts[2] === "heightMm")
        return { kind: "substrateHeight", substrateId }
      if (parts[2] === "roughnessNm")
        return { kind: "substrateRoughness", substrateId }
      return null
    }
    case "stack": {
      const stackIdx = Number(parts[1])
      if (Number.isNaN(stackIdx)) return null
      if (parts[2] === "pixelAreaCm2")
        return { kind: "stackPixelArea", stackIdx }
      if (parts[2] === "numberOfPixels")
        return { kind: "stackNumPixels", stackIdx }
      if (parts[2] === "layer" && parts[4] === "thicknessNm")
        return { kind: "stackLayerThickness", stackIdx, layerId: parts[3] }
      if (parts[2] === "layer" && parts[4] === "bandgapEv")
        return { kind: "stackLayerBandgap", stackIdx, layerId: parts[3] }
      return null
    }
    default:
      return null
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Payload embedding & reading
//
// The canonical JSON travels through the PDF two ways:
//   1. a hidden, widget-less AcroForm text field (`plains:payload`) — the channel
//      import reads, since pdf-lib round-trips form field values reliably;
//   2. a real PDF file attachment (`plains.json`) — a human/tooling-friendly copy.
// The key ids + schema version are also mirrored into document metadata as a
// recognisability marker.
// ─────────────────────────────────────────────────────────────────────────────

export const PAYLOAD_ATTACHMENT_NAME = "plains.json"
export const PAYLOAD_FIELD_NAME = "plains:payload"

/** Marker embedded in the PDF Subject so an importer can recognise our files. */
export function payloadMetadataMirror(payload: SerializedPayload): string {
  const id =
    payload.kind === "process" ? payload.process.id : payload.experiment.id
  return `plains:${payload.kind}:v${payload.schemaVersion}:${id}`
}

export async function embedPayload(
  pdfDoc: PDFDocument,
  payload: SerializedPayload,
  fields?: FieldSnapshot,
): Promise<void> {
  const full: SerializedPayload = fields ? { ...payload, fields } : payload
  const json = JSON.stringify(full)

  // 1. Hidden form field (primary import channel). No addToPage → no widget, so
  //    it never renders but persists in the AcroForm and reads back verbatim.
  const form = pdfDoc.getForm()
  const hidden = form.createTextField(PAYLOAD_FIELD_NAME)
  hidden.setText(json)
  hidden.enableReadOnly()

  // 2. File attachment (human/tooling copy).
  await pdfDoc.attach(new TextEncoder().encode(json), PAYLOAD_ATTACHMENT_NAME, {
    mimeType: "application/json",
    description: "Plains machine-readable process/experiment data",
    creationDate: new Date(),
    modificationDate: new Date(),
  })

  // 3. Metadata mirror (recognisability).
  pdfDoc.setKeywords([payloadMetadataMirror(payload)])
  pdfDoc.setSubject(payloadMetadataMirror(payload))
}

/** Read the canonical payload back out of the hidden form field. */
export function readPayload(pdfDoc: PDFDocument): SerializedPayload | null {
  const form = pdfDoc.getForm()
  let json: string | undefined
  try {
    json = form.getTextField(PAYLOAD_FIELD_NAME).getText() ?? undefined
  } catch {
    return null
  }
  if (!json) return null
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return null
  }
  return migratePayload(raw)
}

// ─────────────────────────────────────────────────────────────────────────────
// Migration ladder — downward compatibility. Each entry migrates from version N
// to N+1. Add one every time PDF_SCHEMA_VERSION is bumped so older PDFs remain
// importable. (No migrations yet; v1 is the initial shape.)
// ─────────────────────────────────────────────────────────────────────────────

const MIGRATIONS: Record<number, (p: SerializedPayload) => SerializedPayload> =
  {
    // 1: (p) => ({ ...p, schemaVersion: 2, /* transform */ }),
  }

/**
 * Validate and upgrade a parsed payload to the current schema version. Returns
 * null if it is not a recognisable Plains payload or is newer than this app.
 */
export function migratePayload(raw: unknown): SerializedPayload | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as { schemaVersion?: unknown; kind?: unknown }
  if (obj.kind !== "process" && obj.kind !== "experiment") return null
  let version = typeof obj.schemaVersion === "number" ? obj.schemaVersion : 0
  if (version > PDF_SCHEMA_VERSION) return null // PDF newer than app
  let payload = raw as SerializedPayload
  while (version < PDF_SCHEMA_VERSION) {
    const migrate = MIGRATIONS[version]
    if (!migrate) return null
    payload = migrate(payload)
    version = payload.schemaVersion
  }
  return payload
}
