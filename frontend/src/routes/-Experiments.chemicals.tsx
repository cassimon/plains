import {
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Modal,
  NativeSelect,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
  Title,
} from "@mantine/core"
import {
  IconAtom,
  IconCheck,
  IconDroplet,
  IconFlask2,
  IconPackageImport,
  IconPlus,
  IconWorldSearch,
} from "@tabler/icons-react"
import * as React from "react"
import { useCallback, useMemo, useRef, useState } from "react"
import type {
  CanvasCollectionElement,
  Experiment,
  ExperimentChemicalsPrep,
  ExperimentSolutionBatch,
  Plane,
  Process,
  ProcessSolutionRecipe,
  ProcessStepInlineMaterial,
} from "@/store/AppContext"
import { useAppContext, useEntityCollection } from "@/store/AppContext"

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

type MaterialItem = {
  stepId: string
  material: ProcessStepInlineMaterial
  sourceRecipeName?: string
  ingredientType?: "solvent" | "solute"
}

type SolutionItem = {
  key: string // "recipe:{id}"
  label: string
  kind: "recipe"
  id: string
  recipe?: ProcessSolutionRecipe
}

type CandidateExp = {
  exp: Experiment
  planeName: string
  planeId: string
  collectionId: string
  collectionName: string
  priority: 0 | 1 | 2
}

