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
// ─────────────────────────────────────────────────────────────────────────────

import { modals } from "@mantine/modals"
import { notifications } from "@mantine/notifications"
import { useCallback } from "react"
import { UploadFlowPanel } from "../components/UploadFlowStatus"
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

export function useStartOrAddUpload() {
  const {
    uploadFlow,
    startUploadFlow,
    addFilesToUploadFlow,
    experiments,
    lastSelectedByKind,
  } = useAppContext()

  return useCallback(
    (files: File[], target: UploadTarget) => {
      if (files.length === 0) {
        return
      }

      // ── An upload is already in progress ────────────────────────────────────
      if (uploadFlow) {
        const sameTarget =
          (target.collectionId != null &&
            uploadFlow.targetCollectionId === target.collectionId) ||
          (target.experimentId != null &&
            uploadFlow.experimentId === target.experimentId)
        if (sameTarget) {
          addFilesToUploadFlow(files)
          notifications.show({
            title: "Added to current upload",
            message: `${files.length} file${
              files.length === 1 ? "" : "s"
            } added to the current upload.`,
            color: "blue",
          })
        } else {
          notifications.show({
            title: "Upload already in progress",
            message:
              "There's still an incomplete upload — finish or cancel it before starting a new one.",
            color: "red",
          })
        }
        return
      }

      // ── Fresh flow: preselect the most-likely process / experiment ──────────
      // Prefer the most-recently-created experiment (appended last), falling
      // back to the last one the user interacted with.
      const defaultExpId =
        experiments[experiments.length - 1]?.id ??
        lastSelectedByKind.experiment ??
        null
      const defaultExp = defaultExpId
        ? experiments.find((e) => e.id === defaultExpId)
        : undefined

      const pendingFiles: StagedFile[] = files.map((f) => ({
        name: f.name,
        size: f.size,
      }))
      const started = startUploadFlow({
        origin: "drag-drop",
        files,
        pendingFiles,
        processId: defaultExp?.processId ?? null,
        experimentId: defaultExp?.id ?? null,
        targetCollectionId: target.collectionId,
        targetPlaneId: target.collectionId ? target.planeId : null,
      })
      if (!started) {
        return
      }
      // Render the exact same window as the top-bar badge's popover
      // (`UploadFlowPanel`) so the post-drop dialog and the top-icon dialog are
      // always identical. No title bar / close button: like the popover, it is
      // dismissed by clicking outside or aborting — the top icon is the guideline.
      modals.open({
        withCloseButton: false,
        children: <UploadFlowPanel onClose={() => modals.closeAll()} />,
      })
    },
    [
      uploadFlow,
      startUploadFlow,
      addFilesToUploadFlow,
      experiments,
      lastSelectedByKind,
    ],
  )
}
