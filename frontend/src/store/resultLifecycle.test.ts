import { describe, expect, test } from "bun:test"

import type { ExperimentResults, MeasurementFile } from "./AppContext"
import {
  isImportedResult,
  isPersistableResult,
  staleResultIdsOf,
} from "./resultLifecycle"

function file(overrides: Partial<MeasurementFile> = {}): MeasurementFile {
  return {
    id: "f1",
    fileName: "device.txt",
    fileType: "JV",
    deviceName: "device",
    cell: "",
    pixel: "",
    ...overrides,
  }
}

function result(overrides: Partial<ExperimentResults> = {}): ExperimentResults {
  return {
    id: "r1",
    experimentId: "e1",
    files: [],
    deviceGroups: [],
    groupingStrategy: "search",
    matchingStrategy: "fuzzy",
    updatedAt: "2026-01-01",
    ...overrides,
  }
}

describe("isImportedResult", () => {
  test("recognizes the groupingStrategy=import marker", () => {
    expect(
      isImportedResult(
        result({ groupingStrategy: "import", files: [file()] }),
      ),
    ).toBe(true)
  })

  test("recognizes the notes fallback (pre-marker records)", () => {
    expect(
      isImportedResult(
        result({ files: [file({ notes: "Imported from ZIP: JV Summary.txt (FW)" })] }),
      ),
    ).toBe(true)
  })

  test("does not classify ordinary NOMAD staging as imported", () => {
    expect(isImportedResult(result({ files: [file()] }))).toBe(false)
  })
})

describe("staleResultIdsOf (transient NOMAD staging cleanup)", () => {
  test("keeps imported results (marker)", () => {
    const imported = result({ id: "imp", groupingStrategy: "import", files: [file()] })
    expect(staleResultIdsOf([imported]).has("imp")).toBe(false)
  })

  test("keeps imported results (notes fallback)", () => {
    const imported = result({
      id: "imp",
      files: [file({ notes: "Imported from ZIP: JV Summary.txt (RV)" })],
    })
    expect(staleResultIdsOf([imported]).has("imp")).toBe(false)
  })

  test("keeps uploaded results", () => {
    const uploaded = result({
      id: "up",
      files: [file()],
      nomad: { upload_id: "u1" },
    })
    expect(staleResultIdsOf([uploaded]).has("up")).toBe(false)
  })

  test("flags ordinary staging (files without upload_id and not imported)", () => {
    const staging = result({ id: "stg", files: [file()] })
    expect(staleResultIdsOf([staging]).has("stg")).toBe(true)
  })

  test("does not flag empty results", () => {
    const empty = result({ id: "empty", files: [] })
    expect(staleResultIdsOf([empty]).has("empty")).toBe(false)
  })
})

describe("isPersistableResult (save snapshot filter)", () => {
  test("keeps empty results", () => {
    expect(isPersistableResult(result({ files: [] }))).toBe(true)
  })

  test("keeps uploaded results", () => {
    expect(
      isPersistableResult(result({ files: [file()], nomad: { upload_id: "u1" } })),
    ).toBe(true)
  })

  test("keeps imported results (marker)", () => {
    expect(
      isPersistableResult(result({ groupingStrategy: "import", files: [file()] })),
    ).toBe(true)
  })

  test("keeps imported results (notes fallback)", () => {
    expect(
      isPersistableResult(
        result({ files: [file({ notes: "Imported from ZIP: JV Summary.txt (FW)" })] }),
      ),
    ).toBe(true)
  })

  test("excludes ordinary NOMAD staging", () => {
    expect(isPersistableResult(result({ files: [file()] }))).toBe(false)
  })
})
