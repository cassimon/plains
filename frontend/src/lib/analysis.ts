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
  /** Records dropped because the metric is missing or non-finite. */
  invalidCount: number
  /** Records dropped because they are not JV measurements. */
  nonJvCount: number
  total: number
}

/** Select effective JV metric values for analysis. Only JV records contribute;
 *  excluded observations and non-finite values are counted but dropped.
 *  Contextual warnings do NOT exclude anything here. */
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
    if ((f.fileType ?? "").toUpperCase() !== "JV") {
      nonJvCount += 1
      continue
    }
    const v = f[metric]
    if (finite(v)) values.push(v)
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

export type FwRvPair = { id: string; fw: MeasurementFile; rv: MeasurementFile }

/** Pair FW/RV records by durable source identity. Requires exactly one
 *  eligible FW and one eligible RV per source (never resolves ambiguity by
 *  array order); explicitly excluded observations never pair. */
export function pairFwRv(files: MeasurementFile[]): FwRvPair[] {
  const eligible = files.filter((f) => !f.excluded)
  const fwBySource = new Map<string, MeasurementFile[]>()
  const rvBySource = new Map<string, MeasurementFile[]>()
  for (const f of eligible) {
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
      pairs.push({ id: sourceId, fw: fwList[0], rv: rvList[0] })
    }
  }
  return pairs
}

/** Complete X/Y pairs from the same observation, for two JV metrics. Missing
 *  or non-finite values, non-JV records and excluded records are dropped. */
export function pairedValues(
  files: MeasurementFile[],
  xMetric: MetricKey,
  yMetric: MetricKey,
): [number, number][] {
  const pairs: [number, number][] = []
  for (const f of files) {
    if (f.excluded) continue
    if ((f.fileType ?? "").toUpperCase() !== "JV") continue
    const x = f[xMetric]
    const y = f[yMetric]
    if (finite(x) && finite(y)) pairs.push([x, y])
  }
  return pairs
}

/** Paired FW/RV differences (RV − FW) for a metric, over unambiguous pairs. */
export function pairedDifferences(
  files: MeasurementFile[],
  metric: MetricKey,
): { count: number; values: number[] } {
  const pairs = pairFwRv(files)
  const values: number[] = []
  for (const { fw, rv } of pairs) {
    const a = fw[metric]
    const b = rv[metric]
    if (finite(a) && finite(b)) values.push(b - a)
  }
  return { count: pairs.length, values }
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
