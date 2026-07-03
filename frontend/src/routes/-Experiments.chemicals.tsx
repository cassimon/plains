import {
  ActionIcon,
  Box,
  Button,
  Collapse,
  Divider,
  Group,
  NumberInput,
  Paper,
  Progress,
  Select,
  Stack,
  Text,
  TextInput,
  ThemeIcon,
} from "@mantine/core"
import { IconCheck, IconChevronDown, IconChevronUp } from "@tabler/icons-react"
import * as React from "react"
import { useMemo, useRef, useState } from "react"
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
    return (
      parseFloat(batch.totalVolumeMl ?? "0") > 0 && Boolean(batch.preparedAt)
    )
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
// Export builder — used by the Summary step to compile chosen chemicals and
// solution quantities into a copy-/download-able report. Consumed by
// SummaryTab in Experiments.page.tsx via `buildChemicalsExport`.
// ─────────────────────────────────────────────────────────────────────────────

export type ChemicalExportRow = {
  name: string
  inventoryLabel: string
  purity?: string
  supplier?: string
  productId?: string
  sourceRecipeName?: string
}

export type SolutionExportRow = {
  name: string
  mode: "make" | "take"
  volumeMl?: string
  preparedAt?: string
  reusedFromName?: string
  quantities: Array<{ name: string; amount: string; unit: string }>
}

