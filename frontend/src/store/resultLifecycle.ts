import type { ExperimentResults } from "./AppContext"

/**
 * Reconcile the flat `files[].groupId` with the `deviceGroups[].files`
 * membership. Group membership is the source of truth; the flat list is what
 * gets serialized, so every file is stamped with the id of its owning group
 * (or null when unassigned).
 */
export function reconcileGroupIds(r: ExperimentResults): ExperimentResults {
  const groupByFile = new Map<string, string>()
  for (const g of r.deviceGroups) {
    for (const f of g.files) {
      groupByFile.set(f.id, g.id)
    }
  }
  let changed = false
  const files = r.files.map((f) => {
    const gid = groupByFile.get(f.id) ?? null
    if (f.groupId !== gid) {
      changed = true
      return { ...f, groupId: gid }
    }
    return f
  })
  if (!changed) {
    return r
  }
  return { ...r, files }
}

/**
 * True when a result holds persistent imported measurements (created by the ZIP
 * importer), as opposed to a transient NOMAD upload staging. Relies on the
 * `groupingStrategy === "import"` marker set at import time, plus the
 * "Imported from ZIP:" provenance note on measurement files for records created
 * before the marker existed.
 */
export function isImportedResult(r: ExperimentResults): boolean {
  if (r.groupingStrategy === "import") return true
  return r.files.some((f) => (f.notes ?? "").startsWith("Imported from ZIP:"))
}

/**
 * A result is persistable when it has no files yet, was handed over to NOMAD
 * (has an upload_id), or holds persistent imported measurements. Transient
 * upload stagings (files without upload_id and not imported) are excluded from
 * every save snapshot.
 */
export function isPersistableResult(r: ExperimentResults): boolean {
  return r.files.length === 0 || !!r.nomad?.upload_id || isImportedResult(r)
}

/**
 * Ids of results whose upload staging never finished: files are present but
 * the result was never handed over to NOMAD (no upload_id) and it is not a
 * persistent import.
 */
export function staleResultIdsOf(results: ExperimentResults[]): Set<string> {
  return new Set(
    results
      .filter(
        (r) => r.files.length > 0 && !r.nomad?.upload_id && !isImportedResult(r),
      )
      .map((r) => r.id),
  )
}
