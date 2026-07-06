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
  Paper,
  Popover,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  ThemeIcon,
  Tooltip,
} from "@mantine/core"
import { modals } from "@mantine/modals"
import { notifications } from "@mantine/notifications"
import {
  IconArrowRight,
  IconCheck,
  IconCopy,
  IconDownload,
  IconInfoCircle,
  IconLayersIntersect,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react"
import { useNavigate as useRouterNavigate } from "@tanstack/react-router"
import * as React from "react"
import { useCallback, useRef, useState } from "react"
import { autoResolveCollection } from "@/lib/autoResolveCollection"
import {
  experimentSummaryDone,
  getExperimentAllStepsDone,
} from "@/lib/uploadFlow"
import type { CollectionConfirmParams } from "../components/SelectCollectionModal"
import {
  type CanvasCollectionElement,
  type Experiment,
  newExperiment,
  PROCESS_PARAMETER_DEFINITIONS,
  type Process,
  type ProcessParameterKey,
  type ProcessSolutionRecipe,
  type ProcessStep,
  useAppContext,
  useEntityCollection,
} from "../store/AppContext"
import {
  buildChemicalsExport,
  ChemicalsTab,
  collectChemicals,
  computeChemsDone,
} from "./-Experiments.chemicals"

// Onboarding "pulse" highlight for the next field the user must fill — mirrors
// the stack-configuration animation on the Processes page (`stk-pulse`).
if (
  typeof document !== "undefined" &&
  !document.getElementById("exp-onboard-styles")
) {
  const s = document.createElement("style")
  s.id = "exp-onboard-styles"
  s.textContent = `
    @keyframes exp-pulse {
      0%   { box-shadow: 0 0 0 0 var(--mantine-color-blue-4); }
      70%  { box-shadow: 0 0 0 6px rgba(34,139,230,0); }
      100% { box-shadow: 0 0 0 0 rgba(34,139,230,0); }
    }
    .exp-pulse {
      border-radius: var(--mantine-radius-sm);
      animation: exp-pulse 1.6s ease-out infinite;
    }
  `
  document.head.appendChild(s)
}

// Required summary fields, in the order the guided flow points at them.
type SummaryFieldKey = "date" | "endDate" | "description"

/** The next unfilled required summary field, or null when all are set. */
function nextRequiredSummaryField(
  experiment: Experiment,
): SummaryFieldKey | null {
  if (!experiment.date) return "date"
  if (!experiment.endDate) return "endDate"
  if (!experiment.description?.trim()) return "description"
  return null
}

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
  solutionRecipes: ProcessSolutionRecipe[] = [],
): string {
  const depositionMethod = step.depositionMethod?.value?.trim() || "Deposition"
  const materialName =
    step.inlineMaterial?.name ||
    (step.chemRecipeId
      ? (solutionRecipes.find((r) => r.id === step.chemRecipeId)?.name ?? null)
      : null)
  return materialName
    ? `${depositionMethod}: ${materialName}`
    : depositionMethod
}

