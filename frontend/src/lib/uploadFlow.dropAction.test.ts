import { describe, expect, test } from "bun:test"
import { resolveUploadDropAction, type UploadFlow } from "./uploadFlow"

// The single-active-flow decision shared by every upload ingress (Organization
// drop, experiment drop zone, Results drop): start / add-to-same-target /
// refuse. See useStartOrAddUpload for the wiring.

function makeFlow(overrides: Partial<UploadFlow> = {}): UploadFlow {
  const now = Date.now()
  return {
    id: "flow-1",
    origin: "drag-drop",
    processId: null,
    experimentId: null,
    targetCollectionId: null,
    targetPlaneId: null,
    createdAt: new Date(now).toISOString(),
    lastActivityAt: now,
    ...overrides,
  }
}

describe("resolveUploadDropAction", () => {
  test("no active flow → start", () => {
    expect(resolveUploadDropAction(null, { collectionId: "c1" })).toBe("start")
    expect(resolveUploadDropAction(null, {})).toBe("start")
  })

  test("same collection → add", () => {
    const flow = makeFlow({ targetCollectionId: "c1" })
    expect(resolveUploadDropAction(flow, { collectionId: "c1" })).toBe("add")
  })

  test("same experiment → add", () => {
    const flow = makeFlow({ experimentId: "e1" })
    expect(resolveUploadDropAction(flow, { experimentId: "e1" })).toBe("add")
  })

  test("either identity matching is enough (collection matches, experiment differs)", () => {
    const flow = makeFlow({ targetCollectionId: "c1", experimentId: "e1" })
    expect(
      resolveUploadDropAction(flow, { collectionId: "c1", experimentId: "e2" }),
    ).toBe("add")
  })

  test("different collection → refuse", () => {
    const flow = makeFlow({ targetCollectionId: "c1" })
    expect(resolveUploadDropAction(flow, { collectionId: "c2" })).toBe("refuse")
  })

  test("different experiment → refuse", () => {
    const flow = makeFlow({ experimentId: "e1" })
    expect(resolveUploadDropAction(flow, { experimentId: "e2" })).toBe("refuse")
  })

  test("flow with a target vs. a targetless ingress → refuse (never silently merge)", () => {
    const flow = makeFlow({ targetCollectionId: "c1", experimentId: "e1" })
    expect(resolveUploadDropAction(flow, {})).toBe("refuse")
    expect(
      resolveUploadDropAction(flow, { collectionId: null, experimentId: null }),
    ).toBe("refuse")
  })

  test("null-target flow vs. null-target ingress → refuse (null is not an identity)", () => {
    // Two independent empty-canvas drops must not be treated as the same
    // target: null means "no collection", not a shared identity.
    const flow = makeFlow()
    expect(
      resolveUploadDropAction(flow, { collectionId: null, experimentId: null }),
    ).toBe("refuse")
  })
})
