import { describe, expect, test } from "bun:test"

import type { DeviceGroup, ExperimentResults, MeasurementFile } from "./AppContext"
import {
  isImportedResult,
  isPersistableResult,
  reconcileGroupIds,
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

describe("reconcileGroupIds (persistent group membership)", () => {
  function group(overrides: Partial<DeviceGroup> = {}): DeviceGroup {
    return { id: "g1", deviceName: "d", files: [], assignedSubstrateId: null, ...overrides }
  }

  test("stamps the flat files with their owning group id", () => {
    const f1 = file({ id: "f1", groupId: null })
    const f2 = file({ id: "f2", groupId: undefined })
    const r = result({
      files: [f1, f2],
      deviceGroups: [group({ id: "g1", files: [f1] })],
    })
    const out = reconcileGroupIds(r)
    expect(out.files.find((f) => f.id === "f1")?.groupId).toBe("g1")
    expect(out.files.find((f) => f.id === "f2")?.groupId).toBeNull()
  })

  test("unassigned measurements stay unassigned (no name fallback)", () => {
    // A file whose deviceName equals the group's name but is NOT in the group's
    // files must NOT be assigned by name.
    const f1 = file({ id: "f1", deviceName: "shared", groupId: undefined })
    const r = result({
      files: [f1],
      deviceGroups: [group({ id: "g1", deviceName: "shared", files: [] })],
    })
    const out = reconcileGroupIds(r)
    expect(out.files[0].groupId).toBeNull()
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
