// Deterministic scientific analysis over authoritative (corrected, effective)
// measurement values. Pure functions — no persistence, no random data.
//
// Box-plot convention: box = Q1..Q3 (linear-interpolation quartiles), line =
// median, whiskers = min..max (outliers are kept and individually inspectable,
// never hidden by fences). Sample standard deviation is used only when n >= 2.

import type { MeasurementFile } from "@/store/AppContext"

export type Stats = {
  n: number
  min: number
  q1: number
  median: number
  mean: number
  q3: number
  max: number
  /** Sample standard deviation (n - 1); null when n < 2. */
  std: number | null
  iqr: number
}

export type MetricKey =
  | "value"
  | "voc"
  | "jsc"
  | "ff"
  | "vmpp"
  | "jmpp"
  | "pmpp"
  | "rs"
  | "rsh"

export const METRIC_LABELS: Record<MetricKey, string> = {
  value: "PCE (%)",
  voc: "Voc (V)",
  jsc: "Jsc (mA/cm²)",
  ff: "FF (%)",
  vmpp: "Vmpp (V)",
  jmpp: "Jmpp (mA/cm²)",
  pmpp: "Pmpp (mW/cm²)",
  rs: "Rs (Ω)",
  rsh: "Rsh (Ω)",
}

function finite(v: number | null | undefined): v is number {
  return v != null && Number.isFinite(v)
}

function isJv(f: MeasurementFile): boolean {
  return (f.fileType ?? "").toUpperCase() === "JV"
}

/** Metric-specific scientific validity (mirrors quality.ts "invalid" rules).
 *  A contextual warning never invalidates; physically-impossible values do.
 *  Legitimate zeros are preserved. Non-finite values are invalid for every
 *  metric. */
export function isMetricValid(
  metric: MetricKey,
  v: number | null | undefined,
): v is number {
  if (!finite(v)) return false
  if (metric === "value") return v >= 0 // negative PCE is invalid
  if (metric === "ff") return v >= 0 && v <= 100 // FF outside 0–100% is invalid
  return true
}

/** Reliable group identifier: the persistent device-group id when available,
 *  otherwise the parsed substrate group / device label. Never merges unrelated
 *  groups on a matching label alone. */
export function groupKey(f: MeasurementFile): string {
  return (
    f.groupId || f.substrateGroup || f.deviceName || f.fileName || "unassigned"
  )
}

/** Linear-interpolation percentile over a sorted array (LabFlow convention). */
export function percentile(sorted: number[], p: number): number {
  const n = sorted.length
  if (n === 0) return Number.NaN
  if (n === 1) return sorted[0]
  const pos = (n - 1) * p
  const b = Math.floor(pos)
  const r = pos - b
  return b + 1 < n ? sorted[b] + r * (sorted[b + 1] - sorted[b]) : sorted[b]
}

export function descriptiveStats(values: number[]): Stats | null {
  const xs = values.filter(finite)
  if (xs.length === 0) return null
  const sorted = [...xs].sort((a, b) => a - b)
  const n = sorted.length
  const sum = sorted.reduce((s, v) => s + v, 0)
  const mean = sum / n
  const variance =
    n > 1
      ? sorted.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (n - 1)
      : 0
  const q1 = percentile(sorted, 0.25)
  const q3 = percentile(sorted, 0.75)
  return {
    n,
    min: sorted[0],
    q1,
    median: percentile(sorted, 0.5),
    mean,
    q3,
    max: sorted[n - 1],
    std: n > 1 ? Math.sqrt(variance) : null,
    iqr: q3 - q1,
  }
}

/** HI (%) = 100 × (PCE_RV − PCE_FW) / PCE_RV. Requires a valid pair, a
 *  non-negative PCE_FW and a strictly positive RV denominator. */
export function hysteresisPct(
  pceFw: number | null | undefined,
  pceRv: number | null | undefined,
): number | null {
  if (!finite(pceFw) || !finite(pceRv)) return null
  if (pceRv <= 0 || pceFw < 0) return null
  return (100 * (pceRv - pceFw)) / pceRv
}

export type PearsonResult = { n: number; r: number }

/** Pearson correlation; requires at least three complete pairs and non-zero
 *  variance in both variables. */
export function pearson(xs: number[], ys: number[]): PearsonResult | null {
  const pairs: [number, number][] = []
  for (let i = 0; i < Math.min(xs.length, ys.length); i++) {
    if (finite(xs[i]) && finite(ys[i])) pairs.push([xs[i], ys[i]])
  }
  if (pairs.length < 3) return null
  const mx = pairs.reduce((s, p) => s + p[0], 0) / pairs.length
  const my = pairs.reduce((s, p) => s + p[1], 0) / pairs.length
  let num = 0
  let dx = 0
  let dy = 0
  for (const [x, y] of pairs) {
    const a = x - mx
    const b = y - my
    num += a * b
    dx += a * a
    dy += b * b
  }
  if (dx === 0 || dy === 0) return null
  return { n: pairs.length, r: num / Math.sqrt(dx * dy) }
}

export type MetricSelection = {
  values: number[]
  /** Records dropped because explicitly excluded. */
  excludedCount: number
  /** Records dropped because the metric is missing/non-finite or physically
   *  impossible (e.g. negative PCE, FF outside 0–100%). */
  invalidCount: number
  /** Records dropped because they are not JV measurements. */
  nonJvCount: number
  total: number
}

