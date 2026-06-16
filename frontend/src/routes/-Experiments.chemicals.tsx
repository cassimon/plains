import {
  Badge,
  Box,
  Button,
  Group,
  NativeSelect,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core"
import {
  IconAtom,
  IconCheck,
  IconDroplet,
  IconFlask2,
} from "@tabler/icons-react"
import * as React from "react"
import { useEffect, useMemo, useState } from "react"
import type {
  Experiment,
  ExperimentChemicalsPrep,
  ExperimentSolutionBatch,
  Material,
  Process,
  ProcessSolutionRecipe,
  Solution,
} from "@/store/AppContext"

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type SolutionItem = {
  key: string // "sol:{id}" or "recipe:{id}"
  label: string
  kind: "solution" | "recipe"
  id: string
  solution?: Solution
  recipe?: ProcessSolutionRecipe
}

// ─────────────────────────────────────────────────────────────────────────────
// Public helpers
// ─────────────────────────────────────────────────────────────────────────────

export function collectChemicals(
  process: Process,
  _materials: Material[],
  solutions: Solution[],
): { materialIds: string[]; solutionItems: SolutionItem[] } {
  const substrateIds = new Set([
    ...(process.substrateIds ?? []),
    ...(process.inlineSubstrates ?? []).map((s) => s.id),
  ])

  const matIds = new Set<string>()
  const solIds = new Set<string>()
  const recIds = new Set<string>()

  for (const stage of process.stages) {
    for (const step of stage.alternatives) {
      if (step.stepCategory === "substrate_preparation") continue
      if (step.materialId && !substrateIds.has(step.materialId))
        matIds.add(step.materialId)
      if (step.solutionId) solIds.add(step.solutionId)
      if (step.chemRecipeId) recIds.add(step.chemRecipeId)
    }
  }

  for (const solId of solIds) {
    const sol = solutions.find((s) => s.id === solId)
    if (sol) {
      for (const comp of sol.components) {
        if (comp.materialId) matIds.add(comp.materialId)
      }
    }
  }

  const solutionItems: SolutionItem[] = [
    ...[...solIds].map((id) => {
      const sol = solutions.find((s) => s.id === id)
      return {
        key: `sol:${id}`,
        label: sol?.name ?? id,
        kind: "solution" as const,
        id,
        solution: sol,
      }
    }),
    ...[...recIds].map((id) => {
      const recipe = (process.solutionRecipes ?? []).find((r) => r.id === id)
      return {
        key: `recipe:${id}`,
        label: recipe?.name ?? id,
        kind: "recipe" as const,
        id,
        recipe,
      }
    }),
  ]

  return { materialIds: [...matIds], solutionItems }
}

export function computeChemsDone(
  prep: ExperimentChemicalsPrep | undefined,
  materialIds: string[],
  solutionItems: Array<{ key: string }>,
): boolean {
  if (materialIds.length === 0 && solutionItems.length === 0) return true
  const allMatsDone = materialIds.every((id) =>
    Boolean(prep?.materialOverrides?.[id]?.inventoryLabel),
  )
  const allSolsDone = solutionItems.every((item) => {
    const batch = prep?.solutionBatches?.[item.key]
    if (!batch) return false
    if (batch.mode === "take") return Boolean(batch.takenFromExpId)
    return parseFloat(batch.totalVolumeMl ?? "0") > 0
  })
  return allMatsDone && allSolsDone
}

// ─────────────────────────────────────────────────────────────────────────────
// Internal helpers
// ─────────────────────────────────────────────────────────────────────────────

function scaleRecipeQuantities(
  recipe: ProcessSolutionRecipe,
  userVolumeMl: number,
): Array<{ name: string; amount: string; unit: string }> {
  const refVol = parseFloat(recipe.totalSolventVolumeMl) || 1
  const scale = userVolumeMl / refVol
  const totalRatio = recipe.solvents.reduce((s, v) => s + v.volumeRatio, 0) || 1
  const rows: Array<{ name: string; amount: string; unit: string }> = []
  for (const sv of recipe.solvents) {
    const vol = (sv.volumeRatio / totalRatio) * userVolumeMl
    rows.push({
      name: sv.name || "Solvent",
      amount: vol.toFixed(3),
      unit: "mL",
    })
  }
  for (const sl of recipe.solutes) {
    const scaled = (parseFloat(sl.amount) || 0) * scale
    rows.push({
      name: sl.name || "Solute",
      amount: scaled.toFixed(3),
      unit: sl.unit,
    })
  }
  return rows
}

function scaleSolutionQuantities(
  sol: Solution,
  materials: Material[],
): Array<{ name: string; amount: string; unit: string }> {
  return sol.components
    .map((comp) => {
      const mat = materials.find((m) => m.id === comp.materialId)
      return {
        name: mat?.name ?? "Component",
        amount: comp.amount,
        unit: comp.unit,
      }
    })
    .filter((r) => Boolean(r.amount))
}

function rowStyle(isDone: boolean): React.CSSProperties {
  return {
    background: isDone ? "var(--mantine-color-teal-0)" : undefined,
    border: isDone
      ? "1px solid var(--mantine-color-teal-3)"
      : "1px solid var(--mantine-color-gray-2)",
    borderRadius: 8,
    padding: "10px 12px",
    transition: "background 200ms, border 200ms",
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline quantity table with copy-to-clipboard
// ─────────────────────────────────────────────────────────────────────────────

function QuantityTable({
  label,
  rows,
  perBatch,
}: {
  label: string
  rows: Array<{ name: string; amount: string; unit: string }>
  perBatch?: boolean
}) {
  const [copied, setCopied] = useState(false)

  if (rows.length === 0) return null

  const copyText = () => {
    const header = perBatch ? `${label} (per 1 batch)` : label
    const lines = rows.map((r) => `${r.name}: ${r.amount} ${r.unit}`)
    navigator.clipboard.writeText([header, ...lines].join("\n"))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Box
      mt={6}
      style={{
        background: "var(--mantine-color-gray-0)",
        borderRadius: 6,
        padding: "6px 10px",
        border: "1px solid var(--mantine-color-gray-2)",
      }}
    >
      <Group gap="xs" mb={4} justify="space-between">
        {perBatch && (
          <Text size="10px" c="dimmed" tt="uppercase" fw={600}>
            Ingredients (per 1 batch)
          </Text>
        )}
        <Button
          size="compact-xs"
          variant="subtle"
          color={copied ? "teal" : "gray"}
          leftSection={
            <IconCheck
              size={10}
              style={{ display: copied ? undefined : "none" }}
            />
          }
          ml="auto"
          onClick={copyText}
        >
          {copied ? "Copied!" : "Copy"}
        </Button>
      </Group>
      <Stack gap={2}>
        {rows.map((r, i) => (
          <Group key={i} gap="md" justify="space-between">
            <Text size="xs" c="dimmed">
              {r.name}
            </Text>
            <Text size="xs" fw={700} ff="monospace">
              {r.amount} {r.unit}
            </Text>
          </Group>
        ))}
      </Stack>
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Material Override Row
// ─────────────────────────────────────────────────────────────────────────────

function MaterialOverrideRow({
  material,
  override,
  onUpdate,
  currentExpId,
  allExperiments,
}: {
  material: Material
  override?: { inventoryLabel?: string; purity?: string; supplier?: string }
  onUpdate: (patch: {
    inventoryLabel?: string
    purity?: string
    supplier?: string
  }) => void
  currentExpId: string
  allExperiments: Experiment[]
}) {
  const [specifying, setSpecifying] = useState(false)
  // Local copy — green state only commits from parent (on blur/Enter or suggestion click)
  const [localLabel, setLocalLabel] = useState(override?.inventoryLabel ?? "")

  // Sync when parent changes (e.g. suggestion clicked from outside)
  useEffect(() => {
    setLocalLabel(override?.inventoryLabel ?? "")
  }, [override?.inventoryLabel])

  const priorLabels = useMemo(() => {
    const labels = new Set<string>()
    for (const exp of allExperiments) {
      if (exp.id === currentExpId) continue
      const label =
        exp.chemicalsPrep?.materialOverrides?.[material.id]?.inventoryLabel
      if (label) labels.add(label)
    }
    return [...labels]
  }, [allExperiments, material.id, currentExpId])

  const isAssigned = Boolean(override?.inventoryLabel)
  // Show inputs when: user clicked Specify, no priors exist, or already assigned
  const showInputs = specifying || priorLabels.length === 0 || isAssigned

  const commitLabel = () => {
    const trimmed = localLabel.trim()
    if (trimmed !== (override?.inventoryLabel ?? "")) {
      onUpdate({ inventoryLabel: trimmed })
    }
  }

  return (
    <Box style={rowStyle(isAssigned)}>
      <Group gap="sm" align="flex-start" wrap="nowrap">
        {/* Material name + CAS */}
        <Box style={{ minWidth: 160, flex: "0 0 160px" }}>
          <Group gap={4} align="center" wrap="nowrap">
            {isAssigned && (
              <IconCheck size={14} color="var(--mantine-color-teal-6)" />
            )}
            <Text
              size="sm"
              fw={600}
              truncate
              c={isAssigned ? "teal" : undefined}
            >
              {material.name || "Unnamed"}
            </Text>
          </Group>
          {material.casNumber && (
            <Text size="xs" c="dimmed">
              CAS {material.casNumber}
            </Text>
          )}
        </Box>

        {showInputs ? (
          /* Input fields — always stay visible even when row is green */
          <Group gap="sm" align="flex-end" wrap="wrap" style={{ flex: 1 }}>
            <TextInput
              size="xs"
              label="Inventory Label"
              placeholder={material.inventoryLabel || "e.g. PbI2-Sigma-001"}
              value={localLabel}
              onChange={(e) => setLocalLabel(e.currentTarget.value)}
              onBlur={commitLabel}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.currentTarget.blur()
                }
              }}
              style={{ flex: 1, minWidth: 140 }}
            />
            <TextInput
              size="xs"
              label="Purity"
              placeholder={material.purity || "—"}
              value={override?.purity ?? ""}
              onChange={(e) => onUpdate({ purity: e.currentTarget.value })}
              style={{ width: 100 }}
            />
            <TextInput
              size="xs"
              label="Supplier"
              placeholder={material.supplier || "—"}
              value={override?.supplier ?? ""}
              onChange={(e) => onUpdate({ supplier: e.currentTarget.value })}
              style={{ width: 110 }}
            />
            {!isAssigned && priorLabels.length > 0 && (
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                style={{ alignSelf: "flex-end", marginBottom: 1 }}
                onClick={() => setSpecifying(false)}
              >
                ← Suggestions
              </Button>
            )}
          </Group>
        ) : (
          /* Suggestion buttons */
          <Group gap={6} wrap="wrap" align="center" style={{ flex: 1 }}>
            {priorLabels.map((label) => (
              <Button
                key={label}
                size="compact-xs"
                variant="light"
                color="teal"
                onClick={() => {
                  onUpdate({ inventoryLabel: label })
                  setSpecifying(true)
                }}
              >
                {label}
              </Button>
            ))}
            <Button
              size="compact-xs"
              variant="outline"
              color="gray"
              onClick={() => setSpecifying(true)}
            >
              Specify
            </Button>
          </Group>
        )}
      </Group>
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Solution Batch Row
// ─────────────────────────────────────────────────────────────────────────────

type PriorBatch = {
  expId: string
  expName: string
  expDate: string
  volumeMl?: string
}

function SolutionBatchRow({
  item,
  batch,
  materials,
  priorBatches,
  onUpdateBatch,
}: {
  item: SolutionItem
  batch?: ExperimentSolutionBatch
  materials: Material[]
  priorBatches: PriorBatch[]
  onUpdateBatch: (patch: Partial<ExperimentSolutionBatch>) => void
}) {
  const mode = batch?.mode ?? "make"
  const totalVol = batch?.totalVolumeMl ?? "0"
  const volumeNum = parseFloat(totalVol) || 0
  const isDone =
    mode === "take" ? Boolean(batch?.takenFromExpId) : volumeNum > 0

  const asSpecifiedVol =
    item.kind === "recipe" && item.recipe
      ? item.recipe.totalSolventVolumeMl
      : undefined

  const isAtSpecified =
    asSpecifiedVol !== undefined &&
    Math.abs(volumeNum - (parseFloat(asSpecifiedVol) || 0)) < 0.001

  const { quantityRows, perBatch } = useMemo(() => {
    if (item.kind === "recipe" && item.recipe) {
      const displayVol =
        volumeNum > 0
          ? volumeNum
          : parseFloat(item.recipe.totalSolventVolumeMl) || 1
      return {
        quantityRows: scaleRecipeQuantities(item.recipe, displayVol),
        perBatch: false,
      }
    }
    if (item.kind === "solution" && item.solution) {
      return {
        quantityRows: scaleSolutionQuantities(item.solution, materials),
        perBatch: true,
      }
    }
    return { quantityRows: [], perBatch: false }
  }, [item, volumeNum, materials])

  const quantityLabel =
    item.kind === "recipe" && volumeNum > 0
      ? `${item.label} (${volumeNum} mL)`
      : item.label

  return (
    <Box style={rowStyle(isDone)}>
      <Group gap="sm" align="flex-end" wrap="wrap">
        {/* Label */}
        <Box style={{ minWidth: 180, flex: "0 0 180px" }}>
          <Group gap={4} wrap="nowrap" align="center">
            {isDone && (
              <IconCheck size={14} color="var(--mantine-color-teal-6)" />
            )}
            <IconDroplet size={14} color="var(--mantine-color-blue-5)" />
            <Text size="sm" fw={600} truncate c={isDone ? "teal" : undefined}>
              {item.label}
            </Text>
          </Group>
          <Badge
            size="xs"
            variant="light"
            color={item.kind === "recipe" ? "violet" : "blue"}
            mt={2}
          >
            {item.kind === "recipe" ? "Chemistry Recipe" : "Solution"}
          </Badge>
        </Box>

        {/* Mode */}
        <NativeSelect
          size="xs"
          label="Mode"
          value={mode}
          onChange={(e) =>
            onUpdateBatch({ mode: e.currentTarget.value as "make" | "take" })
          }
          data={[
            { label: "Make fresh", value: "make" },
            { label: "Take from batch", value: "take" },
          ]}
          style={{ width: 140 }}
        />

        {mode === "make" ? (
          <Group gap="sm" align="flex-end">
            <NumberInput
              size="xs"
              label="Quantity (mL)"
              min={0}
              step={0.5}
              value={volumeNum}
              onChange={(v) =>
                onUpdateBatch({ totalVolumeMl: v !== "" ? String(v) : "0" })
              }
              style={{ width: 140 }}
            />
            {asSpecifiedVol && (
              <Button
                size="compact-xs"
                variant={isAtSpecified ? "filled" : "light"}
                color="teal"
                style={{ alignSelf: "flex-end", marginBottom: 1 }}
                onClick={() => onUpdateBatch({ totalVolumeMl: asSpecifiedVol })}
              >
                As specified ({asSpecifiedVol} mL)
              </Button>
            )}
          </Group>
        ) : (
          <Select
            size="xs"
            label="Source batch"
            placeholder={
              priorBatches.length === 0
                ? "No prior batches found"
                : "Select batch..."
            }
            style={{ flex: 1, minWidth: 260 }}
            disabled={priorBatches.length === 0}
            data={priorBatches.map((b) => ({
              value: b.expId,
              label: `${b.expName}${b.expDate ? ` (${b.expDate})` : ""}${b.volumeMl ? ` — ${b.volumeMl} mL` : ""}`,
            }))}
            value={batch?.takenFromExpId ?? null}
            onChange={(v) => {
              if (v)
                onUpdateBatch({ takenFromExpId: v, takenFromBatchId: item.key })
              else
                onUpdateBatch({
                  takenFromExpId: undefined,
                  takenFromBatchId: undefined,
                })
            }}
            clearable
          />
        )}
      </Group>

      {/* Inline quantity breakdown */}
      {mode === "make" && (
        <QuantityTable
          label={quantityLabel}
          rows={quantityRows}
          perBatch={perBatch}
        />
      )}
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main ChemicalsTab
// ─────────────────────────────────────────────────────────────────────────────

export function ChemicalsTab({
  experiment,
  process,
  materials,
  solutions,
  allExperiments,
  onUpdate,
}: {
  experiment: Experiment
  process: Process
  materials: Material[]
  solutions: Solution[]
  allExperiments: Experiment[]
  onUpdate: (exp: Experiment) => void
}) {
  const { materialIds, solutionItems } = React.useMemo(
    () => collectChemicals(process, materials, solutions),
    [process, materials, solutions],
  )

  const prep: ExperimentChemicalsPrep = experiment.chemicalsPrep ?? {}

  const updatePrep = (patch: Partial<ExperimentChemicalsPrep>) => {
    onUpdate({ ...experiment, chemicalsPrep: { ...prep, ...patch } })
  }

  const updateMaterialOverride = (
    matId: string,
    patch: { inventoryLabel?: string; purity?: string; supplier?: string },
  ) => {
    const prev = prep.materialOverrides ?? {}
    updatePrep({
      materialOverrides: {
        ...prev,
        [matId]: { ...(prev[matId] ?? {}), ...patch },
      },
    })
  }

  const updateSolutionBatch = (
    key: string,
    patch: Partial<ExperimentSolutionBatch>,
  ) => {
    const prev = prep.solutionBatches ?? {}
    updatePrep({
      solutionBatches: {
        ...prev,
        [key]: { mode: "make", ...(prev[key] ?? {}), ...patch },
      },
    })
  }

  const renderedMaterials = React.useMemo(
    () =>
      materialIds
        .map((id) => materials.find((m) => m.id === id))
        .filter((m): m is Material => Boolean(m)),
    [materialIds, materials],
  )

  if (materialIds.length === 0 && solutionItems.length === 0) {
    return (
      <Text size="sm" c="dimmed" ta="center" py="xl">
        No materials or solutions are assigned to processing steps yet. Add them
        in the Process editor first.
      </Text>
    )
  }

  return (
    <Stack gap="lg">
      {/* Materials */}
      {renderedMaterials.length > 0 && (
        <Box>
          <Group gap="xs" mb="sm">
            <IconAtom size={16} color="var(--mantine-color-orange-6)" />
            <Text size="sm" fw={700} tt="uppercase" c="dimmed">
              Materials
            </Text>
            <Text size="xs" c="dimmed">
              (incl. solution components)
            </Text>
          </Group>
          <Stack gap={6}>
            {renderedMaterials.map((mat) => (
              <MaterialOverrideRow
                key={mat.id}
                material={mat}
                override={prep.materialOverrides?.[mat.id]}
                onUpdate={(patch) => updateMaterialOverride(mat.id, patch)}
                currentExpId={experiment.id}
                allExperiments={allExperiments}
              />
            ))}
          </Stack>
        </Box>
      )}

      {/* Solutions & Recipes */}
      {solutionItems.length > 0 && (
        <Box>
          <Group gap="xs" mb="sm">
            <IconFlask2 size={16} color="var(--mantine-color-blue-6)" />
            <Text size="sm" fw={700} tt="uppercase" c="dimmed">
              Solutions & Recipes
            </Text>
          </Group>
          <Stack gap={6}>
            {solutionItems.map((item) => {
              const priorBatches: PriorBatch[] = allExperiments
                .filter((exp) => exp.id !== experiment.id)
                .flatMap((exp) => {
                  const b = exp.chemicalsPrep?.solutionBatches?.[item.key]
                  if (!b || b.mode !== "make") return []
                  return [
                    {
                      expId: exp.id,
                      expName: exp.name || "Untitled",
                      expDate: exp.date || "",
                      volumeMl: b.totalVolumeMl,
                    },
                  ]
                })
              return (
                <SolutionBatchRow
                  key={item.key}
                  item={item}
                  batch={prep.solutionBatches?.[item.key]}
                  materials={materials}
                  priorBatches={priorBatches}
                  onUpdateBatch={(patch) =>
                    updateSolutionBatch(item.key, patch)
                  }
                />
              )
            })}
          </Stack>
        </Box>
      )}
    </Stack>
  )
}
