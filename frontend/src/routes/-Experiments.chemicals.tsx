import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Collapse,
  Divider,
  Group,
  Modal,
  NumberInput,
  Paper,
  Progress,
  Select,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
  Title,
} from "@mantine/core"
import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconPackageImport,
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

// A single question in the guided flow — either assign an inventory label to a
// material, or decide how much of a solution to prepare.
type QueueItem =
  | {
      kind: "material"
      key: string
      stepId: string
      material: ProcessStepInlineMaterial
      sourceRecipeName?: string
    }
  | { kind: "solution"; key: string; item: SolutionItem }

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

function solutionBatchSummary(batch?: ExperimentSolutionBatch): string {
  if (!batch) return "Not set"
  if (batch.mode === "take") return batch.takenFromExpId ? "Reused" : "Not set"
  return parseFloat(batch.totalVolumeMl ?? "0") > 0
    ? `${batch.totalVolumeMl} mL`
    : "Not set"
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

function buildReuseSelectData(candidates: CandidateExp[], itemKey: string) {
  const groups = new Map<
    string,
    { group: string; items: { value: string; label: string }[] }
  >()
  for (const c of candidates) {
    const b = c.exp.chemicalsPrep?.solutionBatches?.[itemKey]
    if (b?.mode !== "make") continue
    const prefix =
      c.priority === 0
        ? "Current collection"
        : c.priority === 1
          ? "This plane"
          : "Imported"
    const groupKey = `${c.priority}:${c.collectionId}`
    const group = `${prefix} — ${c.collectionName}`
    if (!groups.has(groupKey)) groups.set(groupKey, { group, items: [] })
    const vol = b.totalVolumeMl ? ` — ${b.totalVolumeMl} mL` : ""
    const dateStr = c.exp.date ? ` (${c.exp.date})` : ""
    groups.get(groupKey)!.items.push({
      value: c.exp.id,
      label: `${c.exp.name || "Untitled"}${dateStr}${vol}`,
    })
  }
  return [...groups.values()]
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline quantity table with copy-to-clipboard
// ─────────────────────────────────────────────────────────────────────────────

function QuantityTable({
  label,
  rows,
}: {
  label: string
  rows: Array<{ name: string; amount: string; unit: string }>
}) {
  const [copied, setCopied] = useState(false)

  if (rows.length === 0) return null

  const copyText = () => {
    const lines = rows.map((r) => `${r.name}: ${r.amount} ${r.unit}`)
    navigator.clipboard.writeText([label, ...lines].join("\n"))
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Box
      style={{
        background: "var(--mantine-color-gray-0)",
        borderRadius: 6,
        padding: "6px 10px",
        border: "1px solid var(--mantine-color-gray-2)",
      }}
    >
      <Group gap="xs" mb={4} justify="space-between">
        <Text size="10px" c="dimmed" tt="uppercase" fw={600}>
          You will need
        </Text>
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
// Guided query — assign an inventory label to a single chemical
// ─────────────────────────────────────────────────────────────────────────────

function MaterialQueryCard({
  stepId,
  material,
  override,
  knownEntries,
  positionLabel,
  canGoBack,
  onCommit,
  onDone,
  onBack,
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
  knownEntries: ChemicalEntry[]
  positionLabel: string
  canGoBack: boolean
  onCommit: (patch: {
    inventoryLabel?: string
    purity?: string
    supplier?: string
    productId?: string
  }) => void
  onDone: () => void
  onBack: () => void
  onBrowse: (getRelevantInfo: (exp: Experiment) => string | null) => void
}) {
  const [label, setLabel] = useState(override?.inventoryLabel ?? "")
  const [purity, setPurity] = useState(override?.purity ?? "")
  const [supplier, setSupplier] = useState(override?.supplier ?? "")
  const [productId, setProductId] = useState(override?.productId ?? "")
  const [showDetails, setShowDetails] = useState(
    Boolean(override?.purity || override?.supplier || override?.productId),
  )
  const inputRef = useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    const t = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(t)
  }, [])

  const getRelevantInfo = useCallback(
    (exp: Experiment) =>
      exp.chemicalsPrep?.materialOverrides?.[stepId]?.inventoryLabel ?? null,
    [stepId],
  )

  const canContinue = label.trim().length > 0

  const commitAndContinue = () => {
    if (!canContinue) return
    onCommit({
      inventoryLabel: label.trim(),
      purity: purity.trim() || undefined,
      supplier: supplier.trim() || undefined,
      productId: productId.trim() || undefined,
    })
    onDone()
  }

  return (
    <Stack gap="md">
      <Box>
        <Text size="11px" tt="uppercase" fw={700} c="blue.6" mb={2}>
          {positionLabel}
        </Text>
        <Text size="xl" fw={700}>
          {material.name || "Unnamed chemical"}
        </Text>
        {material.pubchemCid && (
          <Text size="xs" c="dimmed">
            PubChem {material.pubchemCid}
          </Text>
        )}
      </Box>

      {knownEntries.length > 0 && (
        <Box>
          <Text size="xs" c="dimmed" mb={4}>
            Previously used — click to reuse:
          </Text>
          <Group gap={6} wrap="wrap">
            {knownEntries.map((entry) => (
              <Button
                key={entry.inventoryLabel}
                size="compact-xs"
                variant="light"
                color="teal"
                onClick={() => {
                  setLabel(entry.inventoryLabel)
                  setPurity(entry.purity ?? "")
                  setSupplier(entry.supplier ?? "")
                  setProductId(entry.productId ?? "")
                }}
              >
                {entry.inventoryLabel}
                {(entry.purity || entry.supplier) && (
                  <Text span size="10px" c="dimmed" ml={4}>
                    {[entry.purity, entry.supplier].filter(Boolean).join(" · ")}
                  </Text>
                )}
              </Button>
            ))}
          </Group>
        </Box>
      )}

      <TextInput
        ref={inputRef}
        label="Inventory label"
        withAsterisk
        size="md"
        placeholder="e.g. PbI2-Sigma-001"
        value={label}
        onChange={(e) => setLabel(e.currentTarget.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") commitAndContinue()
        }}
      />

      {showDetails ? (
        <Group gap="sm" grow>
          <TextInput
            size="xs"
            label="Purity"
            placeholder="—"
            value={purity}
            onChange={(e) => setPurity(e.currentTarget.value)}
          />
          <TextInput
            size="xs"
            label="Supplier"
            placeholder="—"
            value={supplier}
            onChange={(e) => setSupplier(e.currentTarget.value)}
          />
          <TextInput
            size="xs"
            label="Product ID"
            placeholder="—"
            value={productId}
            onChange={(e) => setProductId(e.currentTarget.value)}
          />
        </Group>
      ) : (
        <Group gap="md">
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            onClick={() => setShowDetails(true)}
          >
            + Add purity, supplier, product ID
          </Button>
          <Button
            size="compact-xs"
            variant="subtle"
            color="blue"
            onClick={() => onBrowse(getRelevantInfo)}
          >
            Browse other experiments
          </Button>
        </Group>
      )}

      <Group justify="space-between" mt="xs">
        {canGoBack ? (
          <Button variant="subtle" color="gray" onClick={onBack}>
            ← Back
          </Button>
        ) : (
          <span />
        )}
        <Button
          color="blue"
          disabled={!canContinue}
          onClick={commitAndContinue}
        >
          Confirm &amp; continue
        </Button>
      </Group>
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Guided query — how much of a single solution to prepare
// ─────────────────────────────────────────────────────────────────────────────

function SolutionQueryCard({
  item,
  batch,
  candidates,
  positionLabel,
  canGoBack,
  onCommit,
  onDone,
  onBack,
  onBrowse,
}: {
  item: SolutionItem
  batch?: ExperimentSolutionBatch
  candidates: CandidateExp[]
  positionLabel: string
  canGoBack: boolean
  onCommit: (patch: Partial<ExperimentSolutionBatch>) => void
  onDone: () => void
  onBack: () => void
  onBrowse: (getRelevantInfo: (exp: Experiment) => string | null) => void
}) {
  const asSpecifiedVol = item.recipe
    ? item.recipe.totalSolventVolumeMl
    : undefined
  const defaultVolMl =
    asSpecifiedVol && parseFloat(asSpecifiedVol) > 0 ? asSpecifiedVol : "1"

  const [mode, setMode] = useState<"make" | "take">(batch?.mode ?? "make")
  const [volume, setVolume] = useState<string>(
    batch?.totalVolumeMl && parseFloat(batch.totalVolumeMl) > 0
      ? batch.totalVolumeMl
      : defaultVolMl,
  )
  const [sourceExpId, setSourceExpId] = useState<string | null>(
    batch?.takenFromExpId ?? null,
  )

  const volumeNum = parseFloat(volume) || 0
  const isAtSpecified =
    asSpecifiedVol !== undefined &&
    Math.abs(volumeNum - (parseFloat(asSpecifiedVol) || 0)) < 0.001

  const quantityRows = useMemo(() => {
    if (item.recipe) {
      const displayVol =
        volumeNum > 0
          ? volumeNum
          : parseFloat(item.recipe.totalSolventVolumeMl) || 1
      return scaleRecipeQuantities(item.recipe, displayVol)
    }
    return []
  }, [item, volumeNum])

  const selectData = useMemo(
    () => buildReuseSelectData(candidates, item.key),
    [candidates, item.key],
  )
  const hasPriorBatches = selectData.some((g) => g.items.length > 0)

  const getRelevantInfo = useCallback(
    (exp: Experiment) => {
      const b = exp.chemicalsPrep?.solutionBatches?.[item.key]
      if (b?.mode !== "make") return null
      return b.totalVolumeMl ? `${b.totalVolumeMl} mL` : null
    },
    [item.key],
  )

  const canContinue = mode === "make" ? volumeNum > 0 : Boolean(sourceExpId)

  const commitAndContinue = () => {
    if (!canContinue) return
    if (mode === "make") {
      onCommit({
        mode: "make",
        totalVolumeMl: String(volumeNum),
        takenFromExpId: undefined,
        takenFromBatchId: undefined,
      })
    } else {
      onCommit({
        mode: "take",
        takenFromExpId: sourceExpId ?? undefined,
        takenFromBatchId: item.key,
      })
    }
    onDone()
  }

  return (
    <Stack gap="md">
      <Box>
        <Text size="11px" tt="uppercase" fw={700} c="blue.6" mb={2}>
          {positionLabel}
        </Text>
        <Text size="xl" fw={700}>
          {item.label}
        </Text>
        <Text size="xs" c="dimmed">
          Chemistry recipe
        </Text>
      </Box>

      {mode === "make" ? (
        <>
          <Text size="sm" fw={600}>
            How much are you making?
          </Text>
          <Group gap="sm" align="flex-end">
            <NumberInput
              size="md"
              label="Quantity (mL)"
              min={0}
              step={0.5}
              value={volumeNum || ""}
              onChange={(v) => setVolume(v !== "" ? String(v) : "0")}
              style={{ width: 160 }}
            />
            {asSpecifiedVol && (
              <Button
                size="compact-sm"
                variant={isAtSpecified ? "filled" : "light"}
                color="teal"
                style={{ marginBottom: 4 }}
                onClick={() => setVolume(asSpecifiedVol)}
              >
                As specified ({asSpecifiedVol} mL)
              </Button>
            )}
          </Group>
          <QuantityTable
            label={
              volumeNum > 0 ? `${item.label} (${volumeNum} mL)` : item.label
            }
            rows={quantityRows}
          />
          <Button
            size="compact-xs"
            variant="subtle"
            color="blue"
            style={{ alignSelf: "flex-start" }}
            onClick={() => setMode("take")}
          >
            Reuse from another experiment instead
          </Button>
        </>
      ) : (
        <>
          <Text size="sm" fw={600}>
            Reuse a batch from another experiment
          </Text>
          <Group gap="xs" align="flex-end">
            <Select
              size="md"
              label="Source experiment"
              placeholder={
                hasPriorBatches
                  ? "Select experiment..."
                  : "No prior batches found"
              }
              style={{ flex: 1, minWidth: 260 }}
              disabled={!hasPriorBatches}
              data={selectData}
              value={sourceExpId}
              onChange={setSourceExpId}
              clearable
            />
            <Button
              size="compact-xs"
              variant="subtle"
              color="blue"
              style={{ marginBottom: 6 }}
              onClick={() => onBrowse(getRelevantInfo)}
            >
              Browse
            </Button>
          </Group>
          <Button
            size="compact-xs"
            variant="subtle"
            color="teal"
            style={{ alignSelf: "flex-start" }}
            onClick={() => setMode("make")}
          >
            Make a fresh batch instead
          </Button>
        </>
      )}

      <Group justify="space-between" mt="xs">
        {canGoBack ? (
          <Button variant="subtle" color="gray" onClick={onBack}>
            ← Back
          </Button>
        ) : (
          <span />
        )}
        <Button
          color="blue"
          disabled={!canContinue}
          onClick={commitAndContinue}
        >
          Confirm &amp; continue
        </Button>
      </Group>
    </Stack>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Compact read-only summary row (inside the collapsible "Chemicals" panel)
// ─────────────────────────────────────────────────────────────────────────────

function SummaryItemRow({
  name,
  sub,
  value,
  done,
  onEdit,
}: {
  name: string
  sub?: string
  value: string
  done: boolean
  onEdit: () => void
}) {
  return (
    <Group
      justify="space-between"
      wrap="nowrap"
      style={{
        padding: "6px 10px",
        borderRadius: 6,
        background: done
          ? "var(--mantine-color-teal-0)"
          : "var(--mantine-color-gray-0)",
      }}
    >
      <Group gap={8} wrap="nowrap" style={{ minWidth: 0 }}>
        {done ? (
          <IconCheck
            size={14}
            color="var(--mantine-color-teal-6)"
            style={{ flexShrink: 0 }}
          />
        ) : (
          <Box w={14} style={{ flexShrink: 0 }} />
        )}
        <Text size="sm" fw={600} truncate>
          {name}
        </Text>
        {sub && (
          <Text size="xs" c="dimmed" truncate>
            {sub}
          </Text>
        )}
      </Group>
      <Group gap={8} wrap="nowrap" style={{ flexShrink: 0 }}>
        <Text size="sm" fw={500} c={done ? "teal.7" : "dimmed"}>
          {value}
        </Text>
        <Button
          size="compact-xs"
          variant="subtle"
          color="gray"
          onClick={onEdit}
        >
          Edit
        </Button>
      </Group>
    </Group>
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

  // ── Guided-flow queue ──────────────────────────────────────────────────────
  const queue = useMemo<QueueItem[]>(() => {
    const q: QueueItem[] = []
    for (const m of materialItems) {
      q.push({
        kind: "material",
        key: `mat:${m.stepId}`,
        stepId: m.stepId,
        material: m.material,
        sourceRecipeName: m.sourceRecipeName,
      })
    }
    for (const s of solutionItems) {
      q.push({ kind: "solution", key: `sol:${s.key}`, item: s })
    }
    return q
  }, [materialItems, solutionItems])

  const isDone = (qi: QueueItem): boolean => {
    if (qi.kind === "material") {
      return Boolean(prep.materialOverrides?.[qi.stepId]?.inventoryLabel)
    }
    const b = prep.solutionBatches?.[qi.item.key]
    if (!b) return false
    if (b.mode === "take") return Boolean(b.takenFromExpId)
    return parseFloat(b.totalVolumeMl ?? "0") > 0
  }

  const doneCount = queue.filter(isDone).length
  const total = queue.length
  const allComplete = total > 0 && doneCount === total
  const firstIncomplete = queue.findIndex((qi) => !isDone(qi))

  // `manualIndex` lets the user step back or jump to an already-answered item
  // via the summary's Edit buttons. When null, the flow shows the first
  // unanswered question and advances automatically as each is confirmed.
  const [manualIndex, setManualIndex] = useState<number | null>(null)
  const displayIndex =
    manualIndex !== null && manualIndex >= 0 && manualIndex < queue.length
      ? manualIndex
      : firstIncomplete >= 0
        ? firstIncomplete
        : null

  const [summaryOpen, setSummaryOpen] = useState(allComplete)
  const wasComplete = useRef(allComplete)
  React.useEffect(() => {
    if (allComplete && !wasComplete.current) setSummaryOpen(true)
    wasComplete.current = allComplete
  }, [allComplete])

  if (materialItems.length === 0 && solutionItems.length === 0) {
    return (
      <Text size="sm" c="dimmed" ta="center" py="xl">
        No materials or solutions are assigned to processing steps yet. Add them
        in the Process editor first.
      </Text>
    )
  }

  return (
    <Stack gap="md">
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

      {/* Top: collapsible "Chemicals" overview */}
      <Paper
        withBorder
        radius="md"
        p="md"
        style={{
          borderColor: allComplete ? "var(--mantine-color-teal-3)" : undefined,
        }}
      >
        <Group
          justify="space-between"
          wrap="nowrap"
          style={{ cursor: "pointer" }}
          onClick={() => setSummaryOpen((o) => !o)}
        >
          <Group gap="sm" wrap="nowrap">
            <ThemeIcon
              size={34}
              radius="xl"
              variant={allComplete ? "filled" : "light"}
              color={allComplete ? "teal" : "blue"}
            >
              {allComplete ? (
                <IconCheck size={18} />
              ) : (
                <Text size="sm" fw={700}>
                  {doneCount}
                </Text>
              )}
            </ThemeIcon>
            <Box>
              <Text fw={700}>Chemicals</Text>
              <Text size="xs" c="dimmed">
                {allComplete
                  ? "All chemicals assigned"
                  : `${doneCount} of ${total} completed`}
              </Text>
            </Box>
          </Group>
          <Group gap="sm" wrap="nowrap">
            {!allComplete && (
              <Progress
                value={total > 0 ? (doneCount / total) * 100 : 0}
                w={120}
                size="sm"
                radius="xl"
                color="blue"
              />
            )}
            <ActionIcon variant="subtle" color="gray">
              {summaryOpen ? (
                <IconChevronUp size={18} />
              ) : (
                <IconChevronDown size={18} />
              )}
            </ActionIcon>
          </Group>
        </Group>

        <Collapse in={summaryOpen}>
          <Divider my="md" />
          <Stack gap="lg">
            {materialItems.length > 0 && (
              <Box>
                <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb="xs">
                  Materials
                </Text>
                <Stack gap={4}>
                  {queue.map((qi, idx) =>
                    qi.kind === "material" ? (
                      <SummaryItemRow
                        key={qi.key}
                        name={qi.material.name || "Unnamed"}
                        sub={
                          qi.sourceRecipeName
                            ? `from ${qi.sourceRecipeName}`
                            : undefined
                        }
                        value={
                          prep.materialOverrides?.[qi.stepId]?.inventoryLabel ||
                          "Not set"
                        }
                        done={isDone(qi)}
                        onEdit={() => setManualIndex(idx)}
                      />
                    ) : null,
                  )}
                </Stack>
              </Box>
            )}

            {solutionItems.length > 0 && (
              <Box>
                <Group justify="space-between" mb="xs" align="flex-end">
                  <Text size="xs" fw={700} tt="uppercase" c="dimmed">
                    Solutions &amp; recipes
                  </Text>
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
                <Stack gap={4}>
                  {queue.map((qi, idx) =>
                    qi.kind === "solution" ? (
                      <SummaryItemRow
                        key={qi.key}
                        name={qi.item.label}
                        value={solutionBatchSummary(
                          prep.solutionBatches?.[qi.item.key],
                        )}
                        done={isDone(qi)}
                        onEdit={() => setManualIndex(idx)}
                      />
                    ) : null,
                  )}
                </Stack>
              </Box>
            )}
          </Stack>
        </Collapse>
      </Paper>

      {/* Bottom: one question at a time */}
      {displayIndex !== null &&
        (() => {
          const qi = queue[displayIndex]
          const prefix = manualIndex !== null ? "Editing" : "Next"
          const kindWord = qi.kind === "material" ? "chemical" : "solution"
          const positionLabel = `${prefix} ${kindWord} · ${displayIndex + 1} of ${total}`
          return (
            <Paper
              withBorder
              radius="md"
              p="lg"
              style={{
                borderColor: "var(--mantine-color-blue-4)",
                borderWidth: 2,
              }}
            >
              {qi.kind === "material" ? (
                <MaterialQueryCard
                  key={qi.key}
                  stepId={qi.stepId}
                  material={qi.material}
                  override={prep.materialOverrides?.[qi.stepId]}
                  knownEntries={
                    qi.material.pubchemCid
                      ? (cidToEntries.get(qi.material.pubchemCid) ?? [])
                      : []
                  }
                  positionLabel={positionLabel}
                  canGoBack={displayIndex > 0}
                  onCommit={(patch) => updateMaterialOverride(qi.stepId, patch)}
                  onDone={() => setManualIndex(null)}
                  onBack={() => setManualIndex(displayIndex - 1)}
                  onBrowse={handleBrowse}
                />
              ) : (
                <SolutionQueryCard
                  key={qi.key}
                  item={qi.item}
                  batch={prep.solutionBatches?.[qi.item.key]}
                  candidates={candidates}
                  positionLabel={positionLabel}
                  canGoBack={displayIndex > 0}
                  onCommit={(patch) => updateSolutionBatch(qi.item.key, patch)}
                  onDone={() => setManualIndex(null)}
                  onBack={() => setManualIndex(displayIndex - 1)}
                  onBrowse={handleBrowse}
                />
              )}
            </Paper>
          )
        })()}
    </Stack>
  )
}
