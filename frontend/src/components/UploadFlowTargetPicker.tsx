import {
  ActionIcon,
  Button,
  Combobox,
  Group,
  Input,
  InputBase,
  Paper,
  Stack,
  Text,
  ThemeIcon,
  Tooltip,
  useCombobox,
} from "@mantine/core"
import { notifications } from "@mantine/notifications"
import {
  IconArrowUpRight,
  IconCheck,
  IconFileImport,
  IconFlask2,
  IconPlus,
} from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import { useMemo } from "react"
import { homeCollectionForEntity, useRevealForFlow } from "@/lib/entityReveal"
import {
  buildSubstratesFromNames,
  getExperimentAllStepsDone,
  recognizeGroupNames,
} from "@/lib/uploadFlow"
import {
  type CanvasCollectionElement,
  getProcessStatus,
  newExperiment,
  newProcess,
  useAppContext,
} from "@/store/AppContext"

/** Sentinel option value for the "＋ New …" row inside a combobox dropdown. */
const CREATE_NEW = "__create_new__"

/**
 * A bordered section for one step of the flow. Neutral while pending, green once
 * `done` — this is the "three boxes that turn green" affordance.
 */
function FlowBox({
  label,
  done,
  dimmed,
  children,
}: {
  label: string
  done: boolean
  dimmed?: boolean
  children: React.ReactNode
}) {
  return (
    <Paper
      withBorder
      p="sm"
      radius="md"
      style={{
        borderColor: done ? "var(--mantine-color-teal-5)" : undefined,
        background: done ? "var(--mantine-color-teal-0)" : undefined,
        transition: "background 150ms, border-color 150ms",
      }}
    >
      <Group gap="xs" mb={8} wrap="nowrap">
        <ThemeIcon
          size="sm"
          radius="xl"
          color={done ? "teal" : "gray"}
          variant={done ? "filled" : "light"}
        >
          <IconCheck size={14} opacity={done ? 1 : 0.4} />
        </ThemeIcon>
        <Text size="sm" fw={700} c={dimmed ? "dimmed" : undefined}>
          {label}
        </Text>
      </Group>
      {children}
    </Paper>
  )
}

/**
 * Shared Process → Experiment selection, rendered as two "boxes" that turn green
 * once their entity is complete. Each box carries its own combobox (existing
 * entities plus a "＋ New …" row that creates and routes straight to the entity)
 * and a go-to button that opens the entity's page. The Experiment box also offers
 * "Import substrate names" (from the staged file names), disabled once used.
 *
 * Reads and writes the active upload flow directly through the context.
 */
