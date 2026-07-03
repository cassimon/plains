import { Badge, Button, Group, Select, Stack, Text } from "@mantine/core"
import { IconFlask2, IconPlus } from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import { useMemo } from "react"
import { getExperimentAllStepsDone } from "@/lib/uploadFlow"
import {
  type CanvasCollectionElement,
  getProcessStatus,
  newExperiment,
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
          onChange={(value) => updateUploadFlow({ experimentId: value })}
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
        <Group gap={6} c="dimmed">
          <IconFlask2 size={14} />
          <Text size="xs">
            {uploadFlow.pendingFiles.length} file
            {uploadFlow.pendingFiles.length === 1 ? "" : "s"} staged
          </Text>
        </Group>
      )}
    </Stack>
  )
}
