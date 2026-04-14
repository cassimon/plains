import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Card,
  Checkbox,
  Collapse,
  ColorSwatch,
  Divider,
  FileInput,
  Group,
  NumberInput,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Tabs,
  Text,
  Textarea,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core"
import { modals } from "@mantine/modals"
import {
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconFlask,
  IconInfoCircle,
  IconLayersLinked,
  IconPlus,
  IconRefresh,
  IconStack2,
  IconTrash,
  IconUpload,
  IconX,
} from "@tabler/icons-react"
import { useCallback, useEffect, useRef, useState } from "react"
import { DependencyBlockModal } from "../components/DependencyBlockModal"
import {
  type DeviceArchitecture,
  type Experiment,
  type ExperimentLayer,
  generateSubstrates,
  getDependentLocations,
  getExperimentMissingFields,
  getExperimentStatus,
  getVariedParameters,
  newExperiment,
  newLayer,
  type ParamMode,
  PROCESS_PARAMETER_DEFINITIONS,
  type ProcessParam,
  type ProcessParameterKey,
  regenerateSubstrateNames,
  type Substrate,
  useAppContext,
  useEntityCollection,
} from "../store/AppContext"

// ─────────────────────────────────────────────────────────────────────────────
// Buffered inputs — keep a local draft so parent only re-renders on commit
// ─────────────────────────────────────────────────────────────────────────────

/** TextInput that buffers locally and commits on blur / Enter. */
function BufferedTextInput({
  value,
  onCommit,
  ...rest
}: Omit<React.ComponentProps<typeof TextInput>, "value" | "onChange"> & {
  value: string
  onCommit: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const latest = useRef(value)
  // Sync when the external value changes (e.g. different experiment selected)
  useEffect(() => {
    if (value !== latest.current) {
      setDraft(value)
      latest.current = value
    }
  }, [value])

  const commit = useCallback(() => {
    if (draft !== latest.current) {
      latest.current = draft
      onCommit(draft)
    }
  }, [draft, onCommit])

  return (
    <TextInput
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          commit()
        }
        rest.onKeyDown?.(e)
      }}
    />
  )
}

