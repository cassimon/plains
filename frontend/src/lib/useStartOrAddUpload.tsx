// ─────────────────────────────────────────────────────────────────────────────
// useStartOrAddUpload — shared "drop / pick result files" entry point
//
// Every new upload ingress point (Organization canvas drop, per-collection
// upload button, experiment-level drop zone) funnels through this hook so the
// single-active-flow rules live in exactly one place:
//   • no active flow      → start one (carrying the real File bytes) and open
//                           the Process → Experiment target picker with
//                           most-likely defaults preselected;
//   • active flow, same    → append the files to the current upload ("add to
//     target                the zip");
//   • active flow, other   → refuse, telling the user to finish/cancel first.
//     target
//
// Exported Process/Experiment PDFs are NOT upload attachments: they are split out
// of the drop and registered as pending digestions on the flow (which blocks the
// target picker and shows the digest view instead — see PdfDigestView). Only the
// remaining files count toward the upload.
// ─────────────────────────────────────────────────────────────────────────────

import { modals } from "@mantine/modals"
import { notifications } from "@mantine/notifications"
import { useCallback } from "react"
import { UploadFlowPanel } from "../components/UploadFlowStatus"
import { detectDigestDocs } from "../lib/pdfDigest"
import { useAppContext } from "../store/AppContext"
import type { StagedFile } from "./uploadFlow"

/** Identifies where the files were dropped/picked, so add-to-zip vs. warn can
 *  be decided against the active flow's target. */
export type UploadTarget = {
  /** Collection the files belong to, or null for a non-collection ingress. */
  collectionId: string | null
  /** Plane owning the collection (only meaningful with a collectionId). */
  planeId: string | null
  /** Experiment context, when the ingress is an experiment (drop zone). */
  experimentId?: string | null
}

/** Open the canonical flow window (identical to the top-bar badge's popover). */
function openFlowPanel() {
  modals.open({
    withCloseButton: false,
    children: <UploadFlowPanel onClose={() => modals.closeAll()} />,
  })
}

export function useStartOrAddUpload() {
  const {
    uploadFlow,
    startUploadFlow,
    updateUploadFlow,
    addFilesToUploadFlow,
    experiments,
    lastSelectedByKind,
  } = useAppContext()

  return useCallback(
    (files: File[], target: UploadTarget) => {
      if (files.length === 0) {
        return
      }

      // Detection loads pdf-lib + parses each PDF, so it's async. Keep the
      // returned handler synchronous (callers fire-and-forget) by running the
      // work in a detached task.
      void (async () => {
        const { digests, others, rejected } = await detectDigestDocs(files)

        // Rule 4: a document whose experiment isn't derived from its own process
        // is internally inconsistent — inform the user and ignore it.
        if (rejected.length > 0) {
          notifications.show({
            title: `${rejected.length} document${
              rejected.length === 1 ? "" : "s"
            } ignored`,
            message: rejected
              .map((r) => `${r.fileName}: ${r.reason}`)
              .join("; "),
            color: "yellow",
            autoClose: 8000,
          })
        }

        // ── An upload is already in progress ──────────────────────────────────
        if (uploadFlow) {
          if (digests.length > 0) {
            // Queue the docs behind any already pending, then surface the window.
            updateUploadFlow({
              pendingDigests: [
                ...(uploadFlow.pendingDigests ?? []),
                ...digests,
              ],
            })
            openFlowPanel()
          }
          if (others.length > 0) {
            const sameTarget =
              (target.collectionId != null &&
                uploadFlow.targetCollectionId === target.collectionId) ||
              (target.experimentId != null &&
                uploadFlow.experimentId === target.experimentId)
            if (sameTarget) {
              addFilesToUploadFlow(others)
              notifications.show({
                title: "Added to current upload",
                message: `${others.length} file${
                  others.length === 1 ? "" : "s"
                } added to the current upload.`,
                color: "blue",
              })
            } else {
              // Dropped onto a different collection/experiment than the active
              // upload targets. Never silently swallow the files — tell the user
              // the current upload has to be finished or dropped first.
              notifications.show({
                title: "Upload already in progress",
                message:
                  "There's still an incomplete upload for another target — finish or delete it before starting a new one.",
                color: "red",
              })
            }
          }
          return
        }

        // Nothing usable in the drop.
        if (digests.length === 0 && others.length === 0) {
          return
        }

        // ── Fresh flow ────────────────────────────────────────────────────────
        // When digesting, the process/experiment is decided by the PDF, so don't
        // preselect defaults; otherwise prefer the most-recently-created
        // experiment, falling back to the last one the user interacted with.
        const defaultExpId =
          digests.length > 0
            ? null
            : (experiments[experiments.length - 1]?.id ??
              lastSelectedByKind.experiment ??
              null)
        const defaultExp = defaultExpId
          ? experiments.find((e) => e.id === defaultExpId)
          : undefined

        const pendingFiles: StagedFile[] = others.map((f) => ({
          name: f.name,
          size: f.size,
        }))
        const started = startUploadFlow({
          origin: "drag-drop",
          files: others,
          pendingFiles: others.length > 0 ? pendingFiles : undefined,
          processId: defaultExp?.processId ?? null,
          experimentId: defaultExp?.id ?? null,
          targetCollectionId: target.collectionId,
          targetPlaneId: target.collectionId ? target.planeId : null,
          pendingDigests: digests.length > 0 ? digests : undefined,
        })
        if (!started) {
          return
        }
        // Render the exact same window as the top-bar badge's popover
        // (`UploadFlowPanel`) so the post-drop dialog and the top-icon dialog are
        // always identical. No title bar / close button: like the popover, it is
        // dismissed by clicking outside or aborting — the top icon is the guideline.
        openFlowPanel()
      })()
    },
    [
      uploadFlow,
      startUploadFlow,
      updateUploadFlow,
      addFilesToUploadFlow,
      experiments,
      lastSelectedByKind,
    ],
  )
}
