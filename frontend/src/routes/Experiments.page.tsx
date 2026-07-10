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
  IconCloudUpload,
  IconCopy,
  IconDownload,
  IconFileImport,
  IconInfoCircle,
  IconLayersIntersect,
  IconPlus,
  IconTrash,
} from "@tabler/icons-react"
import { useNavigate as useRouterNavigate } from "@tanstack/react-router"
import * as React from "react"
import { useCallback, useRef, useState } from "react"
import { autoResolveCollection } from "@/lib/autoResolveCollection"
import { filesFromDataTransfer } from "@/lib/dropFiles"
import { homeCollectionForEntity } from "@/lib/entityReveal"
import { exportExperimentSummaryAsPdf } from "@/lib/processExport"
import {
  buildProcessingStacks,
  computeProcessingTimeRange,
  datePart,
  experimentProcessingTimesDone,
  experimentSubstratesDone,
  experimentVariationDone,
  findDecisiveStageIndices,
  findDivergeIdx,
  findProcessingTimeRegressions,
  processingAsAboveKey,
  processingTimeKey,
  resolveProcessingTime,
  stackRowLabel,
  timePart,
  VARIATION_CHOICE_KEY,
  variationChoiceOf,
} from "@/lib/processingTimes"
import { buildStageStepOptions } from "@/lib/stageStepChoices"
import {
  buildSubstratesFromNames,
  experimentProcessingDone,
  experimentSummaryDone,
  getExperimentAllStepsDone,
  recognizeGroupNames,
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
  pulseWhenEmpty,
  ...props
}: Omit<React.ComponentProps<typeof TextInput>, "onChange" | "onBlur"> & {
  value: string
  onChange?: (value: string) => void
  onBlur?: (value: string) => void
  /** When true and the (live) field is blank, wrap the input in a pulsing
   *  highlight to prompt the user to fill it in. Keyed on the local value so
   *  the buzz stops the moment they start typing, before blur commits. */
  pulseWhenEmpty?: boolean
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

  const input = (
    <TextInput
      {...props}
      value={localValue}
      onChange={(e) => setLocalValue(e.currentTarget.value)}
      onBlur={handleBlur}
    />
  )

  // Keep the wrapper element stable (only toggle the class) so the input isn't
  // remounted — and focus lost — the moment the user types the first character.
  if (pulseWhenEmpty) {
    return (
      <Box className={!localValue.trim() ? "exp-pulse" : undefined}>
        {input}
      </Box>
    )
  }
  return input
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

// `buildStageStepOptions` / `buildStepBaseLabel` now live in
// `@/lib/stageStepChoices` so the PDF export/import round-trip builds identical
// step-choice options (see import below).

// ─────────────────────────────────────────────────────────────────────────────
// Edit SubstrateName Generator (simplified display above table)
// ─────────────────────────────────────────────────────────────────────────────

const SubstrateNameGenerator = React.memo(function SubstrateNameGenerator({
  process,
  generatorConfig,
  onChangeGeneratorConfig,
  nextStepDefaults,
  onChangeNextStepDefault,
  onConsultAdvanced,
}: {
  process: Process
  generatorConfig: SubstrateGeneratorConfig
  onChangeGeneratorConfig: (patch: Partial<SubstrateGeneratorConfig>) => void
  nextStepDefaults: Record<number, string>
  onChangeNextStepDefault: (stageIndex: number, value: string) => void
  /** Called the first time the user opens the advanced substrate settings.
   *  Once consulted, newly added substrates are auto-named from the generator
   *  config; before that they start blank so the user is prompted to name
   *  each one directly in the table. */
  onConsultAdvanced: () => void
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
          onClick={() =>
            setShowDetails((v) => {
              const next = !v
              if (next) onConsultAdvanced()
              return next
            })
          }
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
// Processing sub-box — one of the three guided sections (Substrates, Processing
// times, Parameter variation). Turns green once `done`.
// ─────────────────────────────────────────────────────────────────────────────

function ProcessingSubBox({
  index,
  title,
  subtitle,
  done,
  children,
}: {
  index: number
  title: string
  subtitle: string
  done: boolean
  children: React.ReactNode
}) {
  return (
    <Paper
      withBorder
      p="md"
      radius="md"
      style={{
        borderColor: done ? "var(--mantine-color-teal-5)" : undefined,
        background: done
          ? "light-dark(var(--mantine-color-teal-0), var(--mantine-color-teal-9))"
          : undefined,
        transition: "background 150ms, border-color 150ms",
      }}
    >
      <Group gap="sm" mb="sm" wrap="nowrap" align="flex-start">
        <ThemeIcon
          radius="xl"
          size={28}
          color={done ? "teal" : "blue"}
          variant={done ? "filled" : "light"}
          style={{ flexShrink: 0 }}
        >
          {done ? <IconCheck size={16} /> : <Text fw={700}>{index}</Text>}
        </ThemeIcon>
        <Box>
          <Text size="sm" fw={700}>
            {title}
          </Text>
          <Text size="xs" c="dimmed">
            {subtitle}
          </Text>
        </Box>
      </Group>
      {children}
    </Paper>
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
  advancedConsulted,
  onUpdate,
  onUpdateProcess,
  onAddSingleSubstrate,
}: {
  experiment: Experiment
  process: Process
  substrateMaterialOptions: SubstrateMaterialOption[]
  generatorConfig: SubstrateGeneratorConfig
  nextStepDefaults: Record<number, string>
  /** When false, added substrates start unnamed and their name fields buzz to
   *  prompt manual entry; when true they are auto-named from the generator. */
  advancedConsulted: boolean
  onUpdate: (exp: Experiment) => void
  onUpdateProcess: (process: Process) => void
  onAddSingleSubstrate: () => void
}) {
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

  // Commit the given name onto a substrate AND append a fresh one, in a single
  // update. Doing both in one `onUpdate` avoids the two-write clobber where an
  // add built from stale state would overwrite the just-typed name. Used by the
  // Enter/Tab "type a name, jump to the next" flow — the new row is focused via
  // pendingFocusNewSubstrate so, when unnamed, it keeps buzzing for input.
  const commitNameAndAddSubstrate = (substrateId: string, name: string) => {
    const renamed = experiment.substrates.map((substrate) =>
      substrate.id === substrateId ? { ...substrate, name } : substrate,
    )
    const newSubstrate = {
      id: crypto.randomUUID(),
      name: advancedConsulted
        ? buildGeneratedSubstrateName(
            renamed.length + 1,
            experiment,
            generatorConfig,
          )
        : "",
      substrateMaterialId: substrateMaterialOptions[0]?.value,
      parameterValues: buildDefaultStageValues(),
    }
    pendingFocusNewSubstrate.current = true
    onUpdate({
      ...experiment,
      numSubstrates: renamed.length + 1,
      substrates: [...renamed, newSubstrate],
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

  // ── Processing-time "stacks" ────────────────────────────────────────────
  // Substrates that follow different alternatives at some stage need their
  // own timing from the moment they diverge; before that, timing is shared.
  const processingStacks = React.useMemo(
    () => buildProcessingStacks(experiment, process),
    [experiment, process],
  )
  const processingDivergeIdx = React.useMemo(
    () => findDivergeIdx(processingStacks),
    [processingStacks],
  )
  const processingDecisiveStageIndices = React.useMemo(
    () => findDecisiveStageIndices(processingStacks, processingDivergeIdx),
    [processingStacks, processingDivergeIdx],
  )
  const processingCtx = React.useMemo(
    () => ({
      processingTimes: experiment.processingTimes ?? {},
      divergeIdx: processingDivergeIdx,
      stackOrder: processingStacks.map((s) => s.key),
    }),
    [experiment.processingTimes, processingDivergeIdx, processingStacks],
  )
  const processingRegressions = React.useMemo(
    () =>
      findProcessingTimeRegressions(
        process,
        processingStacks,
        processingDivergeIdx,
        processingCtx.processingTimes,
      ),
    [process, processingStacks, processingDivergeIdx, processingCtx],
  )
  const handleProcessingAsAboveToggle = useCallback(
    (key: string, checked: boolean) =>
      handleProcessingTimeChange(key, checked ? "true" : ""),
    [handleProcessingTimeChange],
  )

  // Combine a date part and a time part back into a stored `datetime-local`
  // value: keep the date alone while the time is still missing (so the cell
  // stays "incomplete" and keeps buzzing), and only join them once both exist.
  const handleProcessingDateTimeChange = useCallback(
    (cellKey: string, date: string, time: string) => {
      const combined = date && time ? `${date}T${time}` : date ? date : ""
      handleProcessingTimeChange(cellKey, combined)
    },
    [handleProcessingTimeChange],
  )

  // ── Parameter-variation Yes/No ───────────────────────────────────────────
  const storedVariationChoice = variationChoiceOf(experiment)
  const handleVariationChoice = useCallback(
    (choice: "yes" | "no" | null) =>
      handleProcessingTimeChange(VARIATION_CHOICE_KEY, choice ?? ""),
    [handleProcessingTimeChange],
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

  // ── Three-sub-box completion flags (Substrates → Times → Variation) ───────
  const substratesDone = experimentSubstratesDone(experiment)
  const timesDone = experimentProcessingTimesDone(experiment, process)
  const variationDone = experimentVariationDone(experiment, process)
  const hasVariations = variationColumns.length > 0
  // Existing experiments that already have variation columns are treated as an
  // implicit "Yes" so they show the editor without re-asking the question.
  const variationChoice: "yes" | "no" | null =
    storedVariationChoice ?? (hasVariations ? "yes" : null)

  const thStyle: React.CSSProperties = {
    padding: "12px 8px",
    textAlign: "left",
    fontWeight: 600,
    borderBottom:
      "2px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
  }

  return (
    <Stack gap="md">
      {/* ── Sub-box 1: Substrates ───────────────────────────────────────── */}
      <ProcessingSubBox
        index={1}
        title="Substrates"
        subtitle="Name at least one substrate and choose the process step it followed."
        done={substratesDone}
      >
        <Box style={{ overflowX: "auto" }}>
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
              <tr
                style={{
                  background:
                    "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-5))",
                }}
              >
                <th style={{ ...thStyle, textAlign: "center", minWidth: 46 }}>
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
                <th style={{ ...thStyle, minWidth: 150 }}>Substrate</th>
                <th style={{ ...thStyle, minWidth: 170 }}>Material</th>
                {process.stages.map((stage, idx) => (
                  <th
                    key={`h-stage-${idx}`}
                    style={{ ...thStyle, minWidth: 180 }}
                  >
                    <Group gap="xs" wrap="nowrap">
                      <Text size="sm">#{idx + 1} Step</Text>
                      {stage.alternatives.length > 1 && (
                        <Badge size="xs" variant="light" color="orange">
                          {stage.alternatives.length} options
                        </Badge>
                      )}
                    </Group>
                  </th>
                ))}
                <th style={{ ...thStyle, textAlign: "center", minWidth: 80 }}>
                  Action
                </th>
              </tr>
            </thead>
            <tbody>
              {experiment.substrates.map((substrate, substrateIndex) => (
                <tr
                  key={substrate.id}
                  style={{
                    borderBottom:
                      "1px solid light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4))",
                  }}
                >
                  <td
                    style={{
                      padding: "8px 8px",
                      textAlign: "center",
                      background:
                        "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))",
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
                      background:
                        "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))",
                    }}
                  >
                    <DeferredTextInput
                      ref={nameRefCallbacks[substrateIndex]}
                      size="xs"
                      value={substrate.name}
                      placeholder="Name Substrate..."
                      pulseWhenEmpty
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
                          if (isLast) {
                            commitNameAndAddSubstrate(
                              substrate.id,
                              e.currentTarget.value,
                            )
                          } else {
                            handleSubstrateNameChange(
                              substrate.id,
                              e.currentTarget.value,
                            )
                            focusNameInput(currentIndex + 1)
                          }
                        }
                        if (e.key === "Tab") {
                          e.preventDefault()
                          if (!e.shiftKey && isLast) {
                            commitNameAndAddSubstrate(
                              substrate.id,
                              e.currentTarget.value,
                            )
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
                      background:
                        "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))",
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
                      style={{ padding: "8px 4px" }}
                    >
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
                  ))}
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

              {/* Ghost add row */}
              <tr
                onClick={() => {
                  pendingFocusNewSubstrate.current = true
                  onAddSingleSubstrate()
                }}
                onMouseEnter={() => setAddRowHovered(true)}
                onMouseLeave={() => setAddRowHovered(false)}
                style={{
                  cursor: "pointer",
                  background: addRowHovered
                    ? "light-dark(var(--mantine-color-blue-0), var(--mantine-color-dark-5))"
                    : undefined,
                  transition: "background 100ms",
                  borderTop: `1px dashed ${addRowHovered ? "var(--mantine-color-blue-3)" : "light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))"}`,
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
            </tbody>
          </table>
        </Box>
      </ProcessingSubBox>

      {/* ── Sub-box 2: Processing times ─────────────────────────────────── */}
      {substratesDone && (
        <ProcessingSubBox
          index={2}
          title="Processing times"
          subtitle="Give every step a date and a time. The date auto-fills from the step before — you only need to add the time. Steps may share the same time."
          done={timesDone}
        >
          {(() => {
            const hasDivergence =
              processingDivergeIdx >= 0 && processingStacks.length > 1
            const rows: Array<{
              rowKey: string
              stackKey: string | null
              isShared: boolean
              rowIndexAmongStacks: number
              ownFrom: number
              ownTo: number
            }> = hasDivergence
              ? [
                  {
                    rowKey: "shared",
                    stackKey: null,
                    isShared: true,
                    rowIndexAmongStacks: -1,
                    ownFrom: 0,
                    ownTo: processingDivergeIdx,
                  },
                  ...processingStacks.map((stack, rowIndexAmongStacks) => ({
                    rowKey: stack.key,
                    stackKey: stack.key,
                    isShared: false,
                    rowIndexAmongStacks,
                    ownFrom: processingDivergeIdx,
                    ownTo: process.stages.length,
                  })),
                ]
              : [
                  {
                    rowKey: "shared",
                    stackKey: null,
                    isShared: true,
                    rowIndexAmongStacks: -1,
                    ownFrom: 0,
                    ownTo: process.stages.length,
                  },
                ]

            return (
              <Box style={{ overflowX: "auto" }}>
                <table
                  style={{
                    borderCollapse: "collapse",
                    width: "100%",
                    fontSize: "14px",
                  }}
                >
                  <thead>
                    <tr
                      style={{
                        background:
                          "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-5))",
                      }}
                    >
                      <th style={{ ...thStyle, minWidth: 200 }}>Step</th>
                      {process.stages.map((_stage, idx) => (
                        <th
                          key={`ptime-h-${idx}`}
                          style={{ ...thStyle, minWidth: 250 }}
                        >
                          #{idx + 1} Step
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={row.rowKey}
                        style={{
                          borderBottom:
                            "1px solid light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4))",
                        }}
                      >
                        <td style={{ padding: "10px 8px" }}>
                          {row.isShared ? (
                            <Text size="sm" fw={600}>
                              Processing Times{" "}
                              <Text component="span" c="red.6" fw={700}>
                                *
                              </Text>
                            </Text>
                          ) : (
                            <Group gap={4} wrap="nowrap">
                              <Text size="xs" c="dimmed">
                                ↳
                              </Text>
                              <Text size="xs" fw={600}>
                                {stackRowLabel(
                                  processingStacks[row.rowIndexAmongStacks],
                                  process,
                                  processingDecisiveStageIndices,
                                )}
                              </Text>
                              <Text
                                component="span"
                                c="red.6"
                                fw={700}
                                size="xs"
                              >
                                *
                              </Text>
                            </Group>
                          )}
                        </td>
                        {process.stages.map((_stage, idx) => {
                          const owned = idx >= row.ownFrom && idx < row.ownTo
                          const resolvedValue = resolveProcessingTime(
                            idx,
                            row.stackKey,
                            processingCtx,
                          )
                          if (!owned) {
                            return (
                              <td
                                key={`ptime-${row.rowKey}-${idx}`}
                                style={{
                                  padding: "8px 4px",
                                  background:
                                    "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-5))",
                                }}
                              >
                                <Text size="xs" c="dimmed" ta="center">
                                  {resolvedValue
                                    ? resolvedValue.replace("T", " ")
                                    : "—"}
                                </Text>
                              </td>
                            )
                          }
                          const cellKey = processingTimeKey(idx, row.stackKey)
                          const asAboveKey = row.stackKey
                            ? processingAsAboveKey(idx, row.stackKey)
                            : null
                          const canUseAsAbove =
                            asAboveKey !== null && row.rowIndexAmongStacks > 0
                          const isAsAbove =
                            canUseAsAbove &&
                            processingCtx.processingTimes[asAboveKey!] ===
                              "true"
                          const isFlagged = processingRegressions.has(cellKey)
                          const dateVal = datePart(resolvedValue)
                          const timeVal = timePart(resolvedValue)
                          return (
                            <td
                              key={`ptime-${row.rowKey}-${idx}`}
                              style={{ padding: "8px 4px" }}
                            >
                              <Stack gap={4}>
                                {isAsAbove ? (
                                  <Text size="xs" c="dimmed" ta="center">
                                    {resolvedValue
                                      ? resolvedValue.replace("T", " ")
                                      : "—"}
                                  </Text>
                                ) : (
                                  <Group
                                    gap={4}
                                    wrap="nowrap"
                                    align="flex-start"
                                  >
                                    <DeferredTextInput
                                      size="xs"
                                      type="date"
                                      pulseWhenEmpty
                                      value={dateVal}
                                      onBlur={(value) =>
                                        handleProcessingDateTimeChange(
                                          cellKey,
                                          value,
                                          timeVal,
                                        )
                                      }
                                      style={{ minWidth: 130 }}
                                    />
                                    <DeferredTextInput
                                      size="xs"
                                      type="time"
                                      pulseWhenEmpty
                                      value={timeVal}
                                      onBlur={(value) =>
                                        handleProcessingDateTimeChange(
                                          cellKey,
                                          dateVal,
                                          value,
                                        )
                                      }
                                      style={{ minWidth: 105 }}
                                      styles={
                                        isFlagged
                                          ? {
                                              input: {
                                                borderColor:
                                                  "var(--mantine-color-red-5)",
                                              },
                                            }
                                          : undefined
                                      }
                                    />
                                  </Group>
                                )}
                                {isFlagged && !isAsAbove && (
                                  <Text size="10px" c="red.6">
                                    Earlier than the previous step
                                  </Text>
                                )}
                                {canUseAsAbove && (
                                  <Checkbox
                                    size="xs"
                                    label="As above"
                                    checked={isAsAbove}
                                    onChange={(e) =>
                                      handleProcessingAsAboveToggle(
                                        asAboveKey!,
                                        e.currentTarget.checked,
                                      )
                                    }
                                  />
                                )}
                              </Stack>
                            </td>
                          )
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Box>
            )
          })()}
        </ProcessingSubBox>
      )}

      {/* ── Sub-box 3: Parameter variation ──────────────────────────────── */}
      {substratesDone && timesDone && (
        <ProcessingSubBox
          index={3}
          title="Parameter variation"
          subtitle="Did you vary a process parameter across substrates during this experiment?"
          done={variationDone}
        >
          {variationChoice === null ? (
            <Group gap="sm">
              <Button
                variant="light"
                color="blue"
                onClick={() => handleVariationChoice("yes")}
              >
                Yes, I varied a parameter
              </Button>
              <Button
                variant="default"
                onClick={() => handleVariationChoice("no")}
              >
                No, all substrates used the same parameters
              </Button>
            </Group>
          ) : variationChoice === "no" ? (
            <Group justify="space-between" wrap="nowrap">
              <Text size="sm" c="dimmed">
                No parameter variation — every substrate used the same process
                parameters.
              </Text>
              <Button
                size="xs"
                variant="subtle"
                onClick={() => handleVariationChoice("yes")}
              >
                Actually, I varied a parameter
              </Button>
            </Group>
          ) : (
            <Stack gap="md">
              {!hasVariations && (
                <Alert
                  variant="light"
                  color="orange"
                  icon={<IconInfoCircle size={18} />}
                >
                  Add at least one parameter variation below, or switch back to
                  "No" if nothing was varied.
                </Alert>
              )}

              {/* Add-variation control — pulses while no variation exists yet */}
              <Box
                className={!hasVariations ? "exp-pulse" : undefined}
                p={!hasVariations ? "xs" : 0}
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
                  <Button
                    size="compact-xs"
                    variant="subtle"
                    color="gray"
                    onClick={() => handleVariationChoice("no")}
                  >
                    No variation after all
                  </Button>
                </Group>
              </Box>

              {hasVariations && (
                <Box style={{ overflowX: "auto" }}>
                  <table
                    style={{
                      borderCollapse: "collapse",
                      width: "100%",
                      fontSize: "14px",
                    }}
                  >
                    <thead>
                      <tr
                        style={{
                          background:
                            "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-5))",
                        }}
                      >
                        <th style={{ ...thStyle, minWidth: 150 }}>Substrate</th>
                        {variationColumns.map((col) => (
                          <th
                            key={`var-h-${col.stepId}-${col.paramKey}`}
                            style={{ ...thStyle, minWidth: 190 }}
                          >
                            <Group
                              justify="space-between"
                              gap="xs"
                              wrap="nowrap"
                            >
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
                      </tr>
                    </thead>
                    <tbody>
                      {experiment.substrates.map((substrate) => (
                        <tr
                          key={`var-row-${substrate.id}`}
                          style={{
                            borderBottom:
                              "1px solid light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4))",
                          }}
                        >
                          <td style={{ padding: "10px 8px", fontWeight: 500 }}>
                            {substrate.name || (
                              <Text component="span" c="dimmed" fs="italic">
                                (unnamed)
                              </Text>
                            )}
                          </td>
                          {variationColumns.map((col) => {
                            const key = `${col.stepId}:${col.paramKey}`
                            const editable = isVariationCellEditable(
                              substrate.id,
                              col.stageIndex,
                              col.stepId,
                            )
                            return (
                              <td
                                key={`var-${substrate.id}-${key}`}
                                style={{ padding: "8px 4px" }}
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
                                      col.stepId,
                                      col.paramKey,
                                      value,
                                    )
                                  }
                                />
                              </td>
                            )
                          })}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </Box>
              )}
            </Stack>
          )}
        </ProcessingSubBox>
      )}
    </Stack>
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
                      : "light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
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
                background:
                  "light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
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
// Experiment-level result drop zone (shown on every tab, at the bottom)
//
// The single ingress into the upload flow — dropping files here starts it
// directly (there is no separate "Add Results" button). Neutral gray while
// the experiment is still incomplete; teal once it is fully specified, to
// invite the drop; red when an upload is already in progress (for this
// experiment → drop adds to it; for another → refused). Uses native DOM drag
// handlers, never a Mantine Dropzone, to avoid merged-ref render loops.
// ─────────────────────────────────────────────────────────────────────────────

function ExperimentUploadDropZone({
  belongsToThisExperiment,
  hasOtherUpload,
  fullySpecified,
  onFiles,
}: {
  belongsToThisExperiment: boolean
  hasOtherUpload: boolean
  fullySpecified: boolean
  onFiles: (files: File[]) => void
}) {
  const [dragOver, setDragOver] = useState(false)
  const blocked = belongsToThisExperiment || hasOtherUpload
  const ready = !blocked && fullySpecified
  const borderColor = dragOver
    ? "var(--mantine-color-blue-5)"
    : blocked
      ? "var(--mantine-color-red-4)"
      : ready
        ? "var(--mantine-color-teal-4)"
        : "var(--mantine-color-gray-4)"
  const label = belongsToThisExperiment
    ? "Upload in progress for this experiment — drop more files to add them to the archive."
    : hasOtherUpload
      ? "Another upload is still in progress — finish or cancel it before starting a new one."
      : ready
        ? "Experiment completely specified: Drop Results"
        : "Drag & drop result files here to start an upload."
  return (
    <Box
      mt="xl"
      onDragOver={(e: React.DragEvent<HTMLDivElement>) => {
        if (!e.dataTransfer.types.includes("Files")) {
          return
        }
        e.preventDefault()
        setDragOver(true)
      }}
      onDragLeave={(e: React.DragEvent<HTMLDivElement>) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) {
          setDragOver(false)
        }
      }}
      onDrop={(e: React.DragEvent<HTMLDivElement>) => {
        if (!e.dataTransfer.files || e.dataTransfer.files.length === 0) {
          return
        }
        e.preventDefault()
        setDragOver(false)
        // Expand dropped folders into their files (snapshot synchronously — the
        // DataTransfer is neutered once this handler returns).
        void filesFromDataTransfer(e.dataTransfer).then(onFiles)
      }}
      style={{
        border: `2px dashed ${borderColor}`,
        borderRadius: 8,
        padding: "20px 16px",
        textAlign: "center",
        background: dragOver
          ? "light-dark(var(--mantine-color-blue-0), var(--mantine-color-dark-5))"
          : blocked
            ? "light-dark(var(--mantine-color-red-0), var(--mantine-color-red-9))"
            : ready
              ? "light-dark(var(--mantine-color-teal-0), var(--mantine-color-teal-9))"
              : "transparent",
        transition: "border 120ms ease, background 120ms ease",
      }}
    >
      <Group justify="center" gap="xs" wrap="nowrap">
        <IconCloudUpload
          size={20}
          color={
            blocked
              ? "var(--mantine-color-red-6)"
              : ready
                ? "var(--mantine-color-teal-6)"
                : "var(--mantine-color-gray-6)"
          }
        />
        <Text
          size="sm"
          c={blocked ? "red.7" : ready ? "teal.7" : "dimmed"}
          fw={blocked || ready ? 600 : 500}
        >
          {label}
        </Text>
      </Group>
    </Box>
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
        const vial = s.vialLabel ? `, vial ${s.vialLabel}` : ""
        lines.push(
          `  ${s.name}${s.volumeMl ? ` (${s.volumeMl} mL)` : ""}${at}${vial}:`,
        )
        for (const q of s.quantities) {
          lines.push(`    - ${q.name}: ${q.amount} ${q.unit}`)
        }
      }
    }
  }
  return lines.join("\n")
}

function SummaryTab({
  experiment,
  process,
  allExperiments,
  onUpdate,
  onConfirmSummary,
}: {
  experiment: Experiment
  process: Process
  allExperiments: Experiment[]
  onUpdate: (exp: Experiment) => void
  onConfirmSummary: () => void
}) {
  const [copied, setCopied] = useState(false)
  const [includeFullProcess, setIncludeFullProcess] = useState(false)
  const [isExportingPdf, setIsExportingPdf] = useState(false)

  const { materials, solutions } = React.useMemo(
    () => buildChemicalsExport(experiment, process, allExperiments),
    [experiment, process, allExperiments],
  )

  // Derived from the Processing tab's times — offered as one-click suggestions
  // rather than silently auto-filled, so a real user action still commits them.
  const processingRange = React.useMemo(
    () => computeProcessingTimeRange(experiment, process),
    [experiment, process],
  )
  const suggestedStart = processingRange?.start.slice(0, 10)
  const suggestedEnd = processingRange?.end.slice(0, 10)

  const exportPdf = async () => {
    try {
      setIsExportingPdf(true)
      await exportExperimentSummaryAsPdf({
        experiment,
        process,
        materials: [],
        solutions: [],
        chemicals: materials,
        solutionRows: solutions,
        includeFullProcess,
      })
    } catch (error) {
      console.error("Failed to export experiment PDF", error)
      window.alert("Failed to export experiment PDF. Please try again.")
    } finally {
      setIsExportingPdf(false)
    }
  }

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
          {!experiment.date && suggestedStart && (
            <Group gap={4} mt={4}>
              <Text size="xs" c="dimmed">
                Suggested from processing times: {suggestedStart}
              </Text>
              <Button
                size="compact-xs"
                variant="subtle"
                onClick={() =>
                  onUpdate({ ...experiment, date: suggestedStart })
                }
              >
                Use
              </Button>
            </Group>
          )}
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
          {!experiment.endDate && suggestedEnd && (
            <Group gap={4} mt={4}>
              <Text size="xs" c="dimmed">
                Suggested from processing times: {suggestedEnd}
              </Text>
              <Button
                size="compact-xs"
                variant="subtle"
                onClick={() =>
                  onUpdate({ ...experiment, endDate: suggestedEnd })
                }
              >
                Use
              </Button>
            </Group>
          )}
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
            background:
              "light-dark(var(--mantine-color-teal-0), var(--mantine-color-teal-9))",
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
              : "light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
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
              onClick={onConfirmSummary}
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
              onClick={exportPdf}
              loading={isExportingPdf}
            >
              Export PDF
            </Button>
          </Group>
        </Group>

        <Checkbox
          size="xs"
          mb="md"
          label="Include full process protocol before the experiment details"
          checked={includeFullProcess}
          onChange={(e) => setIncludeFullProcess(e.currentTarget.checked)}
        />

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
                            ? `${s.volumeMl} mL${s.preparedAt ? ` · ${s.preparedAt}` : ""}${s.vialLabel ? ` · ${s.vialLabel}` : ""}`
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
    trashEntity,
    flushSave,
    activeCollectionId,
    activePlaneId,
    setActivePlaneId,
    setActiveCollectionId,
    addCollectionElement,
    pendingCollectionLink,
    setPendingCollectionLink,
    startUploadFlow,
    uploadFlow,
    addFilesToUploadFlow,
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
  // Whether the user has opened the advanced substrate settings. Until they do,
  // newly added substrates start unnamed so their name fields buzz to prompt
  // manual entry rather than silently receiving an auto-generated name.
  const [advancedConsulted, setAdvancedConsulted] = useState(false)

  const experimentNameInputRef = useRef<HTMLInputElement | null>(null)
  const [pendingSelectExperimentNameId, setPendingSelectExperimentNameId] =
    useState<string | null>(null)

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
    setPendingSelectExperimentNameId(newExp.id)

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

  // Focus and select the name field whenever a fresh experiment (created or
  // copied) becomes selected, so the placeholder name is ready for the user
  // to type over immediately.
  React.useEffect(() => {
    if (!selectedExpId || pendingSelectExperimentNameId !== selectedExpId) {
      return
    }
    // Clear the pending flag INSIDE the rAF callback, not synchronously here:
    // a synchronous state reset re-runs this effect and fires its cleanup
    // (cancelAnimationFrame) before the frame paints, cancelling the select.
    const raf = window.requestAnimationFrame(() => {
      const input = experimentNameInputRef.current
      if (input) {
        input.focus()
        input.select()
      }
      setPendingSelectExperimentNameId(null)
    })
    return () => window.cancelAnimationFrame(raf)
  }, [pendingSelectExperimentNameId, selectedExpId])

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
    setPendingSelectExperimentNameId(newExp.id)
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

  // Results already exist for this experiment — just select it on the
  // Results page rather than starting a new upload flow.
  const handleGoToResultsForExperiment = useCallback(
    (exp: Experiment) => {
      setPendingCollectionLink({
        collectionId: "",
        planeId: "",
        kind: "result",
        selectedExperimentId: exp.id,
        openAddResults: false,
        requestId: crypto.randomUUID(),
      })
      setActiveEntity({ kind: "experiment", id: exp.id })
      updateLastSelected("experiment", exp.id)
      void navigate({ to: "/results" })
    },
    [navigate, setActiveEntity, setPendingCollectionLink, updateLastSelected],
  )

  // Update experiment
  const handleUpdateExperiment = useCallback(
    (exp: Experiment) => {
      setExperiments((prev) => prev.map((e) => (e.id === exp.id ? exp : e)))
    },
    [setExperiments],
  )

  // Confirming the summary (Step 3) is what makes an experiment "fully
  // specified". If files were already dropped onto this experiment's upload
  // zone earlier (while it was still incomplete), that upload flow has been
  // sitting idle waiting for this moment — confirming now completes the same
  // hand-off to Results/Upload that a fresh drop would trigger once the
  // experiment is already complete.
  const handleConfirmSummary = useCallback(
    (exp: Experiment) => {
      handleUpdateExperiment({ ...exp, summaryConfirmed: true })
      if (uploadFlow?.experimentId !== exp.id) {
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
      handleUpdateExperiment,
      uploadFlow,
      navigate,
      setActiveEntity,
      setPendingCollectionLink,
      updateLastSelected,
    ],
  )

  // Files dropped straight onto an experiment (the bottom drop zone). Starts a
  // flow carrying the real bytes; it naturally lands at 2/3 when the experiment
  // is fully specified (only Upload left) or 1/3 when it isn't — the step state
  // is derived by getUploadFlowSteps, so no manual step handling here.
  const handleExperimentFilesDrop = useCallback(
    (exp: Experiment, files: File[]) => {
      if (files.length === 0) {
        return
      }
      if (uploadFlow) {
        if (uploadFlow.experimentId === exp.id) {
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
      const process = processes.find((p) => p.id === exp.processId)
      const fullySpecified = getExperimentAllStepsDone(exp, process)
      // Register the ongoing upload on the experiment's home collection so the
      // Organization canvas shows the "incomplete upload" marker there — exactly
      // as if the files had been dropped onto that collection.
      const home = homeCollectionForEntity(planes, "experiment", exp.id)
      const started = startUploadFlow({
        origin: "add-results",
        processId: exp.processId,
        experimentId: exp.id,
        files,
        pendingFiles: files.map((f) => ({ name: f.name, size: f.size })),
        targetCollectionId: home?.collectionId ?? null,
        targetPlaneId: home?.planeId ?? null,
      })
      if (!started) {
        return
      }
      if (fullySpecified) {
        // Complete → go straight to Results & Upload (opens Step 2 via the
        // carried files, reusing the Req 2 path).
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
      } else {
        notifications.show({
          title: "Upload started",
          message:
            "Finish specifying this experiment (chemicals, substrates, summary) to upload its results.",
          color: "yellow",
        })
      }
    },
    [
      uploadFlow,
      addFilesToUploadFlow,
      processes,
      planes,
      startUploadFlow,
      setPendingCollectionLink,
      setActiveEntity,
      updateLastSelected,
      navigate,
    ],
  )

  // Import from Upload (Processing tab): create substrates from the recognized
  // group names in the active upload's staged file names.
  const handleImportSubstratesFromUpload = useCallback(() => {
    if (!selectedExperiment || !uploadFlow) {
      return
    }
    const names = recognizeGroupNames(
      (uploadFlow.pendingFiles ?? []).map((f) => f.name),
    )
    const created = buildSubstratesFromNames(
      selectedExperiment.substrates,
      names,
      substrateMaterialOptions[0]?.value,
    )
    if (created.length === 0) {
      notifications.show({
        title: "Nothing to import",
        message:
          names.length === 0
            ? "No substrate names were recognized in the uploaded files."
            : "All recognized substrate names already exist.",
        color: "yellow",
      })
      return
    }
    handleUpdateExperiment({
      ...selectedExperiment,
      substrates: [...selectedExperiment.substrates, ...created],
      numSubstrates: selectedExperiment.substrates.length + created.length,
    })
    notifications.show({
      title: "Substrates imported",
      message: `Added ${created.length} substrate${
        created.length === 1 ? "" : "s"
      } from the uploaded files.`,
      color: "green",
    })
  }, [
    selectedExperiment,
    uploadFlow,
    handleUpdateExperiment,
    substrateMaterialOptions,
  ])

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
      // Leave the name blank (buzzing for manual entry) until the user has
      // consulted the advanced settings that drive auto-naming.
      name: advancedConsulted
        ? buildGeneratedSubstrateName(
            selectedExperiment.substrates.length + 1,
            selectedExperiment,
            generatorConfig,
          )
        : "",
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
    advancedConsulted,
    substrateMaterialOptions,
    handleUpdateExperiment,
  ])

  // Delete experiment
  const handleDeleteExperiment = (expId: string) => {
    modals.openConfirmModal({
      title: "Delete Experiment?",
      children: (
        <Text size="sm">
          This experiment (and its results) will be moved to the Trash. You can
          restore it from there.
        </Text>
      ),
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        // Flush first so the backend has the experiment's current placement,
        // then soft-delete it (records where to restore it to).
        try {
          await flushSave()
          await trashEntity("experiment", expId)
        } catch (err) {
          console.error("[Experiments] trash failed:", err)
        }
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
    setPendingSelectExperimentNameId(copy.id)

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
          background:
            "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))",
          borderRight:
            "1px solid light-dark(var(--mantine-color-gray-2), var(--mantine-color-dark-4))",
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
                          ? "light-dark(var(--mantine-color-blue-0), var(--mantine-color-dark-5))"
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
                            {expAllStepsDoneMap.get(exp.id) &&
                              (exp.hasResults ? (
                                <Tooltip label="Go to Results" withArrow>
                                  <ActionIcon
                                    size="sm"
                                    variant="subtle"
                                    color="blue"
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleGoToResultsForExperiment(exp)
                                    }}
                                  >
                                    <IconArrowRight size={14} />
                                  </ActionIcon>
                                </Tooltip>
                              ) : (
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
                              ))}
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
                              aria-label="Delete experiment"
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
                    ref={experimentNameInputRef}
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
                    style={{
                      background:
                        "light-dark(var(--mantine-color-blue-0), var(--mantine-color-dark-5))",
                    }}
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
              const procDone = experimentProcessingDone(
                selectedExperiment,
                selectedProcess,
              )
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
                      <Paper
                        withBorder
                        p="md"
                        radius="md"
                        style={
                          procDone
                            ? {
                                borderColor: "var(--mantine-color-teal-5)",
                                background:
                                  "light-dark(var(--mantine-color-teal-0), var(--mantine-color-teal-9))",
                                transition:
                                  "background 150ms, border-color 150ms",
                              }
                            : {
                                transition:
                                  "background 150ms, border-color 150ms",
                              }
                        }
                      >
                        <Group gap="xs" mb="md">
                          <IconLayersIntersect
                            size={18}
                            color="var(--mantine-color-blue-6)"
                          />
                          <Text size="sm" fw={700}>
                            Step 2: Please specify how many substrates you
                            prepared, what steps and parameters you use, and the
                            execution time of every step!
                          </Text>
                        </Group>

                        {/* Import substrate names from the active upload's
                            recognized file-name groups (or prompt for one). */}
                        {uploadFlow ? (
                          <Group justify="space-between" mb="md" wrap="nowrap">
                            <Text size="sm" c="dimmed">
                              Result files are staged — import their device
                              groups as substrates.
                            </Text>
                            <Button
                              color="red"
                              leftSection={<IconFileImport size={18} />}
                              onClick={handleImportSubstratesFromUpload}
                            >
                              Import from Upload
                            </Button>
                          </Group>
                        ) : (
                          <Alert
                            variant="light"
                            color="gray"
                            mb="md"
                            icon={<IconCloudUpload size={18} />}
                          >
                            No active upload. Drop result files onto the canvas
                            or this experiment to import substrate names from
                            them.
                          </Alert>
                        )}

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
                          onConsultAdvanced={() => setAdvancedConsulted(true)}
                        />
                        <ExperimentGrid
                          experiment={selectedExperiment}
                          process={selectedProcess}
                          substrateMaterialOptions={substrateMaterialOptions}
                          generatorConfig={generatorConfig}
                          nextStepDefaults={nextStepDefaults}
                          advancedConsulted={advancedConsulted}
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
                        onConfirmSummary={() =>
                          handleConfirmSummary(selectedExperiment)
                        }
                      />
                    </Paper>
                  )}

                  {/* Experiment-level upload ingress — present on every tab. */}
                  <ExperimentUploadDropZone
                    belongsToThisExperiment={
                      uploadFlow?.experimentId === selectedExperiment.id
                    }
                    hasOtherUpload={
                      uploadFlow != null &&
                      uploadFlow.experimentId !== selectedExperiment.id
                    }
                    fullySpecified={allStepsDone}
                    onFiles={(files) =>
                      handleExperimentFilesDrop(selectedExperiment, files)
                    }
                  />
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
