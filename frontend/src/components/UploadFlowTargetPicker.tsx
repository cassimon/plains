import {
  ActionIcon,
  Badge,
  Button,
  Checkbox,
  Group,
  Select,
  Stack,
  Text,
} from "@mantine/core"
import { IconFlask2, IconPlus, IconX } from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import { useCallback, useMemo } from "react"
import {
  getExperimentAllStepsDone,
  recognizeGroupNames,
} from "@/lib/uploadFlow"
import {
  type CanvasCollectionElement,
  getProcessStatus,
  newExperiment,
  type Substrate,
  useAppContext,
} from "@/store/AppContext"

/**
 * Shared Process → Experiment selection + inline experiment creation, used both
 * in the Organization drop modal and the expanded top-bar status. Reads and
 * writes the active upload flow directly through the context.
 *
 * Rules enforced here:
 *  - The Experiment select is disabled until a Process is chosen.
 *  - "Create Experiment" is enabled only once a Process is chosen (an experiment
 *    is always linked to exactly one process).
 */
export function UploadFlowTargetPicker({
  onNavigateAway,
}: {
  /** Called right before navigating to /experiments (e.g. to close a modal). */
  onNavigateAway?: () => void
}) {
  const {
    uploadFlow,
    updateUploadFlow,
    processes,
    experiments,
    setExperiments,
    setActiveEntity,
    updateLastSelected,
    planes,
    updateElement,
  } = useAppContext()
  const navigate = useNavigate()

  const processId = uploadFlow?.processId ?? null
  const experimentId = uploadFlow?.experimentId ?? null

  // ── Auto-create substrates from recognized file-name groups ────────────────
  // Only meaningful when files were staged BEFORE the experiment exists
  // (flows "upload first" / "upload and associate").
  const stagedFileNames = useMemo(
    () => (uploadFlow?.pendingFiles ?? []).map((f) => f.name),
    [uploadFlow?.pendingFiles],
  )
  const recognizedNames = useMemo(
    () => recognizeGroupNames(stagedFileNames),
    [stagedFileNames],
  )

  /** Add one substrate per recognized group to the experiment (deduplicated
   *  case-insensitively against the names it already has). */
  const autoCreateSubstratesFor = useCallback(
    (targetExperimentId: string) => {
      if (!uploadFlow?.autoCreateSubstrates || recognizedNames.length === 0) {
        return
      }
      // Compute the new substrates OUTSIDE the state updater (updaters must
      // stay pure — Strict Mode double-invokes them). A just-created
      // experiment is not in `experiments` yet, so it has no substrates.
      const target = experiments.find((e) => e.id === targetExperimentId)
      const existing = new Set(
        (target?.substrates ?? []).map((sub) => sub.name.toLowerCase()),
      )
      const created: Substrate[] = recognizedNames
        .filter((name) => !existing.has(name.toLowerCase()))
        .map((name) => ({ id: crypto.randomUUID(), name }))
      if (created.length === 0) {
        return
      }
      setExperiments((prev) =>
        prev.map((e) =>
          e.id === targetExperimentId
            ? {
                ...e,
                substrates: [...e.substrates, ...created],
                numSubstrates: e.substrates.length + created.length,
              }
            : e,
        ),
      )
      updateUploadFlow({
        autoCreatedSubstrateIds: [
          ...(uploadFlow?.autoCreatedSubstrateIds ?? []),
          ...created.map((sub) => sub.id),
        ],
      })
    },
    [
      experiments,
      recognizedNames,
      setExperiments,
      updateUploadFlow,
      uploadFlow?.autoCreateSubstrates,
      uploadFlow?.autoCreatedSubstrateIds,
    ],
  )

  /** Remove a misrecognized auto-created substrate from the experiment. */
  const removeAutoCreatedSubstrate = useCallback(
    (substrateId: string) => {
      if (!experimentId) {
        return
      }
      setExperiments((prev) =>
        prev.map((e) =>
          e.id === experimentId
            ? {
                ...e,
                substrates: e.substrates.filter(
                  (sub) => sub.id !== substrateId,
                ),
                numSubstrates: Math.max(0, e.substrates.length - 1),
              }
            : e,
        ),
      )
      updateUploadFlow({
        autoCreatedSubstrateIds: (
          uploadFlow?.autoCreatedSubstrateIds ?? []
        ).filter((id) => id !== substrateId),
      })
    },
    [
      experimentId,
      setExperiments,
      updateUploadFlow,
      uploadFlow?.autoCreatedSubstrateIds,
    ],
  )

  // The auto-created substrates that still exist on the selected experiment
  // (listed so misrecognized names can be deleted right here).
  const autoCreatedSubstrates = useMemo(() => {
    if (!experimentId) {
      return []
    }
    const ids = new Set(uploadFlow?.autoCreatedSubstrateIds ?? [])
    const experiment = experiments.find((e) => e.id === experimentId)
    return (experiment?.substrates ?? []).filter((sub) => ids.has(sub.id))
  }, [experimentId, experiments, uploadFlow?.autoCreatedSubstrateIds])

  const processOptions = useMemo(
    () =>
      processes.map((p) => ({
        value: p.id,
        label: `${p.name || "Untitled process"}${
          getProcessStatus(p) === "complete" ? "" : "  ·  incomplete"
        }`,
      })),
    [processes],
  )

  const experimentOptions = useMemo(() => {
    if (!processId) {
      return []
    }
    return experiments
      .filter((e) => e.processId === processId)
      .map((e) => {
        const process = processes.find((p) => p.id === e.processId)
        const done = getExperimentAllStepsDone(e, process)
        return {
          value: e.id,
          label: `${e.name || "Untitled experiment"}${
            done ? "" : "  ·  incomplete"
          }`,
        }
      })
  }, [processId, experiments, processes])

  if (!uploadFlow) {
    return null
  }

  const handleCreateExperiment = () => {
    if (!processId) {
      return
    }
    const exp = newExperiment(processId)
    setExperiments((prev) => [...prev, exp])
    updateUploadFlow({ experimentId: exp.id })
    autoCreateSubstratesFor(exp.id)

    // Experiments created inside the drop/upload flow are always associated with
    // the flow's collection. It stays hidden behind the pending marker until the
    // flow completes, then surfaces as a normal experiment item.
    if (uploadFlow.targetCollectionId && uploadFlow.targetPlaneId) {
      const targetPlane = planes.find((p) => p.id === uploadFlow.targetPlaneId)
      const collection = targetPlane?.elements.find(
        (e) =>
          e.id === uploadFlow.targetCollectionId && e.type === "collection",
      ) as CanvasCollectionElement | undefined
      if (collection) {
        updateElement(uploadFlow.targetPlaneId, {
          ...collection,
          refs: [...collection.refs, { kind: "experiment", id: exp.id }],
        })
      }
    }

    setActiveEntity({ kind: "experiment", id: exp.id })
    updateLastSelected("experiment", exp.id)
    onNavigateAway?.()
    void navigate({ to: "/experiments" })
  }

  const selectedProcess = processId
    ? processes.find((p) => p.id === processId)
    : undefined
  const selectedExperiment = experimentId
    ? experiments.find((e) => e.id === experimentId)
    : undefined

  return (
    <Stack gap="sm">
      {/* Process */}
      <Stack gap={4}>
        <Group gap="xs" justify="space-between">
          <Text size="sm" fw={600}>
            Process
          </Text>
          {selectedProcess && (
            <Badge
              size="xs"
              variant="dot"
              color={
                getProcessStatus(selectedProcess) === "complete"
                  ? "green"
                  : "red"
              }
            >
              {getProcessStatus(selectedProcess) === "complete"
                ? "Complete"
                : "Incomplete"}
            </Badge>
          )}
        </Group>
        <Select
          placeholder="Select a process"
          data={processOptions}
          value={processId}
          searchable
          nothingFoundMessage="No processes"
          onChange={(value) =>
            // Changing the process invalidates the experiment selection.
            updateUploadFlow({ processId: value, experimentId: null })
          }
        />
      </Stack>

      {/* Experiment */}
      <Stack gap={4}>
        <Group gap="xs" justify="space-between">
          <Text size="sm" fw={600} c={processId ? undefined : "dimmed"}>
            Experiment
          </Text>
          {selectedExperiment && (
            <Badge
              size="xs"
              variant="dot"
              color={
                getExperimentAllStepsDone(selectedExperiment, selectedProcess)
                  ? "green"
                  : "red"
              }
            >
              {getExperimentAllStepsDone(selectedExperiment, selectedProcess)
                ? "Complete"
                : "Incomplete"}
            </Badge>
          )}
        </Group>
        <Select
          placeholder={
            processId ? "Select an experiment" : "Choose a process first"
          }
          data={experimentOptions}
          value={experimentId}
          disabled={!processId}
          searchable
          nothingFoundMessage="No experiments for this process"
          onChange={(value) => {
            updateUploadFlow({ experimentId: value })
            if (value) {
              autoCreateSubstratesFor(value)
            }
          }}
        />
        <Button
          variant="light"
          size="xs"
          leftSection={<IconPlus size={14} />}
          disabled={!processId}
          onClick={handleCreateExperiment}
        >
          Create experiment
        </Button>
      </Stack>

      {uploadFlow.pendingFiles && uploadFlow.pendingFiles.length > 0 && (
        <Stack gap={6}>
          <Checkbox
            size="xs"
            label={
              recognizedNames.length > 0
                ? `Auto-create substrate names from recognized groups (${recognizedNames.join(", ")})`
                : "Auto-create substrate names from recognized groups"
            }
            checked={!!uploadFlow.autoCreateSubstrates}
            disabled={recognizedNames.length === 0}
            onChange={(e) => {
              const checked = e.currentTarget.checked
              updateUploadFlow({ autoCreateSubstrates: checked })
              // Checking after an experiment is already selected applies
              // immediately; the flow keeps working for late deciders.
              if (checked && experimentId) {
                autoCreateSubstratesFor(experimentId)
              }
            }}
          />
          {autoCreatedSubstrates.length > 0 && (
            <Group gap={4} wrap="wrap">
              <Text size="xs" c="dimmed">
                Auto-created:
              </Text>
              {autoCreatedSubstrates.map((sub) => (
                <Badge
                  key={sub.id}
                  size="sm"
                  variant="light"
                  rightSection={
                    <ActionIcon
                      size={12}
                      variant="transparent"
                      color="red"
                      aria-label={`Delete substrate ${sub.name}`}
                      onClick={() => removeAutoCreatedSubstrate(sub.id)}
                    >
                      <IconX size={10} />
                    </ActionIcon>
                  }
                >
                  {sub.name}
                </Badge>
              ))}
            </Group>
          )}
          <Group gap={6} c="dimmed">
            <IconFlask2 size={14} />
            <Text size="xs">
              {uploadFlow.pendingFiles.length} file
              {uploadFlow.pendingFiles.length === 1 ? "" : "s"} staged
            </Text>
          </Group>
        </Stack>
      )}
    </Stack>
  )
}
