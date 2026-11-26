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
  source: string
  batch: string
  /** true = represented in a summary; false = additional; null = unknown. */
  in_summary: boolean | null
  cell: string
  pixel: string
  substrate_group: string
  date?: string
  user?: string
}

/** Non-CHOSE text entries extracted from a ZIP, for native client parsing. */
export type OtherFile = {
  filename: string
  content: string
}

export type ParseResult = {
  measurements: ServerMeasurement[]
  other_files: OtherFile[]
  skipped: { file: string; reason: string }[]
  warnings: string[]
  archive_path: string | null
  raw_file_count: number
}

/**
 * True only for the structured CHOSE ``Stability (JV)`` export. The
 * ``Stability (Parameters)`` / ``Stability (Tracking)`` exports share the same
 * header/data layout but are NOT JV measurements — they must keep the native
 * client scanner, not the JV-only structured parser.
 */
export function isChoseStructured(text: string): boolean {
  return (
    text.includes("## Data ##") &&
    text.toLowerCase().includes("stability (jv)")
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
    measurementDate: m.date ?? undefined,
    user: m.user ?? undefined,
    direction: m.direction === "FW" || m.direction === "RV" ? m.direction : undefined,
    inSummary: m.in_summary,
    batch: m.batch || undefined,
    substrateGroup: m.substrate_group || undefined,
    notes: `Parsed from ${m.source}${m.direction ? ` (${m.direction})` : ""}${coverage}`,
  }
}

/** POST files to the backend structured parser. ZIPs and individual CHOSE JV
 *  text files are both accepted. Returns structured measurements plus the
 *  staged temporary raw-file archive (for NOMAD preparation). */
export async function parseMeasurementFiles(
  files: File[],
  archivePath?: string | null,
): Promise<ParseResult> {
  const token = await getTokenAsync()
  const form = new FormData()
  // Append to the existing raw-file archive so successive drops keep all files.
  if (archivePath) {
    form.append("archive_path", archivePath)
  }
  for (const f of files) {
    form.append("files", f)
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
