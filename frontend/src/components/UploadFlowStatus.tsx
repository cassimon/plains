import {
  ActionIcon,
  Badge,
  Button,
  Group,
  Paper,
  Popover,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
} from "@mantine/core"
import { modals } from "@mantine/modals"
import { notifications } from "@mantine/notifications"
import {
  IconCheck,
  IconCloudUpload,
  IconTrash,
  IconX,
} from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react"
import { useRevealForFlow } from "@/lib/entityReveal"
import {
  buildSubstratesFromNames,
  countDoneSteps,
  getUploadFlowSteps,
  isUploadFlowComplete,
  recognizeGroupNames,
} from "@/lib/uploadFlow"
import { useAppContext } from "@/store/AppContext"
import { PdfDigestView } from "./PdfDigestView"
import { UploadFlowTargetPicker } from "./UploadFlowTargetPicker"

// Inject the critical-status pulse animation once.
if (
  typeof document !== "undefined" &&
  !document.getElementById("upload-flow-pulse")
) {
  const style = document.createElement("style")
  style.id = "upload-flow-pulse"
  style.textContent = `
    @keyframes upload-flow-pulse {
      0%   { box-shadow: 0 0 0 0 rgba(224, 49, 49, 0.5); }
      70%  { box-shadow: 0 0 0 6px rgba(224, 49, 49, 0); }
      100% { box-shadow: 0 0 0 0 rgba(224, 49, 49, 0); }
    }
    .upload-flow-bubble { animation: upload-flow-pulse 2s ease-out infinite; }
  `
  document.head.appendChild(style)
}

/**
 * The one confirm dialog for discarding an upload flow — every path that
 * cancels a staging (widget trash button, clearing the last staged file) asks
 * through this so the wording and the consequence (permanent deletion of the
 * staged files) stay consistent. `onConfirm` should call
 * `discardUploadFlow()` from AppContext.
 */
export function openDiscardUploadFlowConfirm(opts: {
  title?: string
  message?: ReactNode
  confirmLabel?: string
  onConfirm: () => void
}) {
  modals.openConfirmModal({
    title: opts.title ?? "Delete this upload?",
    children: (
      <Text size="sm">
        {opts.message ?? (
          <>
            The staged files for this upload will be{" "}
            <strong>permanently deleted</strong>. This can't be undone.
          </>
        )}
      </Text>
    ),
    labels: {
      confirm: opts.confirmLabel ?? "Delete permanently",
      cancel: "Keep upload",
    },
    confirmProps: { color: "red" },
    onConfirm: opts.onConfirm,
  })
}

/**
 * The full body of the upload flow — the Process/Experiment/Upload "boxes" (which
 * turn green as each step completes) and the "Go to results & upload" action. This
 * is the single source of truth for what the flow window looks like: it is rendered
 * both inside the top-bar badge's popover (the canonical presentation) and inside
 * the modal opened right after files are dropped, so the two are always identical.
 *
 * The Process and Experiment boxes live in `UploadFlowTargetPicker`; the Upload box
 * is here because it is only ever an action (jump to Results), never a selector.
 *
 * `onClose` is invoked whenever an action navigates away or the flow is aborted,
 * so the host (popover or modal) can dismiss itself.
 */
