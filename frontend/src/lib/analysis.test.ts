import { describe, expect, test } from "bun:test"
import type { MeasurementFile } from "@/store/AppContext"
import {
  descriptiveStats,
  histogram,
  hysteresisPct,
  pairedDifferences,
  pairedValues,
  pairFwRv,
  pearson,
  selectMetricValues,
} from "./analysis"

function mf(over: Partial<MeasurementFile> = {}): MeasurementFile {
  return {
    id: crypto.randomUUID(),
    fileName: "f.txt",
    fileType: "JV",
    deviceName: "D",
    cell: "",
    pixel: "",
    ...over,
  }
}

describe("descriptiveStats", () => {
  test("computes count/mean/median/min/max/q1/q3/iqr/std for a known set", () => {
    // [1,2,3,4,5] -> mean 3, median 3, q1 2, q3 4, sample std ~1.5811
    const s = descriptiveStats([1, 2, 3, 4, 5])
    expect(s).not.toBeNull()
    expect(s!.n).toBe(5)
    expect(s!.min).toBe(1)
    expect(s!.max).toBe(5)
    expect(s!.mean).toBeCloseTo(3, 10)
    expect(s!.median).toBeCloseTo(3, 10)
    expect(s!.q1).toBeCloseTo(2, 10)
    expect(s!.q3).toBeCloseTo(4, 10)
    expect(s!.iqr).toBeCloseTo(2, 10)
    expect(s!.std!).toBeCloseTo(Math.sqrt(2.5), 10)
  })

  test("sample std is null when n < 2", () => {
    expect(descriptiveStats([7])!.std).toBeNull()
    expect(descriptiveStats([])).toBeNull()
  })

  test("legitimate zeros are preserved (not dropped)", () => {
    const s = descriptiveStats([0, 0, 0])
    expect(s!.n).toBe(3)
    expect(s!.mean).toBe(0)
  })

  test("non-finite values are ignored, not treated as zero", () => {
    const s = descriptiveStats([1, Number.NaN, 3, Infinity])
    expect(s!.n).toBe(2)
    expect(s!.mean).toBe(2)
  })
})

describe("hysteresisPct", () => {
  test("HI% = 100*(RV-FW)/RV", () => {
    expect(hysteresisPct(10, 12)).toBeCloseTo((100 * (12 - 10)) / 12, 10)
  })
  test("requires finite values and strictly positive RV denominator", () => {
    expect(hysteresisPct(null, 12)).toBeNull()
    expect(hysteresisPct(10, 0)).toBeNull()
    expect(hysteresisPct(10, -2)).toBeNull() // negative RV denominator
    expect(hysteresisPct(-1, 12)).toBeNull() // negative FW PCE
    expect(hysteresisPct(Number.NaN, 12)).toBeNull()
  })
})

describe("pearson", () => {
  test("perfect positive correlation", () => {
    const r = pearson([1, 2, 3], [2, 4, 6])
    expect(r).not.toBeNull()
    expect(r!.r).toBeCloseTo(1, 10)
    expect(r!.n).toBe(3)
  })
  test("requires at least three complete pairs", () => {
    expect(pearson([1, 2], [2, 4])).toBeNull()
  })
  test("zero variance is rejected", () => {
    expect(pearson([1, 2, 3], [5, 5, 5])).toBeNull()
  })
})

describe("selectMetricValues", () => {
  test("excluded records are counted and dropped; invalid counted separately", () => {
    const files = [
      mf({ value: 10 }),
      mf({ value: 20, excluded: true }),
      mf({ value: Number.NaN }),
      mf({ value: 30 }),
    ]
    const sel = selectMetricValues(files, "value")
    expect(sel.values).toEqual([10, 30])
    expect(sel.excludedCount).toBe(1)
    expect(sel.invalidCount).toBe(1)
    expect(sel.total).toBe(4)
  })
})

describe("pairFwRv / pairedDifferences", () => {
  test("pairs by durable source id + explicit opposite direction", () => {
    const files = [
      mf({ id: "fw1", sourceFileId: "S1", direction: "FW", value: 10 }),
      mf({ id: "rv1", sourceFileId: "S1", direction: "RV", value: 12 }),
      mf({ id: "fw2", sourceFileId: "S2", direction: "FW", value: 8 }), // no RV counterpart
      mf({ id: "orphan", direction: "FW", value: 5 }), // no source id
    ]
    expect(pairFwRv(files).length).toBe(1)
    const d = pairedDifferences(files, "value")
    expect(d.values).toEqual([2]) // RV 12 - FW 10
  })

  test("excludes excluded observations and never resolves ambiguity by order", () => {
    const files = [
      mf({ id: "fw1", sourceFileId: "S1", direction: "FW", value: 10 }),
      mf({ id: "rv1", sourceFileId: "S1", direction: "RV", value: 12 }),
      // a second RV for the same source -> ambiguous, must NOT pair
      mf({ id: "rv2", sourceFileId: "S1", direction: "RV", value: 99 }),
      // an excluded FW/RV pair that must NOT pair
      mf({
        id: "fwX",
        sourceFileId: "S2",
        direction: "FW",
        value: 5,
        excluded: true,
      }),
      mf({
        id: "rvX",
        sourceFileId: "S2",
        direction: "RV",
        value: 6,
        excluded: true,
      }),
    ]
    expect(pairFwRv(files).length).toBe(0)
  })
})

describe("pairedValues + pearson (same-observation pairs)", () => {
  test("reference regression: r=1, n=3", () => {
    const files = [
      mf({ value: 1, voc: 2 }),
      mf({ value: 2, voc: undefined }), // missing voc -> dropped
      mf({ value: undefined, voc: 1 }), // missing PCE -> dropped
      mf({ value: 3, voc: 6 }),
      mf({ value: 4, voc: 8 }),
    ]
    const pairs = pairedValues(files, "value", "voc")
    expect(pairs.length).toBe(3)
    const r = pearson(
      pairs.map((p) => p[0]),
      pairs.map((p) => p[1]),
    )
    expect(r).not.toBeNull()
    expect(r!.n).toBe(3)
    expect(r!.r).toBeCloseTo(1, 10)
  })

  test("selectMetricValues excludes non-JV records", () => {
    const files = [
      mf({ fileType: "JV", value: 10 }),
      mf({ fileType: "UV-Vis", value: 5 }),
    ]
    const sel = selectMetricValues(files, "value")
    expect(sel.values).toEqual([10])
    expect(sel.nonJvCount).toBe(1)
  })
})

describe("histogram", () => {
  test("single bin for constant values; normal binning otherwise", () => {
    expect(histogram([5, 5, 5])!.binCount).toBe(1)
    const h = histogram([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 5)
    expect(h!.binCount).toBe(5)
    expect(h!.counts.reduce((a, b) => a + b, 0)).toBe(10)
  })
})