export function UploadFlowTargetPicker({
  onNavigateAway,
}: {
  /** Called right before navigating away (e.g. to close a modal). */
  onNavigateAway?: () => void
}) {
  const {
    uploadFlow,
    updateUploadFlow,
    processes,
    setProcesses,
    experiments,
    setExperiments,
    setActiveEntity,
    updateLastSelected,
    planes,
    updateElement,
    activePlaneId,
    setActivePlaneId,
    setActiveCollectionId,
  } = useAppContext()
  const navigate = useNavigate()
  const revealForFlow = useRevealForFlow()

  const processCombobox = useCombobox()
  const experimentCombobox = useCombobox()

  const processId = uploadFlow?.processId ?? null
  const experimentId = uploadFlow?.experimentId ?? null

  const selectedProcess = processId
    ? processes.find((p) => p.id === processId)
    : undefined
  const selectedExperiment = experimentId
    ? experiments.find((e) => e.id === experimentId)
    : undefined

  const processDone = selectedProcess
    ? getProcessStatus(selectedProcess) === "complete"
    : false
  const experimentDone = selectedExperiment
    ? getExperimentAllStepsDone(selectedExperiment, selectedProcess)
    : false

  const stagedFileNames = useMemo(
    () => (uploadFlow?.pendingFiles ?? []).map((f) => f.name),
    [uploadFlow?.pendingFiles],
  )

  // Mirrors the Experiments page's `substrateMaterialOptions[0]` — the
  // process's first provided substrate material, used as the default for
  // substrates created here via "Import substrate names".
  const defaultSubstrateMaterialId = selectedProcess?.inlineSubstrates?.[0]?.id

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

  /** Add a canvas reference to the collection that should hold a new entity, and
   *  return the collection's home (for staying in-view after navigation). */
  const linkToHomeCollection = (
    kind: "process" | "experiment",
    id: string,
    processIdForHome: string | null,
  ): { planeId: string; collectionId: string } | null => {
    // Prefer the collection that already holds the linked process; fall back to
    // the flow's drop-target collection (rule 2 in upload-flow-reconciliation).
    const home =
      (processIdForHome
        ? homeCollectionForEntity(planes, "process", processIdForHome)
        : null) ??
      (uploadFlow.targetCollectionId && uploadFlow.targetPlaneId
        ? {
            planeId: uploadFlow.targetPlaneId,
            collectionId: uploadFlow.targetCollectionId,
          }
        : null)
    if (!home) {
      return null
    }
    const homePlane = planes.find((p) => p.id === home.planeId)
    const collection = homePlane?.elements.find(
      (e) => e.id === home.collectionId && e.type === "collection",
    ) as CanvasCollectionElement | undefined
    if (collection) {
      updateElement(home.planeId, {
        ...collection,
        refs: [...collection.refs, { kind, id }],
      })
    }
    return home
  }

  /** Stay in the collection the entity lives in after navigating, else drop to
   *  the current plane's General view (never the cross-plane General view). */
  const settleView = (
    home: { planeId: string; collectionId: string } | null,
  ) => {
    if (home) {
      setActivePlaneId(home.planeId)
      setActiveCollectionId(home.collectionId)
    } else {
      setActivePlaneId(activePlaneId)
      setActiveCollectionId(null)
    }
  }

  const handleCreateProcess = () => {
    const proc = newProcess()
    setProcesses((prev) => [...prev, proc])
    updateUploadFlow({ processId: proc.id, experimentId: null })
    const home = linkToHomeCollection("process", proc.id, null)
    setActiveEntity({ kind: "process", id: proc.id })
    updateLastSelected("process", proc.id)
    settleView(home)
    onNavigateAway?.()
    void navigate({ to: "/processes" })
  }

  const handleCreateExperiment = () => {
    if (!processId) {
      return
    }
    const exp = newExperiment(processId)
    setExperiments((prev) => [...prev, exp])
    updateUploadFlow({ experimentId: exp.id })
    const home = linkToHomeCollection("experiment", exp.id, processId)
    setActiveEntity({ kind: "experiment", id: exp.id })
    updateLastSelected("experiment", exp.id)
    settleView(home)
    onNavigateAway?.()
    void navigate({ to: "/experiments" })
  }

  const goToProcess = () => {
    if (!processId) {
      return
    }
    revealForFlow("process", processId)
    setActiveEntity({ kind: "process", id: processId })
    updateLastSelected("process", processId)
    onNavigateAway?.()
    void navigate({ to: "/processes" })
  }

  const goToExperiment = () => {
    if (!experimentId) {
      return
    }
    revealForFlow("experiment", experimentId)
    setActiveEntity({ kind: "experiment", id: experimentId })
    updateLastSelected("experiment", experimentId)
    onNavigateAway?.()
    void navigate({ to: "/experiments" })
  }

  const handleImportSubstrateNames = () => {
    if (!selectedExperiment) {
      return
    }
    const names = recognizeGroupNames(stagedFileNames)
    const created = buildSubstratesFromNames(
      selectedExperiment.substrates,
      names,
      defaultSubstrateMaterialId,
    )
    if (created.length === 0) {
      notifications.show({
        title: "Nothing to import",
        message:
          names.length === 0
            ? "No substrate names were recognized in the staged files."
            : "All recognized substrate names already exist.",
        color: "yellow",
      })
      return
    }
    setExperiments((prev) =>
      prev.map((e) =>
        e.id === selectedExperiment.id
          ? {
              ...e,
              substrates: [...e.substrates, ...created],
              numSubstrates: e.substrates.length + created.length,
            }
          : e,
      ),
    )
    updateUploadFlow({ substrateNamesImported: true })
    notifications.show({
      title: "Substrates imported",
      message: `Added ${created.length} substrate${
        created.length === 1 ? "" : "s"
      } from the staged files.`,
      color: "green",
    })
  }

  const processButtonLabel = selectedProcess
    ? selectedProcess.name || "Untitled process"
    : null
  const experimentButtonLabel = selectedExperiment
    ? selectedExperiment.name || "Untitled experiment"
    : null

  const hasStagedFiles = (uploadFlow.pendingFiles?.length ?? 0) > 0

  return (
    <Stack gap="sm">
      {/* ── Process box ─────────────────────────────────────────────────────── */}
      <FlowBox label="Process" done={processDone}>
        <Group gap="xs" wrap="nowrap" align="flex-start">
          <Combobox
            store={processCombobox}
            withinPortal={false}
            onOptionSubmit={(value) => {
              processCombobox.closeDropdown()
              if (value === CREATE_NEW) {
                handleCreateProcess()
                return
              }
              updateUploadFlow({ processId: value, experimentId: null })
            }}
          >
            <Combobox.Target>
              <InputBase
                component="button"
                type="button"
                pointer
                style={{ flex: 1 }}
                rightSection={<Combobox.Chevron />}
                rightSectionPointerEvents="none"
                onClick={() => processCombobox.toggleDropdown()}
              >
                {processButtonLabel ?? (
                  <Input.Placeholder>Select a process</Input.Placeholder>
                )}
              </InputBase>
            </Combobox.Target>
            <Combobox.Dropdown>
              <Combobox.Options>
                {processOptions.map((o) => (
                  <Combobox.Option value={o.value} key={o.value}>
                    {o.label}
                  </Combobox.Option>
                ))}
                <Combobox.Option value={CREATE_NEW}>
                  <Group gap={6} wrap="nowrap">
                    <IconPlus size={14} />
                    <Text size="sm" fw={600}>
                      New process
                    </Text>
                  </Group>
                </Combobox.Option>
              </Combobox.Options>
            </Combobox.Dropdown>
          </Combobox>
          <Tooltip label="Open process" withArrow>
            <ActionIcon
              variant="light"
              size="lg"
              disabled={!processId}
              onClick={goToProcess}
              aria-label="Open process"
            >
              <IconArrowUpRight size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </FlowBox>

      {/* ── Experiment box ──────────────────────────────────────────────────── */}
      <FlowBox label="Experiment" done={experimentDone} dimmed={!processId}>
        <Stack gap={8}>
          <Group gap="xs" wrap="nowrap" align="flex-start">
            <Combobox
              store={experimentCombobox}
              withinPortal={false}
              disabled={!processId}
              onOptionSubmit={(value) => {
                experimentCombobox.closeDropdown()
                if (value === CREATE_NEW) {
                  handleCreateExperiment()
                  return
                }
                updateUploadFlow({ experimentId: value })
              }}
            >
              <Combobox.Target>
                <InputBase
                  component="button"
                  type="button"
                  pointer
                  disabled={!processId}
                  style={{ flex: 1 }}
                  rightSection={<Combobox.Chevron />}
                  rightSectionPointerEvents="none"
                  onClick={() => experimentCombobox.toggleDropdown()}
                >
                  {experimentButtonLabel ?? (
                    <Input.Placeholder>
                      {processId
                        ? "Select an experiment"
                        : "Choose a process first"}
                    </Input.Placeholder>
                  )}
                </InputBase>
              </Combobox.Target>
              <Combobox.Dropdown>
                <Combobox.Options>
                  {experimentOptions.map((o) => (
                    <Combobox.Option value={o.value} key={o.value}>
                      {o.label}
                    </Combobox.Option>
                  ))}
                  <Combobox.Option value={CREATE_NEW}>
                    <Group gap={6} wrap="nowrap">
                      <IconPlus size={14} />
                      <Text size="sm" fw={600}>
                        New experiment
                      </Text>
                    </Group>
                  </Combobox.Option>
                </Combobox.Options>
              </Combobox.Dropdown>
            </Combobox>
            <Tooltip label="Open experiment" withArrow>
              <ActionIcon
                variant="light"
                size="lg"
                disabled={!experimentId}
                onClick={goToExperiment}
                aria-label="Open experiment"
              >
                <IconArrowUpRight size={18} />
              </ActionIcon>
            </Tooltip>
          </Group>

          {hasStagedFiles && (
            <>
              <Button
                variant="light"
                size="xs"
                leftSection={<IconFileImport size={14} />}
                disabled={!experimentId || !!uploadFlow.substrateNamesImported}
                onClick={handleImportSubstrateNames}
              >
                {uploadFlow.substrateNamesImported
                  ? "Substrate names imported"
                  : "Import substrate names"}
              </Button>
              <Group gap={6} c="dimmed">
                <IconFlask2 size={14} />
                <Text size="xs">
                  {uploadFlow.pendingFiles?.length} file
                  {uploadFlow.pendingFiles?.length === 1 ? "" : "s"} staged
                </Text>
              </Group>
            </>
          )}
        </Stack>
      </FlowBox>
    </Stack>
  )
}
