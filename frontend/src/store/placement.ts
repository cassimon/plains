import type { CanvasCollectionElement, CollectionRef, Plane } from "./AppContext"

/**
 * Resolve the plane that owns an entity, using collection references first and
 * the persisted planeId (Plane-only placement) as a fallback. Pure and shared
 * by the entity-collection visibility helpers.
 */
/**
 * Pure placement-mutation helper: set the persisted planeId on the matching
 * entities. Shared by the store so the mutation and its serialization are
 * exercised together in tests.
 */
export function applyEntityPlaneId<T extends { id: string }>(
  entities: T[],
  ids: Set<string>,
  planeId: string | null,
): T[] {
  if (ids.size === 0) return entities
  return entities.map((e) => (ids.has(e.id) ? { ...e, planeId } : e))
}

export function resolveEntityPlaneId(
  kind: CollectionRef["kind"],
  id: string,
  planes: Plane[],
  planeIdByEntity: Map<string, string>,
): string | null {
  for (const plane of planes) {
    for (const el of plane.elements) {
      if (el.type !== "collection") continue
      const col = el as CanvasCollectionElement
      if (col.refs.some((r) => r.kind === kind && r.id === id)) return plane.id
    }
  }
  return planeIdByEntity.get(`${kind}:${id}`) ?? null
}
