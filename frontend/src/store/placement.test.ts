import { describe, expect, test } from "bun:test"

import type { Experiment, Plane } from "./AppContext"
import { derivePlacement, experimentToApi } from "./backendMapping"
import { applyEntityPlaneId, resolveEntityPlaneId } from "./placement"

function plane(id: string, refs: Array<{ kind: string; id: string }> = []): Plane {
  return {
    id,
    name: id,
    elements: refs.length
      ? [
          {
            id: `${id}-col`,
            type: "collection",
            name: "col",
            position: { x: 0, y: 0 },
            refs: refs.map((r) => ({ ...r, kind: r.kind as never })),
            color: null,
          },
        ]
      : [],
  } as unknown as Plane
}

describe("resolveEntityPlaneId", () => {
  test("collection reference wins over planeId", () => {
    const planes = [plane("plane-A", [{ kind: "experiment", id: "e1" }])]
    const byEntity = new Map([["experiment:e1", "plane-B"]])
    expect(resolveEntityPlaneId("experiment", "e1", planes, byEntity)).toBe("plane-A")
  })

  test("plane-only placement falls back to planeId", () => {
    const planes = [plane("plane-A")]
    const byEntity = new Map([["experiment:e1", "plane-A"]])
    expect(resolveEntityPlaneId("experiment", "e1", planes, byEntity)).toBe("plane-A")
  })

  test("unassigned entity (no ref, no planeId) resolves to null", () => {
    const planes = [plane("plane-A")]
    expect(resolveEntityPlaneId("experiment", "e1", planes, new Map())).toBeNull()
  })

  test("plane-only entity does not leak into another plane", () => {
    const planes = [plane("plane-A"), plane("plane-B")]
    const byEntity = new Map([["experiment:e1", "plane-A"]])
    // The entity is on plane-A, not plane-B.
    expect(resolveEntityPlaneId("experiment", "e1", planes, byEntity)).toBe("plane-A")
  })
})

function exp(overrides: Partial<Experiment> = {}): Experiment {
  return {
    id: "e1",
    name: "Exp",
    planeId: null,
    ...overrides,
  } as unknown as Experiment
}

describe("applyEntityPlaneId — placement mutation helper", () => {
  test("assign to plane sets planeId", () => {
    const next = applyEntityPlaneId([exp()], new Set(["e1"]), "plane-A")
    expect(next[0].planeId).toBe("plane-A")
  })

  test("unassign clears planeId (no stale plane resurrection)", () => {
    const next = applyEntityPlaneId(
      [exp({ planeId: "plane-A" })],
      new Set(["e1"]),
      null,
    )
    expect(next[0].planeId).toBeNull()
  })

  test("does not touch unrelated entities", () => {
    const entities = [exp(), exp({ id: "e2", planeId: "plane-B" })]
    const next = applyEntityPlaneId(entities, new Set(["e1"]), "plane-A")
    expect(next[0].planeId).toBe("plane-A")
    expect(next[1].planeId).toBe("plane-B")
  })
})

describe("placement mutation → serialization round-trip", () => {
  test("collection ref wins over stale planeId", () => {
    const planes = [plane("plane-A", [{ kind: "experiment", id: "e1" }])]
    const place = derivePlacement(planes)
    const api = experimentToApi(exp({ planeId: "plane-B" }), place, new Set())
    expect(api.plane_id).toBe("plane-A")
    expect(api.collection_id).toBe("plane-A-col")
  })

  test("after collection removal, the assigned planeId is preserved as plane-only", () => {
    // Mutation: assign to a collection on plane-A (sets planeId = plane-A).
    const assigned = applyEntityPlaneId([exp()], new Set(["e1"]), "plane-A")
    // Collection was deleted: no refs remain, so derivePlacement is empty.
    const api = experimentToApi(assigned[0], derivePlacement([]), new Set())
    expect(api.plane_id).toBe("plane-A")
    expect(api.collection_id).toBeNull()
  })

  test("explicit unassign serializes to null plane_id", () => {
    const unassigned = applyEntityPlaneId(
      [exp({ planeId: "plane-A" })],
      new Set(["e1"]),
      null,
    )
    const api = experimentToApi(unassigned[0], derivePlacement([]), new Set())
    expect(api.plane_id).toBeNull()
    expect(api.collection_id).toBeNull()
  })
})