type ChemicalEntry = {
  inventoryLabel: string
  purity?: string
  supplier?: string
  productId?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Public helpers
// ─────────────────────────────────────────────────────────────────────────────

export function collectChemicals(process: Process): {
  materialItems: MaterialItem[]
  solutionItems: SolutionItem[]
} {
  const recIds = new Set<string>()
  const materialItems: MaterialItem[] = []
  const seenStepIds = new Set<string>()

  for (const stage of process.stages) {
    for (const step of stage.alternatives) {
      if (step.stepCategory === "substrate_preparation") continue
      if (step.inlineMaterial && !seenStepIds.has(step.id)) {
        seenStepIds.add(step.id)
        materialItems.push({ stepId: step.id, material: step.inlineMaterial })
      }
      if (step.chemRecipeId) recIds.add(step.chemRecipeId)
    }
  }

  const solutionItems: SolutionItem[] = [...recIds].map((id) => {
    const recipe = (process.solutionRecipes ?? []).find((r) => r.id === id)
    return {
      key: `recipe:${id}`,
      label: recipe?.name ?? id,
      kind: "recipe" as const,
      id,
      recipe,
    }
  })

  // Add solvents and solutes from each solution recipe as individual material items
  const seenIngredientKeys = new Set<string>()
  for (const item of solutionItems) {
    if (!item.recipe) continue
    for (const sv of item.recipe.solvents) {
      const key = `ingredient:${item.id}:${sv.id}`
      if (seenIngredientKeys.has(key)) continue
      seenIngredientKeys.add(key)
      materialItems.push({
        stepId: key,
        material: {
          name: sv.name || "Solvent",
          pubchemCid: sv.pubchemCid || undefined,
        },
        sourceRecipeName: item.recipe.name,
        ingredientType: "solvent",
      })
    }
    for (const sl of item.recipe.solutes) {
      const key = `ingredient:${item.id}:${sl.id}`
      if (seenIngredientKeys.has(key)) continue
      seenIngredientKeys.add(key)
      materialItems.push({
        stepId: key,
        material: {
          name: sl.name || "Solute",
          pubchemCid: sl.pubchemCid || undefined,
        },
        sourceRecipeName: item.recipe.name,
        ingredientType: "solute",
      })
    }
  }

  return { materialItems, solutionItems }
}

export function computeChemsDone(
  prep: ExperimentChemicalsPrep | undefined,
  materialItems: Array<{ stepId: string }>,
  solutionItems: Array<{ key: string }>,
): boolean {
  if (materialItems.length === 0 && solutionItems.length === 0) return true
  const allMatsDone = materialItems.every((item) =>
    Boolean(prep?.materialOverrides?.[item.stepId]?.inventoryLabel),
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

function buildExpLocationMap(planes: Plane[]): Map<
  string,
  {
    planeId: string
    planeName: string
    collectionId: string
    collectionName: string
  }
> {
  const map = new Map<
    string,
    {
      planeId: string
      planeName: string
      collectionId: string
      collectionName: string
    }
  >()
  for (const plane of planes) {
    for (const el of plane.elements) {
      if (el.type !== "collection") continue
      const col = el as CanvasCollectionElement
      for (const ref of col.refs) {
        if (ref.kind === "experiment" && !map.has(ref.id)) {
          map.set(ref.id, {
            planeId: plane.id,
            planeName: plane.name,
            collectionId: col.id,
            collectionName: col.name,
          })
        }
      }
    }
  }
  return map
}

function buildGroupedCandidates(
  allExperiments: Experiment[],
  currentExpId: string,
  currentProcessId: string,
  currentCollectionId: string | null,
  planes: Plane[],
  activePlaneId: string | null,
  importedCollectionIds: string[],
): CandidateExp[] {
  const expLocation = buildExpLocationMap(planes)
  const importedSet = new Set(importedCollectionIds)
  const results: CandidateExp[] = []

  for (const exp of allExperiments) {
    if (exp.id === currentExpId) continue
    if (exp.processId !== currentProcessId) continue

    const loc = expLocation.get(exp.id)
    if (!loc) continue

    let priority: 0 | 1 | 2 | undefined

    if (currentCollectionId && loc.collectionId === currentCollectionId) {
      priority = 0
    } else if (!activePlaneId || loc.planeId === activePlaneId) {
      priority = 1
    } else if (importedSet.has(loc.collectionId)) {
      priority = 2
    }

    if (priority === undefined) continue
    results.push({ exp, ...loc, priority })
  }

  results.sort((a, b) => {
    if (a.priority !== b.priority) return a.priority - b.priority
    return (b.exp.date || "").localeCompare(a.exp.date || "")
  })

  return results
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
// Browse other planes modal
// ─────────────────────────────────────────────────────────────────────────────

function BrowsePlaneModal({
  opened,
  onClose,
  planes,
  activePlaneId,
  allExperiments,
  currentProcessId,
  importedCollectionIds,
  onImport,
  getRelevantInfo,
}: {
  opened: boolean
  onClose: () => void
  planes: Plane[]
  activePlaneId: string | null
  allExperiments: Experiment[]
  currentProcessId: string
  importedCollectionIds: string[]
  onImport: (collectionId: string) => void
  getRelevantInfo: (exp: Experiment) => string | null
}) {
  const importedSet = new Set(importedCollectionIds)
  const expMap = useMemo(
    () => new Map(allExperiments.map((e) => [e.id, e])),
    [allExperiments],
  )

  const relevantPlanes = useMemo(() => {
    return planes
      .filter((p) => p.id !== activePlaneId)
      .map((plane) => {
        const collections = plane.elements
          .filter((el) => el.type === "collection")
          .map((el) => {
            const col = el as CanvasCollectionElement
            const matchingExps = col.refs
              .filter((r) => r.kind === "experiment")
              .map((r) => expMap.get(r.id))
              .filter(
                (e): e is Experiment =>
                  e !== undefined && e.processId === currentProcessId,
              )
            return { col, matchingExps }
          })
          .filter(({ matchingExps }) => matchingExps.length > 0)
        return { plane, collections }
      })
      .filter(({ collections }) => collections.length > 0)
  }, [planes, activePlaneId, expMap, currentProcessId])

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Browse other planes"
      size="lg"
    >
      {relevantPlanes.length === 0 ? (
        <Text c="dimmed" size="sm" ta="center" py="xl">
          No experiments using the same process were found on other planes.
        </Text>
      ) : (
        <Stack gap="lg">
          {relevantPlanes.map(({ plane, collections }) => (
            <Box key={plane.id}>
              <Title order={5} mb="xs">
                {plane.name}
              </Title>
              <Stack gap="xs">
                {collections.map(({ col, matchingExps }) => {
                  const isImported = importedSet.has(col.id)
                  return (
                    <Box
                      key={col.id}
                      style={{
                        border: `1px solid ${isImported ? "var(--mantine-color-teal-3)" : "var(--mantine-color-gray-3)"}`,
                        borderRadius: 8,
                        padding: "8px 12px",
                        background: isImported
                          ? "var(--mantine-color-teal-0)"
                          : undefined,
                      }}
                    >
                      <Group justify="space-between" mb={4}>
                        <Group gap="xs">
                          <Text size="sm" fw={600}>
                            {col.name}
                          </Text>
                          {isImported && (
                            <Badge size="xs" color="teal" variant="light">
                              Imported
                            </Badge>
                          )}
                        </Group>
                        {!isImported && (
                          <Button
                            size="compact-xs"
                            variant="light"
                            color="teal"
                            leftSection={<IconPackageImport size={12} />}
                            onClick={() => onImport(col.id)}
                          >
                            Import
                          </Button>
                        )}
                      </Group>
                      <Stack gap={2}>
                        {matchingExps.map((exp) => {
                          const info = getRelevantInfo(exp)
                          return (
                            <Group key={exp.id} gap="xs">
                              <Text size="xs" c="dimmed">
                                {exp.name || "Untitled"}
                              </Text>
                              {exp.date && (
                                <Text size="xs" c="dimmed">
                                  ({exp.date})
                                </Text>
                              )}
                              {info && (
                                <Text size="xs" fw={500}>
                                  {info}
                                </Text>
                              )}
                            </Group>
                          )
                        })}
                      </Stack>
                    </Box>
                  )
                })}
              </Stack>
              <Divider mt="md" />
            </Box>
          ))}
        </Stack>
      )}
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Material Override Row
// ─────────────────────────────────────────────────────────────────────────────

function MaterialOverrideRow({
  stepId,
  material,
  override,
  onUpdate,
  knownEntries,
  onBrowse,
}: {
  stepId: string
  material: ProcessStepInlineMaterial
  override?: {
    inventoryLabel?: string
    purity?: string
    supplier?: string
    productId?: string
  }
  onUpdate: (patch: {
    inventoryLabel?: string
    purity?: string
    supplier?: string
    productId?: string
  }) => void
  knownEntries: ChemicalEntry[]
  onBrowse: (getRelevantInfo: (exp: Experiment) => string | null) => void
}) {
  const [specifying, setSpecifying] = useState(false)
  const [localLabel, setLocalLabel] = useState(override?.inventoryLabel ?? "")
  const labelRef = useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    setLocalLabel(override?.inventoryLabel ?? "")
  }, [override?.inventoryLabel])

  const isAssigned = Boolean(override?.inventoryLabel)
  const showDetail = isAssigned || specifying

  const getRelevantInfo = useCallback(
    (exp: Experiment) =>
      exp.chemicalsPrep?.materialOverrides?.[stepId]?.inventoryLabel ?? null,
    [stepId],
  )

  const commitLabel = () => {
    const trimmed = localLabel.trim()
    if (trimmed !== (override?.inventoryLabel ?? "")) {
      onUpdate({ inventoryLabel: trimmed })
    }
  }

  const handleQuickAssign = (entry: ChemicalEntry) => {
    onUpdate(entry)
    setLocalLabel(entry.inventoryLabel)
    setSpecifying(true)
  }

  const handleAddNew = () => {
    setSpecifying(true)
    requestAnimationFrame(() => labelRef.current?.focus())
  }

  return (
    <Box style={rowStyle(isAssigned)}>
      <Group gap="sm" align="flex-start" wrap="nowrap">
        {/* Material name */}
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
          {material.pubchemCid && (
            <Text size="xs" c="dimmed">
              PubChem {material.pubchemCid}
            </Text>
          )}
        </Box>

        {showDetail ? (
          /* Detail form */
          <Group gap="sm" align="flex-end" wrap="wrap" style={{ flex: 1 }}>
            <TextInput
              ref={labelRef}
              size="xs"
              label="Inventory Label"
              withAsterisk
              placeholder="e.g. PbI2-Sigma-001"
              value={localLabel}
              onChange={(e) => setLocalLabel(e.currentTarget.value)}
              onBlur={commitLabel}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur()
              }}
              style={{ flex: 1, minWidth: 140 }}
              styles={{
                label: {
                  fontWeight: 700,
                  color: "var(--mantine-color-orange-7)",
                },
                input: {
                  borderColor: localLabel
                    ? undefined
                    : "var(--mantine-color-orange-4)",
                },
              }}
            />
            <TextInput
              size="xs"
              label="Purity"
              placeholder="—"
              value={override?.purity ?? ""}
              onChange={(e) => onUpdate({ purity: e.currentTarget.value })}
              style={{ width: 90 }}
            />
            <TextInput
              size="xs"
              label="Supplier"
              placeholder="—"
              value={override?.supplier ?? ""}
              onChange={(e) => onUpdate({ supplier: e.currentTarget.value })}
              style={{ width: 100 }}
            />
            <TextInput
              size="xs"
              label="Product ID"
              placeholder="—"
              value={override?.productId ?? ""}
              onChange={(e) => onUpdate({ productId: e.currentTarget.value })}
              style={{ width: 100 }}
            />
            {!isAssigned && (
              <Button
                size="compact-xs"
                variant="subtle"
                color="gray"
                style={{ alignSelf: "flex-end", marginBottom: 1 }}
                onClick={() => setSpecifying(false)}
              >
                ← Back
              </Button>
            )}
          </Group>
        ) : (
          /* Fast-assign panel */
          <Stack gap={6} style={{ flex: 1 }}>
            {knownEntries.length > 0 && (
              <Group gap={6} wrap="wrap">
                {knownEntries.map((entry) => (
                  <Button
                    key={entry.inventoryLabel}
                    size="compact-xs"
                    variant="light"
                    color="teal"
                    onClick={() => handleQuickAssign(entry)}
                  >
                    {entry.inventoryLabel}
                    {(entry.purity || entry.supplier) && (
                      <Text span size="10px" c="dimmed" ml={4}>
                        {[entry.purity, entry.supplier]
                          .filter(Boolean)
                          .join(" · ")}
                      </Text>
                    )}
                  </Button>
                ))}
              </Group>
            )}
            <Group gap={6} wrap="wrap">
              <Button
                size="compact-xs"
                variant="outline"
                color="blue"
                leftSection={<IconPlus size={12} />}
                onClick={handleAddNew}
              >
                Add Inventory Chemical
              </Button>
              <Button
                size="compact-xs"
                variant="subtle"
                color="blue"
                leftSection={<IconWorldSearch size={12} />}
                onClick={() => onBrowse(getRelevantInfo)}
              >
                Browse other planes
              </Button>
            </Group>
          </Stack>
        )}
      </Group>
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Solution Batch Row
// ─────────────────────────────────────────────────────────────────────────────

function SolutionBatchRow({
  item,
  batch,
  candidates,
  onBrowse,
  onUpdateBatch,
}: {
  item: SolutionItem
  batch?: ExperimentSolutionBatch
  candidates: CandidateExp[]
  onBrowse: (getRelevantInfo: (exp: Experiment) => string | null) => void
  onUpdateBatch: (patch: Partial<ExperimentSolutionBatch>) => void
}) {
  const mode = batch?.mode ?? "make"
  const totalVol = batch?.totalVolumeMl ?? "0"
  const volumeNum = parseFloat(totalVol) || 0
  const isDone =
    mode === "take" ? Boolean(batch?.takenFromExpId) : volumeNum > 0

  // Start in detail view if batch data has been set already
  const [showDetail, setShowDetail] = useState(Boolean(batch))
  const quantityWrapperRef = useRef<HTMLDivElement>(null)

  const asSpecifiedVol =
    item.kind === "recipe" && item.recipe
      ? item.recipe.totalSolventVolumeMl
      : undefined

  const isAtSpecified =
    asSpecifiedVol !== undefined &&
    Math.abs(volumeNum - (parseFloat(asSpecifiedVol) || 0)) < 0.001

  const { quantityRows, perBatch } = useMemo(() => {
    if (item.recipe) {
      const displayVol =
        volumeNum > 0
          ? volumeNum
          : parseFloat(item.recipe.totalSolventVolumeMl) || 1
      return {
        quantityRows: scaleRecipeQuantities(item.recipe, displayVol),
        perBatch: false,
      }
    }
    return { quantityRows: [], perBatch: false }
  }, [item, volumeNum])

  const quantityLabel =
    item.kind === "recipe" && volumeNum > 0
      ? `${item.label} (${volumeNum} mL)`
      : item.label

  const selectData = useMemo(() => {
    const groups = new Map<
      string,
      { groupLabel: string; items: { value: string; label: string }[] }
    >()
    for (const c of candidates) {
      const b = c.exp.chemicalsPrep?.solutionBatches?.[item.key]
      if (!b || b.mode !== "make") continue
      const prefix =
        c.priority === 0
          ? "Current collection"
          : c.priority === 1
            ? "This plane"
            : "Imported"
      const groupKey = `${c.priority}:${c.collectionId}`
      const groupLabel = `${prefix} — ${c.collectionName}`
      if (!groups.has(groupKey)) groups.set(groupKey, { groupLabel, items: [] })
      const vol = b.totalVolumeMl ? ` — ${b.totalVolumeMl} mL` : ""
      const dateStr = c.exp.date ? ` (${c.exp.date})` : ""
      groups.get(groupKey)!.items.push({
        value: c.exp.id,
        label: `${c.exp.name || "Untitled"}${dateStr}${vol}`,
      })
    }
    return [...groups.values()].map((g) => ({
      group: g.groupLabel,
      items: g.items,
    }))
  }, [candidates, item.key])

  const hasPriorBatches = selectData.some((g) => g.items.length > 0)

  const getRelevantInfo = useCallback(
    (exp: Experiment) => {
      const b = exp.chemicalsPrep?.solutionBatches?.[item.key]
      if (!b || b.mode !== "make") return null
      return b.totalVolumeMl ? `${b.totalVolumeMl} mL` : null
    },
    [item.key],
  )

  const handleMakeFresh1ml = () => {
    onUpdateBatch({ mode: "make", totalVolumeMl: "1" })
    setShowDetail(true)
  }

  const handleMakeFreshCustom = () => {
    onUpdateBatch({ mode: "make", totalVolumeMl: "" })
    setShowDetail(true)
    requestAnimationFrame(() => {
      quantityWrapperRef.current?.querySelector("input")?.focus()
    })
  }

  const handleReuse = () => {
    onUpdateBatch({ mode: "take" })
    setShowDetail(true)
  }

  /* Quick-pick panel — shown before any choice is made */
  if (!showDetail) {
    return (
      <Box style={rowStyle(false)}>
        <Group gap="sm" align="center" wrap="wrap">
          <Box style={{ minWidth: 180, flex: "0 0 180px" }}>
            <Group gap={4} wrap="nowrap" align="center">
              <IconDroplet size={14} color="var(--mantine-color-blue-5)" />
              <Text size="sm" fw={600} truncate>
                {item.label}
              </Text>
            </Group>
            <Badge size="xs" variant="light" color="violet" mt={2}>
              Chemistry Recipe
            </Badge>
          </Box>
          <Button
            size="compact-sm"
            variant="filled"
            color="teal"
            onClick={handleMakeFresh1ml}
          >
            Make fresh: 1 mL
          </Button>
          <Button
            size="compact-sm"
            variant="light"
            color="teal"
            onClick={handleMakeFreshCustom}
          >
            Make fresh: custom
          </Button>
          <Button
            size="compact-sm"
            variant="light"
            color="blue"
            onClick={handleReuse}
          >
            Reuse from experiment
          </Button>
        </Group>
      </Box>
    )
  }

  /* Detail form */
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
          <Badge size="xs" variant="light" color="violet" mt={2}>
            Chemistry Recipe
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
            { label: "Reuse from experiment", value: "take" },
          ]}
          style={{ width: 175 }}
        />

        {mode === "make" ? (
          <Group gap="sm" align="flex-end">
            <div ref={quantityWrapperRef}>
              <NumberInput
                size="xs"
                label="Quantity (mL)"
                min={0}
                step={0.5}
                value={volumeNum || ""}
                onChange={(v) =>
                  onUpdateBatch({
                    totalVolumeMl: v !== "" ? String(v) : "0",
                  })
                }
                style={{ width: 140 }}
              />
            </div>
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
          <Group gap="xs" align="flex-end" style={{ flex: 1 }}>
            <Select
              size="xs"
              label="Source experiment"
              placeholder={
                hasPriorBatches
                  ? "Select experiment..."
                  : "No prior batches found"
              }
              style={{ flex: 1, minWidth: 260 }}
              disabled={!hasPriorBatches}
              data={selectData}
              value={batch?.takenFromExpId ?? null}
              onChange={(v) => {
                if (v)
                  onUpdateBatch({
                    takenFromExpId: v,
                    takenFromBatchId: item.key,
                  })
                else
                  onUpdateBatch({
                    takenFromExpId: undefined,
                    takenFromBatchId: undefined,
                  })
              }}
              clearable
            />
            <Button
              size="compact-xs"
              variant="subtle"
              color="blue"
              leftSection={<IconWorldSearch size={12} />}
              style={{ alignSelf: "flex-end", marginBottom: 1 }}
              onClick={() => onBrowse(getRelevantInfo)}
            >
              Browse
            </Button>
          </Group>
        )}

        {!isDone && (
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            style={{ alignSelf: "flex-end", marginBottom: 1 }}
            onClick={() => setShowDetail(false)}
          >
            ← Back
          </Button>
        )}
      </Group>

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
  allExperiments,
  onUpdate,
}: {
  experiment: Experiment
  process: Process
  allExperiments: Experiment[]
  onUpdate: (exp: Experiment) => void
}) {
  const { planes, activePlaneId } = useAppContext()
  const { getEntityCollection } = useEntityCollection()

  const { materialItems, solutionItems } = React.useMemo(
    () => collectChemicals(process),
    [process],
  )

  const prep: ExperimentChemicalsPrep = experiment.chemicalsPrep ?? {}

  const experimentCollection = useMemo(
    () => getEntityCollection("experiment", experiment.id),
    [getEntityCollection, experiment.id],
  )
  const currentCollectionId = experimentCollection?.collection.id ?? null
  const importedCollectionIds = prep.importedCollectionIds ?? []

  const candidates = useMemo(
    () =>
      buildGroupedCandidates(
        allExperiments,
        experiment.id,
        process.id,
        currentCollectionId,
        planes,
        activePlaneId,
        importedCollectionIds,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      allExperiments,
      experiment.id,
      process.id,
      currentCollectionId,
      planes,
      activePlaneId,
      importedCollectionIds,
    ],
  )

  // Build CID → known inventory entries map from same-process candidate experiments
  const cidToEntries = useMemo(() => {
    const stepToCid = new Map(
      materialItems
        .filter((m) => m.material.pubchemCid)
        .map((m) => [m.stepId, m.material.pubchemCid!]),
    )
    const map = new Map<string, ChemicalEntry[]>()
    for (const c of candidates) {
      const overrides = c.exp.chemicalsPrep?.materialOverrides ?? {}
      for (const [sid, ovr] of Object.entries(overrides)) {
        if (!ovr.inventoryLabel) continue
        const cid = stepToCid.get(sid)
        if (!cid) continue
        if (!map.has(cid)) map.set(cid, [])
        const entries = map.get(cid)!
        const isDupe = entries.some(
          (e) =>
            e.inventoryLabel === ovr.inventoryLabel && e.purity === ovr.purity,
        )
        if (!isDupe) {
          entries.push({
            inventoryLabel: ovr.inventoryLabel,
            purity: ovr.purity,
            supplier: ovr.supplier,
            productId: ovr.productId,
          })
        }
      }
    }
    return map
  }, [materialItems, candidates])

  const anyMakeFresh = solutionItems.some(
    (item) => prep.solutionBatches?.[item.key]?.mode === "make",
  )

  const [browseInfo, setBrowseInfo] = useState<{
    getRelevantInfo: (exp: Experiment) => string | null
  } | null>(null)

  const handleBrowse = useCallback(
    (getRelevantInfo: (exp: Experiment) => string | null) => {
      setBrowseInfo({ getRelevantInfo })
    },
    [],
  )

  const updatePrep = (patch: Partial<ExperimentChemicalsPrep>) => {
    onUpdate({ ...experiment, chemicalsPrep: { ...prep, ...patch } })
  }

  const updateMaterialOverride = (
    stepId: string,
    patch: {
      inventoryLabel?: string
      purity?: string
      supplier?: string
      productId?: string
    },
  ) => {
    const prev = prep.materialOverrides ?? {}
    updatePrep({
      materialOverrides: {
        ...prev,
        [stepId]: { ...(prev[stepId] ?? {}), ...patch },
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
        [key]: { ...{ mode: "make" as const }, ...(prev[key] ?? {}), ...patch },
      },
    })
  }

  const handleImportCollection = (collectionId: string) => {
    const current = prep.importedCollectionIds ?? []
    if (!current.includes(collectionId)) {
      updatePrep({ importedCollectionIds: [...current, collectionId] })
    }
  }

  if (materialItems.length === 0 && solutionItems.length === 0) {
    return (
      <Text size="sm" c="dimmed" ta="center" py="xl">
        No materials or solutions are assigned to processing steps yet. Add them
        in the Process editor first.
      </Text>
    )
  }

  return (
    <Stack gap="lg">
      {/* Shared browse modal */}
      {browseInfo && (
        <BrowsePlaneModal
          opened={true}
          onClose={() => setBrowseInfo(null)}
          planes={planes}
          activePlaneId={activePlaneId}
          allExperiments={allExperiments}
          currentProcessId={process.id}
          importedCollectionIds={importedCollectionIds}
          onImport={(collId) => {
            handleImportCollection(collId)
            setBrowseInfo(null)
          }}
          getRelevantInfo={browseInfo.getRelevantInfo}
        />
      )}

      {/* Materials */}
      {materialItems.length > 0 &&
        (() => {
          const stepMaterials = materialItems.filter((m) => !m.sourceRecipeName)
          const ingredientMaterials = materialItems.filter(
            (m) => m.sourceRecipeName,
          )
          const byRecipe = new Map<string, MaterialItem[]>()
          for (const item of ingredientMaterials) {
            const rn = item.sourceRecipeName!
            if (!byRecipe.has(rn)) byRecipe.set(rn, [])
            byRecipe.get(rn)!.push(item)
          }
          return (
            <Box>
              <Group gap="xs" mb="sm">
                <IconAtom size={16} color="var(--mantine-color-orange-6)" />
                <Text size="sm" fw={700} tt="uppercase" c="dimmed">
                  Materials
                </Text>
              </Group>
              <Stack gap={6}>
                {stepMaterials.map(({ stepId, material }) => (
                  <MaterialOverrideRow
                    key={stepId}
                    stepId={stepId}
                    material={material}
                    override={prep.materialOverrides?.[stepId]}
                    onUpdate={(patch) => updateMaterialOverride(stepId, patch)}
                    knownEntries={
                      material.pubchemCid
                        ? (cidToEntries.get(material.pubchemCid) ?? [])
                        : []
                    }
                    onBrowse={handleBrowse}
                  />
                ))}
                {byRecipe.size > 0 && (
                  <Stack gap="sm" mt={stepMaterials.length > 0 ? "xs" : 0}>
                    {[...byRecipe.entries()].map(([recipeName, items]) => (
                      <Box key={recipeName}>
                        <Group gap={4} mb={4} align="center">
                          <IconFlask2
                            size={13}
                            color="var(--mantine-color-blue-5)"
                          />
                          <Text size="10px" c="dimmed" tt="uppercase" fw={600}>
                            From solution: {recipeName}
                          </Text>
                        </Group>
                        <Stack gap={6}>
                          {items.map(({ stepId, material }) => (
                            <MaterialOverrideRow
                              key={stepId}
                              stepId={stepId}
                              material={material}
                              override={prep.materialOverrides?.[stepId]}
                              onUpdate={(patch) =>
                                updateMaterialOverride(stepId, patch)
                              }
                              knownEntries={
                                material.pubchemCid
                                  ? (cidToEntries.get(material.pubchemCid) ??
                                    [])
                                  : []
                              }
                              onBrowse={handleBrowse}
                            />
                          ))}
                        </Stack>
                      </Box>
                    ))}
                  </Stack>
                )}
              </Stack>
            </Box>
          )
        })()}

      {/* Solutions & Recipes */}
      {solutionItems.length > 0 && (
        <Box>
          <Group gap="xs" mb="sm" justify="space-between" align="flex-end">
            <Group gap="xs">
              <IconFlask2 size={16} color="var(--mantine-color-blue-6)" />
              <Text size="sm" fw={700} tt="uppercase" c="dimmed">
                Solutions & Recipes
              </Text>
            </Group>
            {anyMakeFresh && (
              <TextInput
                type="datetime-local"
                size="xs"
                label="Solutions prepared at"
                value={prep.prepTime ?? ""}
                onChange={(e) =>
                  updatePrep({ prepTime: e.currentTarget.value })
                }
                style={{ width: 220 }}
              />
            )}
          </Group>
          <Stack gap={6}>
            {solutionItems.map((item) => (
              <SolutionBatchRow
                key={item.key}
                item={item}
                batch={prep.solutionBatches?.[item.key]}
                onUpdateBatch={(patch) => updateSolutionBatch(item.key, patch)}
                candidates={candidates}
                onBrowse={handleBrowse}
              />
            ))}
          </Stack>
        </Box>
      )}
    </Stack>
  )
}