/** Textarea that buffers locally and commits on blur. */
function BufferedTextarea({
  value,
  onCommit,
  ...rest
}: Omit<React.ComponentProps<typeof Textarea>, "value" | "onChange"> & {
  value: string
  onCommit: (v: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const latest = useRef(value)
  useEffect(() => {
    if (value !== latest.current) {
      setDraft(value)
      latest.current = value
    }
  }, [value])

  const commit = useCallback(() => {
    if (draft !== latest.current) {
      latest.current = draft
      onCommit(draft)
    }
  }, [draft, onCommit])

  return (
    <Textarea
      {...rest}
      value={draft}
      onChange={(e) => setDraft(e.currentTarget.value)}
      onBlur={commit}
    />
  )
}

/** NumberInput that buffers locally and commits on blur. */
function BufferedNumberInput({
  value,
  onCommit,
  ...rest
}: Omit<React.ComponentProps<typeof NumberInput>, "value" | "onChange"> & {
  value: number
  onCommit: (v: number) => void
}) {
  const [draft, setDraft] = useState<string | number>(value)
  const latest = useRef(value)
  useEffect(() => {
    if (value !== latest.current) {
      setDraft(value)
      latest.current = value
    }
  }, [value])

  const commit = useCallback(() => {
    const num = Number(draft) || 0
    if (num !== latest.current) {
      latest.current = num
      onCommit(num)
    }
  }, [draft, onCommit])

  return (
    <NumberInput
      {...rest}
      value={draft}
      onChange={(v) => setDraft(v as string | number)}
      onBlur={commit}
    />
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Device Stack Visualization
// ─────────────────────────────────────────────────────────────────────────────

function DeviceStackPreview({
  substrateMaterial,
  layers,
  architecture,
}: {
  substrateMaterial: string
  layers: ExperimentLayer[]
  architecture: DeviceArchitecture
}) {
  const LAYER_HEIGHT = 40
  const SUBSTRATE_HEIGHT = 50

  return (
    <Paper withBorder p="md" radius="md">
      <Group justify="space-between" mb="sm">
        <Text size="sm" fw={600}>
          Device Stack
        </Text>
        <Badge size="sm" variant="light" color="violet">
          {architecture}
        </Badge>
      </Group>

      <Box style={{ display: "flex", flexDirection: "column-reverse", gap: 2 }}>
        {/* Substrate at bottom */}
        <Box
          style={{
            background: "linear-gradient(135deg, #a8d5e5 0%, #74b9d0 100%)",
            height: SUBSTRATE_HEIGHT,
            borderRadius: 4,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid rgba(0,0,0,0.1)",
          }}
        >
          <Text size="xs" fw={600} c="dark">
            substrate: {substrateMaterial}
          </Text>
        </Box>

        {/* Layers stacked on top */}
        {layers.map((layer, idx) => {
          const typeMap: Record<string, string> = {
            etl: "ETL",
            htl: "HTL",
            perovskite: "Absorber",
            additional: "Additional",
            back_contact: "Back Contact",
          }
          const displayName = layer.layerType
            ? `${typeMap[layer.layerType]}: ${layer.name}`
            : layer.name

          return (
            <Box
              key={layer.id}
              style={{
                background: layer.color,
                height: LAYER_HEIGHT,
                borderRadius: 4,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                border: "1px solid rgba(0,0,0,0.1)",
                position: "relative",
              }}
            >
              <Text
                size="xs"
                fw={600}
                c="white"
                style={{ textShadow: "0 1px 2px rgba(0,0,0,0.3)" }}
              >
                {displayName}
              </Text>
              <Text
                size="10px"
                c="white"
                style={{
                  position: "absolute",
                  right: 6,
                  top: 2,
                  opacity: 0.7,
                }}
              >
                {idx + 1}
              </Text>
            </Box>
          )
        })}
      </Box>

      {layers.length === 0 && (
        <Text size="xs" c="dimmed" ta="center" mt="sm">
          Add layers to see the device stack
        </Text>
      )}
    </Paper>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Process Parameter Input with Constant/Variation toggle
// ─────────────────────────────────────────────────────────────────────────────

function ProcessParamInput({
  label,
  param,
  onChange,
  placeholder,
  unit,
  initialParam,
  sourceSuggestions = [],
  type = "text",
}: {
  label: string
  param?: ProcessParam
  onChange: (param: ProcessParam | undefined) => void
  placeholder?: string
  unit?: string
  initialParam?: ProcessParam
  sourceSuggestions?: Array<{ label: string; param: ProcessParam }>
  type?: "text" | "number" | "datetime-local"
}) {
  const hasValue = param && param.value !== ""
  const [expanded, setExpanded] = useState(hasValue)

  if (!expanded) {
    return (
      <Group gap={4} align="flex-start" wrap="wrap">
        <Button
          variant="subtle"
          size="xs"
          color="#70a970"
          leftSection={<IconPlus size={12} />}
          onClick={() => {
            setExpanded(true)
            onChange(initialParam ?? { value: "", mode: "constant" })
          }}
          style={{ justifyContent: "flex-start" }}
        >
          Add {label}
        </Button>

        {sourceSuggestions.map((source) => (
          <Button
            key={`${source.label}:${source.param.mode}:${source.param.value}`}
            variant="subtle"
            size="xs"
            color="green"
            leftSection={<IconPlus size={12} />}
            onClick={() => {
              setExpanded(true)
              onChange({ ...source.param })
            }}
            style={{ justifyContent: "flex-start" }}
          >
            as {source.label}
          </Button>
        ))}
      </Group>
    )
  }

  return (
    <Box>
      <Group gap="xs" mb={4}>
        <Text size="xs" fw={500}>
          {label}
        </Text>
        {unit && (
          <Text size="xs" c="dimmed">
            ({unit})
          </Text>
        )}
        <ActionIcon
          size="xs"
          variant="subtle"
          color="red"
          onClick={() => {
            setExpanded(false)
            onChange(undefined)
          }}
        >
          <IconX size={10} />
        </ActionIcon>
      </Group>

      <Group gap="xs">
        {type === "number" ? (
          <BufferedNumberInput
            size="xs"
            value={param?.value ? parseFloat(param.value) : 0}
            onCommit={(val) =>
              onChange({ ...param!, value: String(val ?? "") })
            }
            placeholder={placeholder}
            style={{ flex: 1 }}
            disabled={param?.mode === "variation"}
          />
        ) : type === "datetime-local" ? (
          <BufferedTextInput
            size="xs"
            type="datetime-local"
            value={param?.value ?? ""}
            onCommit={(v) => onChange({ ...param!, value: v })}
            style={{ flex: 1 }}
            disabled={param?.mode === "variation"}
          />
        ) : (
          <BufferedTextInput
            size="xs"
            value={param?.value ?? ""}
            onCommit={(v) => onChange({ ...param!, value: v })}
            placeholder={placeholder}
            style={{ flex: 1 }}
            disabled={param?.mode === "variation"}
          />
        )}

        <SegmentedControl
          size="xs"
          value={param?.mode ?? "constant"}
          onChange={(v) => onChange({ ...param!, mode: v as ParamMode })}
          data={[
            { label: "Const", value: "constant" },
            { label: "Vary", value: "variation" },
          ]}
        />
      </Group>

      {param?.mode === "variation" && (
        <Paper
          withBorder
          p="xs"
          mt="xs"
          style={{ background: "var(--mantine-color-yellow-0)" }}
        >
          <Text size="xs" c="dimmed">
            <IconInfoCircle size={12} style={{ verticalAlign: "middle" }} />{" "}
            Variation editor tab created. Define different values for different
            substrates there.
          </Text>
        </Paper>
      )}
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Layer Configuration Card
// ─────────────────────────────────────────────────────────────────────────────

function LayerCard({
  layer,
  index,
  priorLayers,
  onUpdate,
  onDelete,
  materials,
  solutions,
}: {
  layer: ExperimentLayer
  index: number
  priorLayers: ExperimentLayer[]
  onUpdate: (layer: ExperimentLayer) => void
  onDelete: () => void
  materials: { id: string; name: string }[]
  solutions: { id: string; name: string }[]
}) {
  const [expanded, setExpanded] = useState(true)
  const ABSOLUTE_TIME_KEYS: ProcessParameterKey[] = [
    "depositionStartTime",
    "annealingStartTime",
  ]

  const isAbsoluteTimeKey = (key: ProcessParameterKey) =>
    ABSOLUTE_TIME_KEYS.includes(key)

  const extractDatePart = (value: string): string | null => {
    const match = value.match(/^(\d{4}-\d{2}-\d{2})/)
    return match ? match[1] : null
  }

  const getDefaultAbsoluteTimeParam = (key: ProcessParameterKey): ProcessParam => {
    const lastLayer = priorLayers[priorLayers.length - 1]
    const otherKey =
      key === "depositionStartTime" ? "annealingStartTime" : "depositionStartTime"

    let datePart: string | null = null
    if (lastLayer) {
      datePart =
        (lastLayer[key]?.value && extractDatePart(lastLayer[key]!.value)) ||
        (lastLayer[otherKey]?.value && extractDatePart(lastLayer[otherKey]!.value)) ||
        null
    }

    if (!datePart) {
      for (let i = priorLayers.length - 1; i >= 0 && !datePart; i--) {
        const src = priorLayers[i]
        datePart =
          (src[key]?.value && extractDatePart(src[key]!.value)) ||
          (src[otherKey]?.value && extractDatePart(src[otherKey]!.value)) ||
          null
      }
    }

    const baseDate = datePart ?? new Date().toISOString().slice(0, 10)
    return { value: `${baseDate}T09:00`, mode: "constant" }
  }

  const abbreviateLayerName = (name: string, maxLength = 14) => {
    const trimmed = name.trim()
    if (!trimmed) {
      return "Unnamed"
    }
    return trimmed.length <= maxLength
      ? trimmed
      : `${trimmed.slice(0, maxLength - 1)}…`
  }

  const getSourceSuggestions = (key: ProcessParameterKey) => {
    if (isAbsoluteTimeKey(key)) {
      return []
    }

    const seen = new Set<string>()
    const suggestions: Array<{ label: string; param: ProcessParam }> = []

    // Walk backwards so recent layers win; duplicate values collapse to latest.
    for (let i = priorLayers.length - 1; i >= 0; i--) {
      const srcLayer = priorLayers[i]
      const srcParam = srcLayer[key]
      if (!srcParam || srcParam.value === "") {
        continue
      }

      const signature = `${srcParam.mode}::${srcParam.value}`
      if (seen.has(signature)) {
        continue
      }
      seen.add(signature)
      suggestions.push({
        label: abbreviateLayerName(srcLayer.name || `Layer ${i + 1}`),
        param: { ...srcParam },
      })
    }

    return suggestions
  }

  const updateParam =
    (key: ProcessParameterKey) => (param: ProcessParam | undefined) => {
      onUpdate({ ...layer, [key]: param })
    }

  // Count filled optional parameters
  const filledParams = PROCESS_PARAMETER_DEFINITIONS.filter(
    ({ key }) => layer[key]?.value,
  ).length

  return (
    <Card withBorder radius="md" p={0} style={{ overflow: "visible" }}>
      {/* Header */}
      <Group
        gap="sm"
        p="sm"
        style={{
          background: `linear-gradient(90deg, ${layer.color}22 0%, transparent 100%)`,
          cursor: "pointer",
        }}
        onClick={() => setExpanded(!expanded)}
      >
        <ColorSwatch color={layer.color} size={20} />
        <Text fw={600} style={{ flex: 1 }}>
          {layer.name || `Layer ${index + 1}`}
        </Text>

        {filledParams > 0 && (
          <Badge size="xs" variant="light" color="teal">
            {filledParams} params
          </Badge>
        )}

        <ActionIcon
          size="sm"
          variant="subtle"
          color="red"
          onClick={(e) => {
            e.stopPropagation()
            onDelete()
          }}
        >
          <IconTrash size={14} />
        </ActionIcon>

        {expanded ? (
          <IconChevronDown size={16} />
        ) : (
          <IconChevronRight size={16} />
        )}
      </Group>

      <Collapse in={expanded}>
        <Box p="sm" pt={0}>
          {/* Basic info */}
          <SimpleGrid cols={4} spacing="sm" mb="md">
            <BufferedTextInput
              size="xs"
              label="Layer Name"
              value={layer.name}
              onCommit={(v) => onUpdate({ ...layer, name: v })}
            />
            <Select
              size="xs"
              label="Layer Type"
              placeholder="Select type"
              data={[
                { value: "etl", label: "ETL" },
                { value: "htl", label: "HTL" },
                { value: "perovskite", label: "Absorber (Perovskite)" },
                { value: "additional", label: "Additional" },
                { value: "back_contact", label: "Back Contact" },
              ]}
              value={layer.layerType ?? null}
              onChange={(v) =>
                onUpdate({
                  ...layer,
                  layerType: v as
                    | "etl"
                    | "htl"
                    | "perovskite"
                    | "additional"
                    | "back_contact"
                    | undefined,
                })
              }
              clearable
            />
            <TextInput
              size="xs"
              label="Color"
              type="color"
              value={layer.color}
              onChange={(e) =>
                onUpdate({ ...layer, color: e.currentTarget.value })
              }
              style={{ width: 80 }}
            />
            <Select
              size="xs"
              label="Material"
              placeholder="Select or leave empty"
              data={materials.map((m) => ({
                value: m.id,
                label: m.name || "Unnamed",
              }))}
              value={layer.materialId ?? null}
              onChange={(v) =>
                onUpdate({ ...layer, materialId: v ?? undefined })
              }
              clearable
              searchable
            />
          </SimpleGrid>

          <Select
            size="xs"
            label="Solution"
            placeholder="Select or leave empty"
            data={solutions.map((s) => ({
              value: s.id,
              label: s.name || "Unnamed",
            }))}
            value={layer.solutionId ?? null}
            onChange={(v) => onUpdate({ ...layer, solutionId: v ?? undefined })}
            clearable
            searchable
            mb="md"
          />

          <Divider label="Process Parameters" labelPosition="center" mb="sm" />

          {/* Suggested parameters - show add buttons for missing ones */}
          <SimpleGrid cols={2} spacing="sm">
            {PROCESS_PARAMETER_DEFINITIONS.map(
              ({ key, label, placeholder, unit, type = "text" }) => (
                <ProcessParamInput
                  key={key}
                  label={label}
                  param={layer[key]}
                  onChange={updateParam(key)}
                  placeholder={placeholder}
                  unit={unit}
                  initialParam={
                    isAbsoluteTimeKey(key)
                      ? getDefaultAbsoluteTimeParam(key)
                      : undefined
                  }
                  sourceSuggestions={getSourceSuggestions(key)}
                  type={type}
                />
              ),
            )}
          </SimpleGrid>

          <BufferedTextarea
            size="xs"
            label="Notes"
            placeholder="Any additional notes for this layer..."
            value={layer.notes ?? ""}
            onCommit={(v) => onUpdate({ ...layer, notes: v })}
            mt="sm"
            minRows={2}
          />
        </Box>
      </Collapse>
    </Card>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Parameter Variation Tab
// ─────────────────────────────────────────────────────────────────────────────

function ParameterVariationTab({
  experiment,
  onUpdate,
}: {
  experiment: Experiment
  onUpdate: (exp: Experiment) => void
}) {
  const variedParams = getVariedParameters(experiment)
  const [selectedParamKeys, setSelectedParamKeys] = useState<Set<string>>(
    new Set(),
  )
  const [helperValue, setHelperValue] = useState("")
  const [helperCount, setHelperCount] = useState(1)
  const helperValueInputRef = useRef<HTMLInputElement>(null)

  const toggleParam = (paramKey: string) => {
    setSelectedParamKeys((prev) => {
      const next = new Set(prev)
      next.has(paramKey) ? next.delete(paramKey) : next.add(paramKey)
      return next
    })
  }

  const updateSubstrateParam = (
    substrateIndex: number,
    paramKey: string,
    value: string,
  ) => {
    const newSubstrates = [...experiment.substrates]
    newSubstrates[substrateIndex] = {
      ...newSubstrates[substrateIndex],
      parameterValues: {
        ...newSubstrates[substrateIndex].parameterValues,
        [paramKey]: value,
      },
    }
    onUpdate({ ...experiment, substrates: newSubstrates })
  }

  const applyHelperAssignment = () => {
    if (selectedParamKeys.size === 0 || !helperValue) {
      return
    }
    const newSubstrates = [...experiment.substrates]
    const keysToAssign = Array.from(selectedParamKeys)

    keysToAssign.forEach((paramKey) => {
      let assigned = 0
      for (let i = 0; i < newSubstrates.length && assigned < helperCount; i++) {
        const sub = newSubstrates[i]
        const paramValues = sub.parameterValues || {}
        if (!paramValues[paramKey] || paramValues[paramKey] === "") {
          newSubstrates[i] = {
            ...newSubstrates[i],
            parameterValues: {
              ...newSubstrates[i].parameterValues,
              [paramKey]: helperValue,
            },
          }
          assigned++
        }
      }
    })

    onUpdate({ ...experiment, substrates: newSubstrates })
    helperValueInputRef.current?.focus()
  }

  return (
    <Stack gap="md">
      {/* Parameters marked for variation — act as selectable toggle buttons */}
      <Paper withBorder p="md" radius="md">
        <Text size="sm" fw={600} mb="sm">
          Parameters marked for variation
        </Text>
        <Text size="xs" c="dimmed" mb="sm">
          Select one or more to use with the bulk assign helper below.
        </Text>
        <Group gap="xs">
          {variedParams.map((param) => {
            const selected = selectedParamKeys.has(param.paramKey)
            return (
              <Button
                key={param.paramKey}
                size="xs"
                variant={selected ? "filled" : "outline"}
                color={selected ? "blue" : "gray"}
                onClick={() => toggleParam(param.paramKey)}
              >
                {param.layerName}: {param.paramName}
              </Button>
            )
          })}
        </Group>

        {/* Inline bulk assign helper — always visible */}
        <Divider my="sm" />
        <Text size="xs" fw={500} mb="xs">
          Bulk Assign Helper
        </Text>
        <Group gap="sm" align="flex-end">
          <TextInput
            label="Value"
            placeholder="e.g., 150°C"
            size="xs"
            value={helperValue}
            ref={helperValueInputRef}
            onChange={(e) => setHelperValue(e.currentTarget.value)}
            style={{ flex: 1 }}
          />
          <NumberInput
            label="Next N substrates (without value)"
            size="xs"
            value={helperCount}
            onChange={(v) => setHelperCount(Number(v) || 1)}
            min={1}
            max={experiment.substrates.length || 1}
            style={{ width: 220 }}
          />
          <Button
            size="xs"
            onClick={applyHelperAssignment}
            disabled={selectedParamKeys.size === 0 || !helperValue}
          >
            Assign
          </Button>
        </Group>
        {selectedParamKeys.size === 0 && (
          <Text size="xs" c="dimmed" mt={4}>
            Select at least one parameter above to assign.
          </Text>
        )}
      </Paper>

      {/* Variation table */}
      <Paper withBorder p="md" radius="md">
        <Text size="sm" fw={600} mb="md">
          Substrate Parameter Values
        </Text>

        {experiment.substrates.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="md">
            No substrates. Create substrates in the Substrates tab.
          </Text>
        ) : (
          <Box style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "14px",
              }}
            >
              <thead>
                <tr
                  style={{
                    background: "var(--mantine-color-gray-1)",
                    borderBottom: "2px solid var(--mantine-color-gray-3)",
                  }}
                >
                  <th
                    style={{
                      padding: "12px 8px",
                      textAlign: "left",
                      fontWeight: 600,
                      width: "80px",
                    }}
                  >
                    Substrate
                  </th>
                  {variedParams.map((param) => (
                    <th
                      key={param.paramKey}
                      style={{
                        padding: "12px 8px",
                        textAlign: "left",
                        fontWeight: 600,
                        minWidth: "150px",
                        background: selectedParamKeys.has(param.paramKey)
                          ? "var(--mantine-color-blue-0)"
                          : undefined,
                      }}
                    >
                      {param.layerName}: {param.paramName}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {experiment.substrates.map((substrate, idx) => (
                  <tr
                    key={substrate.id}
                    style={{
                      borderBottom: "1px solid var(--mantine-color-gray-2)",
                    }}
                  >
                    <td
                      style={{
                        padding: "8px",
                        fontWeight: 600,
                        background: "var(--mantine-color-gray-0)",
                      }}
                    >
                      {substrate.name}
                    </td>
                    {variedParams.map((param) => (
                      <td
                        key={param.paramKey}
                        style={{
                          padding: "8px",
                          background: selectedParamKeys.has(param.paramKey)
                            ? "var(--mantine-color-blue-0)"
                            : undefined,
                        }}
                      >
                        <TextInput
                          size="xs"
                          placeholder="—"
                          value={
                            substrate.parameterValues?.[param.paramKey] || ""
                          }
                          onChange={(e) =>
                            updateSubstrateParam(
                              idx,
                              param.paramKey,
                              e.currentTarget.value,
                            )
                          }
                          style={{ width: "100%" }}
                        />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </Box>
        )}
      </Paper>
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Substrates Tab with Table Editor
// ─────────────────────────────────────────────────────────────────────────────

function SubstratesTab({
  experiment,
  onUpdate,
}: {
  experiment: Experiment
  onUpdate: (exp: Experiment) => void
}) {
  const [baseName, setBaseName] = useState("substrate")
  const [includeDate, setIncludeDate] = useState(false)
  const [includeExpName, setIncludeExpName] = useState(false)
  const [includeUser, setIncludeUser] = useState(false)
  const [editingIndex, setEditingIndex] = useState<number | null>(null)
  const [editingName, setEditingName] = useState("")
  const editingInputRef = useRef<HTMLInputElement | null>(null)
  const suppressBlurCommitRef = useRef(false)

  useEffect(() => {
    if (editingIndex === null) {
      return
    }
    const raf = window.requestAnimationFrame(() => {
      editingInputRef.current?.focus()
      editingInputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(raf)
  }, [editingIndex])

  const updateSubstrate = (index: number, substrate: Substrate) => {
    const newSubstrates = [...experiment.substrates]
    newSubstrates[index] = substrate
    onUpdate({ ...experiment, substrates: newSubstrates })
  }

  const deleteSubstrate = (index: number) => {
    const newSubstrates = experiment.substrates.filter((_, i) => i !== index)
    onUpdate({ ...experiment, substrates: newSubstrates })
  }

  const getSubstrateNameOptions = () => ({
    baseName,
    date: experiment.date,
    experimentName: experiment.name,
    userName: "User",
    includeDate,
    includeExpName,
    includeUser,
  })

  const resizeSubstrates = (newCount: number) => {
    const boundedCount = Math.max(1, newCount)
    const newSubstrates =
      boundedCount > experiment.substrates.length
        ? [
            ...experiment.substrates,
            ...generateSubstrates(
              boundedCount - experiment.substrates.length,
              {
                ...getSubstrateNameOptions(),
                startIndex: experiment.substrates.length + 1,
              },
            ),
          ]
        : experiment.substrates.slice(0, boundedCount)

    onUpdate({
      ...experiment,
      numSubstrates: boundedCount,
      substrates: newSubstrates,
    })
  }

  const handleRegenerateName = (index: number) => {
    const newNames = regenerateSubstrateNames(
      experiment.substrates,
      getSubstrateNameOptions(),
    )
    const newSubstrates = [...experiment.substrates]
    newSubstrates[index] = newNames[index]
    onUpdate({ ...experiment, substrates: newSubstrates })
  }

  const handleRegenerateAll = () => {
    const newSubstrates = regenerateSubstrateNames(
      experiment.substrates,
      getSubstrateNameOptions(),
    )
    onUpdate({ ...experiment, substrates: newSubstrates })
  }

  const commitSubstrateName = useCallback(
    (index: number, moveToNext: boolean) => {
      const trimmed = editingName.trim()
      if (trimmed) {
        updateSubstrate(index, {
          ...experiment.substrates[index],
          name: trimmed,
        })
      }

      if (moveToNext && index < experiment.substrates.length - 1) {
        const nextIndex = index + 1
        suppressBlurCommitRef.current = true
        setEditingIndex(nextIndex)
        setEditingName(experiment.substrates[nextIndex].name)
        return
      }

      setEditingIndex(null)
    },
    [editingName, experiment.substrates, updateSubstrate],
  )

  return (
    <Stack gap="md">
      <Paper
        withBorder
        p="md"
        radius="md"
        style={{ background: "var(--mantine-color-blue-0)" }}
      >
        <Text size="sm" fw={500} mb="xs">
          Substrate Name Generator Options
        </Text>
        <Group gap="lg">
          <TextInput
            label="Base Name"
            value={baseName}
            onChange={(e) => setBaseName(e.currentTarget.value)}
            placeholder="substrate"
            size="sm"
            style={{ minWidth: 180 }}
          />
          <Checkbox
            label="Include Date"
            checked={includeDate}
            onChange={(e) => setIncludeDate(e.currentTarget.checked)}
            size="sm"
          />
          <Checkbox
            label="Include Experiment Name"
            checked={includeExpName}
            onChange={(e) => setIncludeExpName(e.currentTarget.checked)}
            size="sm"
          />
          <Checkbox
            label="Include User"
            checked={includeUser}
            onChange={(e) => setIncludeUser(e.currentTarget.checked)}
            size="sm"
          />
          <Button size="xs" variant="light" onClick={handleRegenerateAll}>
            Regenerate All Names
          </Button>
        </Group>
      </Paper>

      <Paper withBorder p="md" radius="md">
        <Group align="flex-end" gap="xs" mb="md">
          <NumberInput
            label="Number of Substrates"
            value={experiment.numSubstrates}
            onChange={(v) => resizeSubstrates(Number(v) || 1)}
            min={1}
            style={{ flex: 1 }}
          />
          <Button
            size="sm"
            variant="light"
            leftSection={<IconPlus size={14} />}
            onClick={() => resizeSubstrates(experiment.numSubstrates + 1)}
            title="Add a substrate"
          >
            Add
          </Button>
        </Group>

        <Group justify="space-between" mb="sm">
          <Text size="sm" fw={600}>
            Substrates ({experiment.substrates.length})
          </Text>
          <Text size="xs" c="dimmed">
            {Math.ceil(Math.sqrt(experiment.numSubstrates))}×
            {Math.ceil(
              experiment.numSubstrates /
                Math.ceil(Math.sqrt(experiment.numSubstrates)),
            )}{" "}
            grid
          </Text>
        </Group>

        {experiment.substrates.length === 0 ? (
          <Text size="sm" c="dimmed" ta="center" py="md">
            No substrates. Update the count in General to create them.
          </Text>
        ) : (
          <Box style={{ overflowX: "auto" }}>
            <table
              style={{
                width: "100%",
                borderCollapse: "collapse",
                fontSize: "14px",
              }}
            >
              <thead>
                <tr
                  style={{
                    background: "var(--mantine-color-gray-1)",
                    borderBottom: "2px solid var(--mantine-color-gray-3)",
                  }}
                >
                  <th
                    style={{
                      padding: "12px 8px",
                      textAlign: "left",
                      fontWeight: 600,
                      width: "60px",
                    }}
                  >
                    #
                  </th>
                  <th
                    style={{
                      padding: "12px 8px",
                      textAlign: "left",
                      fontWeight: 600,
                    }}
                  >
                    Name
                  </th>
                  <th
                    style={{
                      padding: "12px 8px",
                      textAlign: "right",
                      fontWeight: 600,
                      width: "120px",
                    }}
                  >
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {experiment.substrates.map((substrate, idx) => (
                  <tr
                    key={substrate.id}
                    style={{
                      borderBottom: "1px solid var(--mantine-color-gray-2)",
                      background:
                        idx % 2 === 0
                          ? "transparent"
                          : "var(--mantine-color-gray-0)",
                    }}
                  >
                    <td
                      style={{
                        padding: "12px 8px",
                        textAlign: "center",
                        fontWeight: 500,
                        color: "var(--mantine-color-gray-7)",
                      }}
                    >
                      {idx + 1}
                    </td>
                    <td
                      style={{
                        padding: "12px 8px",
                      }}
                    >
                      {editingIndex === idx ? (
                        <TextInput
                          ref={editingInputRef}
                          size="xs"
                          value={editingName}
                          onChange={(e) =>
                            setEditingName(e.currentTarget.value)
                          }
                          onBlur={() => {
                            if (suppressBlurCommitRef.current) {
                              suppressBlurCommitRef.current = false
                              return
                            }
                            commitSubstrateName(idx, false)
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === "Tab") {
                              e.preventDefault()
                              commitSubstrateName(idx, true)
                              return
                            }
                            if (e.key === "Escape") {
                              setEditingIndex(null)
                            }
                          }}
                          autoFocus
                          style={{ width: "100%" }}
                        />
                      ) : (
                        <Text
                          size="sm"
                          onClick={() => {
                            setEditingIndex(idx)
                            setEditingName(substrate.name)
                          }}
                          style={{
                            cursor: "pointer",
                            padding: "4px 8px",
                            borderRadius: "4px",
                            transition: "background 0.2s",
                          }}
                          onMouseEnter={(e) => {
                            e.currentTarget.style.background =
                              "var(--mantine-color-gray-1)"
                          }}
                          onMouseLeave={(e) => {
                            e.currentTarget.style.background = "transparent"
                          }}
                        >
                          {substrate.name}
                        </Text>
                      )}
                    </td>
                    <td
                      style={{
                        padding: "12px 8px",
                        textAlign: "right",
                      }}
                    >
                      <Group gap="4" justify="flex-end">
                        <Tooltip label="Regenerate name">
                          <ActionIcon
                            size="sm"
                            variant="subtle"
                            color="blue"
                            onClick={() => handleRegenerateName(idx)}
                          >
                            <IconRefresh size={14} />
                          </ActionIcon>
                        </Tooltip>
                        <Tooltip label="Delete">
                          <ActionIcon
                            size="sm"
                            variant="subtle"
                            color="red"
                            onClick={() => deleteSubstrate(idx)}
                          >
                            <IconTrash size={14} />
                          </ActionIcon>
                        </Tooltip>
                      </Group>
                    </td>
                  </tr>
                ))}
                <tr
                  style={{
                    borderBottom: "2px solid var(--mantine-color-gray-2)",
                    background: "var(--mantine-color-gray-0)",
                  }}
                >
                  <td
                    colSpan={3}
                    style={{
                      padding: "12px 8px",
                      textAlign: "center",
                    }}
                  >
                    <Button
                      size="xs"
                      variant="subtle"
                      leftSection={<IconPlus size={14} />}
                      onClick={() => resizeSubstrates(experiment.numSubstrates + 1)}
                    >
                      Add Substrate
                    </Button>
                  </td>
                </tr>
              </tbody>
            </table>
          </Box>
        )}
      </Paper>
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

function ExperimentDetail({
  experiment,
  onUpdate,
  onClose,
  materials,
  solutions,
}: {
  experiment: Experiment
  onUpdate: (exp: Experiment) => void
  onClose: () => void
  materials: { id: string; name: string }[]
  solutions: { id: string; name: string }[]
}) {
  const updateLayer = (index: number, layer: ExperimentLayer) => {
    const newLayers = [...experiment.layers]
    newLayers[index] = layer
    onUpdate({ ...experiment, layers: newLayers })
  }

  const deleteLayer = (index: number) => {
    const newLayers = experiment.layers.filter((_, i) => i !== index)
    onUpdate({ ...experiment, layers: newLayers })
  }

  const addLayer = () => {
    const newLayers = [...experiment.layers, newLayer(experiment.layers.length)]
    onUpdate({ ...experiment, layers: newLayers })
  }

  const status = getExperimentStatus(experiment)
  const missingFields = getExperimentMissingFields(experiment)
  const statusColor =
    status === "finished" ? "green" : status === "ready" ? "yellow" : "red"
  const statusLabel =
    status === "finished"
      ? "Finished"
      : status === "ready"
        ? "Ready"
        : "Incomplete"

  return (
    <Box style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <Group
        justify="space-between"
        p="md"
        style={{
          borderBottom: "1px solid var(--mantine-color-default-border)",
        }}
      >
        <Group gap="sm">
          <Title order={4}>{experiment.name || "Untitled Experiment"}</Title>
          <Badge color={statusColor} size="sm">
            {statusLabel}
          </Badge>
        </Group>
        <ActionIcon variant="subtle" onClick={onClose}>
          <IconX size={18} />
        </ActionIcon>
      </Group>

      <ScrollArea style={{ flex: 1 }} p="md">
        <Tabs defaultValue="general">
          <Tabs.List mb="md">
            <Tabs.Tab
              value="general"
              leftSection={<IconInfoCircle size={14} />}
            >
              General
            </Tabs.Tab>
            <Tabs.Tab value="substrates" leftSection={<IconStack2 size={14} />}>
              Substrates ({experiment.substrates.length})
            </Tabs.Tab>
            <Tabs.Tab
              value="layerstack"
              leftSection={<IconLayersLinked size={14} />}
            >
              Layer Stack ({experiment.layers.length})
            </Tabs.Tab>
            <Tabs.Tab
              value="layers"
              leftSection={<IconLayersLinked size={14} />}
            >
              Assign Parameters ({
                experiment.layers.reduce((total, layer) => {
                  const layerParams = PROCESS_PARAMETER_DEFINITIONS.filter(
                    ({ key }) => layer[key]?.value,
                  ).length
                  return total + layerParams
                }, 0)
              })
            </Tabs.Tab>
            {getVariedParameters(experiment).length > 0 && (
              <Tabs.Tab
                value="paramvariation"
                leftSection={<IconStack2 size={14} />}
              >
                Parameter Variation
              </Tabs.Tab>
            )}
            {experiment.deviceType !== "film" && (
              <Tabs.Tab
                value="devicelayout"
                leftSection={<IconStack2 size={14} />}
              >
                Device Layout
              </Tabs.Tab>
            )}
          </Tabs.List>

          <Tabs.Panel value="general">
            <Stack gap="md">
              <Paper withBorder p="md" radius="md">
                <Text size="sm" fw={600} mb="sm">
                  Experiment Information
                </Text>

                <BufferedTextInput
                  label="Experiment Name"
                  value={experiment.name}
                  onCommit={(v) => onUpdate({ ...experiment, name: v })}
                  mb="sm"
                  error={
                    missingFields.includes("name")
                      ? "Name is required"
                      : undefined
                  }
                  styles={
                    missingFields.includes("name")
                      ? { input: { borderColor: "var(--mantine-color-red-5)" } }
                      : undefined
                  }
                  required
                />

                <BufferedTextarea
                  label="Description"
                  placeholder="Describe the objective of this experiment..."
                  value={experiment.description}
                  onCommit={(v) => onUpdate({ ...experiment, description: v })}
                  mb="sm"
                  minRows={2}
                />

                <SimpleGrid cols={2} spacing="sm">
                  <TextInput
                    label="Fabrication Date"
                    type="date"
                    value={experiment.date}
                    onChange={(e) =>
                      onUpdate({ ...experiment, date: e.currentTarget.value })
                    }
                    error={
                      missingFields.includes("date")
                        ? "Date is required"
                        : undefined
                    }
                    styles={
                      missingFields.includes("date")
                        ? {
                            input: {
                              borderColor: "var(--mantine-color-red-5)",
                            },
                          }
                        : undefined
                    }
                    required
                  />
                  <TextInput
                    label="End Date"
                    type="date"
                    placeholder="Optional"
                    value={experiment.endDate ?? ""}
                    onChange={(e) =>
                      onUpdate({
                        ...experiment,
                        endDate: e.currentTarget.value || undefined,
                      })
                    }
                  />
                </SimpleGrid>
              </Paper>

              {missingFields.length > 0 && (
                <Paper
                  withBorder
                  p="md"
                  radius="md"
                  style={{
                    background: "var(--mantine-color-red-0)",
                    borderColor: "var(--mantine-color-red-3)",
                  }}
                >
                  <Group gap="xs" mb="xs">
                    <IconInfoCircle
                      size={16}
                      color="var(--mantine-color-red-6)"
                    />
                    <Text size="sm" fw={600} c="red.7">
                      Required to reach Ready status
                    </Text>
                  </Group>
                  <Stack gap={4}>
                    {missingFields.includes("name") && (
                      <Text size="xs" c="red.6">
                        • Experiment name is missing
                      </Text>
                    )}
                    {missingFields.includes("date") && (
                      <Text size="xs" c="red.6">
                        • Fabrication date is missing
                      </Text>
                    )}
                    {missingFields.includes("numSubstrates") && (
                      <Text size="xs" c="red.6">
                        • Number of substrates must be at least 1
                      </Text>
                    )}
                  </Stack>
                </Paper>
              )}
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="layerstack">
            <Paper withBorder p="md" radius="md">
              <SimpleGrid cols={{ base: 1, sm: 2 }} spacing="lg">
                {/* Left: settings + layer editor */}
                <Stack gap="md">
                  <Box>
                    <Text size="sm" fw={600} mb="sm">
                      Architecture & Substrate
                    </Text>
                    <Select
                      label="Architecture"
                      size="sm"
                      data={[
                        { value: "n-i-p", label: "n-i-p (Regular)" },
                        { value: "p-i-n", label: "p-i-n (Inverted)" },
                        { value: "n-i-p-n", label: "n-i-p-n (Tandem)" },
                        { value: "p-i-n-p", label: "p-i-n-p (Tandem)" },
                        { value: "custom", label: "Custom" },
                      ]}
                      value={experiment.architecture}
                      onChange={(v) =>
                        onUpdate({
                          ...experiment,
                          architecture: (v as DeviceArchitecture) ?? "n-i-p",
                        })
                      }
                      mb="sm"
                    />
                    <BufferedTextInput
                      label="Substrate Material"
                      size="sm"
                      value={experiment.substrateMaterial}
                      onCommit={(v) =>
                        onUpdate({ ...experiment, substrateMaterial: v })
                      }
                      mb="md"
                    />
                  </Box>

                  <Box>
                    <Text size="sm" fw={600} mb="xs">
                      Device Type
                    </Text>
                    <SegmentedControl
                      fullWidth
                      value={experiment.deviceType}
                      onChange={(v) =>
                        onUpdate({
                          ...experiment,
                          deviceType: v as "film" | "half" | "full",
                        })
                      }
                      data={[
                        { label: "Test (Film)", value: "film" },
                        { label: "Half Device", value: "half" },
                        { label: "Full Device", value: "full" },
                      ]}
                    />
                  </Box>

                  <Divider />

                  <Box>
                    <Group justify="space-between" mb="sm">
                      <Text size="sm" fw={600}>
                        Layers
                      </Text>
                      <Button
                        size="xs"
                        variant="light"
                        leftSection={<IconPlus size={14} />}
                        onClick={addLayer}
                      >
                        Add
                      </Button>
                    </Group>
                    <Stack gap="xs">
                      {experiment.layers.length === 0 ? (
                        <Text size="xs" c="dimmed" ta="center" py="sm">
                          No layers yet
                        </Text>
                      ) : (
                        experiment.layers.map((layer, idx) => (
                          <Group
                            key={layer.id}
                            gap="sm"
                            p="xs"
                            style={{
                              background: `${layer.color}18`,
                              borderLeft: `3px solid ${layer.color}`,
                              borderRadius: 4,
                            }}
                          >
                            <TextInput
                              size="xs"
                              value={layer.name}
                              onChange={(e) =>
                                updateLayer(idx, {
                                  ...layer,
                                  name: e.currentTarget.value,
                                })
                              }
                              placeholder={`Layer ${idx + 1}`}
                              style={{ flex: 1 }}
                            />
                            <Select
                              size="xs"
                              placeholder="Type"
                              value={layer.layerType ?? null}
                              onChange={(v) =>
                                updateLayer(idx, {
                                  ...layer,
                                  layerType: v as
                                    | "etl"
                                    | "htl"
                                    | "perovskite"
                                    | "additional"
                                    | "back_contact"
                                    | undefined,
                                })
                              }
                              data={[
                                { value: "etl", label: "ETL" },
                                { value: "htl", label: "HTL" },
                                { value: "perovskite", label: "Absorber" },
                                { value: "additional", label: "Additional" },
                                {
                                  value: "back_contact",
                                  label: "Back Contact",
                                },
                              ]}
                              clearable
                              style={{ width: 120 }}
                            />
                            <TextInput
                              size="xs"
                              type="color"
                              value={layer.color}
                              onChange={(e) =>
                                updateLayer(idx, {
                                  ...layer,
                                  color: e.currentTarget.value,
                                })
                              }
                              style={{ width: 52 }}
                            />
                            <ActionIcon
                              size="sm"
                              variant="subtle"
                              color="red"
                              onClick={() => deleteLayer(idx)}
                            >
                              <IconTrash size={14} />
                            </ActionIcon>
                          </Group>
                        ))
                      )}
                    </Stack>
                  </Box>
                </Stack>

                {/* Right: Overview */}
                <Stack gap="md">
                  <Text size="sm" fw={600}>
                    Overview
                  </Text>
                  <DeviceStackPreview
                    substrateMaterial={experiment.substrateMaterial}
                    layers={experiment.layers}
                    architecture={experiment.architecture}
                  />
                  <Box
                    p="xs"
                    style={{
                      background: "var(--mantine-color-gray-0)",
                      borderRadius: 4,
                      fontFamily: "monospace",
                    }}
                  >
                    <Stack gap="xs">
                      {/* General notation showing architecture format */}
                      <Text size="xs" c="dimmed">
                        <Text span fw={600}>
                          General:
                        </Text>{" "}
                        {(() => {
                          const typeMap: Record<string, string> = {
                            etl: "ETL",
                            htl: "HTL",
                            perovskite: "Absorber",
                            additional: "Additional",
                            back_contact: "Back Contact",
                          }

                          // Build list of type display names from layers
                          const types = experiment.layers.map((l) =>
                            l.layerType ? typeMap[l.layerType] : "unknown",
                          )

                          // Group consecutive same types with counts
                          const grouped: Array<{
                            type: string
                            count: number
                          }> = []
                          types.forEach((t) => {
                            const last = grouped[grouped.length - 1]
                            if (last && last.type === t) {
                              last.count++
                            } else {
                              grouped.push({ type: t, count: 1 })
                            }
                          })

                          // Format as "TYPE" or "TYPE (count)"
                          const formatted = grouped
                            .map((g) =>
                              g.count > 1 ? `${g.type} (${g.count})` : g.type,
                            )
                            .join(" / ")

                          // Return full general notation, use ':' before architecture
                          return `substrate${formatted ? ` / ${formatted}` : ""}: ${experiment.architecture}`
                        })()}
                      </Text>

                      {/* Concrete stack notation */}
                      <Text size="xs" c="dimmed">
                        <Text span fw={600}>
                          Stack:
                        </Text>{" "}
                        {experiment.substrateMaterial}
                        {experiment.layers.length > 0 && (
                          <>
                            {" | "}
                            {experiment.layers.map((l) => l.name).join(" | ")}
                            {" |"}
                          </>
                        )}
                      </Text>
                    </Stack>
                  </Box>
                </Stack>
              </SimpleGrid>
            </Paper>
          </Tabs.Panel>

          <Tabs.Panel value="layers">
            <Stack gap="md">
              {experiment.layers.map((layer, idx) => (
                <LayerCard
                  key={layer.id}
                  layer={layer}
                  index={idx}
                  priorLayers={experiment.layers.slice(0, idx)}
                  onUpdate={(l) => updateLayer(idx, l)}
                  onDelete={() => deleteLayer(idx)}
                  materials={materials}
                  solutions={solutions}
                />
              ))}

              <Button
                variant="light"
                leftSection={<IconPlus size={16} />}
                onClick={addLayer}
              >
                Add Layer
              </Button>

              {experiment.layers.length === 0 && (
                <Paper
                  withBorder
                  p="lg"
                  ta="center"
                  style={{ background: "var(--mantine-color-gray-0)" }}
                >
                  <IconStack2 size={40} color="var(--mantine-color-gray-5)" />
                  <Text size="sm" c="dimmed" mt="sm">
                    No layers yet. Add your first layer to start building the
                    device stack.
                  </Text>
                </Paper>
              )}
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="paramvariation">
            <ParameterVariationTab
              experiment={experiment}
              onUpdate={onUpdate}
            />
          </Tabs.Panel>

          <Tabs.Panel value="devicelayout">
            <Stack gap="md">
              <Paper withBorder p="md" radius="md">
                <Text size="sm" fw={600} mb="sm">
                  Device Layout Configuration
                </Text>

                <SimpleGrid cols={2} spacing="sm" mb="md">
                  <BufferedNumberInput
                    label="Substrate Width"
                    suffix=" cm"
                    value={experiment.substrateWidth}
                    onCommit={(v) =>
                      onUpdate({ ...experiment, substrateWidth: v })
                    }
                    min={0}
                    step={0.1}
                    decimalScale={2}
                  />
                  <BufferedNumberInput
                    label="Substrate Length"
                    suffix=" cm"
                    value={experiment.substrateLength}
                    onCommit={(v) =>
                      onUpdate({ ...experiment, substrateLength: v })
                    }
                    min={0}
                    step={0.1}
                    decimalScale={2}
                  />
                </SimpleGrid>

                <SimpleGrid cols={2} spacing="sm" mb="md">
                  <BufferedNumberInput
                    label="Device Area"
                    suffix=" cm²"
                    value={experiment.deviceArea}
                    onCommit={(v) => onUpdate({ ...experiment, deviceArea: v })}
                    min={0}
                    step={0.01}
                    decimalScale={3}
                  />
                  <BufferedNumberInput
                    label="Devices per Substrate"
                    value={experiment.devicesPerSubstrate}
                    onCommit={(v) =>
                      onUpdate({ ...experiment, devicesPerSubstrate: v })
                    }
                    min={0}
                  />
                </SimpleGrid>
              </Paper>

              <Paper withBorder p="md" radius="md">
                <Text size="sm" fw={600} mb="sm">
                  Device Layout Image
                </Text>
                <FileInput
                  label="Upload device layout image (JPG, PNG)"
                  placeholder="Select image file"
                  accept="image/jpg,image/jpeg,image/png"
                  leftSection={<IconUpload size={14} />}
                  onChange={(file) => {
                    if (file) {
                      const reader = new FileReader()
                      reader.onload = (e) => {
                        const base64 = e.target?.result as string
                        onUpdate({ ...experiment, deviceLayoutImage: base64 })
                      }
                      reader.readAsDataURL(file)
                    }
                  }}
                />

                {experiment.deviceLayoutImage && (
                  <Box mt="md">
                    <Text size="sm" fw={600} mb="xs">
                      Layout Preview:
                    </Text>
                    <img
                      src={experiment.deviceLayoutImage}
                      alt="Device layout"
                      style={{
                        maxWidth: "100%",
                        maxHeight: "400px",
                        borderRadius: "4px",
                        border: "1px solid var(--mantine-color-gray-3)",
                      }}
                    />
                  </Box>
                )}
              </Paper>
            </Stack>
          </Tabs.Panel>

          <Tabs.Panel value="substrates">
            <SubstratesTab experiment={experiment} onUpdate={onUpdate} />
          </Tabs.Panel>
        </Tabs>
      </ScrollArea>
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Experiment List Item
// ─────────────────────────────────────────────────────────────────────────────

function ExperimentListItem({
  experiment,
  isSelected,
  onSelect,
  onDelete,
  onCopy,
  collectionColor,
}: {
  experiment: Experiment
  isSelected: boolean
  onSelect: () => void
  onDelete: () => void
  onCopy: () => void
  collectionColor?: string
}) {
  const status = getExperimentStatus(experiment)
  const statusColor =
    status === "finished" ? "green" : status === "ready" ? "yellow" : "red"
  const statusLabel =
    status === "finished"
      ? "Finished"
      : status === "ready"
        ? "Ready"
        : "Incomplete"

  return (
    <Paper
      withBorder
      p="sm"
      radius="md"
      style={{
        cursor: "pointer",
        background: isSelected ? "var(--mantine-color-blue-0)" : undefined,
        borderColor: isSelected ? "var(--mantine-color-blue-4)" : undefined,
        borderLeft: collectionColor
          ? `4px solid ${collectionColor}`
          : undefined,
      }}
      onClick={onSelect}
    >
      <Group justify="space-between" wrap="nowrap">
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group gap="xs" mb={4}>
            <Text size="sm" fw={600} truncate>
              {experiment.name || "Untitled"}
            </Text>
            <Badge size="xs" color={statusColor} variant="dot">
              {statusLabel}
            </Badge>
          </Group>
          <Group gap="xs">
            <Text size="xs" c="dimmed">
              {experiment.date || "No date"}
            </Text>
            <Text size="xs" c="dimmed">
              •
            </Text>
            <Text size="xs" c="dimmed">
              {experiment.layers.length} layer
              {experiment.layers.length !== 1 ? "s" : ""}
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
              onCopy()
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
              onDelete()
            }}
          >
            <IconTrash size={14} />
          </ActionIcon>
        </Group>
      </Group>
    </Paper>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────

export function ExperimentsPage() {
  const {
    experiments,
    setExperiments,
    materials,
    solutions,
    results,
    planes,
    updateElement,
    removeCollectionRefs,
    pendingCollectionLink,
    setPendingCollectionLink,
    setActiveEntity,
    activeCollectionId,
    activePlaneId,
  } = useAppContext()
  const { getEntityColor, isEntityVisible, getEntityPlane, getEntityCollection } =
    useEntityCollection()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const processedPendingRequestIdsRef = useRef<Set<string>>(new Set())

  const selectExperiment = useCallback(
    (id: string | null) => {
      setSelectedId(id)
      setActiveEntity(id ? { kind: "experiment", id } : null)
    },
    [setActiveEntity],
  )

  // Auto-create experiment + link to collection when navigated from action bubble
  useEffect(() => {
    if (!pendingCollectionLink || pendingCollectionLink.kind !== "experiment") {
      return
    }
    if (
      processedPendingRequestIdsRef.current.has(pendingCollectionLink.requestId)
    ) {
      return
    }
    processedPendingRequestIdsRef.current.add(pendingCollectionLink.requestId)

    const { collectionId, planeId } = pendingCollectionLink
    setPendingCollectionLink(null)

    const exp = newExperiment()
    setExperiments((prev) => [...prev, exp])
    selectExperiment(exp.id)

    // Link back to collection
    const plane = planes.find((p) => p.id === planeId)
    if (plane) {
      const col = plane.elements.find((e) => e.id === collectionId)
      if (col && col.type === "collection") {
        const updated = {
          ...col,
          refs: [...col.refs, { kind: "experiment" as const, id: exp.id }],
        }
        updateElement(planeId, updated)
      }
    }
  }, [
    pendingCollectionLink,
    setPendingCollectionLink,
    setExperiments,
    planes,
    updateElement,
    selectExperiment,
  ])

  const selectedExperiment = experiments.find((e) => e.id === selectedId)

  const updateExperiment = (exp: Experiment) => {
    setExperiments((prev) => prev.map((e) => (e.id === exp.id ? exp : e)))
  }

  const deleteExperiment = (id: string) => {
    const exp = experiments.find((e) => e.id === id)
    const dependents = getDependentLocations("experiment", id, {
      solutions,
      experiments,
      results,
      planes,
    })
    if (dependents.length > 0) {
      modals.open({
        title: "Cannot delete experiment",
        children: (
          <DependencyBlockModal
            itemName={exp?.name ?? id}
            dependents={dependents}
          />
        ),
      })
      return
    }
    setExperiments((prev) => prev.filter((e) => e.id !== id))
    removeCollectionRefs("experiment", [id])
    if (selectedId === id) {
      selectExperiment(null)
    }
  }

  const copyExperiment = (id: string) => {
    const original = experiments.find((e) => e.id === id)
    if (!original) return
    const layerIdMap = new Map(
      original.layers.map((l) => [l.id, crypto.randomUUID()]),
    )
    const copied: Experiment = {
      ...original,
      id: crypto.randomUUID(),
      name: `Copy of ${original.name}`,
      hasResults: false,
      layers: original.layers.map((l) => ({ ...l, id: layerIdMap.get(l.id)! })),
      substrates: original.substrates.map((s) => {
        const newParamValues: { [key: string]: string } = {}
        if (s.parameterValues) {
          for (const [key, value] of Object.entries(s.parameterValues)) {
            const colonIdx = key.indexOf(":")
            const oldLayerId = key.slice(0, colonIdx)
            const rest = key.slice(colonIdx)
            const newLayerId = layerIdMap.get(oldLayerId)
            if (newLayerId) {
              newParamValues[`${newLayerId}${rest}`] = value
            }
          }
        }
        return {
          ...s,
          id: crypto.randomUUID(),
          parameterValues: s.parameterValues ? newParamValues : undefined,
        }
      }),
    }
    setExperiments((prev) => [...prev, copied])
    const owner = getEntityCollection("experiment", id)
    if (owner) {
      updateElement(owner.plane.id, {
        ...owner.collection,
        refs: [...owner.collection.refs, { kind: "experiment" as const, id: copied.id }],
      })
    }
    selectExperiment(copied.id)
  }

  const createExperiment = () => {
    const exp = newExperiment()
    setExperiments((prev) => [...prev, exp])
    selectExperiment(exp.id)
    // Link to active collection if one is selected
    if (activeCollectionId && activePlaneId) {
      const plane = planes.find((p) => p.id === activePlaneId)
      if (plane) {
        const col = plane.elements.find((e) => e.id === activeCollectionId)
        if (col && col.type === "collection") {
          updateElement(activePlaneId, {
            ...col,
            refs: [...col.refs, { kind: "experiment" as const, id: exp.id }],
          })
        }
      }
    }
  }

  // Filter by visibility (collection context)
  const visibleExperiments = experiments.filter((e) =>
    isEntityVisible("experiment", e.id),
  )

  useEffect(() => {
    if (
      selectedId &&
      !visibleExperiments.some((experiment) => experiment.id === selectedId)
    ) {
      selectExperiment(null)
    }
  }, [selectedId, selectExperiment, visibleExperiments])

  // Material and solution lists for dropdowns
  const materialOptions = materials.map((m) => ({ id: m.id, name: m.name }))
  const solutionOptions = solutions.map((s) => ({ id: s.id, name: s.name }))

  return (
    <Box style={{ display: "flex", height: "calc(100vh - 60px)" }}>
      {/* Sidebar: Experiment List */}
      <Box
        style={{
          width: 300,
          borderRight: "1px solid var(--mantine-color-default-border)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Group
          justify="space-between"
          p="md"
          style={{
            borderBottom: "1px solid var(--mantine-color-default-border)",
          }}
        >
          <Title order={5}>Experiments</Title>
          <Button
            size="xs"
            leftSection={<IconPlus size={14} />}
            onClick={createExperiment}
            disabled={!activeCollectionId}
          >
            New
          </Button>
        </Group>

        {!activeCollectionId && (
          <Alert
            icon={<IconInfoCircle size={16} />}
            color="blue"
            radius={0}
            p="sm"
            style={{ borderRadius: 0, borderLeft: 0, borderRight: 0 }}
          >
            Select a collection in the Organization tab to add experiments.
          </Alert>
        )}

        <ScrollArea style={{ flex: 1 }} p="sm">
          <Stack gap="sm">
            {visibleExperiments.length === 0 ? (
              <Paper
                p="lg"
                ta="center"
                style={{ background: "var(--mantine-color-gray-0)" }}
              >
                <IconFlask size={32} color="var(--mantine-color-gray-5)" />
                <Text size="sm" c="dimmed" mt="sm">
                  No experiments yet
                </Text>
              </Paper>
            ) : !activePlaneId ? (
              // General mode: group by plane
              (() => {
                const groups = new Map<
                  string,
                  { planeName: string; items: typeof visibleExperiments }
                >()
                const orphans: typeof visibleExperiments = []
                for (const exp of visibleExperiments) {
                  const plane = getEntityPlane("experiment", exp.id)
                  if (plane) {
                    const group = groups.get(plane.id)
                    if (group) {
                      group.items.push(exp)
                    } else {
                      groups.set(plane.id, {
                        planeName: plane.name,
                        items: [exp],
                      })
                    }
                  } else {
                    orphans.push(exp)
                  }
                }
                const sections: React.ReactNode[] = []
                for (const [planeId, { planeName, items }] of groups) {
                  sections.push(
                    <Text
                      key={`plane-header-${planeId}`}
                      size="xs"
                      fw={700}
                      c="dimmed"
                      tt="uppercase"
                      mt="xs"
                    >
                      {planeName}
                    </Text>,
                  )
                  sections.push(
                    ...items.map((exp) => (
                      <ExperimentListItem
                        key={exp.id}
                        experiment={exp}
                        isSelected={selectedId === exp.id}
                        onSelect={() => selectExperiment(exp.id)}
                        onDelete={() => deleteExperiment(exp.id)}
                        onCopy={() => copyExperiment(exp.id)}
                        collectionColor={
                          getEntityColor("experiment", exp.id) ?? undefined
                        }
                      />
                    )),
                  )
                }
                if (orphans.length > 0) {
                  sections.push(
                    <Text
                      key="plane-header-orphan"
                      size="xs"
                      fw={700}
                      c="dimmed"
                      tt="uppercase"
                      mt="xs"
                    >
                      Unassigned
                    </Text>,
                  )
                  sections.push(
                    ...orphans.map((exp) => (
                      <ExperimentListItem
                        key={exp.id}
                        experiment={exp}
                        isSelected={selectedId === exp.id}
                        onSelect={() => selectExperiment(exp.id)}
                        onDelete={() => deleteExperiment(exp.id)}
                        onCopy={() => copyExperiment(exp.id)}
                        collectionColor={
                          getEntityColor("experiment", exp.id) ?? undefined
                        }
                      />
                    )),
                  )
                }
                return sections
              })()
            ) : (
              visibleExperiments.map((exp) => (
                <ExperimentListItem
                  key={exp.id}
                  experiment={exp}
                  isSelected={selectedId === exp.id}
                  onSelect={() => selectExperiment(exp.id)}
                  onDelete={() => deleteExperiment(exp.id)}
                  onCopy={() => copyExperiment(exp.id)}
                  collectionColor={
                    getEntityColor("experiment", exp.id) ?? undefined
                  }
                />
              ))
            )}
          </Stack>
        </ScrollArea>
      </Box>

      {/* Main: Experiment Detail */}
      <Box style={{ flex: 1, background: "var(--mantine-color-gray-0)" }}>
        {selectedExperiment ? (
          <ExperimentDetail
            experiment={selectedExperiment}
            onUpdate={updateExperiment}
            onClose={() => selectExperiment(null)}
            materials={materialOptions}
            solutions={solutionOptions}
          />
        ) : (
          <Box
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <IconFlask size={64} color="var(--mantine-color-gray-4)" />
            <Text size="lg" c="dimmed" mt="md">
              Select an experiment to view details
            </Text>
            <Button
              mt="lg"
              onClick={createExperiment}
              disabled={!activeCollectionId}
            >
              Create Experiment
            </Button>
          </Box>
        )}
      </Box>
    </Box>
  )
}
