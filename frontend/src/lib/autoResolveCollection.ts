import type { CanvasCollectionElement, Plane, Vec2 } from "@/store/AppContext"

export type ResolvedCollection = {
  planeId: string
  collection: CanvasCollectionElement
}

/**
 * Auto-picks a collection for a new entity without prompting the user:
 * 1. Prefers the last collection with at least one ref on the active plane
 * 2. Falls back to the top-left collection (smallest y then x) if none have refs
 * 3. Creates a new collection at the top-left if the plane has no collections
 * 4. Uses the first available plane when no active plane is set
 */
export function autoResolveCollection(
  planes: Plane[],
  activePlaneId: string | null,
  addCollectionElement: (planeId: string, pos: Vec2) => CanvasCollectionElement,
  setActivePlaneId: (id: string | null) => void,
  setActiveCollectionId: (id: string | null) => void,
): ResolvedCollection | null {
  const planeId = activePlaneId ?? planes[0]?.id ?? null
  if (!planeId) return null

  const plane = planes.find((p) => p.id === planeId)
  if (!plane) return null

  const collections = plane.elements.filter(
    (e) => e.type === "collection",
  ) as CanvasCollectionElement[]

  let collection: CanvasCollectionElement

  const withRefs = collections.filter((c) => c.refs.length > 0)
  if (withRefs.length > 0) {
    collection = withRefs[withRefs.length - 1]
  } else if (collections.length > 0) {
    collection = collections.reduce((best, c) => {
      const by = best.position.y
      const bx = best.position.x
      const cy = c.position.y
      const cx = c.position.x
      return cy < by || (cy === by && cx < bx) ? c : best
    })
  } else {
    collection = addCollectionElement(planeId, { x: 40, y: 40 })
  }

  setActivePlaneId(planeId)
  setActiveCollectionId(collection.id)
  return { planeId, collection }
}
