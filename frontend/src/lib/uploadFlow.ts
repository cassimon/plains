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
} from "@/store/AppContext"

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
  /** Files dropped in Organization, staged until an experiment is chosen. */
  pendingFiles?: StagedFile[]
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
  const procDone = exp.substrates.length > 0
  const summaryDone = Boolean(exp.description?.trim()) && Boolean(exp.date)
  return chemDone && procDone && summaryDone
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
