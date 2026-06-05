import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Divider,
  Group,
  Modal,
  NumberInput,
  Paper,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core"
import { modals } from "@mantine/modals"
import {
  IconCopy,
  IconInfoCircle,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react"
import * as React from "react"
import { useCallback, useRef, useState } from "react"
import {
  type CollectionConfirmParams,
  SelectCollectionModal,
} from "../components/SelectCollectionModal"
import {
  type CanvasCollectionElement,
  type Experiment,
  getExperimentStatus,
  type Material,
  newExperiment,
  PROCESS_PARAMETER_DEFINITIONS,
  type Process,
  type ProcessParameterKey,
  type ProcessStep,
  useAppContext,
  useEntityCollection,
} from "../store/AppContext"

type SubstrateGeneratorConfig = {
  namePrefix: string
  includeDate: boolean
  includeExperimentName: boolean
  addCount: number
}

type SubstrateMaterialOption = {
  value: string
  label: string
  heightMm: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Performance-optimized TextInput with local state + onBlur
// ─────────────────────────────────────────────────────────────────────────────

function DeferredTextInput({
  value,
  onChange,
  onBlur,
  ...props
}: Omit<React.ComponentProps<typeof TextInput>, "onChange" | "onBlur"> & {
  value: string
  onChange?: (value: string) => void
  onBlur?: (value: string) => void
}) {
  const [localValue, setLocalValue] = useState(value)

  React.useEffect(() => {
    setLocalValue(value)
  }, [value])

  const handleBlur = () => {
    if (localValue !== value && onBlur) {
      onBlur(localValue)
    }
  }

  return (
    <TextInput
      {...props}
      value={localValue}
      onChange={(e) => setLocalValue(e.currentTarget.value)}
      onBlur={handleBlur}
    />
  )
}

function buildGeneratedSubstrateName(
  index: number,
  experiment: Experiment,
  generatorConfig: SubstrateGeneratorConfig,
) {
  const parts: string[] = [generatorConfig.namePrefix || "sample"]
  if (generatorConfig.includeDate && experiment.date) {
    parts.push(experiment.date)
  }
  if (generatorConfig.includeExperimentName && experiment.name) {
    parts.push(experiment.name.replace(/\s+/g, "_"))
  }
  return `${parts.join("_")}_${index}`
}

function alphabeticSuffix(index: number): string {
  let n = index
  let suffix = ""
  do {
    suffix = String.fromCharCode(65 + (n % 26)) + suffix
    n = Math.floor(n / 26) - 1
  } while (n >= 0)
  return suffix
}

function buildStepBaseLabel(
  step: ProcessStep,
  materialNameById: Map<string, string>,
  solutionNameById: Map<string, string>,
): string {
  const depositionMethod = step.depositionMethod?.value?.trim() || "Deposition"
  const materialName = step.materialId
    ? materialNameById.get(step.materialId)
    : undefined
  const solutionName = step.solutionId
    ? solutionNameById.get(step.solutionId)
    : undefined
  const targetName = materialName || solutionName || step.name || "Material"
  return `${depositionMethod}: ${targetName}`
}

function buildStageStepOptions(
  alternatives: ProcessStep[],
  materialNameById: Map<string, string>,
  solutionNameById: Map<string, string>,
) {
  const options = alternatives.map((step) => ({
    value: step.id,
    label: buildStepBaseLabel(step, materialNameById, solutionNameById),
  }))

  const totalByLabel = new Map<string, number>()
  for (const option of options) {
    totalByLabel.set(option.label, (totalByLabel.get(option.label) ?? 0) + 1)
  }

  const seenByLabel = new Map<string, number>()
  const deduped = options.map((option) => {
    const total = totalByLabel.get(option.label) ?? 0
    if (total <= 1) {
      return option
    }
    const seen = seenByLabel.get(option.label) ?? 0
    seenByLabel.set(option.label, seen + 1)
    return { ...option, label: `${option.label} (${alphabeticSuffix(seen)})` }
  })

  return [...deduped, { value: "SKIP", label: "Skip step" }]
}

// ─────────────────────────────────────────────────────────────────────────────
// Edit SubstrateName Generator (simplified display above table)
// ─────────────────────────────────────────────────────────────────────────────

const SubstrateNameGenerator = React.memo(function SubstrateNameGenerator({
  process,
  substrateMaterialOptions,
  materialNameById,
  solutionNameById,
  generatorConfig,
  onChangeGeneratorConfig,
  nextStepDefaults,
  onChangeNextStepDefault,
  onAddSubstratesForMaterial,
}: {
  process: Process
  substrateMaterialOptions: SubstrateMaterialOption[]
  materialNameById: Map<string, string>
  solutionNameById: Map<string, string>
  generatorConfig: SubstrateGeneratorConfig
  onChangeGeneratorConfig: (patch: Partial<SubstrateGeneratorConfig>) => void
  nextStepDefaults: Record<number, string>
  onChangeNextStepDefault: (stageIndex: number, value: string) => void
  onAddSubstratesForMaterial: (materialId: string) => void
}) {
  return (
    <Paper
      withBorder
      p="md"
      radius="md"
      mb="md"
      style={{ background: "var(--mantine-color-blue-0)" }}
    >
      <Text size="sm" fw={600} mb="xs">
        Sample Information
      </Text>
      <Group gap="sm" align="flex-end" wrap="nowrap">
        <TextInput
          label="Name Prefix"
          placeholder="e.g. sample"
          size="sm"
          value={generatorConfig.namePrefix}
          onChange={(e) =>
            onChangeGeneratorConfig({ namePrefix: e.currentTarget.value })
          }
          style={{ flex: 1, minWidth: 180 }}
        />
        <Checkbox
          label="Include Date"
          checked={generatorConfig.includeDate}
          onChange={(e) =>
            onChangeGeneratorConfig({ includeDate: e.currentTarget.checked })
          }
        />
        <Checkbox
          label="Include Experiment Name"
          checked={generatorConfig.includeExperimentName}
          onChange={(e) =>
            onChangeGeneratorConfig({
              includeExperimentName: e.currentTarget.checked,
            })
          }
        />
        <NumberInput
          label="How Many"
          size="sm"
          min={1}
          max={200}
          value={generatorConfig.addCount}
          onChange={(v) =>
            onChangeGeneratorConfig({ addCount: Number(v) || 1 })
          }
          style={{ width: 120 }}
        />
      </Group>

      <Divider my="sm" />

      <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb="xs">
        Default Values For Next Added Samples
      </Text>
      <Group gap="sm" align="flex-end" wrap="wrap">
        {process.stages.map((stage, idx) => (
          <Select
            key={`default-stage-${idx}`}
            size="xs"
            label={`#${idx + 1} Step`}
            w={210}
            value={nextStepDefaults[idx] ?? stage.alternatives[0]?.id ?? "SKIP"}
            onChange={(value) =>
              onChangeNextStepDefault(
                idx,
                value ?? stage.alternatives[0]?.id ?? "SKIP",
              )
            }
            data={buildStageStepOptions(
              stage.alternatives,
              materialNameById,
              solutionNameById,
            )}
          />
        ))}
      </Group>

      <Group justify="center" mt="sm" gap="sm" wrap="wrap">
        {substrateMaterialOptions.map((option) => (
          <Button
            key={`add-substrate-${option.value}`}
            size="md"
            variant="filled"
            leftSection={<IconPlus size={16} />}
            onClick={() => onAddSubstratesForMaterial(option.value)}
          >
            {`Add Samples: ${option.label}`}
          </Button>
        ))}
      </Group>
      {substrateMaterialOptions.length === 0 && (
        <Alert
          color="yellow"
          mt="sm"
          title="No substrate materials in selected process"
        >
          Add substrate materials in the process first.
        </Alert>
      )}
    </Paper>
  )
})

// ─────────────────────────────────────────────────────────────────────────────
// Recipe Selection Modal
// ─────────────────────────────────────────────────────────────────────────────

function RecipeSelectionModal({
  isOpen,
  processes,
  onSelect,
  onClose,
}: {
  isOpen: boolean
  processes: Process[]
  onSelect: (processId: string) => void
  onClose: () => void
}) {
  const [selectedProcessId, setSelectedProcessId] = useState<string | null>(
    null,
  )

  const handleConfirm = () => {
    if (selectedProcessId) {
      onSelect(selectedProcessId)
      onClose()
      setSelectedProcessId(null)
    }
  }

  return (
    <Modal
      opened={isOpen}
      onClose={onClose}
      title="Select Process (Recipe) for Experiment"
      size="md"
    >
      <Stack gap="md">
        <Text size="sm" c="dimmed">
          Choose which recipe/process this experiment will follow. You can
          change this later.
        </Text>

        {processes.length === 0 ? (
          <Alert
            icon={<IconInfoCircle size={16} />}
            title="No Processes Available"
            color="yellow"
          >
            Please create a process first before creating an experiment.
          </Alert>
        ) : (
          <Select
            label="Process"
            placeholder="Select a process..."
            searchable
            data={processes.map((p) => ({
              value: p.id,
              label: p.name,
            }))}
            value={selectedProcessId}
            onChange={setSelectedProcessId}
            size="sm"
          />
        )}

        <Group justify="flex-end" gap="sm">
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            onClick={handleConfirm}
            disabled={!selectedProcessId || processes.length === 0}
          >
            Confirm
          </Button>
        </Group>
      </Stack>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Process Step Selection Dropdown (for each cell in grid)
// ─────────────────────────────────────────────────────────────────────────────

function ProcessStepSelector({
  alternatives,
  materialNameById,
  solutionNameById,
  selectedStepId,
  defaultStepId,
  onSelect,
}: {
  alternatives: ProcessStep[]
  materialNameById: Map<string, string>
  solutionNameById: Map<string, string>
  selectedStepId: string | undefined | null
  defaultStepId: string | null
  onSelect: (stepId: string | null) => void
}) {
  const data = buildStageStepOptions(
    alternatives,
    materialNameById,
    solutionNameById,
  ).map((option) =>
    option.value === "SKIP" ? { ...option, label: "Skip this step" } : option,
  )

  const handleChange = (value: string | null) => {
    if (value === "SKIP") {
      onSelect(null)
    } else {
      onSelect(value)
    }
  }

  return (
    <Select
      placeholder="Select step..."
      data={data}
      value={selectedStepId ?? defaultStepId ?? "SKIP"}
      onChange={handleChange}
      size="xs"
      maxDropdownHeight={200}
    />
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Experiment Grid View
// ─────────────────────────────────────────────────────────────────────────────

function ExperimentGrid({
  experiment,
  process,
  substrateMaterialOptions,
  materialNameById,
  solutionNameById,
  generatorConfig,
  nextStepDefaults,
  onUpdate,
  onUpdateProcess,
}: {
  experiment: Experiment
  process: Process
  substrateMaterialOptions: SubstrateMaterialOption[]
  materialNameById: Map<string, string>
  solutionNameById: Map<string, string>
  generatorConfig: SubstrateGeneratorConfig
  nextStepDefaults: Record<number, string>
  onUpdate: (exp: Experiment) => void
  onUpdateProcess: (process: Process) => void
}) {
  const [variationTarget, setVariationTarget] = useState<string | null>(null)
  const [variationParam, setVariationParam] = useState<string | null>(null)
  const [selectedSubstrateIds, setSelectedSubstrateIds] = useState<Set<string>>(
    new Set(),
  )
  const nameInputRefs = React.useRef<Array<HTMLInputElement | null>>([])

  const stepDisplayById = React.useMemo(() => {
    const map = new Map<string, string>()
    process.stages.forEach((stage) => {
      const options = buildStageStepOptions(
        stage.alternatives,
        materialNameById,
        solutionNameById,
      )
      for (const option of options) {
        if (option.value !== "SKIP") {
          map.set(option.value, option.label)
        }
      }
    })
    return map
  }, [materialNameById, process.stages, solutionNameById])

  React.useEffect(() => {
    const validIds = new Set(
      experiment.substrates.map((substrate) => substrate.id),
    )
    setSelectedSubstrateIds((prev) => {
      let changed = false
      const next = new Set<string>()
      for (const id of prev) {
        if (validIds.has(id)) {
          next.add(id)
        } else {
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [experiment.substrates])

  const variationColumns = React.useMemo(() => {
    const columns = new Map<
      string,
      {
        stageIndex: number
        stepId: string
        stepLabel: string
        paramKey: ProcessParameterKey
        label: string
      }
    >()

    for (const substrate of experiment.substrates) {
      const values = substrate.parameterValues ?? {}
      for (const key of Object.keys(values)) {
        if (key.startsWith("stageSelection:")) {
          continue
        }

        const [stepId, rawParamKey] = key.split(":")
        if (!stepId || !rawParamKey) {
          continue
        }

        const paramDef = PROCESS_PARAMETER_DEFINITIONS.find(
          (def) => def.key === rawParamKey,
        )
        if (!paramDef) {
          continue
        }

        let match:
          | {
              stageIndex: number
            }
          | undefined

        for (
          let stageIdx = 0;
          stageIdx < process.stages.length;
          stageIdx += 1
        ) {
          const stage = process.stages[stageIdx]
          const step = stage.alternatives.find(
            (candidate) => candidate.id === stepId,
          )
          if (step) {
            match = {
              stageIndex: stageIdx,
            }
            break
          }
        }

        if (!match) {
          continue
        }

        const columnKey = `${stepId}:${paramDef.key}`
        if (!columns.has(columnKey)) {
          const stepLabel =
            stepDisplayById.get(stepId) ?? "Deposition: Material"
          columns.set(columnKey, {
            stageIndex: match.stageIndex,
            stepId,
            stepLabel,
            paramKey: paramDef.key,
            label: `#${match.stageIndex + 1} Step - ${stepLabel} - ${paramDef.label}`,
          })
        }
      }
    }

    return Array.from(columns.values()).sort((a, b) => {
      if (a.stageIndex !== b.stageIndex) {
        return a.stageIndex - b.stageIndex
      }
      if (a.stepLabel !== b.stepLabel) {
        return a.stepLabel.localeCompare(b.stepLabel)
      }
      return a.paramKey.localeCompare(b.paramKey)
    })
  }, [experiment.substrates, process.stages, stepDisplayById])

  const selectedVariationStep = React.useMemo(() => {
    if (!variationTarget) {
      return null
    }
    const [stageIndexRaw, stepId] = variationTarget.split(":")
    const stageIndex = Number(stageIndexRaw)
    if (!Number.isFinite(stageIndex)) {
      return null
    }
    return (
      process.stages[stageIndex]?.alternatives.find(
        (step) => step.id === stepId,
      ) ?? null
    )
  }, [process.stages, variationTarget])

  const variationParamOptions = React.useMemo(() => {
    if (!selectedVariationStep) {
      return []
    }
    return PROCESS_PARAMETER_DEFINITIONS.filter(({ key }) => {
      if (
        key === "depositionMethod" ||
        key === "depositionStartTime" ||
        key === "annealingStartTime"
      ) {
        return false
      }
      const param = selectedVariationStep[key as ProcessParameterKey]
      return !!param?.value?.trim()
    }).map(({ key, label }) => ({ value: key, label }))
  }, [selectedVariationStep])

  const getStageSelection = (
    substrateId: string,
    stageIndex: number,
  ): string | null => {
    const substrate = experiment.substrates.find((s) => s.id === substrateId)
    const stored = substrate?.parameterValues?.[`stageSelection:${stageIndex}`]
    if (stored) {
      return stored
    }
    return process.stages[stageIndex]?.alternatives[0]?.id ?? null
  }

  const handleStepSelect = (
    substrateId: string,
    stageIndex: number,
    stepId: string | null,
  ) => {
    const newSubstrates = experiment.substrates.map((substrate) => {
      if (substrate.id !== substrateId) return substrate
      return {
        ...substrate,
        parameterValues: {
          ...(substrate.parameterValues ?? {}),
          [`stageSelection:${stageIndex}`]: stepId ?? "SKIP",
        },
      }
    })
    onUpdate({ ...experiment, substrates: newSubstrates })
  }

  const handleRemoveSubstrate = (substrateId: string) => {
    const newSubstrates = experiment.substrates.filter(
      (s) => s.id !== substrateId,
    )
    setSelectedSubstrateIds((prev) => {
      const next = new Set(prev)
      next.delete(substrateId)
      return next
    })
    onUpdate({
      ...experiment,
      numSubstrates: newSubstrates.length,
      substrates: newSubstrates,
    })
  }

  const handleToggleSubstrateSelection = (
    substrateId: string,
    checked: boolean,
  ) => {
    setSelectedSubstrateIds((prev) => {
      const next = new Set(prev)
      if (checked) {
        next.add(substrateId)
      } else {
        next.delete(substrateId)
      }
      return next
    })
  }

  const handleSelectAllSubstrates = () => {
    setSelectedSubstrateIds(
      new Set(experiment.substrates.map((substrate) => substrate.id)),
    )
  }

  const handleSelectNoSubstrates = () => {
    setSelectedSubstrateIds(new Set())
  }

  const handleDeleteSelectedSubstrates = () => {
    if (selectedSubstrateIds.size === 0) {
      return
    }
    modals.openConfirmModal({
      title: "Delete selected substrates?",
      children: (
        <Text size="sm">
          Remove {selectedSubstrateIds.size} selected substrate
          {selectedSubstrateIds.size !== 1 ? "s" : ""} from this experiment?
        </Text>
      ),
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => {
        const newSubstrates = experiment.substrates.filter(
          (substrate) => !selectedSubstrateIds.has(substrate.id),
        )
        setSelectedSubstrateIds(new Set())
        onUpdate({
          ...experiment,
          numSubstrates: newSubstrates.length,
          substrates: newSubstrates,
        })
      },
    })
  }

  const buildDefaultStageValues = () => {
    const values: Record<string, string> = {}
    process.stages.forEach((stage, idx) => {
      values[`stageSelection:${idx}`] =
        nextStepDefaults[idx] ?? stage.alternatives[0]?.id ?? "SKIP"
    })
    return values
  }

  const focusNameInput = (index: number) => {
    const nextInput = nameInputRefs.current[index]
    if (!nextInput) return
    requestAnimationFrame(() => {
      nextInput.focus()
      nextInput.select()
    })
  }

  const handleSubstrateNameChange = useCallback(
    (substrateId: string, name: string) => {
      onUpdate({
        ...experiment,
        substrates: experiment.substrates.map((substrate) =>
          substrate.id === substrateId ? { ...substrate, name } : substrate,
        ),
      })
    },
    [experiment, onUpdate],
  )

  const handleSubstrateMaterialChange = useCallback(
    (substrateId: string, materialId: string | null) => {
      onUpdate({
        ...experiment,
        substrates: experiment.substrates.map((substrate) =>
          substrate.id === substrateId
            ? { ...substrate, substrateMaterialId: materialId ?? undefined }
            : substrate,
        ),
      })
    },
    [experiment, onUpdate],
  )

  const handleDuplicateSubstrate = (substrateId: string) => {
    const source = experiment.substrates.find(
      (substrate) => substrate.id === substrateId,
    )
    if (!source) return
    const duplicateIndex = experiment.substrates.length + 1
    const duplicate = {
      ...source,
      id: crypto.randomUUID(),
      name: buildGeneratedSubstrateName(
        duplicateIndex,
        experiment,
        generatorConfig,
      ),
      parameterValues: {
        ...buildDefaultStageValues(),
        ...(source.parameterValues ?? {}),
      },
    }
    const newSubstrates = [...experiment.substrates, duplicate]
    onUpdate({
      ...experiment,
      numSubstrates: newSubstrates.length,
      substrates: newSubstrates,
    })
  }

  const handleAddVariation = () => {
    if (!variationTarget || !variationParam) return
    const [stageIndexRaw, stepId] = variationTarget.split(":")
    const stageIndex = Number(stageIndexRaw)
    const paramKey = variationParam as ProcessParameterKey
    const targetStep = process.stages[stageIndex]?.alternatives.find(
      (step) => step.id === stepId,
    )
    if (!targetStep) return

    const baseValue = targetStep[paramKey]?.value ?? ""
    const variationKey = `${stepId}:${paramKey}`
    const hasVariationColumn = variationColumns.some(
      (column) => column.stepId === stepId && column.paramKey === paramKey,
    )

    const updatedProcess: Process = {
      ...process,
      stages: process.stages.map((stage, idx) =>
        idx !== stageIndex
          ? stage
          : {
              ...stage,
              alternatives: stage.alternatives.map((step) =>
                step.id !== stepId
                  ? step
                  : {
                      ...step,
                      [paramKey]: {
                        ...(step[paramKey] ?? {
                          value: baseValue,
                          mode: "variation",
                        }),
                        value: step[paramKey]?.value ?? baseValue,
                        mode: "variation",
                      },
                    },
              ),
            },
      ),
    }

    const updatedExperiment: Experiment = {
      ...experiment,
      substrates: experiment.substrates.map((substrate) => ({
        ...substrate,
        parameterValues: {
          ...(substrate.parameterValues ?? {}),
          ...(hasVariationColumn
            ? {}
            : {
                [variationKey]:
                  substrate.parameterValues?.[variationKey] ?? baseValue,
              }),
        },
      })),
    }

    onUpdateProcess(updatedProcess)
    onUpdate(updatedExperiment)
    setVariationTarget(null)
    setVariationParam(null)
  }

  const removeVariationColumn = (column: (typeof variationColumns)[number]) => {
    const key = `${column.stepId}:${column.paramKey}`
    const targetStep = process.stages[column.stageIndex]?.alternatives.find(
      (step) => step.id === column.stepId,
    )
    const defaultValue = targetStep?.[column.paramKey]?.value ?? ""
    const hasChangedDefaultValues = experiment.substrates.some(
      (substrate) =>
        (substrate.parameterValues?.[key] ?? defaultValue) !== defaultValue,
    )

    const applyRemoval = () => {
      const updatedExperiment: Experiment = {
        ...experiment,
        substrates: experiment.substrates.map((substrate) => {
          const values = { ...(substrate.parameterValues ?? {}) }
          delete values[key]
          return { ...substrate, parameterValues: values }
        }),
      }

      const updatedProcess: Process = {
        ...process,
        stages: process.stages.map((stage, idx) =>
          idx !== column.stageIndex
            ? stage
            : {
                ...stage,
                alternatives: stage.alternatives.map((step) =>
                  step.id !== column.stepId
                    ? step
                    : {
                        ...step,
                        [column.paramKey]: step[column.paramKey]
                          ? { ...step[column.paramKey]!, mode: "constant" }
                          : step[column.paramKey],
                      },
                ),
              },
        ),
      }

      onUpdateProcess(updatedProcess)
      onUpdate(updatedExperiment)
    }

    if (hasChangedDefaultValues) {
      modals.openConfirmModal({
        title: "Delete parameter variation?",
        children: (
          <Text size="sm">
            Some variation values differ from the default process value. Delete
            this variation column and discard those changes?
          </Text>
        ),
        labels: { confirm: "Delete", cancel: "Cancel" },
        confirmProps: { color: "red" },
        onConfirm: applyRemoval,
      })
      return
    }

    applyRemoval()
  }

  const handleProcessingTimeChange = useCallback(
    (stageKey: string, value: string) => {
      onUpdate({
        ...experiment,
        processingTimes: {
          ...(experiment.processingTimes ?? {}),
          [stageKey]: value,
        },
      })
    },
    [experiment, onUpdate],
  )

  const handleVariationValueChange = useCallback(
    (
      substrateId: string,
      stepId: string,
      paramKey: ProcessParameterKey,
      value: string,
    ) => {
      const key = `${stepId}:${paramKey}`
      onUpdate({
        ...experiment,
        substrates: experiment.substrates.map((substrate) =>
          substrate.id !== substrateId
            ? substrate
            : {
                ...substrate,
                parameterValues: {
                  ...(substrate.parameterValues ?? {}),
                  [key]: value,
                },
              },
        ),
      })
    },
    [experiment, onUpdate],
  )

  const isVariationCellEditable = (
    substrateId: string,
    stageIndex: number,
    stepId: string,
  ) => {
    const selectedStepId = getStageSelection(substrateId, stageIndex)
    return selectedStepId === stepId
  }

  const allSelected =
    experiment.substrates.length > 0 &&
    experiment.substrates.every((substrate) =>
      selectedSubstrateIds.has(substrate.id),
    )
  const partiallySelected = selectedSubstrateIds.size > 0 && !allSelected

  return (
    <>
      {experiment.substrates.length > 0 && (
        <Group align="flex-start" wrap="nowrap" gap="md" mb="lg">
          <Box style={{ overflowX: "auto", flex: 1 }}>
            <Group justify="space-between" mb="xs">
              <Group gap="xs">
                <Button
                  size="xs"
                  variant="light"
                  onClick={handleSelectAllSubstrates}
                >
                  Select All
                </Button>
                <Button
                  size="xs"
                  variant="default"
                  onClick={handleSelectNoSubstrates}
                >
                  Select None
                </Button>
              </Group>
              <Group gap="xs">
                <Text size="xs" c="dimmed">
                  {selectedSubstrateIds.size} selected
                </Text>
                <Button
                  size="xs"
                  color="red"
                  variant="light"
                  disabled={selectedSubstrateIds.size === 0}
                  onClick={handleDeleteSelectedSubstrates}
                >
                  Delete Selected
                </Button>
              </Group>
            </Group>
            <table
              style={{
                borderCollapse: "collapse",
                width: "100%",
                fontSize: "14px",
              }}
            >
              <thead>
                <tr style={{ background: "var(--mantine-color-gray-1)" }}>
                  <th
                    style={{
                      padding: "12px 8px",
                      textAlign: "center",
                      fontWeight: 600,
                      borderBottom: "2px solid var(--mantine-color-gray-3)",
                      minWidth: "46px",
                    }}
                  >
                    <Checkbox
                      checked={allSelected}
                      indeterminate={partiallySelected}
                      onChange={(e) => {
                        if (e.currentTarget.checked) {
                          handleSelectAllSubstrates()
                        } else {
                          handleSelectNoSubstrates()
                        }
                      }}
                      aria-label="Select all substrates"
                    />
                  </th>
                  <th
                    style={{
                      padding: "12px 8px",
                      textAlign: "left",
                      fontWeight: 600,
                      borderBottom: "2px solid var(--mantine-color-gray-3)",
                      minWidth: "150px",
                    }}
                  >
                    Substrate
                  </th>
                  <th
                    style={{
                      padding: "12px 8px",
                      textAlign: "left",
                      fontWeight: 600,
                      borderBottom: "2px solid var(--mantine-color-gray-3)",
                      minWidth: "170px",
                    }}
                  >
                    Material
                  </th>
                  {process.stages.map((stage, idx) => {
                    return (
                      <th
                        key={`stage-${idx}`}
                        style={{
                          padding: "12px 8px",
                          textAlign: "left",
                          fontWeight: 600,
                          borderBottom: "2px solid var(--mantine-color-gray-3)",
                          minWidth: "180px",
                        }}
                      >
                        <Group justify="space-between" gap="xs">
                          <Text size="sm">#{idx + 1} Step</Text>
                          {stage.alternatives.length > 1 && (
                            <Badge size="xs" variant="light" color="orange">
                              {stage.alternatives.length} options
                            </Badge>
                          )}
                        </Group>
                      </th>
                    )
                  })}
                  {variationColumns.map((column) => (
                    <th
                      key={`variation-col-${column.stepId}-${column.paramKey}`}
                      style={{
                        padding: "12px 8px",
                        textAlign: "left",
                        fontWeight: 600,
                        borderBottom: "2px solid var(--mantine-color-gray-3)",
                        minWidth: "190px",
                      }}
                    >
                      <Group justify="space-between" gap="xs" wrap="nowrap">
                        <Text size="sm">{column.label}</Text>
                        <Tooltip label="Delete variation column">
                          <ActionIcon
                            size="xs"
                            variant="subtle"
                            color="red"
                            onClick={() => removeVariationColumn(column)}
                          >
                            <IconTrash size={12} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </th>
                  ))}
                  <th
                    style={{
                      padding: "12px 8px",
                      textAlign: "center",
                      fontWeight: 600,
                      borderBottom: "2px solid var(--mantine-color-gray-3)",
                      minWidth: "80px",
                    }}
                  >
                    Action
                  </th>
                </tr>
              </thead>
              <tbody>
                {experiment.substrates.map((substrate) => (
                  <tr
                    key={substrate.id}
                    style={{
                      borderBottom: "1px solid var(--mantine-color-gray-2)",
                    }}
                  >
                    <td
                      style={{
                        padding: "8px 8px",
                        textAlign: "center",
                        background: "var(--mantine-color-gray-0)",
                      }}
                    >
                      <Checkbox
                        checked={selectedSubstrateIds.has(substrate.id)}
                        onChange={(e) =>
                          handleToggleSubstrateSelection(
                            substrate.id,
                            e.currentTarget.checked,
                          )
                        }
                        aria-label={`Select substrate ${substrate.name}`}
                      />
                    </td>
                    <td
                      style={{
                        padding: "12px 8px",
                        fontWeight: 500,
                        background: "var(--mantine-color-gray-0)",
                      }}
                    >
                      <DeferredTextInput
                        ref={(node) => {
                          nameInputRefs.current[
                            experiment.substrates.findIndex(
                              (s) => s.id === substrate.id,
                            )
                          ] = node
                        }}
                        size="xs"
                        value={substrate.name}
                        onBlur={(value) =>
                          handleSubstrateNameChange(substrate.id, value)
                        }
                        onFocus={(e) => e.currentTarget.select()}
                        onKeyDown={(e) => {
                          const currentIndex = experiment.substrates.findIndex(
                            (s) => s.id === substrate.id,
                          )
                          if (e.key === "Enter") {
                            e.preventDefault()
                            const value = e.currentTarget.value
                            handleSubstrateNameChange(substrate.id, value)
                            focusNameInput(currentIndex + 1)
                          }
                          if (e.key === "Tab") {
                            e.preventDefault()
                            focusNameInput(
                              e.shiftKey ? currentIndex - 1 : currentIndex + 1,
                            )
                          }
                        }}
                        styles={{ input: { fontWeight: 500 } }}
                      />
                    </td>

                    <td
                      style={{
                        padding: "8px 4px",
                        background: "var(--mantine-color-gray-0)",
                      }}
                    >
                      <Select
                        size="xs"
                        placeholder="Select material"
                        data={substrateMaterialOptions}
                        value={substrate.substrateMaterialId ?? null}
                        onChange={(value) =>
                          handleSubstrateMaterialChange(substrate.id, value)
                        }
                      />
                    </td>

                    {process.stages.map((stage, stageIdx) => (
                      <td
                        key={`${substrate.id}-stage-${stageIdx}`}
                        style={{
                          padding: "8px 4px",
                        }}
                      >
                        <ProcessStepSelector
                          alternatives={stage.alternatives}
                          materialNameById={materialNameById}
                          solutionNameById={solutionNameById}
                          defaultStepId={stage.alternatives[0]?.id ?? null}
                          selectedStepId={getStageSelection(
                            substrate.id,
                            stageIdx,
                          )}
                          onSelect={(stepId) =>
                            handleStepSelect(substrate.id, stageIdx, stepId)
                          }
                        />
                      </td>
                    ))}

                    {variationColumns.map((column) => {
                      const key = `${column.stepId}:${column.paramKey}`
                      const editable = isVariationCellEditable(
                        substrate.id,
                        column.stageIndex,
                        column.stepId,
                      )
                      return (
                        <td
                          key={`${substrate.id}-${key}`}
                          style={{
                            padding: "8px 4px",
                          }}
                        >
                          <DeferredTextInput
                            size="xs"
                            value={substrate.parameterValues?.[key] ?? ""}
                            disabled={!editable}
                            styles={
                              !editable
                                ? { input: { opacity: 0.55 } }
                                : undefined
                            }
                            onBlur={(value) =>
                              handleVariationValueChange(
                                substrate.id,
                                column.stepId,
                                column.paramKey,
                                value,
                              )
                            }
                          />
                        </td>
                      )
                    })}

                    <td
                      style={{
                        padding: "8px 4px",
                        textAlign: "center",
                      }}
                    >
                      <Group justify="center" gap={2} wrap="nowrap">
                        <Tooltip label="Duplicate substrate">
                          <ActionIcon
                            size="sm"
                            variant="subtle"
                            color="teal"
                            onClick={() =>
                              handleDuplicateSubstrate(substrate.id)
                            }
                          >
                            <IconCopy size={14} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Remove substrate">
                          <ActionIcon
                            size="sm"
                            variant="subtle"
                            color="red"
                            onClick={() => handleRemoveSubstrate(substrate.id)}
                          >
                            <IconTrash size={14} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </td>
                  </tr>
                ))}

                <tr style={{ background: "var(--mantine-color-gray-0)" }}>
                  <td
                    style={{
                      borderTop: "2px solid var(--mantine-color-gray-2)",
                    }}
                  />
                  <td
                    style={{
                      padding: "10px 8px",
                      fontWeight: 600,
                      borderTop: "2px solid var(--mantine-color-gray-2)",
                    }}
                  >
                    Processing Times
                  </td>
                  <td
                    style={{
                      borderTop: "2px solid var(--mantine-color-gray-2)",
                    }}
                  />
                  {process.stages.map((stage, idx) => {
                    const processingKey = `stage:${idx}`
                    return (
                      <td
                        key={`processing-time-${stage.index}-${idx}`}
                        style={{
                          padding: "8px 4px",
                          borderTop: "2px solid var(--mantine-color-gray-2)",
                        }}
                      >
                        <DeferredTextInput
                          size="xs"
                          type="datetime-local"
                          value={
                            experiment.processingTimes?.[processingKey] ?? ""
                          }
                          onBlur={(value) =>
                            handleProcessingTimeChange(processingKey, value)
                          }
                        />
                      </td>
                    )
                  })}
                  {variationColumns.map((column) => (
                    <td
                      key={`processing-variation-${column.stepId}-${column.paramKey}`}
                      style={{
                        borderTop: "2px solid var(--mantine-color-gray-2)",
                      }}
                    />
                  ))}
                  <td
                    style={{
                      borderTop: "2px solid var(--mantine-color-gray-2)",
                    }}
                  />
                </tr>
              </tbody>
            </table>
          </Box>

          <Paper
            withBorder
            p="md"
            radius="md"
            style={{ width: 320, background: "var(--mantine-color-blue-0)" }}
          >
            <Text size="sm" fw={600} mb="xs">
              Add Parameter Variation
            </Text>
            <Text size="xs" c="dimmed" mb="sm">
              Create variation columns for selected process steps.
            </Text>
            <Stack gap="sm">
              <Select
                placeholder="Select step..."
                searchable
                value={variationTarget}
                onChange={setVariationTarget}
                data={process.stages.flatMap((stage, idx) =>
                  buildStageStepOptions(
                    stage.alternatives,
                    materialNameById,
                    solutionNameById,
                  )
                    .filter((option) => option.value !== "SKIP")
                    .map((option) => ({
                      value: `${idx}:${option.value}`,
                      label: `#${idx + 1} Step - ${option.label}`,
                    })),
                )}
                size="sm"
              />
              <Select
                placeholder="Select parameter..."
                value={variationParam}
                onChange={setVariationParam}
                data={variationParamOptions}
                size="sm"
              />
              <Button
                size="sm"
                disabled={!variationTarget || !variationParam}
                onClick={handleAddVariation}
              >
                Add Variation
              </Button>
            </Stack>
          </Paper>
        </Group>
      )}

      {experiment.substrates.length === 0 && (
        <Text size="sm" c="dimmed" ta="center" py="md">
          No substrates added yet. Use the substrate buttons above to get
          started.
        </Text>
      )}
    </>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Experiments Page
// ─────────────────────────────────────────────────────────────────────────────

export default function ExperimentsPage() {
  const {
    experiments,
    setExperiments,
    materials,
    solutions,
    processes,
    setProcesses,
    activeEntity,
    setActiveEntity,
    lastSelectedByKind,
    updateLastSelected,
    planes,
    updateElement,
    removeCollectionRefs,
    activeCollectionId,
    activePlaneId,
    pendingCollectionLink,
    setPendingCollectionLink,
  } = useAppContext()
  const { getEntityColor, isEntityVisible } = useEntityCollection()

  const [selectedExpId, setSelectedExpId] = useState<string | null>(
    () => lastSelectedByKind.experiment ?? null,
  )
  const [recipeModalOpen, setRecipeModalOpen] = useState(false)
  const [collectionModalOpen, setCollectionModalOpen] = useState(false)
  const [newExperimentProcessId, setNewExperimentProcessId] = useState<
    string | null
  >(null)
  const [generatorConfig, setGeneratorConfig] =
    useState<SubstrateGeneratorConfig>({
      namePrefix: "substrate",
      includeDate: false,
      includeExperimentName: false,
      addCount: 5,
    })
  const [nextStepDefaults, setNextStepDefaults] = useState<
    Record<number, string>
  >({})

  // Track processed pending request IDs to avoid double-firing
  const processedPendingRequestIdsRef = useRef(new Set<string>())

  // Auto-create experiment + link to collection when navigated from action bubble
  React.useEffect(() => {
    if (!pendingCollectionLink || pendingCollectionLink.kind !== "experiment") {
      return
    }
    if (
      processedPendingRequestIdsRef.current.has(pendingCollectionLink.requestId)
    ) {
      return
    }
    processedPendingRequestIdsRef.current.add(pendingCollectionLink.requestId)

    const { collectionId, planeId, selectedProcessId } = pendingCollectionLink
    setPendingCollectionLink(null)

    // Need at least one process to create an experiment
    const processId = selectedProcessId || processes[0]?.id
    if (!processId) return

    const newExp = newExperiment(processId)
    setExperiments((prev) => [...prev, newExp])
    setSelectedExpId(newExp.id)

    // Link back to collection
    const plane = planes.find((p) => p.id === planeId)
    if (plane) {
      const col = plane.elements.find((e) => e.id === collectionId)
      if (col && col.type === "collection") {
        updateElement(planeId, {
          ...col,
          refs: [...col.refs, { kind: "experiment" as const, id: newExp.id }],
        })
      }
    }
  }, [
    pendingCollectionLink,
    setPendingCollectionLink,
    processes,
    setExperiments,
    planes,
    updateElement,
  ])

  const selectedExperiment = experiments.find((e) => e.id === selectedExpId)
  const selectedProcess =
    selectedExperiment &&
    processes.find((p) => p.id === selectedExperiment.processId)
  const materialNameById = React.useMemo(
    () =>
      new Map(
        materials.map((material) => [
          material.id,
          material.name ||
            material.inventoryLabel ||
            material.casNumber ||
            material.id,
        ]),
      ),
    [materials],
  )
  const solutionNameById = React.useMemo(
    () =>
      new Map(
        solutions.map((solution) => [
          solution.id,
          solution.name || solution.id,
        ]),
      ),
    [solutions],
  )
  const substrateMaterialOptions = React.useMemo(() => {
    if (!selectedProcess) {
      return []
    }
    const ids = selectedProcess.substrateIds ?? []
    return ids.map((id) => {
      const material = materials.find((m: Material) => m.id === id)
      return {
        value: id,
        label:
          material?.name ||
          material?.inventoryLabel ||
          material?.casNumber ||
          "Unnamed substrate",
        heightMm: material?.heightMm ?? "",
      }
    })
  }, [materials, selectedProcess])

  React.useEffect(() => {
    if (processes.length === 0) {
      setNewExperimentProcessId(null)
      return
    }
    if (
      !newExperimentProcessId ||
      !processes.some((process) => process.id === newExperimentProcessId)
    ) {
      setNewExperimentProcessId(processes[0].id)
    }
  }, [newExperimentProcessId, processes])

  // Keep a ref so effect 3 can guard against deleted experiments without
  // taking experiments as a reactive dependency (which would cause it to fire
  // in the same batch as setSelectedExpId, creating an infinite loop with
  // effect 4).
  const experimentsRef = useRef(experiments)
  experimentsRef.current = experiments

  React.useEffect(() => {
    if (activeEntity?.kind !== "experiment") {
      return
    }
    if (!experimentsRef.current.some((e) => e.id === activeEntity.id)) {
      return
    }
    setSelectedExpId(activeEntity.id)
  }, [activeEntity])

  React.useEffect(() => {
    if (!selectedExpId) {
      return
    }
    setActiveEntity({ kind: "experiment", id: selectedExpId })
    updateLastSelected("experiment", selectedExpId)
  }, [selectedExpId, setActiveEntity, updateLastSelected])

  // Create new experiment
  const doAddExperiment = ({
    planeId,
    collection,
  }: CollectionConfirmParams) => {
    if (!newExperimentProcessId) return
    const newExp = newExperiment(newExperimentProcessId)
    setExperiments((prev) => [...prev, newExp])
    setSelectedExpId(newExp.id)
    updateElement(planeId, {
      ...collection,
      refs: [
        ...collection.refs,
        { kind: "experiment" as const, id: newExp.id },
      ],
    })
  }

  const handleNewExperiment = () => {
    if (!newExperimentProcessId) return
    if (activeCollectionId && activePlaneId) {
      const plane = planes.find((p) => p.id === activePlaneId)
      const col = plane?.elements.find((e) => e.id === activeCollectionId)
      if (col && col.type === "collection") {
        doAddExperiment({
          planeId: activePlaneId,
          collectionId: activeCollectionId,
          collection: col as CanvasCollectionElement,
        })
        return
      }
    }
    setCollectionModalOpen(true)
  }

  // Select recipe after creation
  const handleRecipeSelect = (processId: string) => {
    if (!selectedExpId) return
    const exp = experiments.find((e) => e.id === selectedExpId)
    if (exp) {
      handleUpdateExperiment({
        ...exp,
        processId,
      })
    }
  }

  // Update experiment
  const handleUpdateExperiment = useCallback(
    (exp: Experiment) => {
      setExperiments((prev) => prev.map((e) => (e.id === exp.id ? exp : e)))
    },
    [setExperiments],
  )

  const handleUpdateProcess = useCallback(
    (updatedProcess: Process) => {
      setProcesses((prev) =>
        prev.map((process) =>
          process.id === updatedProcess.id ? updatedProcess : process,
        ),
      )
    },
    [setProcesses],
  )

  const handleAddSubstratesForMaterial = useCallback(
    (materialId: string) => {
      if (!selectedExperiment || !selectedProcess) {
        return
      }

      const count = Math.max(1, generatorConfig.addCount)
      const buildDefaultStageValues = () => {
        const values: Record<string, string> = {}
        selectedProcess.stages.forEach((stage, idx) => {
          const selected =
            nextStepDefaults[idx] ?? stage.alternatives[0]?.id ?? "SKIP"
          values[`stageSelection:${idx}`] = selected
        })
        return values
      }

      const newSubstrates = [
        ...selectedExperiment.substrates,
        ...Array.from({ length: count }, (_, i) => ({
          id: crypto.randomUUID(),
          name: buildGeneratedSubstrateName(
            selectedExperiment.substrates.length + i + 1,
            selectedExperiment,
            generatorConfig,
          ),
          substrateMaterialId: materialId,
          parameterValues: buildDefaultStageValues(),
        })),
      ]

      handleUpdateExperiment({
        ...selectedExperiment,
        numSubstrates: newSubstrates.length,
        substrates: newSubstrates,
      })
    },
    [
      selectedExperiment,
      selectedProcess,
      generatorConfig,
      nextStepDefaults,
      handleUpdateExperiment,
    ],
  )

  // Delete experiment
  const handleDeleteExperiment = (expId: string) => {
    modals.openConfirmModal({
      title: "Delete Experiment?",
      children: (
        <Text size="sm">
          Are you sure you want to delete this experiment? This action cannot be
          undone.
        </Text>
      ),
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => {
        setExperiments((prev) => prev.filter((e) => e.id !== expId))
        removeCollectionRefs("experiment", [expId])
        setSelectedExpId(null)
      },
    })
  }

  const handleCopyExperiment = (exp: Experiment) => {
    const copy: Experiment = {
      ...exp,
      id: crypto.randomUUID(),
      name: `${exp.name || "Experiment"} (Copy)`,
      substrates: exp.substrates.map((substrate) => ({
        ...substrate,
        id: crypto.randomUUID(),
        parameterValues: { ...(substrate.parameterValues ?? {}) },
      })),
      processingTimes: { ...(exp.processingTimes ?? {}) },
      hasResults: false,
    }
    setExperiments((prev) => [...prev, copy])
    setSelectedExpId(copy.id)
  }

  const groupedExperiments = React.useMemo(() => {
    const processNameById = new Map(processes.map((p) => [p.id, p.name]))
    const groups = new Map<string, Experiment[]>()

    // Filter to only visible experiments
    const visibleExperiments = experiments.filter((exp) =>
      isEntityVisible("experiment", exp.id),
    )

    for (const exp of visibleExperiments) {
      const key = exp.processId || "__unassigned__"
      const list = groups.get(key)
      if (list) {
        list.push(exp)
      } else {
        groups.set(key, [exp])
      }
    }

    return Array.from(groups.entries())
      .sort((a, b) => {
        const aName =
          a[0] === "__unassigned__"
            ? "Unassigned"
            : (processNameById.get(a[0]) ?? "Unknown Process")
        const bName =
          b[0] === "__unassigned__"
            ? "Unassigned"
            : (processNameById.get(b[0]) ?? "Unknown Process")
        return aName.localeCompare(bName)
      })
      .map(([processId, items]) => {
        const processName =
          processId === "__unassigned__"
            ? "Unassigned"
            : (processNameById.get(processId) ?? "Unknown Process")
        const sortedItems = [...items].sort((a, b) => {
          const byName = (a.name || "").localeCompare(b.name || "")
          if (byName !== 0) return byName
          return (a.date || "").localeCompare(b.date || "")
        })
        return { processId, processName, items: sortedItems }
      })
  }, [experiments, processes, isEntityVisible])

  return (
    <>
      <Group gap={0} align="flex-start" style={{ height: "100%" }}>
        {/* Left Sidebar - Experiment List */}
        <Box
          style={{
            width: "16%",
            minWidth: 220,
            background: "var(--mantine-color-gray-0)",
            borderRight: "1px solid var(--mantine-color-gray-2)",
            display: "flex",
            flexDirection: "column",
            height: "100%",
          }}
        >
          <Stack gap="sm" p="md" style={{ flex: 1, overflowY: "auto" }}>
            <Select
              label="Process"
              placeholder="Select process..."
              size="xs"
              searchable
              data={processes
                .filter((process) => isEntityVisible("process", process.id))
                .map((process) => ({
                  value: process.id,
                  label: process.name || "Untitled",
                }))}
              value={newExperimentProcessId}
              onChange={setNewExperimentProcessId}
            />

            <Button
              fullWidth
              leftSection={<IconPlus size={16} />}
              onClick={handleNewExperiment}
              disabled={!newExperimentProcessId || processes.length === 0}
            >
              New Experiment
            </Button>

            <Text size="xs" fw={600} c="dimmed" tt="uppercase">
              Experiments ({experiments.length})
            </Text>

            <Stack gap="xs">
              {groupedExperiments.map((group) => (
                <React.Fragment key={`process-group-${group.processId}`}>
                  <Text size="xs" fw={700} c="dimmed" tt="uppercase" mt="xs">
                    {group.processName}
                  </Text>
                  {group.items.map((exp) => {
                    const status = getExperimentStatus(exp)
                    const isSelected = exp.id === selectedExpId

                    const collectionColor = getEntityColor("experiment", exp.id)
                    return (
                      <Paper
                        key={exp.id}
                        withBorder
                        p="sm"
                        radius="md"
                        style={{
                          cursor: "pointer",
                          background: isSelected
                            ? "var(--mantine-color-blue-0)"
                            : undefined,
                          borderLeft: isSelected
                            ? "4px solid var(--mantine-color-blue-4)"
                            : collectionColor
                              ? `4px solid ${collectionColor}`
                              : undefined,
                          paddingLeft: collectionColor
                            ? "calc(var(--mantine-spacing-sm) - 3px)"
                            : undefined,
                        }}
                        onClick={() => setSelectedExpId(exp.id)}
                      >
                        <Group justify="space-between" wrap="nowrap">
                          <Box style={{ flex: 1, minWidth: 0 }}>
                            <Group gap="xs" mb={4}>
                              <Text size="sm" fw={600} truncate>
                                {exp.name || "Untitled"}
                              </Text>
                              <Badge
                                size="xs"
                                color={
                                  status === "finished"
                                    ? "green"
                                    : status === "ready"
                                      ? "yellow"
                                      : "red"
                                }
                                variant="dot"
                              >
                                {status === "finished"
                                  ? "Finished"
                                  : status === "ready"
                                    ? "Ready"
                                    : "Incomplete"}
                              </Badge>
                            </Group>
                            <Group gap="xs">
                              <Text size="xs" c="dimmed">
                                {exp.date || "No date"}
                              </Text>
                              <Text size="xs" c="dimmed">
                                •
                              </Text>
                              <Text size="xs" c="dimmed">
                                {exp.substrates.length} substrate
                                {exp.substrates.length !== 1 ? "s" : ""}
                              </Text>
                            </Group>
                          </Box>

                          <Group gap={2} wrap="nowrap">
                            <ActionIcon
                              size="sm"
                              variant="subtle"
                              color="teal"
                              onClick={(e) => {
                                e.stopPropagation()
                                handleCopyExperiment(exp)
                              }}
                            >
                              <IconCopy size={14} />
                            </ActionIcon>
                            <ActionIcon
                              size="sm"
                              variant="subtle"
                              color="red"
                              onClick={(e) => {
                                e.stopPropagation()
                                handleDeleteExperiment(exp.id)
                              }}
                            >
                              <IconTrash size={14} />
                            </ActionIcon>
                          </Group>
                        </Group>
                      </Paper>
                    )
                  })}
                </React.Fragment>
              ))}
            </Stack>
          </Stack>
        </Box>

        {/* Main Content Area */}
        <Box
          style={{
            flex: 1,
            height: "100%",
            overflowY: "auto",
            padding: "2rem",
          }}
        >
          {!selectedExperiment ? (
            <Stack
              gap="md"
              align="center"
              justify="center"
              style={{ height: "100%" }}
            >
              <IconPlus size={48} color="var(--mantine-color-gray-4)" />
              <Text size="lg" fw={500} c="dimmed">
                Select or create an experiment to get started
              </Text>
            </Stack>
          ) : !selectedProcess ? (
            <Stack
              gap="md"
              align="center"
              justify="center"
              style={{ height: "100%" }}
            >
              <Alert
                icon={<IconInfoCircle size={16} />}
                title="No Recipe Selected"
                color="yellow"
              >
                Please select a recipe for this experiment to continue.
              </Alert>
              <Button onClick={() => setRecipeModalOpen(true)}>
                Select Recipe
              </Button>
            </Stack>
          ) : (
            <Stack gap="md">
              {/* Header with title and meta info */}
              <Group justify="space-between" align="flex-start">
                <Paper
                  withBorder
                  p="sm"
                  radius="md"
                  style={{ flex: 1, background: "var(--mantine-color-gray-1)" }}
                >
                  <SimpleGrid cols={4} spacing="sm">
                    <TextInput
                      label="Experiment Name"
                      placeholder="Name"
                      size="sm"
                      value={selectedExperiment.name}
                      onChange={(e) =>
                        handleUpdateExperiment({
                          ...selectedExperiment,
                          name: e.currentTarget.value,
                        })
                      }
                    />

                    <Box>
                      <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb={4}>
                        Date of Execution
                      </Text>
                      <TextInput
                        type="date"
                        value={selectedExperiment.date}
                        onChange={(e) =>
                          handleUpdateExperiment({
                            ...selectedExperiment,
                            date: e.currentTarget.value,
                          })
                        }
                        size="sm"
                      />
                    </Box>

                    <Box>
                      <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb={4}>
                        Status
                      </Text>
                      <Badge
                        size="lg"
                        color={
                          getExperimentStatus(selectedExperiment) === "finished"
                            ? "green"
                            : getExperimentStatus(selectedExperiment) ===
                                "ready"
                              ? "blue"
                              : "yellow"
                        }
                      >
                        {getExperimentStatus(selectedExperiment)}
                      </Badge>
                    </Box>

                    <Paper
                      withBorder
                      p="xs"
                      radius="sm"
                      style={{ background: "var(--mantine-color-blue-0)" }}
                    >
                      <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb={4}>
                        Recipe / Process
                      </Text>
                      <Group gap="xs">
                        <Badge color="blue" variant="filled" size="lg">
                          {selectedProcess.name}
                        </Badge>
                        <Button
                          size="xs"
                          variant="subtle"
                          onClick={() => setRecipeModalOpen(true)}
                        >
                          Change
                        </Button>
                      </Group>
                    </Paper>
                  </SimpleGrid>
                </Paper>
              </Group>

              {/* Intent/Description */}
              <Box>
                <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb={4}>
                  Intent / Description
                </Text>
                <TextInput
                  placeholder="What is the purpose of this experiment?"
                  value={selectedExperiment.description}
                  onChange={(e) =>
                    handleUpdateExperiment({
                      ...selectedExperiment,
                      description: e.currentTarget.value,
                    })
                  }
                />
              </Box>

              <Divider />

              {/* Substrate Management */}
              <SubstrateNameGenerator
                process={selectedProcess}
                substrateMaterialOptions={substrateMaterialOptions}
                materialNameById={materialNameById}
                solutionNameById={solutionNameById}
                generatorConfig={generatorConfig}
                onChangeGeneratorConfig={(patch) =>
                  setGeneratorConfig((prev) => ({ ...prev, ...patch }))
                }
                nextStepDefaults={nextStepDefaults}
                onChangeNextStepDefault={(stageIndex, value) =>
                  setNextStepDefaults((prev) => ({
                    ...prev,
                    [stageIndex]: value,
                  }))
                }
                onAddSubstratesForMaterial={handleAddSubstratesForMaterial}
              />

              {/* Main Grid */}
              <Paper withBorder p="md" radius="md">
                <Text size="sm" fw={600} mb="md">
                  Experiment Steps Grid
                </Text>
                <ExperimentGrid
                  experiment={selectedExperiment}
                  process={selectedProcess}
                  substrateMaterialOptions={substrateMaterialOptions}
                  materialNameById={materialNameById}
                  solutionNameById={solutionNameById}
                  generatorConfig={generatorConfig}
                  nextStepDefaults={nextStepDefaults}
                  onUpdate={handleUpdateExperiment}
                  onUpdateProcess={handleUpdateProcess}
                />
              </Paper>
            </Stack>
          )}
        </Box>

        {/* Recipe Selection Modal */}
        <RecipeSelectionModal
          isOpen={recipeModalOpen}
          processes={processes}
          onSelect={handleRecipeSelect}
          onClose={() => setRecipeModalOpen(false)}
        />
      </Group>

      <SelectCollectionModal
        opened={collectionModalOpen}
        onClose={() => setCollectionModalOpen(false)}
        onConfirm={doAddExperiment}
        confirmLabel="Add Experiment"
      />
    </>
  )
}
