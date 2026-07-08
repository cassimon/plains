// ─────────────────────────────────────────────────────────────────────────────
// Upload-flow model & derived-state selectors
//
// The "File Upload" critical status orchestrates the three-step flow
// Process → Experiment → Upload over the existing Process / Experiment /
// ExperimentResults entities. This module owns the flow's data shape and the
// pure selectors that derive per-step status from live data, so the UI never
// stores stale booleans.
//
// NB: AppContext imports only the *types* from here (erased at compile time),
// while this module imports value helpers back from AppContext. The runtime
// dependency is therefore one-directional (uploadFlow → AppContext) — no cycle.
// ─────────────────────────────────────────────────────────────────────────────

import {
  collectChemicals,
  computeChemsDone,
} from "@/routes/-Experiments.chemicals"
import {
  type Experiment,
  type ExperimentResults,
  getProcessStatus,
  type Process,
  type Substrate,
} from "@/store/AppContext"
import type { DigestDoc } from "./pdfDigest"

/** The three ordered steps of an upload flow. */
export type UploadFlowStep = "process" | "experiment" | "upload"

/** How the flow was started. */
export type UploadFlowOrigin = "add-results" | "drag-drop"

/** A file staged from an Organization drop, kept until an experiment is chosen. */
export type StagedFile = {
  name: string
  size: number
  /** base64 content — only kept for small files; never persisted. */
  content?: string
}

/** A single active upload flow. Only one may exist at a time. */
export type UploadFlow = {
  id: string
  origin: UploadFlowOrigin
  processId: string | null
  experimentId: string | null
  /**
   * When the flow was started by dropping files onto a specific collection,
   * this identifies it so the Organization canvas can render the "incomplete
   * upload" marker on that collection until the flow finishes. Null when files
   * were dropped on empty canvas.
   */
  targetCollectionId?: string | null
  targetPlaneId?: string | null
  /** Files dropped in Organization, staged until an experiment is chosen. */
  pendingFiles?: StagedFile[]
  /**
   * The actual dropped `File` objects, kept in memory so the bytes follow the
   * flow into the Results page (which uploads them to NOMAD) — the user never
   * has to re-drop. Never persisted: the whole flow is ephemeral and dropped on
   * logout / inactivity, so raw file handles never leave the browser session.
   */
  files?: File[]
  /**
   * When true, associating/creating an experiment auto-creates one substrate
   * per group recognized in the staged file names (flows where files arrive
   * before the experiment). User-checkable in the target picker.
   */
  autoCreateSubstrates?: boolean
  /** Substrate ids auto-created from recognized groups, so misrecognized
   *  names can be listed and deleted from the picker. */
  autoCreatedSubstrateIds?: string[]
  /**
   * True once the user has run "Import substrate names" for the current set of
   * staged files, so the button can disable itself. Reset to false whenever new
   * files are appended to the same flow (see `addFilesToUploadFlow`) so the
   * newly-dropped names can be imported too.
   */
  substrateNamesImported?: boolean
  /**
   * Exported Process/Experiment PDFs pulled out of a drop, awaiting digestion.
   * While non-empty the flow's target picker is BLOCKED and the digest view is
   * shown instead (see UploadFlowPanel): each doc is resolved into a selected or
   * newly-created process/experiment, then removed. Transient — never persisted
   * (the whole flow is ephemeral and dropped on logout / inactivity).
   */
  pendingDigests?: DigestDoc[]
  createdAt: string
  /** Epoch ms of the last user interaction — drives the inactivity drop. */
  lastActivityAt: number
}

/** Per-step visual state. */
export type StepState = "pending" | "active" | "done" | "error"

export type UploadFlowStepStates = {
  process: StepState
  experiment: StepState
  upload: StepState
}

/**
 * The stronger "completely specified" definition used by the Add-Results gate:
 * chemicals prep complete, at least one substrate, and description + date set.
 * Single source of truth shared by the Experiments page and the upload status.
 */
/**
 * Step 3 (Summary) is finished only when start date, end date and intent are all
 * filled AND the user has explicitly confirmed the summary. Confirmation is
 * sticky (see `Experiment.summaryConfirmed`), so editing later never re-requires
 * it — but clearing a required field still un-completes the step.
 */
export function experimentSummaryDone(exp: Experiment): boolean {
  return (
    Boolean(exp.description?.trim()) &&
    Boolean(exp.date) &&
    Boolean(exp.endDate) &&
    Boolean(exp.summaryConfirmed)
  )
}

/**
 * Step 2 (Processing) is finished only when the experiment has at least one
 * substrate AND every process stage has its execution time filled in. The
 * per-step times are obligatory — this is what turns the processing layout
 * green and unlocks Step 3. Times are stored per stage under `stage:${idx}`.
 */
export function experimentProcessingDone(
  exp: Experiment,
  process: Process | undefined,
): boolean {
  if (!process || exp.substrates.length === 0) {
    return false
  }
  return process.stages.every((_stage, idx) =>
    Boolean(exp.processingTimes?.[`stage:${idx}`]?.trim()),
  )
}

export function getExperimentAllStepsDone(
  exp: Experiment,
  process: Process | undefined,
): boolean {
  if (!process) {
    return false
  }
  const { materialItems, solutionItems } = collectChemicals(process)
  const chemDone = computeChemsDone(
    exp.chemicalsPrep,
    materialItems,
    solutionItems,
  )
  const procDone = experimentProcessingDone(exp, process)
  return chemDone && procDone && experimentSummaryDone(exp)
}

/** NOMAD statuses that mean the upload finished successfully. */
const UPLOAD_SUCCESS_STATUSES = new Set(["success", "published", "done"])
/** NOMAD statuses that mean the upload terminally failed. */
const UPLOAD_FAILURE_STATUSES = new Set(["failure", "error", "failed"])