export function UploadFlowPanel({ onClose }: { onClose: () => void }) {
  const {
    uploadFlow,
    discardUploadFlow,
    processes,
    experiments,
    results,
    setActiveEntity,
    updateLastSelected,
    setPendingCollectionLink,
  } = useAppContext()
  const navigate = useNavigate()
  const revealForFlow = useRevealForFlow()

  const steps = useMemo(() => {
    if (!uploadFlow) {
      return null
    }
    return getUploadFlowSteps(uploadFlow, { processes, experiments, results })
  }, [uploadFlow, processes, experiments, results])

  if (!uploadFlow || !steps) {
    return null
  }

  const handleGoToResults = () => {
    if (!uploadFlow.experimentId) {
      return
    }
    // Keep the experiment visible in the left selection bar without discarding the
    // plane context: stay in its collection if we're already there, else drop to
    // the plane's General view (never the cross-plane General view). See
    // `computeRevealView` for why (isEntityVisible filtering / Results auto-deselect).
    revealForFlow("experiment", uploadFlow.experimentId)
    setPendingCollectionLink({
      collectionId: "",
      planeId: "",
      kind: "result",
      selectedExperimentId: uploadFlow.experimentId,
      openAddResults: true,
      requestId: crypto.randomUUID(),
    })
    setActiveEntity({ kind: "experiment", id: uploadFlow.experimentId })
    updateLastSelected("experiment", uploadFlow.experimentId)
    onClose()
    void navigate({ to: "/results" })
  }

  const handleDelete = () => {
    openDiscardUploadFlowConfirm({
      onConfirm: () => {
        onClose()
        void discardUploadFlow()
      },
    })
  }

  const uploadDone = steps.upload === "done"
  const canGoToResults = steps.experiment === "done" && !uploadDone

  return (
    <Stack gap="sm">
      <Group justify="space-between">
        <Text fw={700} size="sm">
          File Upload
        </Text>
        <Group gap={4}>
          <Tooltip label="Delete upload permanently" withArrow>
            <ActionIcon
              size="sm"
              variant="subtle"
              color="red"
              onClick={handleDelete}
              aria-label="Delete upload permanently"
            >
              <IconTrash size={14} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Close" withArrow>
            <ActionIcon
              size="sm"
              variant="subtle"
              color="gray"
              onClick={onClose}
              aria-label="Close"
            >
              <IconX size={14} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Group>

      {(uploadFlow.pendingDigests?.length ?? 0) > 0 ? (
        // A Process/Experiment PDF was dropped: digestion BLOCKS the target
        // picker and shows a different view until every doc is resolved into a
        // selected / newly-created entity.
        <PdfDigestView />
      ) : (
        <>
          {/* Process + Experiment boxes (turn green when complete). Creating an
              entity here navigates to its page; the picker settles the view
              itself, so this only needs to dismiss the host. */}
          <UploadFlowTargetPicker onNavigateAway={onClose} />

          {/* Upload box — the results link is blocked until the experiment (and
              therefore the process) is complete and correct. */}
          <Paper
            withBorder
            p="sm"
            radius="md"
            style={{
              borderColor: uploadDone
                ? "var(--mantine-color-teal-5)"
                : undefined,
              background: uploadDone
                ? "light-dark(var(--mantine-color-teal-0), var(--mantine-color-teal-9))"
                : undefined,
              transition: "background 150ms, border-color 150ms",
            }}
          >
            <Group gap="xs" mb={8} wrap="nowrap">
              <ThemeIcon
                size="sm"
                radius="xl"
                color={uploadDone ? "teal" : "gray"}
                variant={uploadDone ? "filled" : "light"}
              >
                <IconCheck size={14} opacity={uploadDone ? 1 : 0.4} />
              </ThemeIcon>
              <Text
                size="sm"
                fw={700}
                c={steps.experiment === "done" ? undefined : "dimmed"}
              >
                Upload
              </Text>
            </Group>
            {uploadDone ? (
              <Text size="xs" c="dimmed">
                Uploaded to NOMAD.
              </Text>
            ) : canGoToResults ? (
              <Button
                fullWidth
                size="xs"
                leftSection={<IconCloudUpload size={14} />}
                onClick={handleGoToResults}
              >
                Go to results &amp; upload
              </Button>
            ) : (
              <Text size="xs" c="dimmed">
                Complete the process and experiment to upload results.
              </Text>
            )}
          </Paper>
        </>
      )}
    </Stack>
  )
}

