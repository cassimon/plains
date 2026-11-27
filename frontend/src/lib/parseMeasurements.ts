// ─────────────────────────────────────────────────────────────────────────────
// parseMeasurements — server-side structured parsing for the native upload flow.
//
// CHOSE ``Stability (JV)`` files (structured header + tab-delimited FW/RV data)
// and ZIP archives are parsed by the backend's single scientific parser
// (services/zip_import.py) so individual files, directories and ZIP archives
// all produce identical measurements. The client keeps its own lightweight
// scanner only for formats the structured parser does not cover (Dark JV, IPCE,
// Stability, UV-Vis).
// ─────────────────────────────────────────────────────────────────────────────

import { OpenAPI } from "@/client/core/OpenAPI"
import { getTokenAsync } from "@/lib/keycloakInstance"
import type { MeasurementFile } from "@/store/AppContext"

export type ServerMeasurement = {
  file: string
  filename: string
  device: string
  direction: string | null
  voc: number | null
  jsc: number | null
  ff: number | null
  eff: number | null
  vmpp?: number | null
  jmpp?: number | null
  pmpp?: number | null
  rs?: number | null
  rsh?: number | null
  curve?: { v: number; j: number }[]
  source: string
  batch: string
  /** true = represented in a summary; false = additional; null = unknown. */
  in_summary: boolean | null
  cell: string
  pixel: string
  substrate_group: string
  date?: string
  user?: string
  /** Durable provenance: id of the stored original source file. */
  source_file_id?: string | null
  /** Record-level locator within the source file. */
  source_record_locator?: string | null
  /** Relative path of the source file (same as `source`). */
  source_path?: string | null
}

/** Non-CHOSE text entries extracted from a ZIP, for native client parsing. */
export type OtherFile = {
  filename: string
  content: string
}

export type InventoryEntry = {
  name: string
  directory: boolean
  size: number
  type: string
  recognized: boolean
}

export type ParseResult = {
  measurements: ServerMeasurement[]
  other_files: OtherFile[]
  skipped: { file: string; reason: string }[]
  warnings: string[]
  archive_path: string | null
  raw_file_count: number
  original_file_count: number
  recognized_file_count: number
  inventory: InventoryEntry[]
}

/**
 * True only for the structured CHOSE ``Stability (JV)`` export. The
 * ``Stability (Parameters)`` / ``Stability (Tracking)`` exports share the same
 * header/data layout but are NOT JV measurements — they must keep the native
 * client scanner, not the JV-only structured parser.
 */
export function isChoseStructured(text: string): boolean {
  return (
    text.includes("## Data ##") && text.toLowerCase().includes("stability (jv)")
  )
}

export function serverMeasurementToFile(m: ServerMeasurement): MeasurementFile {
  const coverage =
    m.in_summary === true
      ? " · in summary"
      : m.in_summary === false
        ? " · additional"
        : " · summary coverage unknown"
  return {
    id: crypto.randomUUID(),
    fileName: m.filename,
    fileType: "JV",
    deviceName: m.device,
    cell: m.cell,
    pixel: m.pixel,
    value: m.eff ?? undefined,
    voc: m.voc ?? undefined,
    jsc: m.jsc ?? undefined,
    ff: m.ff ?? undefined,
    vmpp: m.vmpp ?? undefined,
    jmpp: m.jmpp ?? undefined,
    pmpp: m.pmpp ?? undefined,
    rs: m.rs ?? undefined,
    rsh: m.rsh ?? undefined,
    curve: m.curve ?? undefined,
    measurementDate: m.date ?? undefined,
    user: m.user ?? undefined,
    direction:
      m.direction === "FW" || m.direction === "RV" ? m.direction : undefined,
    inSummary: m.in_summary,
    batch: m.batch || undefined,
    substrateGroup: m.substrate_group || undefined,
    sourcePath: m.source_path ?? (m.source || undefined),
    sourceFileId: m.source_file_id ?? undefined,
    sourceRecordLocator: m.source_record_locator ?? undefined,
    notes: `Parsed from ${m.source}${m.direction ? ` (${m.direction})` : ""}${coverage}`,
  }
}

export type ParseOptions = {
  /**
   * When false the backend performs a pure exploratory parse and does NOT stage
   * a temporary NOMAD archive (no persistent side effects). Default true.
   */
  stage?: boolean
  /**
   * Optional client-side relative path for each file, aligned with the `files`
   * array (e.g. files selected from a directory). Preserves the original
   * relative location for provenance.
   */
  paths?: string[]
}

/** POST files to the backend structured parser. ZIPs and individual CHOSE JV
 *  text files are both accepted. Returns structured measurements plus the
 *  staged temporary raw-file archive (for NOMAD preparation) unless
 *  `options.stage` is false. */
export async function parseMeasurementFiles(
  files: File[],
  archivePath?: string | null,
  options?: ParseOptions,
): Promise<ParseResult> {
  const token = await getTokenAsync()
  const form = new FormData()
  // Append to the existing raw-file archive so successive drops keep all files.
  if (archivePath) {
    form.append("archive_path", archivePath)
  }
  form.append("stage", options?.stage === false ? "false" : "true")
  for (const f of files) {
    form.append("files", f)
  }
  if (options?.paths) {
    for (const p of options.paths) {
      form.append("paths", p)
    }
  }
  const res = await fetch(`${OpenAPI.BASE}/api/v1/zip-explorer/parse`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  })
  if (!res.ok) {
    let detail: string | undefined
    try {
      const data = await res.json()
      detail = (data as { detail?: string })?.detail
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail ?? `Request failed (${res.status})`)
  }
  return (await res.json()) as ParseResult
}

/** Pure exploratory parse used by the import preview: returns structured
 *  measurements, skipped files and warnings without touching the NOMAD staging
 *  archive. */
export function parseMeasurementFilesPreview(
  files: File[],
  paths?: string[],
): Promise<ParseResult> {
  return parseMeasurementFiles(files, null, { stage: false, paths })
}

export type SourceFileInfo = {
  id: string
  relative_path: string | null
  original_filename: string
  size: number
  sha256: string
  file_type: string | null
}

export type ImportResult = {
  import_id: string
  experiment_id: string
  measurements: ServerMeasurement[]
  skipped: { file: string; reason: string }[]
  warnings: string[]
  source_files: SourceFileInfo[]
}

/** Confirm an import: persist original source files server-side and return the
 *  structured measurements linked to their stored source evidence. Idempotent
 *  per `importId` (retries reuse stored sources). */
export async function importMeasurementSources(
  experimentId: string,
  importId: string,
  files: File[],
  paths?: string[],
): Promise<ImportResult> {
  const token = await getTokenAsync()
  const form = new FormData()
  form.append("experiment_id", experimentId)
  form.append("import_id", importId)
  for (const f of files) {
    form.append("files", f)
  }
  if (paths) {
    for (const p of paths) {
      form.append("paths", p)
    }
  }
  const res = await fetch(`${OpenAPI.BASE}/api/v1/zip-explorer/import`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : undefined,
    body: form,
  })
  if (!res.ok) {
    let detail: string | undefined
    try {
      const data = await res.json()
      detail = (data as { detail?: string })?.detail
    } catch {
      /* non-JSON error body */
    }
    throw new Error(detail ?? `Import request failed (${res.status})`)
  }
  return (await res.json()) as ImportResult
}