function normalizeStatus(status: string | undefined): string {
  return (status ?? "").toLowerCase()
}

/**
 * Derive per-step status from the flow + live data. Kept pure so the UI can call
 * it on every render without storing anything.
 */
export function getUploadFlowSteps(
  flow: UploadFlow,
  data: {
    processes: Process[]
    experiments: Experiment[]
    results: ExperimentResults[]
  },
): UploadFlowStepStates {
  const process = flow.processId
    ? data.processes.find((p) => p.id === flow.processId)
    : undefined
  const experiment = flow.experimentId
    ? data.experiments.find((e) => e.id === flow.experimentId)
    : undefined

  // ── Process step ──────────────────────────────────────────────────────────
  const processDone = Boolean(
    process && getProcessStatus(process) === "complete",
  )
  const processState: StepState = processDone
    ? "done"
    : flow.processId
      ? "active"
      : "active"

  // ── Experiment step ───────────────────────────────────────────────────────
  const experimentDone = Boolean(
    experiment && getExperimentAllStepsDone(experiment, process),
  )
  let experimentState: StepState
  if (!processDone) {
    experimentState = "pending"
  } else if (experimentDone) {
    experimentState = "done"
  } else {
    experimentState = "active"
  }

  // ── Upload step ───────────────────────────────────────────────────────────
  // Look at the ExperimentResults for the flow's experiment (if any).
  const flowResults = flow.experimentId
    ? data.results.filter((r) => r.experimentId === flow.experimentId)
    : []
  const anySuccess = flowResults.some((r) =>
    UPLOAD_SUCCESS_STATUSES.has(normalizeStatus(r.nomad?.status)),
  )
  const anyFailure = flowResults.some((r) =>
    UPLOAD_FAILURE_STATUSES.has(normalizeStatus(r.nomad?.status)),
  )
  let uploadState: StepState
  if (anySuccess) {
    uploadState = "done"
  } else if (anyFailure) {
    uploadState = "error"
  } else if (!experimentDone) {
    uploadState = "pending"
  } else {
    uploadState = "active"
  }

  return {
    process: processState,
    experiment: experimentState,
    upload: uploadState,
  }
}

/** Count of completed steps (0–3), for the collapsed "N/3" badge. */
export function countDoneSteps(steps: UploadFlowStepStates): number {
  return (
    (steps.process === "done" ? 1 : 0) +
    (steps.experiment === "done" ? 1 : 0) +
    (steps.upload === "done" ? 1 : 0)
  )
}

/** True once every step is done — the flow can be auto-cleared. */
export function isUploadFlowComplete(steps: UploadFlowStepStates): boolean {
  return (
    steps.process === "done" &&
    steps.experiment === "done" &&
    steps.upload === "done"
  )
}

/** Inactivity window after which an incomplete flow is dropped (ms). */
export const UPLOAD_FLOW_INACTIVITY_MS = 30 * 60 * 1000

/**
 * Best-effort device/substrate group name for a single file. Mirrors the Results
 * page's `extractDeviceFromFilename` so substrates created from an upload line up
 * with the groups the review step later matches against — but returns null (not a
 * date/basename fallback) when nothing device-like is present, so pure numeric or
 * date-prefixed names don't seed bogus substrates.
 *
 *  1. 2–4 letters + 2–3 digits as a whole separator-delimited token, ANYWHERE and
 *     case-insensitively ("AI44" inside "2025-11-19_AI44-1C", "ab41") — the primary
 *     lab substrate-ID convention. This is the key fix: it now survives a leading
 *     date, which the old "must be at the start / must be uppercase" rule dropped.
 *  2. a letters-then-digits word at the very start ("Device01").
 *  3. the first separator-delimited token, but only when it carries a letter and
 *     isn't purely numeric (so a leading "2025"/"01" is skipped).
 */
export function recognizeGroupName(fileName: string): string | null {
  const base = fileName.replace(/\.[^/.]+$/, "")
  const idMatch = base.match(/(?:^|[_\-\s])([A-Za-z]{2,4}\d{2,3})(?=$|[_\-\s])/)
  if (idMatch) {
    return idMatch[1].toUpperCase()
  }
  const wordMatch = base.match(/^([A-Za-z]+\d+)/)
  if (wordMatch) {
    return wordMatch[1].toUpperCase()
  }
  const first = base.split(/[_\-\s]+/).filter(Boolean)[0]
  if (first && /[A-Za-z]/.test(first) && !/^\d+$/.test(first)) {
    return first.toUpperCase()
  }
  return null
}

/**
 * Recognize substrate/device group names across staged file names, deduplicated
 * (case-insensitively) in first-seen order. See {@link recognizeGroupName}.
 */
export function recognizeGroupNames(fileNames: string[]): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const fileName of fileNames) {
    const name = recognizeGroupName(fileName)
    if (name) {
      const key = name.toLowerCase()
      if (!seen.has(key)) {
        seen.add(key)
        names.push(name)
      }
    }
  }
  return names
}

/**
 * Build new `Substrate`s for the given names, skipping any whose name already
 * exists (case-insensitive) among `existing`. Shared by the upload-flow target
 * picker's auto-create checkbox and the Experiments "Import from Upload" button
 * so both derive substrates from recognized file-name groups identically.
 */
export function buildSubstratesFromNames(
  existing: Substrate[],
  names: string[],
): Substrate[] {
  const taken = new Set(existing.map((sub) => sub.name.toLowerCase()))
  const created: Substrate[] = []
  for (const name of names) {
    const key = name.toLowerCase()
    if (taken.has(key)) {
      continue
    }
    taken.add(key)
    created.push({ id: crypto.randomUUID(), name })
  }
  return created
}