export function UploadFlowStatus() {
  const {
    uploadFlow,
    discardUploadFlow,
    processes,
    experiments,
    results,
    setExperiments,
    updateUploadFlow,
  } = useAppContext()
  const [opened, setOpened] = useState(false)

  // ── Automatic substrate-name import ────────────────────────────────────────
  // The moment the flow (carrying staged files) becomes associated with an
  // experiment whose substrates are not yet named — a fresh experiment created
  // from the picker, or an existing one with no/only-unnamed substrates — the
  // device-group names recognized in the staged file names are imported
  // automatically, replacing any unnamed placeholder rows. Experiments that
  // already carry named substrates are never touched: the user can still erase
  // them ("Delete all" on the Experiments page) and re-import manually.
  // One-directional by design (flow+experiments → one experiments write); the
  // ref key is set BEFORE the write so the effect can never re-fire for the
  // same flow/experiment pair (see CLAUDE.md on effect feedback loops).
  const autoImportKeyRef = useRef<string | null>(null)
  useEffect(() => {
    if (!uploadFlow?.experimentId) {
      return
    }
    const key = `${uploadFlow.id}:${uploadFlow.experimentId}`
    if (autoImportKeyRef.current === key) {
      return
    }
    const fileNames = (uploadFlow.pendingFiles ?? []).map((f) => f.name)
    if (fileNames.length === 0) {
      return
    }
    const experiment = experiments.find((e) => e.id === uploadFlow.experimentId)
    if (!experiment) {
      return
    }
    const allUnnamed = experiment.substrates.every((s) => s.name.trim() === "")
    autoImportKeyRef.current = key
    if (experiment.substrates.length > 0 && !allUnnamed) {
      // Substrate names were already defined — never overwrite them.
      return
    }
    const names = recognizeGroupNames(fileNames)
    if (names.length === 0) {
      return
    }
    const process = processes.find((p) => p.id === experiment.processId)
    const created = buildSubstratesFromNames(
      [],
      names,
      process?.inlineSubstrates?.[0]?.id,
    )
    if (created.length === 0) {
      return
    }
    setExperiments((prev) =>
      prev.map((e) =>
        e.id === experiment.id
          ? { ...e, substrates: created, numSubstrates: created.length }
          : e,
      ),
    )
    updateUploadFlow({
      substrateNamesImported: true,
      autoCreatedSubstrateIds: created.map((c) => c.id),
    })
    notifications.show({
      title: "Substrate names imported",
      message: `${created.length} substrate name${
        created.length === 1 ? " was" : "s were"
      } imported from the upload's file names. Use “Delete all” in the experiment's Processing step to start from scratch instead.`,
      color: "green",
    })
  }, [uploadFlow, experiments, processes, setExperiments, updateUploadFlow])

  const steps = useMemo(() => {
    if (!uploadFlow) {
      return null
    }
    return getUploadFlowSteps(uploadFlow, { processes, experiments, results })
  }, [uploadFlow, processes, experiments, results])

  // On completion: notify once and auto-clear the flow after a short delay.
  const complete = steps ? isUploadFlowComplete(steps) : false
  const notifiedRef = useRef(false)
  useEffect(() => {
    if (!complete) {
      notifiedRef.current = false
      return
    }
    if (notifiedRef.current) {
      return
    }
    notifiedRef.current = true
    notifications.show({
      title: "Upload complete",
      message: "Your files were uploaded to NOMAD.",
      color: "green",
    })
    // Auto-clear through the same discard path: on a complete flow the result
    // has its upload_id and empty files, so the sweep only clears the flow
    // itself (plus any leftover archive record) — never the uploaded result.
    const timer = window.setTimeout(() => void discardUploadFlow(), 5000)
    return () => window.clearTimeout(timer)
  }, [complete, discardUploadFlow])

  if (!uploadFlow || !steps) {
    return null
  }

  const done = countDoneSteps(steps)

  return (
    <Popover
      opened={opened}
      onChange={setOpened}
      width={340}
      position="bottom"
      shadow="md"
      withArrow
    >
      <Popover.Target>
        <Badge
          className="upload-flow-bubble"
          color="red"
          variant="filled"
          size="lg"
          leftSection={<IconCloudUpload size={14} />}
          style={{ cursor: "pointer" }}
          onClick={() => setOpened((o) => !o)}
        >
          File Upload · {done}/3
        </Badge>
      </Popover.Target>
      <Popover.Dropdown>
        <UploadFlowPanel onClose={() => setOpened(false)} />
      </Popover.Dropdown>
    </Popover>
  )
}