function buildStageStepOptions(
  alternatives: ProcessStep[],
  solutionRecipes: ProcessSolutionRecipe[] = [],
) {
  const options = alternatives.map((step) => ({
    value: step.id,
    label: buildStepBaseLabel(step, solutionRecipes),
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
  generatorConfig,
  onChangeGeneratorConfig,
  nextStepDefaults,
  onChangeNextStepDefault,
}: {
  process: Process
  generatorConfig: SubstrateGeneratorConfig
  onChangeGeneratorConfig: (patch: Partial<SubstrateGeneratorConfig>) => void
  nextStepDefaults: Record<number, string>
  onChangeNextStepDefault: (stageIndex: number, value: string) => void
}) {
  const [showDetails, setShowDetails] = useState(false)

  return (
    <Paper withBorder p="sm" radius="md" mb="md">
      <Group justify="space-between" align="center">
        <Text size="xs" fw={600} c="dimmed" tt="uppercase">
          Substrate settings
        </Text>
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          onClick={() => setShowDetails((v) => !v)}
        >
          {showDetails ? "▲ Hide" : "▼ Show settings"}
        </Button>
      </Group>

      {showDetails && (
        <>
          <Divider my="sm" />
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
                onChangeGeneratorConfig({
                  includeDate: e.currentTarget.checked,
                })
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
                value={
                  nextStepDefaults[idx] ?? stage.alternatives[0]?.id ?? "SKIP"
                }
                onChange={(value) =>
                  onChangeNextStepDefault(
                    idx,
                    value ?? stage.alternatives[0]?.id ?? "SKIP",
                  )
                }
                data={buildStageStepOptions(
                  stage.alternatives,
                  process.solutionRecipes ?? [],
                )}
              />
            ))}
          </Group>
        </>
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
  solutionRecipes,
  selectedStepId,
  defaultStepId,
  onSelect,
}: {
  alternatives: ProcessStep[]
  solutionRecipes: ProcessSolutionRecipe[]
  selectedStepId: string | undefined | null
  defaultStepId: string | null
  onSelect: (stepId: string | null) => void
}) {
  const data = buildStageStepOptions(alternatives, solutionRecipes).map(
    (option) =>
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
  generatorConfig,
  nextStepDefaults,
  onUpdate,
  onUpdateProcess,
  onAddSingleSubstrate,
}: {
  experiment: Experiment
  process: Process
  substrateMaterialOptions: SubstrateMaterialOption[]
  generatorConfig: SubstrateGeneratorConfig
  nextStepDefaults: Record<number, string>
  onUpdate: (exp: Experiment) => void
  onUpdateProcess: (process: Process) => void
  onAddSingleSubstrate: () => void
}) {
  const [variationPopoverStageIdx, setVariationPopoverStageIdx] = useState<
    number | null
  >(null)
  const [variationAltStepId, setVariationAltStepId] = useState<string | null>(
    null,
  )
  const [variationParam, setVariationParam] = useState<string | null>(null)
  const [selectedSubstrateIds, setSelectedSubstrateIds] = useState<Set<string>>(
    new Set(),
  )
  const [addRowHovered, setAddRowHovered] = useState(false)
  const [hintStageIdx, setHintStageIdx] = useState<number | null>(null)
  const [hintAltStepId, setHintAltStepId] = useState<string | null>(null)
  const [hintParam, setHintParam] = useState<string | null>(null)
  const nameInputRefs = React.useRef<Array<HTMLInputElement | null>>([])
  const pendingFocusNewSubstrate = useRef(false)

  // Pre-create stable ref callbacks so Mantine's useMergedRef doesn't see a new
  // function on every render (which would recreate its merged ref and trigger
  // React's assignRefs → mergeRefs cycle for every re-render).
  // Only recreate when the number of substrates changes, not on every edit.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally keyed only on length
  const nameRefCallbacks = React.useMemo(
    () =>
      experiment.substrates.map(
        (_substrate, idx) => (node: HTMLInputElement | null) => {
          nameInputRefs.current[idx] = node
        },
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [experiment.substrates.length],
  )

  const stepDisplayById = React.useMemo(() => {
    const recipes = process.solutionRecipes ?? []
    const map = new Map<string, string>()
    process.stages.forEach((stage) => {
      const options = buildStageStepOptions(stage.alternatives, recipes)
      for (const option of options) {
        if (option.value !== "SKIP") {
          map.set(option.value, option.label)
        }
      }
    })
    return map
  }, [process.stages, process.solutionRecipes])

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

  React.useEffect(() => {
    if (pendingFocusNewSubstrate.current) {
      pendingFocusNewSubstrate.current = false
      const idx = experiment.substrates.length - 1
      requestAnimationFrame(() => {
        nameInputRefs.current[idx]?.focus()
        nameInputRefs.current[idx]?.select()
      })
    }
  }, [experiment.substrates.length])

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
    if (variationPopoverStageIdx === null || !variationAltStepId) return null
    return (
      process.stages[variationPopoverStageIdx]?.alternatives.find(
        (step) => step.id === variationAltStepId,
      ) ?? null
    )
  }, [process.stages, variationPopoverStageIdx, variationAltStepId])

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

  const hintStageOptions = React.useMemo(
    () =>
      process.stages.map((_, idx) => ({
        value: String(idx),
        label: `#${idx + 1} Step`,
      })),
    [process.stages],
  )

  const hintAltOptions = React.useMemo(() => {
    if (hintStageIdx === null) return []
    return buildStageStepOptions(
      process.stages[hintStageIdx]?.alternatives ?? [],
      process.solutionRecipes ?? [],
    ).filter((o) => o.value !== "SKIP")
  }, [process.stages, process.solutionRecipes, hintStageIdx])

  const hintSelectedStep = React.useMemo(() => {
    if (hintStageIdx === null || !hintAltStepId) return null
    return (
      process.stages[hintStageIdx]?.alternatives.find(
        (s) => s.id === hintAltStepId,
      ) ?? null
    )
  }, [process.stages, hintStageIdx, hintAltStepId])

  const hintParamOptions = React.useMemo(() => {
    if (!hintSelectedStep) return []
    return PROCESS_PARAMETER_DEFINITIONS.filter(({ key }) => {
      if (
        key === "depositionMethod" ||
        key === "depositionStartTime" ||
        key === "annealingStartTime"
      ) {
        return false
      }
      return !!hintSelectedStep[key as ProcessParameterKey]?.value?.trim()
    }).map(({ key, label }) => ({ value: key, label }))
  }, [hintSelectedStep])

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

  const doAddVariation = (
    stageIndex: number,
    stepId: string,
    paramKey: ProcessParameterKey,
  ) => {
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
  }

  const handleAddVariation = () => {
    if (
      variationPopoverStageIdx === null ||
      !variationAltStepId ||
      !variationParam
    )
      return
    doAddVariation(
      variationPopoverStageIdx,
      variationAltStepId,
      variationParam as ProcessParameterKey,
    )
    setVariationPopoverStageIdx(null)
    setVariationAltStepId(null)
    setVariationParam(null)
  }

  const handleAddVariationFromHint = () => {
    if (hintStageIdx === null || !hintAltStepId || !hintParam) return
    doAddVariation(
      hintStageIdx,
      hintAltStepId,
      hintParam as ProcessParameterKey,
    )
    setHintParam(null)
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

  // Group variation columns by stage index so they render right after their stage column
  const variationColumnsByStageIdx = React.useMemo(() => {
    const map = new Map<number, (typeof variationColumns)[number][]>()
    for (const col of variationColumns) {
      if (!map.has(col.stageIndex)) map.set(col.stageIndex, [])
      map.get(col.stageIndex)!.push(col)
    }
    return map
  }, [variationColumns])

  return (
    <Box mb="lg" style={{ overflowX: "auto" }}>
      {experiment.substrates.length > 0 && (
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
      )}
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
              const stageVarCols = variationColumnsByStageIdx.get(idx) ?? []
              const isOpen = variationPopoverStageIdx === idx
              const altOptions = buildStageStepOptions(
                stage.alternatives,
                process.solutionRecipes ?? [],
              ).filter((o) => o.value !== "SKIP")
              return (
                <React.Fragment key={`stage-${idx}`}>
                  <th
                    style={{
                      padding: "12px 8px",
                      textAlign: "left",
                      fontWeight: 600,
                      borderBottom: "2px solid var(--mantine-color-gray-3)",
                      minWidth: "180px",
                    }}
                  >
                    <Group justify="space-between" gap="xs" wrap="nowrap">
                      <Group gap="xs" wrap="nowrap">
                        <Text size="sm">#{idx + 1} Step</Text>
                        {stage.alternatives.length > 1 && (
                          <Badge size="xs" variant="light" color="orange">
                            {stage.alternatives.length} options
                          </Badge>
                        )}
                      </Group>
                      <Popover
                        opened={isOpen}
                        onClose={() => setVariationPopoverStageIdx(null)}
                        position="bottom-end"
                        withArrow
                        shadow="md"
                        trapFocus
                      >
                        <Popover.Target>
                          <Tooltip label="Add parameter variation">
                            <ActionIcon
                              size="xs"
                              variant="subtle"
                              color="blue"
                              onClick={() => {
                                if (isOpen) {
                                  setVariationPopoverStageIdx(null)
                                } else {
                                  setVariationPopoverStageIdx(idx)
                                  setVariationAltStepId(
                                    stage.alternatives[0]?.id ?? null,
                                  )
                                  setVariationParam(null)
                                }
                              }}
                            >
                              <IconPlus size={10} />
                            </ActionIcon>
                          </Tooltip>
                        </Popover.Target>
                        <Popover.Dropdown>
                          <Stack gap="xs" style={{ minWidth: 220 }}>
                            <Text size="xs" fw={600}>
                              Add Parameter Variation
                            </Text>
                            {stage.alternatives.length > 1 && (
                              <Select
                                size="xs"
                                label="Alternative"
                                data={altOptions}
                                value={variationAltStepId}
                                onChange={(v) => {
                                  setVariationAltStepId(v)
                                  setVariationParam(null)
                                }}
                              />
                            )}
                            <Select
                              size="xs"
                              label="Parameter"
                              placeholder="Select parameter..."
                              data={variationParamOptions}
                              value={variationParam}
                              onChange={setVariationParam}
                              disabled={variationParamOptions.length === 0}
                            />
                            <Button
                              size="xs"
                              disabled={!variationAltStepId || !variationParam}
                              onClick={handleAddVariation}
                            >
                              Add Variation
                            </Button>
                          </Stack>
                        </Popover.Dropdown>
                      </Popover>
                    </Group>
                  </th>
                  {stageVarCols.map((col) => (
                    <th
                      key={`variation-col-${col.stepId}-${col.paramKey}`}
                      style={{
                        padding: "12px 8px",
                        textAlign: "left",
                        fontWeight: 600,
                        borderBottom: "2px solid var(--mantine-color-gray-3)",
                        minWidth: "190px",
                        background: "var(--mantine-color-blue-0)",
                      }}
                    >
                      <Group justify="space-between" gap="xs" wrap="nowrap">
                        <Text size="xs">{col.label}</Text>
                        <Tooltip label="Delete variation column">
                          <ActionIcon
                            size="xs"
                            variant="subtle"
                            color="red"
                            onClick={() => removeVariationColumn(col)}
                          >
                            <IconTrash size={12} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </th>
                  ))}
                </React.Fragment>
              )
            })}
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
          {experiment.substrates.map((substrate, substrateIndex) => (
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
                  ref={nameRefCallbacks[substrateIndex]}
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
                    const isLast =
                      currentIndex === experiment.substrates.length - 1
                    if (e.key === "Enter") {
                      e.preventDefault()
                      const value = e.currentTarget.value
                      handleSubstrateNameChange(substrate.id, value)
                      focusNameInput(currentIndex + 1)
                    }
                    if (e.key === "Tab") {
                      e.preventDefault()
                      if (!e.shiftKey && isLast) {
                        handleSubstrateNameChange(
                          substrate.id,
                          e.currentTarget.value,
                        )
                        pendingFocusNewSubstrate.current = true
                        onAddSingleSubstrate()
                      } else {
                        focusNameInput(
                          e.shiftKey ? currentIndex - 1 : currentIndex + 1,
                        )
                      }
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
              {process.stages.map((stage, stageIdx) => {
                const stageVarCols =
                  variationColumnsByStageIdx.get(stageIdx) ?? []
                return (
                  <React.Fragment key={`${substrate.id}-stage-${stageIdx}`}>
                    <td style={{ padding: "8px 4px" }}>
                      <ProcessStepSelector
                        alternatives={stage.alternatives}
                        solutionRecipes={process.solutionRecipes ?? []}
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
                    {stageVarCols.map((column) => {
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
                            background: "var(--mantine-color-blue-0)",
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
                  </React.Fragment>
                )
              })}
              <td style={{ padding: "8px 4px", textAlign: "center" }}>
                <Group justify="center" gap={2} wrap="nowrap">
                  <Tooltip label="Duplicate substrate">
                    <ActionIcon
                      size="sm"
                      variant="subtle"
                      color="teal"
                      onClick={() => handleDuplicateSubstrate(substrate.id)}
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

          {/* Ghost add row — above Processing Times */}
          <tr
            onClick={onAddSingleSubstrate}
            onMouseEnter={() => setAddRowHovered(true)}
            onMouseLeave={() => setAddRowHovered(false)}
            style={{
              cursor: "pointer",
              background: addRowHovered
                ? "var(--mantine-color-blue-0)"
                : undefined,
              transition: "background 100ms",
              borderTop: `1px dashed ${addRowHovered ? "var(--mantine-color-blue-3)" : "var(--mantine-color-gray-3)"}`,
            }}
          >
            <td style={{ padding: "10px 8px", textAlign: "center" }}>
              <IconPlus
                size={12}
                color={
                  addRowHovered
                    ? "var(--mantine-color-blue-5)"
                    : "var(--mantine-color-gray-4)"
                }
              />
            </td>
            <td colSpan={999} style={{ padding: "10px 8px" }}>
              <Text
                size="xs"
                c={addRowHovered ? "blue" : "dimmed"}
                fw={addRowHovered ? 500 : 400}
                fs={addRowHovered ? undefined : "italic"}
              >
                {addRowHovered
                  ? "Click to add a new substrate"
                  : "Add substrate..."}
              </Text>
            </td>
          </tr>

          {experiment.substrates.length > 0 && (
            <tr style={{ background: "var(--mantine-color-gray-0)" }}>
              <td
                style={{ borderTop: "2px solid var(--mantine-color-gray-2)" }}
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
                style={{ borderTop: "2px solid var(--mantine-color-gray-2)" }}
              />
              {process.stages.map((stage, idx) => {
                const processingKey = `stage:${idx}`
                const stageVarCols = variationColumnsByStageIdx.get(idx) ?? []
                return (
                  <React.Fragment key={`processing-time-${stage.index}-${idx}`}>
                    <td
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
                    {stageVarCols.map((col) => (
                      <td
                        key={`processing-var-${col.stepId}-${col.paramKey}`}
                        style={{
                          borderTop: "2px solid var(--mantine-color-gray-2)",
                          background: "var(--mantine-color-blue-0)",
                        }}
                      />
                    ))}
                  </React.Fragment>
                )
              })}
              <td
                style={{ borderTop: "2px solid var(--mantine-color-gray-2)" }}
              />
            </tr>
          )}
        </tbody>

        {/* Variation hint — same action as + buttons in the step column headers */}
        {process.stages.length > 0 && (
          <tfoot>
            <tr>
              <td
                colSpan={999}
                style={{
                  padding: "8px 12px",
                  background: "var(--mantine-color-gray-0)",
                  borderTop: "1px solid var(--mantine-color-gray-3)",
                }}
              >
                <Group gap="xs" align="center" wrap="wrap">
                  <Group gap={4} align="center" style={{ flexShrink: 0 }}>
                    <ActionIcon size="xs" variant="subtle" color="blue">
                      <IconPlus size={10} />
                    </ActionIcon>
                    <Text size="xs" fw={600} c="blue.7">
                      Add parameter variation for step:
                    </Text>
                  </Group>
                  <Select
                    size="xs"
                    placeholder="Select step..."
                    data={hintStageOptions}
                    value={hintStageIdx !== null ? String(hintStageIdx) : null}
                    onChange={(v) => {
                      const idx = v !== null ? Number(v) : null
                      setHintStageIdx(idx)
                      setHintAltStepId(
                        idx !== null
                          ? (process.stages[idx]?.alternatives[0]?.id ?? null)
                          : null,
                      )
                      setHintParam(null)
                    }}
                    style={{ minWidth: 130 }}
                  />
                  {hintStageIdx !== null &&
                    (process.stages[hintStageIdx]?.alternatives.length ?? 0) >
                      1 && (
                      <Select
                        size="xs"
                        placeholder="Alternative..."
                        data={hintAltOptions}
                        value={hintAltStepId}
                        onChange={(v) => {
                          setHintAltStepId(v)
                          setHintParam(null)
                        }}
                        style={{ minWidth: 140 }}
                      />
                    )}
                  {hintStageIdx !== null && (
                    <Select
                      size="xs"
                      placeholder="Select parameter..."
                      data={hintParamOptions}
                      value={hintParam}
                      onChange={setHintParam}
                      disabled={hintParamOptions.length === 0}
                      style={{ minWidth: 160 }}
                    />
                  )}
                  <Button
                    size="compact-xs"
                    variant="light"
                    leftSection={<IconPlus size={10} />}
                    disabled={
                      hintStageIdx === null || !hintAltStepId || !hintParam
                    }
                    onClick={handleAddVariationFromHint}
                  >
                    Add variation
                  </Button>
                </Group>
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Three-Step Timeline Header
// ─────────────────────────────────────────────────────────────────────────────

type ExpTab = "chemicals" | "processing" | "summary"

const EXP_STEPS: Array<{ id: ExpTab; label: string; sublabel: string }> = [
  { id: "chemicals", label: "Step 1", sublabel: "Chemicals" },
  { id: "processing", label: "Step 2", sublabel: "Processing" },
  { id: "summary", label: "Step 3", sublabel: "Summary" },
]

function ExperimentTimeline({
  activeTab,
  onSetTab,
  chemicalsDone,
  processingDone,
  summaryDone,
}: {
  activeTab: ExpTab
  onSetTab: (tab: ExpTab) => void
  chemicalsDone: boolean
  processingDone: boolean
  summaryDone: boolean
}) {
  const done: Record<ExpTab, boolean> = {
    chemicals: chemicalsDone,
    processing: processingDone,
    summary: summaryDone,
  }
  return (
    <Group gap={0} align="center" mb="lg" wrap="nowrap">
      {EXP_STEPS.map((step, i) => (
        <React.Fragment key={step.id}>
          <Box
            onClick={() => onSetTab(step.id)}
            style={{ cursor: "pointer", userSelect: "none" }}
          >
            <Group gap="xs" align="center" wrap="nowrap">
              <Box
                style={{
                  width: 36,
                  height: 36,
                  borderRadius: "50%",
                  flexShrink: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  background: done[step.id]
                    ? "var(--mantine-color-teal-6)"
                    : activeTab === step.id
                      ? "var(--mantine-color-blue-6)"
                      : "var(--mantine-color-gray-3)",
                  boxShadow:
                    activeTab === step.id
                      ? done[step.id]
                        ? "0 0 0 3px var(--mantine-color-teal-2)"
                        : "0 0 0 3px var(--mantine-color-blue-2)"
                      : "none",
                  transition: "all 0.15s",
                }}
              >
                {done[step.id] ? (
                  <IconCheck size={16} color="white" />
                ) : (
                  <Text size="sm" fw={700} c="white">
                    {i + 1}
                  </Text>
                )}
              </Box>
              <Box>
                <Text
                  size="xs"
                  fw={600}
                  c={activeTab === step.id ? "blue" : "dimmed"}
                  tt="uppercase"
                  lh={1.2}
                >
                  {step.label}
                </Text>
                <Text
                  size="sm"
                  fw={activeTab === step.id ? 700 : 500}
                  c={activeTab === step.id ? "blue" : undefined}
                  lh={1.2}
                >
                  {step.sublabel}
                </Text>
              </Box>
            </Group>
          </Box>
          {i < EXP_STEPS.length - 1 && (
            <Box
              style={{
                flex: 1,
                height: 2,
                background: "var(--mantine-color-gray-3)",
                margin: "0 12px",
              }}
            />
          )}
        </React.Fragment>
      ))}
    </Group>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Summary Tab (experiment metadata + export)
// ─────────────────────────────────────────────────────────────────────────────

function buildExportText(
  experiment: Experiment,
  process: Process,
  allExperiments: Experiment[],
): string {
  const { materials, solutions } = buildChemicalsExport(
    experiment,
    process,
    allExperiments,
  )
  const lines: string[] = []
  lines.push(`Experiment: ${experiment.name || "Untitled"}`)
  lines.push(`Process: ${process.name}`)
  if (experiment.date) lines.push(`Start date: ${experiment.date}`)
  if (experiment.endDate) lines.push(`End date: ${experiment.endDate}`)
  if (experiment.description) lines.push(`Intent: ${experiment.description}`)
  lines.push("")
  lines.push("CHEMICALS")
  if (materials.length === 0) {
    lines.push("  (none)")
  } else {
    for (const m of materials) {
      const extra = [m.purity, m.supplier, m.productId]
        .filter(Boolean)
        .join(", ")
      const src = m.sourceRecipeName ? ` [from ${m.sourceRecipeName}]` : ""
      lines.push(
        `  ${m.name}${src}: ${m.inventoryLabel || "—"}${extra ? ` (${extra})` : ""}`,
      )
    }
  }
  lines.push("")
  lines.push("SOLUTIONS")
  if (solutions.length === 0) {
    lines.push("  (none)")
  } else {
    for (const s of solutions) {
      if (s.mode === "take") {
        lines.push(
          `  ${s.name}: reused from ${s.reusedFromName ?? "another experiment"}`,
        )
      } else {
        const at = s.preparedAt ? `, prepared ${s.preparedAt}` : ""
        lines.push(
          `  ${s.name}${s.volumeMl ? ` (${s.volumeMl} mL)` : ""}${at}:`,
        )
        for (const q of s.quantities) {
          lines.push(`    - ${q.name}: ${q.amount} ${q.unit}`)
        }
      }
    }
  }
  return lines.join("\n")
}

function buildExportCsv(
  experiment: Experiment,
  process: Process,
  allExperiments: Experiment[],
): string {
  const { materials, solutions } = buildChemicalsExport(
    experiment,
    process,
    allExperiments,
  )
  const rows: string[][] = [["Type", "Name", "Detail", "Amount", "Unit"]]
  for (const m of materials) {
    const extra = [m.purity, m.supplier, m.productId].filter(Boolean).join(", ")
    rows.push(["Chemical", m.name, m.inventoryLabel || "", extra, ""])
  }
  for (const s of solutions) {
    if (s.mode === "take") {
      rows.push([
        "Solution",
        s.name,
        `reused from ${s.reusedFromName ?? "another experiment"}`,
        "",
        "",
      ])
    } else {
      rows.push([
        "Solution",
        s.name,
        s.preparedAt ? `prepared ${s.preparedAt}` : "total",
        s.volumeMl ?? "",
        "mL",
      ])
      for (const q of s.quantities) {
        rows.push([
          "Solution ingredient",
          `${s.name} — ${q.name}`,
          "",
          q.amount,
          q.unit,
        ])
      }
    }
  }
  const esc = (v: string) => `"${v.replace(/"/g, '""')}"`
  return rows.map((r) => r.map(esc).join(",")).join("\n")
}

function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type })
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

function SummaryTab({
  experiment,
  process,
  allExperiments,
  onUpdate,
}: {
  experiment: Experiment
  process: Process
  allExperiments: Experiment[]
  onUpdate: (exp: Experiment) => void
}) {
  const [copied, setCopied] = useState(false)

  const { materials, solutions } = React.useMemo(
    () => buildChemicalsExport(experiment, process, allExperiments),
    [experiment, process, allExperiments],
  )

  const safeName = (experiment.name || "experiment").replace(/[^\w.-]+/g, "_")

  const copyAll = () => {
    navigator.clipboard.writeText(
      buildExportText(experiment, process, allExperiments),
    )
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  // Guided highlighting: point the user at the next required field until the
  // summary is confirmed. Confirmation is a one-time gate (see below) — once
  // confirmed we stop pulsing even if the user edits fields afterwards.
  const confirmed = Boolean(experiment.summaryConfirmed)
  const nextField = confirmed ? null : nextRequiredSummaryField(experiment)
  const allFilled = nextRequiredSummaryField(experiment) === null

  const requiredLabel = (text: string, done: boolean) => (
    <Group gap={6} align="center" mb={4}>
      {done ? (
        <IconCheck size={13} color="var(--mantine-color-teal-6)" />
      ) : (
        <Box
          w={9}
          h={9}
          style={{
            borderRadius: "50%",
            background: "var(--mantine-color-red-5)",
            flexShrink: 0,
          }}
        />
      )}
      <Text size="xs" fw={600} c={done ? "teal.7" : "dimmed"} tt="uppercase">
        {text}
      </Text>
    </Group>
  )

  return (
    <Stack gap="lg">
      {/* Experiment metadata — all three are required to complete Step 3 */}
      <SimpleGrid cols={2} spacing="md">
        <Box>
          {requiredLabel("Start Date", Boolean(experiment.date))}
          <Box className={nextField === "date" ? "exp-pulse" : undefined}>
            <TextInput
              type="date"
              value={experiment.date}
              onChange={(e) =>
                onUpdate({ ...experiment, date: e.currentTarget.value })
              }
            />
          </Box>
        </Box>
        <Box>
          {requiredLabel("End Date", Boolean(experiment.endDate))}
          <Box className={nextField === "endDate" ? "exp-pulse" : undefined}>
            <TextInput
              type="date"
              value={experiment.endDate ?? ""}
              onChange={(e) =>
                onUpdate({ ...experiment, endDate: e.currentTarget.value })
              }
            />
          </Box>
        </Box>
      </SimpleGrid>

      <Box>
        {requiredLabel("Intent", Boolean(experiment.description?.trim()))}
        <Box className={nextField === "description" ? "exp-pulse" : undefined}>
          <Textarea
            autosize
            minRows={2}
            placeholder="What is the purpose of this experiment?"
            value={experiment.description}
            onChange={(e) =>
              onUpdate({ ...experiment, description: e.currentTarget.value })
            }
          />
        </Box>
      </Box>

      {/* Confirmation gate — turns Step 3 green. One-time: editing later never
          re-requires it because `summaryConfirmed` stays true. */}
      {confirmed ? (
        <Paper
          withBorder
          radius="md"
          p="sm"
          style={{
            borderColor: "var(--mantine-color-teal-4)",
            background: "var(--mantine-color-teal-0)",
          }}
        >
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon size={28} radius="xl" color="teal">
              <IconCheck size={16} />
            </ThemeIcon>
            <Text size="sm" fw={600} c="teal.8">
              Experiment summary confirmed
            </Text>
          </Group>
        </Paper>
      ) : (
        <Paper
          withBorder
          radius="md"
          p="md"
          style={{
            borderColor: allFilled
              ? "var(--mantine-color-blue-4)"
              : "var(--mantine-color-gray-3)",
          }}
        >
          <Group justify="space-between" wrap="wrap" gap="sm">
            <Text size="sm" c="dimmed">
              {allFilled
                ? "Review the details above, then confirm to complete this experiment."
                : "Fill in start date, end date and intent to confirm the summary."}
            </Text>
            <Button
              className={allFilled ? "exp-pulse" : undefined}
              color="teal"
              disabled={!allFilled}
              leftSection={<IconCheck size={18} />}
              onClick={() =>
                onUpdate({ ...experiment, summaryConfirmed: true })
              }
            >
              Confirm summary
            </Button>
          </Group>
        </Paper>
      )}

      <Divider label="Export" labelPosition="center" />

      <Paper withBorder radius="md" p="md">
        <Group justify="space-between" mb="md" wrap="wrap">
          <Text fw={700} size="sm">
            Chemicals &amp; solution quantities
          </Text>
          <Group gap="xs">
            <Button
              size="xs"
              variant="light"
              color={copied ? "teal" : "blue"}
              leftSection={
                copied ? <IconCheck size={14} /> : <IconCopy size={14} />
              }
              onClick={copyAll}
            >
              {copied ? "Copied!" : "Copy"}
            </Button>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconDownload size={14} />}
              onClick={() =>
                downloadFile(
                  `${safeName}_chemicals.txt`,
                  buildExportText(experiment, process, allExperiments),
                  "text/plain",
                )
              }
            >
              .txt
            </Button>
            <Button
              size="xs"
              variant="light"
              leftSection={<IconDownload size={14} />}
              onClick={() =>
                downloadFile(
                  `${safeName}_chemicals.csv`,
                  buildExportCsv(experiment, process, allExperiments),
                  "text/csv",
                )
              }
            >
              .csv
            </Button>
          </Group>
        </Group>

        <Stack gap="md">
          <Box>
            <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb="xs">
              Chemicals
            </Text>
            {materials.length === 0 ? (
              <Text size="sm" c="dimmed">
                None
              </Text>
            ) : (
              <Stack gap={4}>
                {materials.map((m, i) => (
                  <Group key={i} justify="space-between" wrap="nowrap">
                    <Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
                      <Text size="sm" fw={600} truncate>
                        {m.name}
                      </Text>
                      {m.sourceRecipeName && (
                        <Text size="xs" c="dimmed" truncate>
                          from {m.sourceRecipeName}
                        </Text>
                      )}
                    </Group>
                    <Text
                      size="sm"
                      fw={500}
                      c={m.inventoryLabel ? undefined : "dimmed"}
                    >
                      {m.inventoryLabel || "Not set"}
                    </Text>
                  </Group>
                ))}
              </Stack>
            )}
          </Box>

          <Box>
            <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb="xs">
              Solutions
            </Text>
            {solutions.length === 0 ? (
              <Text size="sm" c="dimmed">
                None
              </Text>
            ) : (
              <Stack gap="sm">
                {solutions.map((s, i) => (
                  <Box key={i}>
                    <Group justify="space-between" wrap="nowrap">
                      <Text size="sm" fw={600}>
                        {s.name}
                      </Text>
                      <Text size="sm" fw={500} c="dimmed">
                        {s.mode === "take"
                          ? `reused from ${s.reusedFromName ?? "another experiment"}`
                          : s.volumeMl
                            ? `${s.volumeMl} mL${s.preparedAt ? ` · ${s.preparedAt}` : ""}`
                            : "Not set"}
                      </Text>
                    </Group>
                    {s.quantities.length > 0 && (
                      <Stack gap={2} mt={4} pl="md">
                        {s.quantities.map((q, j) => (
                          <Group key={j} justify="space-between">
                            <Text size="xs" c="dimmed">
                              {q.name}
                            </Text>
                            <Text size="xs" fw={600} ff="monospace">
                              {q.amount} {q.unit}
                            </Text>
                          </Group>
                        ))}
                      </Stack>
                    )}
                  </Box>
                ))}
              </Stack>
            )}
          </Box>
        </Stack>
      </Paper>
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Experiments Page
// ─────────────────────────────────────────────────────────────────────────────

export default function ExperimentsPage() {
  const navigate = useRouterNavigate()
  const {
    experiments,
    setExperiments,
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
    setActivePlaneId,
    setActiveCollectionId,
    addCollectionElement,
    pendingCollectionLink,
    setPendingCollectionLink,
    startUploadFlow,
  } = useAppContext()
  const { getEntityColor, isEntityVisible } = useEntityCollection()

  const [selectedExpId, setSelectedExpId] = useState<string | null>(
    () => lastSelectedByKind.experiment ?? null,
  )
  const [activeExpTab, setActiveExpTab] = useState<ExpTab>("chemicals")
  const [recipeModalOpen, setRecipeModalOpen] = useState(false)
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

  /** Select an experiment as a direct result of a user action, keeping the
   *  app-wide activeEntity and last-selected bookkeeping in sync. */
  const selectExperiment = useCallback(
    (id: string) => {
      setSelectedExpId(id)
      setActiveEntity({ kind: "experiment", id })
      updateLastSelected("experiment", id)
    },
    [setActiveEntity, updateLastSelected],
  )

  // Track processed pending request IDs to avoid double-firing
  const processedPendingRequestIdsRef = useRef(new Set<string>())

  // Keep planes in a ref so the pendingCollectionLink effect can read the latest
  // planes without depending on them (the effect calls updateElement which modifies
  // planes, which would otherwise cause the effect to re-run unnecessarily).
  const planesRef = useRef(planes)
  planesRef.current = planes

  // Auto-create experiment + link to collection when navigated from action bubble
  React.useEffect(() => {
    if (pendingCollectionLink?.kind !== "experiment") {
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
    selectExperiment(newExp.id)
    setActiveExpTab("chemicals")

    // Link back to collection
    const plane = planesRef.current.find((p) => p.id === planeId)
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
    updateElement,
    selectExperiment,
  ])

  const selectedExperiment = experiments.find((e) => e.id === selectedExpId)
  const selectedProcess =
    selectedExperiment &&
    processes.find((p) => p.id === selectedExperiment.processId)
  const substrateMaterialOptions = React.useMemo(() => {
    if (!selectedProcess) {
      return []
    }
    return (selectedProcess.inlineSubstrates ?? []).map((s) => ({
      value: s.id,
      label: s.name || "Substrate",
      heightMm: s.heightMm ?? "",
    }))
  }, [selectedProcess])

  const allExpStepsDone = React.useMemo(() => {
    if (!selectedExperiment || !selectedProcess) return false
    const { materialItems, solutionItems } = collectChemicals(selectedProcess)
    const chemDone = computeChemsDone(
      selectedExperiment.chemicalsPrep,
      materialItems,
      solutionItems,
    )
    const procDone = selectedExperiment.substrates.length > 0
    return chemDone && procDone && experimentSummaryDone(selectedExperiment)
  }, [selectedExperiment, selectedProcess])

  const expAllStepsDoneMap = React.useMemo(() => {
    const map = new Map<string, boolean>()
    for (const exp of experiments) {
      const process = processes.find((p) => p.id === exp.processId)
      map.set(exp.id, getExperimentAllStepsDone(exp, process))
    }
    return map
  }, [experiments, processes])

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

  // Sync is deliberately ONE-directional: activeEntity (context) → selectedExpId
  // (local). The reverse direction is pushed imperatively by user-action
  // handlers via selectExperiment() below. A second effect syncing
  // selectedExpId → activeEntity re-created the "Maximum update depth exceeded"
  // production crash: two effects mirroring each other's state with ref guards
  // still oscillate, because each guard reads a ref that lags one commit
  // behind the other effect's write (see CLAUDE.md, Strict Mode Pitfalls #4).
  React.useEffect(() => {
    if (activeEntity?.kind !== "experiment") {
      return
    }
    if (!experimentsRef.current.some((e) => e.id === activeEntity.id)) {
      return
    }
    setSelectedExpId(activeEntity.id)
  }, [activeEntity])

  // Create new experiment
  const doAddExperiment = ({
    planeId,
    collection,
  }: CollectionConfirmParams) => {
    if (!newExperimentProcessId) return
    const newExp = newExperiment(newExperimentProcessId)
    setExperiments((prev) => [...prev, newExp])
    selectExperiment(newExp.id)
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
    const resolved = autoResolveCollection(
      planes,
      activePlaneId,
      addCollectionElement,
      setActivePlaneId,
      setActiveCollectionId,
    )
    if (resolved)
      doAddExperiment({ ...resolved, collectionId: resolved.collection.id })
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

  const handleAddResultsForExperiment = useCallback(
    (exp: Experiment) => {
      // Start the "File Upload" flow with Process + Experiment already
      // satisfied — only the Upload step remains. The single-flow rule means
      // this no-ops (returns false) if another upload is already in progress.
      const started = startUploadFlow({
        origin: "add-results",
        processId: exp.processId,
        experimentId: exp.id,
      })
      if (!started) {
        notifications.show({
          title: "Upload already in progress",
          message:
            "Finish or cancel the current upload before starting another.",
          color: "red",
        })
        return
      }
      setPendingCollectionLink({
        collectionId: "",
        planeId: "",
        kind: "result",
        selectedExperimentId: exp.id,
        openAddResults: true,
        requestId: crypto.randomUUID(),
      })
      setActiveEntity({ kind: "experiment", id: exp.id })
      updateLastSelected("experiment", exp.id)
      void navigate({ to: "/results" })
    },
    [
      navigate,
      setActiveEntity,
      setPendingCollectionLink,
      startUploadFlow,
      updateLastSelected,
    ],
  )

  const handleAddResultsForSelectedExperiment = useCallback(() => {
    if (!selectedExperiment || !allExpStepsDone) {
      return
    }
    handleAddResultsForExperiment(selectedExperiment)
  }, [handleAddResultsForExperiment, selectedExperiment, allExpStepsDone])

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

  const handleAddSingleSubstrate = useCallback(() => {
    if (!selectedExperiment || !selectedProcess) {
      return
    }

    const buildDefaultStageValues = () => {
      const values: Record<string, string> = {}
      selectedProcess.stages.forEach((stage, idx) => {
        const selected =
          nextStepDefaults[idx] ?? stage.alternatives[0]?.id ?? "SKIP"
        values[`stageSelection:${idx}`] = selected
      })
      return values
    }

    const newSubstrate = {
      id: crypto.randomUUID(),
      name: buildGeneratedSubstrateName(
        selectedExperiment.substrates.length + 1,
        selectedExperiment,
        generatorConfig,
      ),
      substrateMaterialId: substrateMaterialOptions[0]?.value,
      parameterValues: buildDefaultStageValues(),
    }

    handleUpdateExperiment({
      ...selectedExperiment,
      numSubstrates: selectedExperiment.substrates.length + 1,
      substrates: [...selectedExperiment.substrates, newSubstrate],
    })
  }, [
    selectedExperiment,
    selectedProcess,
    generatorConfig,
    nextStepDefaults,
    substrateMaterialOptions,
    handleUpdateExperiment,
  ])

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
      hasCompletedUpload: false,
    }

    setExperiments((prev) => [...prev, copy])
    selectExperiment(copy.id)

    // Keep copied experiment inside the same collection(s) as the source.
    for (const plane of planes) {
      for (const element of plane.elements) {
        if (element.type !== "collection") {
          continue
        }
        const collection = element as CanvasCollectionElement
        const hasSourceRef = collection.refs.some(
          (ref) => ref.kind === "experiment" && ref.id === exp.id,
        )
        if (!hasSourceRef) {
          continue
        }

        const alreadyLinked = collection.refs.some(
          (ref) => ref.kind === "experiment" && ref.id === copy.id,
        )
        if (alreadyLinked) {
          continue
        }

        updateElement(plane.id, {
          ...collection,
          refs: [
            ...collection.refs,
            { kind: "experiment" as const, id: copy.id },
          ],
        })
      }
    }
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
    <Group gap={0} align="flex-start" style={{ height: "100%" }}>
      {/* Left Sidebar - Experiment List */}
      <Box
        style={{
          width: 250,
          minWidth: 250,
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
                  const isComplete = expAllStepsDoneMap.get(exp.id) ?? false
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
                      onClick={() => selectExperiment(exp.id)}
                    >
                      <Stack gap={4}>
                        <Text size="sm" fw={600} truncate>
                          {exp.name || "Untitled"}
                        </Text>
                        <Group justify="space-between" wrap="nowrap">
                          <Badge
                            size="xs"
                            color={isComplete ? "green" : "red"}
                            variant="dot"
                          >
                            {isComplete ? "Complete" : "Incomplete"}
                          </Badge>
                          <Group gap={2} wrap="nowrap">
                            {expAllStepsDoneMap.get(exp.id) && (
                              <Tooltip label="Add Results" withArrow>
                                <ActionIcon
                                  size="sm"
                                  variant="subtle"
                                  color="green"
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    handleAddResultsForExperiment(exp)
                                  }}
                                >
                                  <IconDownload size={14} />
                                </ActionIcon>
                              </Tooltip>
                            )}
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
                      </Stack>
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
              <Paper withBorder p="sm" radius="md" style={{ flex: 1 }}>
                <SimpleGrid cols={2} spacing="sm">
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

            {/* Three-step timeline */}
            {(() => {
              const { materialItems, solutionItems } =
                collectChemicals(selectedProcess)
              const chemDone = computeChemsDone(
                selectedExperiment.chemicalsPrep,
                materialItems,
                solutionItems,
              )
              const procDone = selectedExperiment.substrates.length > 0
              const summaryDone = experimentSummaryDone(selectedExperiment)
              const allStepsDone = chemDone && procDone && summaryDone
              return (
                <>
                  <ExperimentTimeline
                    activeTab={activeExpTab}
                    onSetTab={setActiveExpTab}
                    chemicalsDone={chemDone}
                    processingDone={procDone}
                    summaryDone={summaryDone}
                  />

                  {activeExpTab === "chemicals" && (
                    <Box>
                      <ChemicalsTab
                        key={selectedExperiment.id}
                        experiment={selectedExperiment}
                        process={selectedProcess}
                        allExperiments={experiments}
                        onUpdate={handleUpdateExperiment}
                      />
                      {chemDone && (
                        <Group justify="center" mt="xl">
                          <Button
                            size="lg"
                            color="blue"
                            rightSection={<IconArrowRight size={20} />}
                            onClick={() => setActiveExpTab("processing")}
                          >
                            Continue to Step 2: Processing
                          </Button>
                        </Group>
                      )}
                    </Box>
                  )}

                  {activeExpTab === "processing" && (
                    <Stack gap="md">
                      <Paper withBorder p="md" radius="md">
                        <Group gap="xs" mb="md">
                          <IconLayersIntersect
                            size={18}
                            color="var(--mantine-color-blue-6)"
                          />
                          <Text size="sm" fw={700}>
                            Step 2: Please specify how many substrates you
                            prepared and what steps and parameters you use!
                          </Text>
                        </Group>
                        <SubstrateNameGenerator
                          process={selectedProcess}
                          generatorConfig={generatorConfig}
                          onChangeGeneratorConfig={(patch) =>
                            setGeneratorConfig((prev) => ({
                              ...prev,
                              ...patch,
                            }))
                          }
                          nextStepDefaults={nextStepDefaults}
                          onChangeNextStepDefault={(stageIndex, value) =>
                            setNextStepDefaults((prev) => ({
                              ...prev,
                              [stageIndex]: value,
                            }))
                          }
                        />
                        <ExperimentGrid
                          experiment={selectedExperiment}
                          process={selectedProcess}
                          substrateMaterialOptions={substrateMaterialOptions}
                          generatorConfig={generatorConfig}
                          nextStepDefaults={nextStepDefaults}
                          onUpdate={handleUpdateExperiment}
                          onUpdateProcess={handleUpdateProcess}
                          onAddSingleSubstrate={handleAddSingleSubstrate}
                        />
                        {procDone && (
                          <Group justify="center" mt="xl">
                            <Button
                              size="lg"
                              color="blue"
                              rightSection={<IconArrowRight size={20} />}
                              onClick={() => setActiveExpTab("summary")}
                            >
                              Continue to Step 3: Summary
                            </Button>
                          </Group>
                        )}
                      </Paper>
                    </Stack>
                  )}

                  {activeExpTab === "summary" && (
                    <Paper withBorder p="md" radius="md">
                      <SummaryTab
                        experiment={selectedExperiment}
                        process={selectedProcess}
                        allExperiments={experiments}
                        onUpdate={handleUpdateExperiment}
                      />
                      {allStepsDone && (
                        <Group justify="center" mt="xl">
                          <Button
                            size="lg"
                            color="green"
                            variant="subtle"
                            leftSection={<IconDownload size={20} />}
                            onClick={handleAddResultsForSelectedExperiment}
                          >
                            Add Results
                          </Button>
                        </Group>
                      )}
                    </Paper>
                  )}
                </>
              )
            })()}
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
  )
}
