import { describe, expect, test } from "bun:test"

import { isChoseStructured, serverMeasurementToFile } from "./parseMeasurements"

describe("isChoseStructured", () => {
  test("recognizes the CHOSE structured JV layout", () => {
    const text =
      "## Header ##\n[General info]\nDevice\tN 1 1-1A\nTest\tStability (JV)\n## Data ##\nScan\tVoc\nFW\t1.0\t20"
    expect(isChoseStructured(text)).toBe(true)
  })

  test("rejects Stability (Parameters) structured files", () => {
    const text =
      "## Header ##\n[General info]\nDevice\tN 1 1-1A\nTest\tStability (Parameters)\n## Data ##\nScan\tVoc"
    expect(isChoseStructured(text)).toBe(false)
  })

  test("rejects Stability (Tracking) structured files", () => {
    const text =
      "## Header ##\n[General info]\nDevice\tN 1 1-1A\nTest\tStability (Tracking)\n## Data ##\nScan\tVoc"
    expect(isChoseStructured(text)).toBe(false)
  })

  test("rejects other text formats (no data section)", () => {
    expect(isChoseStructured("Device: AI44\nVoc: 1.1\nJsc: 20")).toBe(false)
  })
})

describe("serverMeasurementToFile", () => {
  test("preserves full device id, cell/pixel, FW/RV and parameters", () => {
    const f = serverMeasurementToFile({
      file: "dir/0001_Stability (JV)_N 1 1-1A.txt",
      filename: "0001_Stability (JV)_N 1 1-1A.txt",
      device: "N 1 1-1A",
      cell: "1",
      pixel: "A",
      direction: "FW",
      voc: 1.013,
      jsc: 21.18,
      ff: 67.11,
      eff: 14.42,
      source: "dir/0001_Stability (JV)_N 1 1-1A.txt",
      batch: "2026_01_22",
      in_summary: true,
      substrate_group: "N 1 1",
      date: "2026-01-22",
      user: "KARTHI",
    })

    expect(f.fileType).toBe("JV")
    expect(f.deviceName).toBe("N 1 1-1A")
    expect(f.cell).toBe("1")
    expect(f.pixel).toBe("A")
    expect(f.voc).toBe(1.013)
    expect(f.jsc).toBe(21.18)
    expect(f.ff).toBe(67.11)
    expect(f.value).toBe(14.42)
    expect(f.notes).toContain("(FW)")
    expect(f.notes).toContain("Stability (JV)")
  })

  test("FW and RV rows from the same file get distinct ids", () => {
    const base = {
      file: "f.txt", filename: "f.txt", device: "D-1A", cell: "1", pixel: "A",
      voc: 1, jsc: 20, ff: 70, eff: 14, source: "f.txt", batch: "b",
      in_summary: true, substrate_group: "D",
    }
    const fw = serverMeasurementToFile({ ...base, direction: "FW" })
    const rv = serverMeasurementToFile({ ...base, direction: "RV" })
    expect(fw.id).not.toBe(rv.id)
  })
})
