// Deterministic scientific quality findings for JV measurement records.
// Mirrors backend/app/services/quality.py (the authoritative implementation) so
// the review panel can compute findings from already-loaded measurements without
// a round-trip. Ranges beyond a *typical* perovskite cell are warnings, not
// physical invalidity; only non-finite values and physically impossible values
// are "invalid". Nothing here auto-excludes a measurement.

export type QualityFinding = {
  severity: "invalid" | "warning" | "missing"
  metric: string
  message: string
  value: number | null
}

const VOC_MAX_TYPICAL = 2.0
const JSC_MAX_TYPICAL = 50.0
const FF_MAX_TYPICAL = 90.0
const PCE_MAX_TYPICAL = 40.0

function finite(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v)
}

export function qualityFindings(m: {
  fileType?: string
  voc?: number
  jsc?: number
  ff?: number
  value?: number
}): QualityFinding[] {
  if ((m.fileType ?? "").toUpperCase() !== "JV") return []

  const findings: QualityFinding[] = []
  const add = (
    severity: QualityFinding["severity"],
    metric: string,
    message: string,
    value: number | null,
  ) => findings.push({ severity, metric, message, value })

  const { voc, jsc, ff, value: pce } = m

  for (const [metric, v] of [
    ["Voc", voc],
    ["Jsc", jsc],
    ["FF", ff],
    ["PCE", pce],
  ] as const) {
    if (v == null) add("missing", metric, `${metric} is missing`, null)
    else if (!Number.isFinite(v))
      add("invalid", metric, `${metric} is non-finite`, v)
  }

  if (finite(voc) && voc < 0)
    add("invalid", "Voc", "Negative open-circuit voltage", voc)
  if (finite(ff) && (ff < 0 || ff > 100))
    add("invalid", "FF", "Fill factor outside 0–100%", ff)
  if (finite(pce) && pce < 0) add("invalid", "PCE", "Negative efficiency", pce)

  if (finite(voc) && voc > VOC_MAX_TYPICAL)
    add(
      "warning",
      "Voc",
      `Voc above typical range (> ${VOC_MAX_TYPICAL} V)`,
      voc,
    )
  if (finite(jsc) && jsc < 0)
    add("warning", "Jsc", "Negative Jsc — check sign convention", jsc)
  if (finite(jsc) && Math.abs(jsc) > JSC_MAX_TYPICAL)
    add(
      "warning",
      "Jsc",
      `|Jsc| above typical range (> ${JSC_MAX_TYPICAL} mA/cm²)`,
      jsc,
    )
  if (finite(ff) && ff > FF_MAX_TYPICAL)
    add("warning", "FF", `FF above typical range (> ${FF_MAX_TYPICAL}%)`, ff)
  if (finite(pce) && pce > PCE_MAX_TYPICAL)
    add(
      "warning",
      "PCE",
      `PCE above typical range (> ${PCE_MAX_TYPICAL}%)`,
      pce,
    )

  return findings
}
