// ─────────────────────────────────────────────────────────────────────────────
// entityReveal — where to point the plane / collection view so an entity that the
// upload flow navigates to stays visible, honoring the reference-follow rules:
//
//   1. A new process is created in the current (drop-target) collection → stay in
//      that collection.
//   2. A new experiment is created in the collection of its process → stay in that
//      collection.
//   3. When neither holds — the entity lives in a *different* collection, or is
//      referenced outside the collection where the data was placed — drop to the
//      "General Plane" view (keep the plane, clear the collection). NEVER the
//      cross-plane "General" view: visibility stays limited to the plane's objects.
//
// The visibility model these mirror lives in `useEntityCollection`/`isEntityVisible`
// (store/AppContext.tsx): with a plane selected and no collection, an entity is
// visible if it's referenced by a collection on that plane OR is an orphan
// (referenced by no collection anywhere).
// ─────────────────────────────────────────────────────────────────────────────

import { useCallback } from "react"
import {
  type CanvasCollectionElement,
  type CollectionRef,
  type Plane,
  useAppContext,
} from "@/store/AppContext"

/** A plane + collection selection. `collectionId: null` == the plane's General view. */
export type RevealView = { planeId: string | null; collectionId: string | null }

/**
 * The first collection (scanning all planes) that references the entity, or null
 * when it is an orphan. Used when *creating* an entity that should join its
 * process's collection (rule 2).
 */
export function homeCollectionForEntity(
  planes: Plane[],
  kind: CollectionRef["kind"],
  id: string,
): { planeId: string; collectionId: string } | null {
  for (const plane of planes) {
    for (const el of plane.elements) {
      if (el.type !== "collection") {
        continue
      }
      const col = el as CanvasCollectionElement
      if (col.refs.some((r) => r.kind === kind && r.id === id)) {
        return { planeId: plane.id, collectionId: col.id }
      }
    }
  }
  return null
}

/**
 * The minimal view change that keeps `kind:id` visible when the flow navigates to
 * it:
 *  - already inside the active collection             → stay (no change);
 *  - visible in the current plane's General view       → keep the plane, clear the
 *    (referenced on it, or an orphan)                     collection filter;
 *  - referenced only on another plane                  → switch to that plane's
 *                                                         General view;
 *  - orphan and no current plane                       → cross-plane General view
 *                                                         (the only case that clears the plane).
 *
 * Crucially it never navigates INTO a *different* collection than the current one:
 * crossing a collection boundary always drops to the General Plane view so the
 * plane context is preserved.
 */
export function computeRevealView(
  planes: Plane[],
  currentPlaneId: string | null,
  currentCollectionId: string | null,
  kind: CollectionRef["kind"],
  id: string,
): RevealView {
  const matches = (r: CollectionRef) => r.kind === kind && r.id === id
  let inActiveCollection = false
  let onCurrentPlane = false
  let referencingPlaneId: string | null = null

  for (const plane of planes) {
    for (const el of plane.elements) {
      if (el.type !== "collection") {
        continue
      }
      const col = el as CanvasCollectionElement
      if (!col.refs.some(matches)) {
        continue
      }
      if (referencingPlaneId === null) {
        referencingPlaneId = plane.id
      }
      if (plane.id === currentPlaneId) {
        onCurrentPlane = true
        if (currentCollectionId && col.id === currentCollectionId) {
          inActiveCollection = true
        }
      }
    }
  }
  const isOrphan = referencingPlaneId === null

  // 1. Already visible under the active collection filter → stay.
  if (currentCollectionId && inActiveCollection) {
    return { planeId: currentPlaneId, collectionId: currentCollectionId }
  }
  // 2. Visible in the current plane's General view → keep plane, drop collection.
  if (currentPlaneId && (onCurrentPlane || isOrphan)) {
    return { planeId: currentPlaneId, collectionId: null }
  }
  // 3. Referenced only on another plane → that plane's General view.
  if (referencingPlaneId) {
    return { planeId: referencingPlaneId, collectionId: null }
  }
  // 4. Orphan with no current plane → cross-plane General view.
  return { planeId: null, collectionId: null }
}

/**
 * Hook returning a callback that applies {@link computeRevealView} for the current
 * plane/collection selection — the one-liner every reference-follow in the upload
 * flow uses instead of the old blanket `setActivePlaneId(null)` reset.
 */
export function useRevealForFlow() {
  const {
    planes,
    activePlaneId,
    activeCollectionId,
    setActivePlaneId,
    setActiveCollectionId,
  } = useAppContext()
  return useCallback(
    (kind: CollectionRef["kind"], id: string) => {
      const view = computeRevealView(
        planes,
        activePlaneId,
        activeCollectionId,
        kind,
        id,
      )
      setActivePlaneId(view.planeId)
      setActiveCollectionId(view.collectionId)
    },
    [
      planes,
      activePlaneId,
      activeCollectionId,
      setActivePlaneId,
      setActiveCollectionId,
    ],
  )
}
