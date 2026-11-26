import { describe, expect, test } from "bun:test"

import {
  bulkToSnapshot,
  derivePlacement,
  deviceGroupsToApi,
  experimentToApi,
  measurementFilesToApi,
} from "./backendMapping"
import type { Experiment, ExperimentResults, MeasurementFile } from "./AppContext"

function mf(overrides: Partial<MeasurementFile> = {}): MeasurementFile {
  return {
    id: "f1",
    fileName: "device.txt",
    fileType: "JV",
    deviceName: "DEVICE-1",
    cell: "",
    pixel: "",
    ...overrides,
  }
}

describe("bulkToSnapshot — DeviceGroup.files reconstruction", () => {
  test("reconstructs group membership from device_name", () => {
    const bulk = {
      results: [
        {
          id: "r1",
          experiment_id: "e1",
          grouping_strategy: "import",
          matching_strategy: "manual",
          measurement_files: [
            {
              id: "f1",
              filename: "DEVICE-1.txt",
              file_type: "JV",
              device_name: "DEVICE-1",
              device_group_id: "g1",
              voc: 1.1,
              jsc: 22.5,
              ff: 76.4,
              value: 18.9,
              notes: "Imported from ZIP: JV Summary_Parameters FW.txt (FW)",
            },
            {
              id: "f2",
              filename: "DEVICE-1.txt",
              file_type: "JV",
              device_name: "DEVICE-1",
              device_group_id: "g1",
              voc: 1.08,
              jsc: 21.9,
              ff: 75.0,
              value: 18.0,
              notes: "Imported from ZIP: JV Summary_Parameters RV.txt (RV)",
            },
            {
              id: "f3",
              filename: "DEVICE-2.txt",
              file_type: "JV",
              device_name: "DEVICE-2",
              device_group_id: "g2",
              voc: 1.05,
              jsc: 20.0,
              ff: 74.0,
              value: 17.0,
              notes: "Imported from ZIP: JV Summary_Parameters FW.txt (FW)",
            },
          ],
          device_groups: [
            { id: "g1", name: "DEVICE-1", assigned_substrate_id: null },
            { id: "g2", name: "DEVICE-2", assigned_substrate_id: "sub-1" },
          ],
        },
      ],
      experiments: [],
      processes: [],
      planes: [],
    }

    const snapshot = bulkToSnapshot(bulk)
    const r = snapshot.results[0]

    expect(r.groupingStrategy).toBe("import")
    expect(r.files.length).toBe(3)

    const g1 = r.deviceGroups.find((g) => g.deviceName === "DEVICE-1")!
    const g2 = r.deviceGroups.find((g) => g.deviceName === "DEVICE-2")!

    // FW + RV of the same device belong to the same group; the other device is separate.
    expect(g1.files.map((f) => f.id)).toEqual(["f1", "f2"])
    expect(g2.files.map((f) => f.id)).toEqual(["f3"])
    // Substrate assignment survives hydration.
    expect(g2.assignedSubstrateId).toBe("sub-1")
    // Provenance notes survive hydration.
    expect(r.files[0].notes).toContain("(FW)")
    expect(r.files[1].notes).toContain("(RV)")
  })
})

describe("results membership — serialize/reconstruct by stable id", () => {
  function resultsFixture(): ExperimentResults {
    return {
      id: "r1",
      experimentId: "e1",
      planeId: null,
      groupingStrategy: "import",
      matchingStrategy: "manual",
      updatedAt: "2026-01-01",
      files: [
        mf({ id: "f1", deviceName: "DEV", groupId: "g1" }),
        mf({ id: "f2", deviceName: "DEV", groupId: "g1" }),
      ],
      deviceGroups: [
        {
          id: "g1",
          deviceName: "DEV",
          files: [],
          assignedSubstrateId: null,
        },
      ],
    } as unknown as ExperimentResults
  }

  test("serializes device_group_id and reconstructs membership by id", () => {
    const r = resultsFixture()
    const filesApi = measurementFilesToApi(r)
    const groupsApi = deviceGroupsToApi(r)

    expect(filesApi[0].device_group_id).toBe("g1")

    const snapshot = bulkToSnapshot({
      results: [
        {
          id: r.id,
          experiment_id: r.experimentId,
          plane_id: null,
          grouping_strategy: "import",
          matching_strategy: "manual",
          created_at: "2026-01-01",
          measurement_files: filesApi,
          device_groups: groupsApi,
        },
      ],
      experiments: [],
      processes: [],
      planes: [],
    })

    const out = snapshot.results[0]
    expect(out.files.map((f) => f.groupId)).toEqual(["g1", "g1"])
    expect(out.deviceGroups[0].files.map((f) => f.id)).toEqual(["f1", "f2"])
  })

  test("group rename does not change the device identifier", () => {
    const r = resultsFixture()
    const groupsApi = deviceGroupsToApi(r).map((g) => ({ ...g, name: "Renamed" }))
    const filesApi = measurementFilesToApi(r)

    const snapshot = bulkToSnapshot({
      results: [
        {
          id: r.id,
          experiment_id: r.experimentId,
          plane_id: null,
          grouping_strategy: "import",
          matching_strategy: "manual",
          created_at: "2026-01-01",
          measurement_files: filesApi,
          device_groups: groupsApi,
        },
      ],
      experiments: [],
      processes: [],
      planes: [],
    })

    const out = snapshot.results[0]
    expect(out.deviceGroups[0].deviceName).toBe("Renamed")
    expect(out.files.every((f) => f.deviceName === "DEV")).toBe(true)
    expect(out.deviceGroups[0].files.map((f) => f.id)).toEqual(["f1", "f2"])
  })

  test("unassigned measurement stays unassigned after reload", () => {
    const r = resultsFixture()
    const filesApi = measurementFilesToApi(r).map((f) => ({ ...f, device_group_id: null }))
    const groupsApi = deviceGroupsToApi(r)

    const snapshot = bulkToSnapshot({
      results: [
        {
          id: r.id,
          experiment_id: r.experimentId,
          plane_id: null,
          grouping_strategy: "import",
          matching_strategy: "manual",
          created_at: "2026-01-01",
          measurement_files: filesApi,
          device_groups: groupsApi,
        },
      ],
      experiments: [],
      processes: [],
      planes: [],
    })

    const out = snapshot.results[0]
    expect(out.files.map((f) => f.groupId)).toEqual([null, null])
    expect(out.deviceGroups[0].files).toEqual([])
  })
})

