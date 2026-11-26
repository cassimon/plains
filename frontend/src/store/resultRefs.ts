import type { CanvasCollectionElement, CanvasElement, Plane } from "./AppContext"

/**
 * Keep Collection result-refs in sync with the persisted result for an
 * experiment. For every collection that already references the experiment, the
 * old result refs for this experiment are replaced by `nextResultId` (or removed
 * when null). Shared by the Results page and the import modal so both follow the
 * exact same placement convention. No new placement is invented: an experiment
 * not already in a collection is left untouched.
 */
export function syncResultRefsForExperiment(
  experimentId: string,
  resultIdsForExperiment: string[],
  nextResultId: string | null,
  planes: Plane[],
  updateElement: (planeId: string, element: CanvasElement) => void,
  setEntityPlaneId: (
    kind: "result",
    ids: string[],
    planeId: string | null,
  ) => void,
): void {
  const resultIdSet = new Set(resultIdsForExperiment)

  for (const plane of planes) {
    for (const element of plane.elements) {
      if (element.type !== "collection") {
        continue
      }
      const collection = element as CanvasCollectionElement
      const hasExperimentRef = collection.refs.some(
        (ref) => ref.kind === "experiment" && ref.id === experimentId,
      )
      if (!hasExperimentRef) {
        continue
      }

      const withoutOldResultRefs = collection.refs.filter(
        (ref) => !(ref.kind === "result" && resultIdSet.has(ref.id)),
      )
      const nextRefs =
        nextResultId === null
          ? withoutOldResultRefs
          : [
              ...withoutOldResultRefs,
              { kind: "result" as const, id: nextResultId },
            ]

      const refsChanged =
        nextRefs.length !== collection.refs.length ||
        nextRefs.some((ref, idx) => {
          const prev = collection.refs[idx]
          return !prev || prev.kind !== ref.kind || prev.id !== ref.id
        })

      if (refsChanged) {
        updateElement(plane.id, { ...collection, refs: nextRefs })
        if (nextResultId !== null) {
          setEntityPlaneId("result", [nextResultId], plane.id)
        }
      }
    }
  }
}