export function buildChemicalsExport(
  experiment: Experiment,
  process: Process,
  allExperiments: Experiment[] = [],
): { materials: ChemicalExportRow[]; solutions: SolutionExportRow[] } {
  const { materialItems, solutionItems } = collectChemicals(process)
  const prep = experiment.chemicalsPrep ?? {}
  const expNameById = new Map(allExperiments.map((e) => [e.id, e.name]))

  const materials: ChemicalExportRow[] = materialItems.map((m) => {
    const ovr = prep.materialOverrides?.[m.stepId] ?? {}
    return {
      name: m.material.name || "Unnamed",
      inventoryLabel: ovr.inventoryLabel ?? "",
      purity: ovr.purity,
      supplier: ovr.supplier,
      productId: ovr.productId,
      sourceRecipeName: m.sourceRecipeName,
    }
  })

  const solutions: SolutionExportRow[] = solutionItems.map((s) => {
    const b = prep.solutionBatches?.[s.key]
    const mode = b?.mode ?? "make"
    const vol =
      parseFloat(b?.totalVolumeMl ?? "") ||
      (s.recipe ? parseFloat(s.recipe.totalSolventVolumeMl) : 0) ||
      0
    const quantities =
      s.recipe && mode === "make" && vol > 0
        ? scaleRecipeQuantities(s.recipe, vol)
        : []
    return {
      name: s.label,
      mode,
      volumeMl: b?.totalVolumeMl,
      preparedAt: b?.preparedAt,
      reusedFromName:
        mode === "take" && b?.takenFromExpId
          ? (expNameById.get(b.takenFromExpId) ?? "another experiment")
          : undefined,
      quantities,
    }
  })

  return { materials, solutions }
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline quantity table (info only — copy lives in the Summary step)
// ─────────────────────────────────────────────────────────────────────────────

function QuantityTable({
  rows,
}: {
  rows: Array<{ name: string; amount: string; unit: string }>
}) {
  if (rows.length === 0) return null

  return (
    <Box
      style={{
        background: "var(--mantine-color-gray-0)",
        borderRadius: 6,
        padding: "6px 10px",
        border: "1px solid var(--mantine-color-gray-2)",
      }}
    >
      <Text size="10px" c="dimmed" tt="uppercase" fw={600} mb={4}>
        You will need
      </Text>
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
// Guided query — assign an inventory label to a single chemical
// ─────────────────────────────────────────────────────────────────────────────

function MaterialQueryCard({
  material,
  sourceRecipeName,
  override,
  positionLabel,
  canGoBack,
  onCommit,
  onDone,
  onBack,
}: {
  material: ProcessStepInlineMaterial
  sourceRecipeName?: string
  override?: {
    inventoryLabel?: string
    purity?: string
    supplier?: string
    productId?: string
  }
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

  const answered = label.trim().length > 0

  const commit = () => {
    onCommit({
      inventoryLabel: label.trim(),
      purity: purity.trim() || undefined,
      supplier: supplier.trim() || undefined,
      productId: productId.trim() || undefined,
    })
  }

  const commitAndContinue = () => {
    if (!answered) return
    commit()
    onDone()
  }

  return (
    <Paper
      withBorder
      radius="md"
      p="lg"
      style={{
        borderWidth: 2,
        borderColor: answered
          ? "var(--mantine-color-teal-4)"
          : "var(--mantine-color-blue-4)",
        background: answered ? "var(--mantine-color-teal-0)" : undefined,
        transition: "background 150ms, border-color 150ms",
      }}
    >
      <Stack gap="md">
        <Group justify="space-between" wrap="nowrap">
          <Text
            size="11px"
            tt="uppercase"
            fw={700}
            c={answered ? "teal.7" : "blue.6"}
          >
            {positionLabel}
          </Text>
          {answered && (
            <IconCheck size={18} color="var(--mantine-color-teal-6)" />
          )}
        </Group>

        <Text size="lg" fw={600}>
          Which inventory chemical did you use for{" "}
          <Text span fw={800}>
            {material.name || "this chemical"}
          </Text>
          ?
          {sourceRecipeName && (
            <Text span size="sm" c="dimmed">
              {"  "}(from {sourceRecipeName})
            </Text>
          )}
        </Text>

        <TextInput
          ref={inputRef}
          size="md"
          placeholder="e.g. PbI2-Sigma-001"
          value={label}
          onChange={(e) => setLabel(e.currentTarget.value)}
          onBlur={commit}
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
              onBlur={commit}
            />
            <TextInput
              size="xs"
              label="Supplier"
              placeholder="—"
              value={supplier}
              onChange={(e) => setSupplier(e.currentTarget.value)}
              onBlur={commit}
            />
            <TextInput
              size="xs"
              label="Product ID"
              placeholder="—"
              value={productId}
              onChange={(e) => setProductId(e.currentTarget.value)}
              onBlur={commit}
            />
          </Group>
        ) : (
          <Button
            size="compact-xs"
            variant="subtle"
            color="gray"
            style={{ alignSelf: "flex-start" }}
            onClick={() => setShowDetails(true)}
          >
            + Add purity, supplier, product ID
          </Button>
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
            color={answered ? "teal" : "blue"}
            disabled={!answered}
            onClick={commitAndContinue}
          >
            Confirm &amp; continue
          </Button>
        </Group>
      </Stack>
    </Paper>
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
  defaultPreparedAt,
  canGoBack,
  onCommit,
  onDone,
  onBack,
}: {
  item: SolutionItem
  batch?: ExperimentSolutionBatch
  candidates: CandidateExp[]
  positionLabel: string
  defaultPreparedAt: string
  canGoBack: boolean
  onCommit: (patch: Partial<ExperimentSolutionBatch>) => void
  onDone: () => void
  onBack: () => void
}) {
  const asSpecifiedVol = item.recipe
    ? item.recipe.totalSolventVolumeMl
    : undefined
  const defaultVolMl =
    asSpecifiedVol && parseFloat(asSpecifiedVol) > 0 ? asSpecifiedVol : "1"

  // The user first chooses a method (Make fresh / Reuse). An existing batch
  // means the method was already picked, so jump straight to its detail view.
  const [choice, setChoice] = useState<"make" | "take" | null>(
    batch ? batch.mode : null,
  )
  const [volume, setVolume] = useState<string>(
    batch?.totalVolumeMl && parseFloat(batch.totalVolumeMl) > 0
      ? batch.totalVolumeMl
      : defaultVolMl,
  )
  const [preparedAt, setPreparedAt] = useState<string>(
    batch?.preparedAt ?? defaultPreparedAt ?? "",
  )
  const [sourceExpId, setSourceExpId] = useState<string | null>(
    batch?.takenFromExpId ?? null,
  )
  const inputRef = useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (choice !== "make") return
    const t = requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => cancelAnimationFrame(t)
  }, [choice])

  const volumeNum = parseFloat(volume) || 0

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

  const answered =
    choice === "make"
      ? volumeNum > 0 && preparedAt !== ""
      : choice === "take"
        ? Boolean(sourceExpId)
        : false

  const commitMake = (v: number, at: string) => {
    onCommit({
      mode: "make",
      totalVolumeMl: String(v),
      preparedAt: at || undefined,
      takenFromExpId: undefined,
      takenFromBatchId: undefined,
    })
  }

  const pickMake = () => {
    setChoice("make")
    commitMake(volumeNum, preparedAt)
  }

  const pickTake = () => {
    setChoice("take")
    if (sourceExpId)
      onCommit({
        mode: "take",
        takenFromExpId: sourceExpId,
        takenFromBatchId: item.key,
      })
  }

  // Changing the amount or time just records it and keeps the field green —
  // it does not advance to the next question.
  const handleVolume = (raw: number | string) => {
    const s = raw !== "" ? String(raw) : "0"
    setVolume(s)
    const n = parseFloat(s) || 0
    if (n > 0) commitMake(n, preparedAt)
  }

  const handlePreparedAt = (value: string) => {
    setPreparedAt(value)
    if (volumeNum > 0) commitMake(volumeNum, value)
  }

  const commitAndContinue = () => {
    if (!answered) return
    if (choice === "make") {
      commitMake(volumeNum, preparedAt)
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
    <Paper
      withBorder
      radius="md"
      p="lg"
      style={{
        borderWidth: 2,
        borderColor: answered
          ? "var(--mantine-color-teal-4)"
          : "var(--mantine-color-blue-4)",
        background: answered ? "var(--mantine-color-teal-0)" : undefined,
        transition: "background 150ms, border-color 150ms",
      }}
    >
      <Stack gap="md">
        <Group justify="space-between" wrap="nowrap">
          <Text
            size="11px"
            tt="uppercase"
            fw={700}
            c={answered ? "teal.7" : "blue.6"}
          >
            {positionLabel}
          </Text>
          {answered && (
            <IconCheck size={18} color="var(--mantine-color-teal-6)" />
          )}
        </Group>

        {choice === null ? (
          <>
            <Text size="lg" fw={600}>
              How are you preparing{" "}
              <Text span fw={800}>
                {item.label}
              </Text>
              ?
            </Text>
            <Group gap="sm">
              <Button size="md" color="teal" onClick={pickMake}>
                Make fresh
              </Button>
              <Button size="md" variant="light" color="blue" onClick={pickTake}>
                Reuse
              </Button>
            </Group>
          </>
        ) : choice === "make" ? (
          <>
            <Text size="lg" fw={600}>
              How much{" "}
              <Text span fw={800}>
                {item.label}
              </Text>{" "}
              are you making, and when?
            </Text>
            <Group gap="md" align="flex-end" wrap="wrap">
              <NumberInput
                ref={inputRef}
                size="md"
                label="Amount"
                suffix=" mL"
                min={0}
                step={0.5}
                value={volumeNum || ""}
                onChange={handleVolume}
                style={{ width: 180 }}
              />
              <TextInput
                size="md"
                type="datetime-local"
                label="Prepared at"
                withAsterisk
                value={preparedAt}
                onChange={(e) => handlePreparedAt(e.currentTarget.value)}
                style={{ width: 240 }}
              />
            </Group>
            <QuantityTable rows={quantityRows} />
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              style={{ alignSelf: "flex-start" }}
              onClick={() => setChoice(null)}
            >
              ← Change method
            </Button>
          </>
        ) : (
          <>
            <Text size="lg" fw={600}>
              Which experiment's batch of{" "}
              <Text span fw={800}>
                {item.label}
              </Text>{" "}
              are you reusing?
            </Text>
            <Select
              size="md"
              placeholder={
                hasPriorBatches
                  ? "Select experiment..."
                  : "No prior batches found"
              }
              style={{ maxWidth: 420 }}
              disabled={!hasPriorBatches}
              data={selectData}
              value={sourceExpId}
              onChange={(v) => {
                setSourceExpId(v)
                if (v)
                  onCommit({
                    mode: "take",
                    takenFromExpId: v,
                    takenFromBatchId: item.key,
                  })
              }}
              clearable
            />
            <Button
              size="compact-xs"
              variant="subtle"
              color="gray"
              style={{ alignSelf: "flex-start" }}
              onClick={() => setChoice(null)}
            >
              ← Change method
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
          {choice !== null && (
            <Button
              color={answered ? "teal" : "blue"}
              disabled={!answered}
              onClick={commitAndContinue}
            >
              Confirm &amp; continue
            </Button>
          )}
        </Group>
      </Stack>
    </Paper>
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

  // Default the "prepared at" datetime of the next solution to the most recent
  // one the user has already entered (batches are usually prepared together).
  const preparedAtValues = solutionItems
    .map((item) => prep.solutionBatches?.[item.key]?.preparedAt)
    .filter((v): v is string => Boolean(v))
    .sort()
  const defaultPreparedAt =
    preparedAtValues[preparedAtValues.length - 1] ?? prep.prepTime ?? ""

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
    return parseFloat(b.totalVolumeMl ?? "0") > 0 && Boolean(b.preparedAt)
  }

  const doneCount = queue.filter(isDone).length
  const total = queue.length
  const allComplete = total > 0 && doneCount === total
  const firstIncomplete = queue.findIndex((qi) => !isDone(qi))
  const materialCount = materialItems.length

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
                <Text size="xs" fw={700} tt="uppercase" c="dimmed" mb="xs">
                  Solutions &amp; recipes
                </Text>
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
          if (qi.kind === "material") {
            const positionLabel = `Chemical ${displayIndex + 1} of ${materialCount}`
            return (
              <MaterialQueryCard
                key={qi.key}
                material={qi.material}
                sourceRecipeName={qi.sourceRecipeName}
                override={prep.materialOverrides?.[qi.stepId]}
                positionLabel={positionLabel}
                canGoBack={displayIndex > 0}
                onCommit={(patch) => updateMaterialOverride(qi.stepId, patch)}
                onDone={() => setManualIndex(null)}
                onBack={() => setManualIndex(displayIndex - 1)}
              />
            )
          }
          const solPos = displayIndex - materialCount + 1
          const positionLabel = `Solution ${solPos} of ${solutionItems.length}`
          return (
            <SolutionQueryCard
              key={qi.key}
              item={qi.item}
              batch={prep.solutionBatches?.[qi.item.key]}
              candidates={candidates}
              positionLabel={positionLabel}
              defaultPreparedAt={defaultPreparedAt}
              canGoBack={displayIndex > 0}
              onCommit={(patch) => updateSolutionBatch(qi.item.key, patch)}
              onDone={() => setManualIndex(null)}
              onBack={() => setManualIndex(displayIndex - 1)}
            />
          )
        })()}
    </Stack>
  )
}