describe("experimentToApi — plane-only placement round-trip", () => {
  test("preserves planeId when there is no collection ref", () => {
    const exp = {
      id: "e1",
      name: "Exp",
      description: "",
      date: "",
      architecture: "n-i-p",
      substrateMaterial: "",
      substrateWidth: 0,
      substrateLength: 0,
      numSubstrates: 0,
      devicesPerSubstrate: 0,
      deviceArea: 0,
      deviceType: "film",
      processId: "",
      planeId: "plane-1",
      substrates: [],
      hasResults: false,
    } as unknown as Experiment
    const place = derivePlacement([])
    const api = experimentToApi(exp, place, new Set())
    expect(api.plane_id).toBe("plane-1")
    expect(api.collection_id).toBeNull()
  })

  test("writes null planeId for an unassigned experiment", () => {
    const exp = {
      id: "e2",
      name: "Exp",
      description: "",
      date: "",
      architecture: "n-i-p",
      substrateMaterial: "",
      substrateWidth: 0,
      substrateLength: 0,
      numSubstrates: 0,
      devicesPerSubstrate: 0,
      deviceArea: 0,
      deviceType: "film",
      processId: "",
      planeId: null,
      substrates: [],
      hasResults: false,
    } as unknown as Experiment
    const api = experimentToApi(exp, derivePlacement([]), new Set())
    expect(api.plane_id).toBeNull()
  })
})

describe("measurementFilesToApi — provenance round-trip", () => {
  test("preserves notes and device_name", () => {
    const files = [
      mf({
        id: "f1",
        fileName: "device.txt",
        deviceName: "DEVICE-1",
        notes: "Imported from ZIP: JV Summary.txt (FW)",
      }),
    ]
    const api = measurementFilesToApi({ files } as unknown as ExperimentResults)
    expect(api[0].notes).toBe("Imported from ZIP: JV Summary.txt (FW)")
    expect(api[0].device_name).toBe("DEVICE-1")
    expect(api[0].filename).toBe("device.txt")
  })
})

describe("deviceGroupsToApi — substrate assignment round-trip", () => {
  test("preserves name and assigned substrate", () => {
    const groups = [
      {
        id: "g1",
        deviceName: "DEVICE-1",
        files: [],
        assignedSubstrateId: "sub-1",
        matchScore: 0.9,
      },
    ]
    const api = deviceGroupsToApi({
      deviceGroups: groups,
    } as unknown as ExperimentResults)
    expect(api[0].name).toBe("DEVICE-1")
    expect(api[0].assigned_substrate_id).toBe("sub-1")
  })
})

describe("measurementFilesToApi / bulkToSnapshot — structured metadata round-trip", () => {
  test("preserves direction, inSummary, batch, substrateGroup and sourcePath", () => {
    const files = [
      mf({
        id: "f1",
        direction: "FW",
        inSummary: true,
        batch: "2026_01_22",
        substrateGroup: "PVK1-BSAM-C60-28",
        sourcePath: "2026_01_22/sample_A Stability (JV).txt",
      }),
      mf({
        id: "f2",
        direction: "RV",
        inSummary: false,
        substrateGroup: "PVK1-BSAM-C60-28",
        sourcePath: "2026_01_22/sample_A Stability (JV).txt",
      }),
    ]
    const api = measurementFilesToApi({ files } as unknown as ExperimentResults)
    expect(api[0].direction).toBe("FW")
    expect(api[0].in_summary).toBe(true)
    expect(api[0].batch).toBe("2026_01_22")
    expect(api[0].substrate_group).toBe("PVK1-BSAM-C60-28")
    expect(api[0].file_path).toBe("2026_01_22/sample_A Stability (JV).txt")

    // Hydration direction: the same fields come back (and false stays distinct
    // from null/unknown).
    const bulk = {
      results: [
        {
          id: "r1",
          experiment_id: "e1",
          measurement_files: api,
          device_groups: [],
        },
      ],
      experiments: [],
      processes: [],
      planes: [],
    }
    const snapshot = bulkToSnapshot(bulk)
    const hydrated = snapshot.results[0].files
    expect(hydrated[0].direction).toBe("FW")
    expect(hydrated[0].inSummary).toBe(true)
    expect(hydrated[0].batch).toBe("2026_01_22")
    expect(hydrated[0].substrateGroup).toBe("PVK1-BSAM-C60-28")
    expect(hydrated[0].sourcePath).toBe(
      "2026_01_22/sample_A Stability (JV).txt",
    )
    expect(hydrated[1].inSummary).toBe(false) // additional ≠ null/unknown
  })
})
