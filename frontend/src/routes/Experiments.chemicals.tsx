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
  Tooltip,
} from "@mantine/core"
import {
  IconAtom,
  IconDroplet,
  IconFlask2,
} from "@tabler/icons-react"
import * as React from "react"
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
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

export function collectChemicals(
  process: Process,
  materials: Material[],
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
      if (step.materialId && !substrateIds.has(step.materialId)) {
        matIds.add(step.materialId)
      }
      if (step.solutionId) solIds.add(step.solutionId)
      if (step.chemRecipeId) recIds.add(step.chemRecipeId)
    }
  }

  // Add component materials from entity solutions
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

function scaleRecipeQuantities(
  recipe: ProcessSolutionRecipe,
  userVolumeMl: number,
): Array<{ name: string; amount: string; unit: string }> {
  const refVol = parseFloat(recipe.totalSolventVolumeMl) || 1
  const scale = userVolumeMl / refVol
  const totalRatio =
    recipe.solvents.reduce((s, v) => s + v.volumeRatio, 0) || 1

  const rows: Array<{ name: string; amount: string; unit: string }> = []
  for (const sv of recipe.solvents) {
    const vol = (sv.volumeRatio / totalRatio) * userVolumeMl
    rows.push({ name: sv.name || "Solvent", amount: vol.toFixed(3), unit: "mL" })
  }
  for (const sl of recipe.solutes) {
    const scaled = (parseFloat(sl.amount) || 0) * scale
    rows.push({ name: sl.name || "Solute", amount: scaled.toFixed(3), unit: sl.unit })
  }
  return rows
}

function scaleSolutionQuantities(
  sol: Solution,
  materials: Material[],
  multiplier: number,
): Array<{ name: string; amount: string; unit: string }> {
  return sol.components.map((comp) => {
    const mat = materials.find((m) => m.id === comp.materialId)
    const name = mat?.name ?? "Component"
    const raw = parseFloat(comp.amount)
    const scaled = Number.isNaN(raw) ? comp.amount : (raw * multiplier).toFixed(3)
    return { name, amount: scaled, unit: comp.unit }
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Material Override Row
// ─────────────────────────────────────────────────────────────────────────────

function MaterialOverrideRow({
  material,
  override,
  onUpdate,
}: {
  material: Material
  override?: { inventoryLabel?: string; purity?: string; supplier?: string }
  onUpdate: (patch: {
    inventoryLabel?: string
    purity?: string
    supplier?: string
  }) => void
}) {
  return (
    <Group
      gap="sm"
      align="flex-end"
      wrap="nowrap"
      style={{
        borderBottom: "1px solid var(--mantine-color-gray-2)",
        paddingBottom: 8,
      }}
    >
      <Box style={{ minWidth: 160, flex: "0 0 160px" }}>
        <Text size="sm" fw={600} truncate>
          {material.name || "Unnamed"}
        </Text>
        {material.casNumber && (
          <Text size="xs" c="dimmed">
            CAS {material.casNumber}
          </Text>
        )}
      </Box>
      <TextInput
        size="xs"
        label="Inventory Label"
        placeholder={material.inventoryLabel || "—"}
        value={override?.inventoryLabel ?? ""}
        onChange={(e) => onUpdate({ inventoryLabel: e.currentTarget.value })}
        style={{ flex: 1 }}
      />
      <TextInput
        size="xs"
        label="Purity"
        placeholder={material.purity || "—"}
        value={override?.purity ?? ""}
        onChange={(e) => onUpdate({ purity: e.currentTarget.value })}
        style={{ flex: 1 }}
      />
      <TextInput
        size="xs"
        label="Supplier"
        placeholder={material.supplier || "—"}
        value={override?.supplier ?? ""}
        onChange={(e) => onUpdate({ supplier: e.currentTarget.value })}
        style={{ flex: 1 }}
      />
    </Group>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Quantity tooltip
// ─────────────────────────────────────────────────────────────────────────────

function QuantitiesTooltip({
  rows,
}: {
  rows: Array<{ name: string; amount: string; unit: string }>
}) {
  if (rows.length === 0) return null
  return (
    <Tooltip
      label={
        <Stack gap={2} p={2}>
          {rows.map((r, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: stable order
            <Group key={i} gap="md" justify="space-between">
              <Text size="xs" c="dimmed">
                {r.name}
              </Text>
              <Text size="xs" fw={700}>
                {r.amount} {r.unit}
              </Text>
            </Group>
          ))}
        </Stack>
      }
      withArrow
      multiline
      w={280}
      position="bottom"
    >
      <Button size="xs" variant="light" color="teal">
        Quantities ▾
      </Button>
    </Tooltip>
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

  const quantityRows = React.useMemo(() => {
    if (item.kind === "recipe" && item.recipe) {
      const refVol = parseFloat(item.recipe.totalSolventVolumeMl) || 1
      const vol = parseFloat(batch?.totalVolumeMl ?? "") || refVol
      return scaleRecipeQuantities(item.recipe, vol)
    }
    if (item.kind === "solution" && item.solution) {
      const mult = parseFloat(batch?.multiplier ?? "1") || 1
      return scaleSolutionQuantities(item.solution, materials, mult)
    }
    return []
  }, [item, batch, materials])

  return (
    <Group
      gap="sm"
      align="flex-end"
      wrap="wrap"
      style={{
        borderBottom: "1px solid var(--mantine-color-gray-2)",
        paddingBottom: 8,
      }}
    >
      <Box style={{ minWidth: 180, flex: "0 0 180px" }}>
        <Group gap={4} wrap="nowrap">
          <IconDroplet size={14} color="var(--mantine-color-blue-5)" />
          <Text size="sm" fw={600} truncate>
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
        <>
          {item.kind === "recipe" ? (
            <NumberInput
              size="xs"
              label="Total volume (mL)"
              placeholder={item.recipe?.totalSolventVolumeMl || "5"}
              value={batch?.totalVolumeMl ? Number(batch.totalVolumeMl) : ""}
              onChange={(v) =>
                onUpdateBatch({ totalVolumeMl: v !== "" ? String(v) : "" })
              }
              min={0}
              style={{ width: 150 }}
            />
          ) : (
            <NumberInput
              size="xs"
              label="Batches (×)"
              min={0.01}
              step={0.5}
              value={batch?.multiplier ? Number(batch.multiplier) : ""}
              placeholder="1"
              onChange={(v) =>
                onUpdateBatch({ multiplier: v !== "" ? String(v) : "" })
              }
              style={{ width: 110 }}
            />
          )}
          <QuantitiesTooltip rows={quantityRows} />
        </>
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
            if (v) onUpdateBatch({ takenFromExpId: v, takenFromBatchId: item.key })
            else onUpdateBatch({ takenFromExpId: undefined, takenFromBatchId: undefined })
          }}
          clearable
        />
      )}
    </Group>
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
        No materials or solutions are assigned to processing steps yet. Add
        them in the Process editor first.
      </Text>
    )
  }

  return (
    <Stack gap="lg">
      {/* Prep time */}
      <Box>
        <Text size="xs" fw={600} c="dimmed" tt="uppercase" mb={4}>
          Chemicals Preparation Time
        </Text>
        <TextInput
          size="sm"
          type="datetime-local"
          value={prep.prepTime ?? ""}
          onChange={(e) => updatePrep({ prepTime: e.currentTarget.value })}
          style={{ width: 240 }}
        />
      </Box>

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
                  onUpdateBatch={(patch) => updateSolutionBatch(item.key, patch)}
                />
              )
            })}
          </Stack>
        </Box>
      )}
    </Stack>
  )
}