/** Select effective JV metric values for analysis. Only JV records contribute;
 *  excluded observations, non-JV records and metric-invalid (missing/non-finite
 *  or physically-impossible) values are counted but dropped. Contextual
 *  warnings do NOT exclude anything here. */
export function selectMetricValues(
  files: MeasurementFile[],
  metric: MetricKey,
): MetricSelection {
  let excludedCount = 0
  let invalidCount = 0
  let nonJvCount = 0
  const values: number[] = []
  for (const f of files) {
    if (f.excluded) {
      excludedCount += 1
      continue
    }
    if (!isJv(f)) {
      nonJvCount += 1
      continue
    }
    const v = f[metric]
    if (isMetricValid(metric, v)) values.push(v)
    else invalidCount += 1
  }
  return {
    values,
    excludedCount,
    invalidCount,
    nonJvCount,
    total: files.length,
  }
}

/** Per-group metric selection (reliable group identifiers), for box plots and
 *  other group comparisons. */
export function selectMetricValuesByGroup(
  files: MeasurementFile[],
  metric: MetricKey,
): { group: string; selection: MetricSelection }[] {
  const byGroup = new Map<string, MeasurementFile[]>()
  for (const f of files) {
    const key = groupKey(f)
    const arr = byGroup.get(key) ?? []
    arr.push(f)
    byGroup.set(key, arr)
  }
  return Array.from(byGroup.entries()).map(([group, gfiles]) => ({
    group,
    selection: selectMetricValues(gfiles, metric),
  }))
}

export type FwRvPair = { id: string; fw: MeasurementFile; rv: MeasurementFile }

/** Pair FW/RV records by durable source identity. Ambiguity is determined
 *  *before* exclusions: a source must carry exactly one FW and one RV candidate
 *  (regardless of exclusion) to be unambiguous — excluding one of several
 *  candidates does not resolve the ambiguity. Only unambiguous, non-excluded
 *  pairs are returned. */
export function pairFwRv(files: MeasurementFile[]): FwRvPair[] {
  const jv = files.filter(isJv)
  const fwBySource = new Map<string, MeasurementFile[]>()
  const rvBySource = new Map<string, MeasurementFile[]>()
  for (const f of jv) {
    if (!f.sourceFileId) continue
    if (f.direction === "FW") {
      const arr = fwBySource.get(f.sourceFileId) ?? []
      arr.push(f)
      fwBySource.set(f.sourceFileId, arr)
    } else if (f.direction === "RV") {
      const arr = rvBySource.get(f.sourceFileId) ?? []
      arr.push(f)
      rvBySource.set(f.sourceFileId, arr)
    }
  }
  const pairs: FwRvPair[] = []
  for (const [sourceId, fwList] of fwBySource) {
    const rvList = rvBySource.get(sourceId) ?? []
    if (fwList.length === 1 && rvList.length === 1) {
      const fw = fwList[0]
      const rv = rvList[0]
      if (!fw.excluded && !rv.excluded) {
        pairs.push({ id: sourceId, fw, rv })
      }
    }
  }
  return pairs
}

/** Complete X/Y pairs from the same observation, for two JV metrics. Missing or
 *  non-finite values, non-JV records, excluded records and metric-invalid
 *  values are dropped. */
export function pairedValues(
  files: MeasurementFile[],
  xMetric: MetricKey,
  yMetric: MetricKey,
): [number, number][] {
  const pairs: [number, number][] = []
  for (const f of files) {
    if (f.excluded) continue
    if (!isJv(f)) continue
    const x = f[xMetric]
    const y = f[yMetric]
    if (isMetricValid(xMetric, x) && isMetricValid(yMetric, y))
      pairs.push([x, y])
  }
  return pairs
}

/** Paired FW/RV differences (RV − FW) for a metric, over unambiguous JV pairs
 *  with valid values on both sides. `count` is the number of pairs that
 *  actually contributed a difference. */
export function pairedDifferences(
  files: MeasurementFile[],
  metric: MetricKey,
): { count: number; values: number[] } {
  const pairs = pairFwRv(files)
  const values: number[] = []
  for (const { fw, rv } of pairs) {
    const a = fw[metric]
    const b = rv[metric]
    if (isMetricValid(metric, a) && isMetricValid(metric, b)) values.push(b - a)
  }
  return { count: values.length, values }
}

/** Fixed-width histogram. Returns bin edges + counts. */
export function histogram(
  values: number[],
  binCount = 10,
): { edges: number[]; counts: number[]; binCount: number } | null {
  const xs = values.filter(finite)
  if (xs.length === 0) return null
  const min = Math.min(...xs)
  const max = Math.max(...xs)
  if (min === max) {
    return { edges: [min, max], counts: [xs.length], binCount: 1 }
  }
  const count = Math.max(1, binCount)
  const width = (max - min) / count
  const edges: number[] = []
  for (let i = 0; i <= count; i++) edges.push(min + i * width)
  const counts = new Array<number>(count).fill(0)
  for (const v of xs) {
    const idx = Math.min(count - 1, Math.floor((v - min) / width))
    counts[idx] += 1
  }
  return { edges, counts, binCount: count }
}
