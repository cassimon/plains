import { describe, expect, test } from "bun:test"
import { qualityFindings } from "./quality"

const jv = (over: Record<string, unknown> = {}) => ({
  fileType: "JV",
  voc: 1.1,
  jsc: 22.5,
  ff: 76.4,
  value: 18.9,
  ...over,
})

describe("qualityFindings (deterministic JV checks)", () => {
  test("normal JV record has no findings", () => {
    expect(qualityFindings(jv())).toEqual([])
  })

  test("missing metric is reported, not treated as zero", () => {
    const findings = qualityFindings(jv({ voc: undefined }))
    expect(
      findings.some((f) => f.severity === "missing" && f.metric === "Voc"),
    ).toBe(true)
  })

  test("non-finite value is invalid", () => {
    const findings = qualityFindings(jv({ ff: Number.NaN }))
    expect(
      findings.some((f) => f.severity === "invalid" && f.metric === "FF"),
    ).toBe(true)
  })

  test("contextual outlier is a warning, not invalid", () => {
    const findings = qualityFindings(jv({ voc: 2.5 }))
    const voc = findings.filter((f) => f.metric === "Voc")
    expect(voc.some((f) => f.severity === "warning")).toBe(true)
    expect(voc.some((f) => f.severity === "invalid")).toBe(false)
  })

  test("physically impossible values are invalid", () => {
    const findings = qualityFindings(jv({ voc: -0.1, ff: 101, value: -1 }))
    expect(findings.filter((f) => f.severity === "invalid").length).toBe(3)
  })

  test("zero values are legitimate (no findings)", () => {
    expect(qualityFindings(jv({ voc: 0, jsc: 0, ff: 0, value: 0 }))).toEqual([])
  })

  test("non-JV records get no JV findings", () => {
    expect(qualityFindings({ fileType: "UV-Vis", value: 0.5 })).toEqual([])
  })
})
