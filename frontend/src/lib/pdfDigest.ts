// ─────────────────────────────────────────────────────────────────────────────
// PDF digestion — turning an exported Process/Experiment PDF back into a
// SELECTED (or newly created) app entity, instead of an upload attachment.
//
// Sits on top of pdfImport.ts: `importPdf` already parses the canonical payload,
// diffs the PDF's live AcroForm values against the exported snapshot, and reports
// unparseable edits. This module adds the ingress detection + the ownership /
// copy / overwrite primitives the upload flow's digest view needs. See
// `components/PdfDigestView.tsx` for the UI and `lib/useStartOrAddUpload.tsx` for
// where PDFs are split out of a drop.
// ─────────────────────────────────────────────────────────────────────────────

import type { Experiment, Process } from "@/store/AppContext"
import {
  applyFieldValue,
  type FieldEdit,
  type ImportResult,
  importPdf,
  NotAPlainsPdfError,
} from "./pdfImport"

/** One exported Process/Experiment PDF, parsed and pending resolution. */
export type DigestDoc = {
  /** Stable id for list keys / removal. */
  id: string
  fileName: string
  result: ImportResult
}

/** A file is a candidate for digestion when it looks like a PDF. */
export function isPdfFile(file: File): boolean {
  return file.type === "application/pdf" || /\.pdf$/i.test(file.name)
}

/** A digestion candidate that had to be dropped, with a user-facing reason. */
export type RejectedDoc = { fileName: string; reason: string }

/**
 * Split dropped files into Plains process/experiment PDFs (parsed into
 * DigestDocs), everything else, and rejected docs. A PDF that isn't one of ours —
 * or is unreadable — simply lands in `others` and flows through to the upload as
 * an ordinary attachment, exactly as before.
 *
 * A well-formed export always carries an experiment together with the process it
 * derives from, so an experiment PDF whose `experiment.processId` doesn't match
 * its own process is internally inconsistent (hand-edited / corrupted). Such a doc
 * is `rejected` (the caller informs the user and ignores it), never digested — a
 * selected experiment must always derive from its selected process (rule 4).
 */
export async function detectDigestDocs(files: File[]): Promise<{
  digests: DigestDoc[]
  others: File[]
  rejected: RejectedDoc[]
}> {
  const digests: DigestDoc[] = []
  const others: File[] = []
  const rejected: RejectedDoc[] = []
  for (const file of files) {
    if (!isPdfFile(file)) {
      others.push(file)
      continue
    }
    try {
      const bytes = await file.arrayBuffer()
      const result = await importPdf(bytes)
      if (
        result.kind === "experiment" &&
        result.original.experiment &&
        result.original.experiment.processId !== result.original.process.id
      ) {
        rejected.push({
          fileName: file.name,
          reason: "the experiment isn’t derived from its own process",
        })
        continue
      }
      digests.push({ id: crypto.randomUUID(), fileName: file.name, result })
    } catch (err) {
      if (!(err instanceof NotAPlainsPdfError)) {
        console.warn("[digest] failed to read PDF", file.name, err)
      }
      others.push(file)
    }
  }
  return { digests, others, rejected }
}

/**
 * True when the payload's entity is one the current user already has loaded
 * (their own, or on a plane shared with them — the frontend only ever holds that
 * set). Absent ⇒ it belongs to someone else / doesn't exist for this user, so it
 * must be copied rather than mutated.
 */
export function findEntityById<T extends { id: string }>(
  list: T[],
  id: string,
): T | undefined {
  return list.find((e) => e.id === id)
}

/**
 * Regenerate ONLY the top-level entity id. Nested ids (substrates, recipes,
 * steps, layers) and their internal cross-references (e.g. `chemRecipeId`,
 * `solutionBatches` keys, `parameterValues` keys) plus external material /
 * solution references are deliberately left intact, so the copy stays internally
 * consistent and still points at the right shared materials. The object's
 * identity is its top-level id — that is what "a copy with a different id" means.
 */
export function copyProcessWithNewIds(process: Process): Process {
  return { ...structuredClone(process), id: crypto.randomUUID() }
}

export function copyExperimentWithNewIds(
  experiment: Experiment,
  processId: string,
): Experiment {
  return {
    ...structuredClone(experiment),
    id: crypto.randomUUID(),
    processId,
  }
}

/**
 * Apply a set of already-validated field edits onto clones of the given entity
 * pair. Used by the "overwrite app values" path to patch ONLY the differing,
 * parseable fields onto the live app entity (unparseable ones are reported and
 * left untouched by the caller).
 */
export function applyEditsToEntities(
  process: Process,
  experiment: Experiment | undefined,
  edits: FieldEdit[],
): { process: Process; experiment: Experiment | undefined } {
  const nextProcess = structuredClone(process)
  const nextExperiment = experiment ? structuredClone(experiment) : undefined
  for (const edit of edits) {
    applyFieldValue(nextProcess, nextExperiment, edit.path, edit.newValue)
  }
  return { process: nextProcess, experiment: nextExperiment }
}
