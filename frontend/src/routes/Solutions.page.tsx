import {
  ActionIcon,
  Badge,
  Button,
  Collapse,
  ColorSwatch,
  Container,
  Divider,
  Group,
  NativeSelect,
  NumberInput,
  Paper,
  rem,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
} from "@mantine/core"
import { modals } from "@mantine/modals"
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCopy,
  IconPencil,
  IconPlus,
  IconRestore,
  IconSparkles,
  IconTrash,
  IconX,
} from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo, useRef, useState } from "react"
import { DependencyBlockModal } from "../components/DependencyBlockModal"
import {
  type CollectionConfirmParams,
  SelectCollectionModal,
} from "../components/SelectCollectionModal"
import {
  type CanvasCollectionElement,
  getDependentLocations,
  type Material,
  newComponent,
  newSolution,
  type Solution,
  type SolutionComponent,
  useAppContext,
  useEntityCollection,
} from "../store/AppContext"

function toDateTimeLocalValue(isoValue: string | undefined): string {
  if (!isoValue) {
    return ""
  }
  const d = new Date(isoValue)
  if (Number.isNaN(d.getTime())) {
    return ""
  }

  const pad2 = (n: number) => String(n).padStart(2, "0")
  const year = d.getFullYear()
  const month = pad2(d.getMonth() + 1)
  const day = pad2(d.getDate())
  const hour = pad2(d.getHours())
  const minute = pad2(d.getMinutes())
  return `${year}-${month}-${day}T${hour}:${minute}`
}

function fromDateTimeLocalValue(localValue: string): string | null {
  if (!localValue) {
    return null
  }
  const d = new Date(localValue)
  if (Number.isNaN(d.getTime())) {
    return null
  }
  return d.toISOString()
}

function getDefaultUnitForMaterial(material: Material): "mg" | "ml" {
  if ((material.category ?? "chemical_compound") === "substrate_material") {
    return "mg"
  }
  if (material.stateAtRt === "liquid" || material.stateAtRt === "gas") {
    return "ml"
  }
  return "mg"
}

// ── Component row (material/solution + amount + unit) ─────────────────────────

type ComponentRowProps = {
  component: SolutionComponent
  onChange: (updated: SolutionComponent) => void
  onDelete: () => void
  componentName: string
  editing: boolean
  onStartEdit: () => void
  onCommit: () => void
  onCancel: () => void
  buffer: SolutionComponent | null
  onBufferChange: (b: SolutionComponent) => void
  groupedComponentOptions: {
    group: string
    items: { value: string; label: string }[]
  }[]
  solutionIdSet: Set<string>
  materialUnitById?: Map<string, "mg" | "ml">
  componentColorMap?: Map<string, string>
}

function ComponentRow({
  component,
  onDelete,
  componentName,
  editing,
  onStartEdit,
  onCommit,
  onCancel,
  buffer,
  onBufferChange,
  groupedComponentOptions,
  solutionIdSet,
  materialUnitById,
  componentColorMap,
}: ComponentRowProps) {
  return (
    <Table.Tr>
      <Table.Td>
        {editing && buffer ? (
          <Select
            size="xs"
            value={buffer.materialId || buffer.solutionId || null}
            onChange={(v) => {
              if (!v) {
                onBufferChange({
                  ...buffer,
                  materialId: "",
                  solutionId: undefined,
                })
                return
              }
              if (solutionIdSet.has(v)) {
                onBufferChange({
                  ...buffer,
                  solutionId: v,
                  materialId: undefined,
                })
              } else {
                const unit = materialUnitById?.get(v) ?? buffer.unit
                onBufferChange({
                  ...buffer,
                  materialId: v,
                  solutionId: undefined,
                  unit,
                })
              }
            }}
            data={groupedComponentOptions}
            placeholder="— select component —"
            clearable
            searchable
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommit()
            }}
            renderOption={({ option }) => {
              const color = componentColorMap?.get(option.value)
              return (
                <Group gap={6} wrap="nowrap">
                  <ColorSwatch
                    color={color ?? "transparent"}
                    size={12}
                    withShadow={false}
                    style={{ opacity: color ? 1 : 0, flexShrink: 0 }}
                  />
                  <Text size="xs">{option.label}</Text>
                </Group>
              )
            }}
          />
        ) : (
          <Text size="sm">
            {componentName || (
              <Text span c="dimmed" size="sm">
                —
              </Text>
            )}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        {editing && buffer ? (
          <NumberInput
            size="xs"
            value={buffer.amount}
            onChange={(v) => onBufferChange({ ...buffer, amount: String(v) })}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommit()
            }}
            min={0}
            style={{ width: rem(100) }}
          />
        ) : (
          <Text size="sm">
            {component.amount || (
              <Text span c="dimmed" size="sm">
                —
              </Text>
            )}
          </Text>
        )}
      </Table.Td>
      <Table.Td>
        {editing && buffer ? (
          <NativeSelect
            size="xs"
            value={buffer.unit}
            onChange={(e) =>
              onBufferChange({
                ...buffer,
                unit: e.currentTarget.value as "mg" | "ml",
              })
            }
            data={["mg", "ml"]}
            onKeyDown={(e) => {
              if (e.key === "Enter") onCommit()
            }}
            style={{ width: rem(80) }}
          />
        ) : (
          <Badge variant="light" size="sm">
            {component.unit}
          </Badge>
        )}
      </Table.Td>
      <Table.Td>
        <Group gap={4} justify="center">
          {editing ? (
            <>
              <Tooltip label="Save">
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="green"
                  onClick={onCommit}
                >
                  <IconCheck size={14} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Cancel">
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  onClick={onCancel}
                >
                  <IconX size={14} />
                </ActionIcon>
              </Tooltip>
            </>
          ) : (
            <>
              <Tooltip label="Edit">
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="blue"
                  onClick={onStartEdit}
                >
                  <IconPencil size={14} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Delete">
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="red"
                  onClick={onDelete}
                >
                  <IconTrash size={14} />
                </ActionIcon>
              </Tooltip>
            </>
          )}
        </Group>
      </Table.Td>
    </Table.Tr>
  )
}

// ── Solution card ─────────────────────────────────────────────────────────────

type SolutionCardProps = {
  solution: Solution
  onUpdate: (s: Solution) => void
  onDelete: () => void
  onCopy: () => void
  groupedComponentOptions: {
    group: string
    items: { value: string; label: string }[]
  }[]
  solutionIdSet: Set<string>
  solventIdSet: Set<string>
  materialUnitById?: Map<string, "mg" | "ml">
  getMaterialName: (id: string) => string
  getSolutionName: (id: string) => string
  componentColorMap?: Map<string, string>
  collectionColor?: string
  isSelected?: boolean
  onSelect?: (id: string | null) => void
  onEditingChange?: (id: string, isEditing: boolean) => void
  autoAddComponent?: boolean
  onAutoAdded?: () => void
}

function SolutionCard({
  solution,
  onUpdate,
  onDelete,
  onCopy,
  groupedComponentOptions,
  solutionIdSet,
  solventIdSet,
  materialUnitById,
  getMaterialName,
  getSolutionName,
  componentColorMap,
  collectionColor,
  isSelected,
  onSelect,
  onEditingChange,
  autoAddComponent,
  onAutoAdded,
}: SolutionCardProps) {
  const [open, setOpen] = useState(isSelected ?? false)
  const [nameAtExpand, setNameAtExpand] = useState(solution.name)

  const commitName = () => {
    const nextName = nameBuffer.trim() || solution.name
    if (nextName !== solution.name) {
      onUpdate({ ...solution, name: nextName })
    }
  }

  const restoreNameToExpandedState = () => {
    setNameBuffer(nameAtExpand)
    if (solution.name !== nameAtExpand) {
      onUpdate({ ...solution, name: nameAtExpand })
    }
  }

  const commitOpenEditsBeforeClose = () => {
    if (editingName) {
      commitName()
    }
    if (editingComponentId && componentBuffer) {
      onUpdate({
        ...solution,
        components: solution.components.map((c) =>
          c.id === componentBuffer.id ? componentBuffer : c,
        ),
      })
    }
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: commitOpenEditsBeforeClose should not trigger re-run
  useEffect(() => {
    const nextOpen = Boolean(isSelected)

    if (open && !nextOpen) {
      commitOpenEditsBeforeClose()
    }

    setOpen(nextOpen)
    if (nextOpen) {
      setNameAtExpand(solution.name)
      setNameBuffer(solution.name)
      setEditingName(true)
    } else {
      setEditingName(false)
      setEditingComponentId(null)
      setComponentBuffer(null)
    }
  }, [isSelected, open])

  const handleToggleOpen = (newOpen: boolean) => {
    if (newOpen) {
      setNameAtExpand(solution.name)
      setNameBuffer(solution.name)
      setEditingName(true)
    } else {
      commitOpenEditsBeforeClose()
      setEditingName(false)
      setEditingComponentId(null)
      setComponentBuffer(null)
    }
    setOpen(newOpen)
    if (onSelect) {
      onSelect(newOpen ? solution.id : null)
    }
  }

  const [editingName, setEditingName] = useState(false)
  const [nameBuffer, setNameBuffer] = useState(solution.name)
  const [handlingBuffer, setHandlingBuffer] = useState(solution.handling ?? "")
  const [storageBuffer, setStorageBuffer] = useState(solution.storage ?? "")
  const [creationTimeBuffer, setCreationTimeBuffer] = useState(
    toDateTimeLocalValue(solution.creationTime),
  )
  const [editingComponentId, setEditingComponentId] = useState<string | null>(
    null,
  )
  const [componentBuffer, setComponentBuffer] =
    useState<SolutionComponent | null>(null)

  useEffect(() => {
    onEditingChange?.(solution.id, editingName || editingComponentId !== null)
    return () => {
      onEditingChange?.(solution.id, false)
    }
  }, [editingComponentId, editingName, onEditingChange, solution.id])

  useEffect(() => {
    setHandlingBuffer(solution.handling ?? "")
    setStorageBuffer(solution.storage ?? "")
    setCreationTimeBuffer(toDateTimeLocalValue(solution.creationTime))
  }, [solution.creationTime, solution.handling, solution.storage])

  useEffect(() => {
    // Sync nameBuffer with solution.name when it changes externally
    // (e.g., after generateName or after the parent updates the solution)
    if (!editingName) {
      setNameBuffer(solution.name)
    }
  }, [solution.name, editingName])

  const generateName = () => {
    const solutes: string[] = []
    const solvents: string[] = []
    for (const comp of solution.components) {
      if (comp.solutionId) {
        solutes.push(getSolutionName(comp.solutionId))
      } else if (comp.materialId) {
        if (solventIdSet.has(comp.materialId)) {
          solvents.push(getMaterialName(comp.materialId))
        } else {
          solutes.push(getMaterialName(comp.materialId))
        }
      }
    }
    const date = new Date(solution.creationTime)
    const dateStr = Number.isNaN(date.getTime())
      ? ""
      : date.toLocaleDateString(undefined, {
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        })
    let name = ""
    if (solutes.length > 0) name += solutes.join(", ")
    if (solvents.length > 0) name += (name ? " in " : "") + solvents.join(", ")
    if (dateStr) name += (name ? " " : "") + dateStr
    if (!name) return
    onUpdate({ ...solution, name })
    setNameBuffer(name)
  }

  const addComponent = () => {
    const c = newComponent()
    const updated = { ...solution, components: [...solution.components, c] }
    onUpdate(updated)
    setEditingComponentId(c.id)
    setComponentBuffer(c)
  }

  const commitHandling = () => {
    if ((solution.handling ?? "") === handlingBuffer) return
    onUpdate({ ...solution, handling: handlingBuffer })
  }

  const commitStorage = () => {
    if ((solution.storage ?? "") === storageBuffer) return
    onUpdate({ ...solution, storage: storageBuffer })
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally runs once on mount
  useEffect(() => {
    if (autoAddComponent) {
      onAutoAdded?.()
      addComponent()
    }
  }, [])

  const commitCreationTime = () => {
    const parsed = fromDateTimeLocalValue(creationTimeBuffer)
    if (!parsed) {
      setCreationTimeBuffer(toDateTimeLocalValue(solution.creationTime))
      return
    }
    if (parsed === solution.creationTime) return
    onUpdate({ ...solution, creationTime: parsed })
  }

  const commitComponent = () => {
    if (!componentBuffer) return
    onUpdate({
      ...solution,
      components: solution.components.map((c) =>
        c.id === componentBuffer.id ? componentBuffer : c,
      ),
    })
    setEditingComponentId(null)
    setComponentBuffer(null)
  }

  const cancelComponent = (id: string) => {
    const original = solution.components.find((c) => c.id === id)
    if (
      original &&
      !original.materialId &&
      !original.solutionId &&
      !original.amount
    ) {
      onUpdate({
        ...solution,
        components: solution.components.filter((c) => c.id !== id),
      })
    }
    setEditingComponentId(null)
    setComponentBuffer(null)
  }

  const deleteComponent = (id: string) => {
    onUpdate({
      ...solution,
      components: solution.components.filter((c) => c.id !== id),
    })
  }

  return (
    <Paper
      withBorder
      radius="md"
      p="sm"
      mb="sm"
      style={{
        borderLeft: collectionColor
          ? `6px solid ${collectionColor}`
          : undefined,
      }}
    >
      <Group justify="space-between" wrap="nowrap">
        <Group gap="xs" wrap="nowrap" style={{ flex: 1 }}>
          <ActionIcon
            size="sm"
            variant="subtle"
            color="gray"
            onClick={() => handleToggleOpen(!open)}
            aria-label={open ? "Collapse" : "Expand"}
          >
            {open ? (
              <IconChevronDown size={16} />
            ) : (
              <IconChevronRight size={16} />
            )}
          </ActionIcon>

          {editingName ? (
            <Group gap={4} wrap="nowrap">
              <TextInput
                size="xs"
                value={nameBuffer}
                onChange={(e) => setNameBuffer(e.currentTarget.value)}
                onBlur={commitName}
                onFocus={(e) => e.currentTarget.select()}
                onKeyDown={(e) => {
                  if (e.key === "Enter") commitName()
                  if (e.key === "Escape") {
                    restoreNameToExpandedState()
                  }
                }}
                autoFocus
                style={{ width: rem(240) }}
              />
              <Tooltip label="Auto-generate name from components">
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="violet"
                  onClick={generateName}
                >
                  <IconSparkles size={14} />
                </ActionIcon>
              </Tooltip>
              <Tooltip label="Restore name from when this tab was expanded">
                <ActionIcon
                  size="sm"
                  variant="subtle"
                  color="gray"
                  onClick={restoreNameToExpandedState}
                >
                  <IconRestore size={14} />
                </ActionIcon>
              </Tooltip>
            </Group>
          ) : (
            <Group gap={4} wrap="nowrap">
              <Text
                fw={600}
                style={{ cursor: "text" }}
                title="Click to rename"
                onClick={() => setEditingName(true)}
              >
                {solution.name}
              </Text>
            </Group>
          )}

          <Badge size="sm" variant="outline" color="gray">
            {solution.components.length} component
            {solution.components.length !== 1 ? "s" : ""}
          </Badge>
        </Group>

        <Tooltip label="Duplicate solution">
          <ActionIcon size="sm" variant="subtle" color="teal" onClick={onCopy}>
            <IconCopy size={14} />
          </ActionIcon>
        </Tooltip>
        <Tooltip label="Delete solution">
          <ActionIcon size="sm" variant="subtle" color="red" onClick={onDelete}>
            <IconTrash size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>

      <Collapse in={open}>
        <Divider my="sm" />
        <Group grow mb="xs" align="end">
          <TextInput
            label="Handling"
            size="xs"
            value={handlingBuffer}
            onChange={(e) => setHandlingBuffer(e.currentTarget.value)}
            onBlur={commitHandling}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitHandling()
            }}
            placeholder="e.g. PVDF 0.22 µm filter before use"
          />
          <TextInput
            label="Storage"
            size="xs"
            value={storageBuffer}
            onChange={(e) => setStorageBuffer(e.currentTarget.value)}
            onBlur={commitStorage}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitStorage()
            }}
            placeholder="e.g. N2 Glovebox"
          />
          <TextInput
            label="Creation Time"
            size="xs"
            type="datetime-local"
            value={creationTimeBuffer}
            onChange={(e) => setCreationTimeBuffer(e.currentTarget.value)}
            onBlur={commitCreationTime}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitCreationTime()
            }}
          />
        </Group>
        <ScrollArea>
          <Table withColumnBorders withTableBorder>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Component</Table.Th>
                <Table.Th>Amount</Table.Th>
                <Table.Th>Unit</Table.Th>
                <Table.Th style={{ width: rem(80) }} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {solution.components.length === 0 && (
                <Table.Tr>
                  <Table.Td colSpan={4}>
                    <Text c="dimmed" ta="center" size="sm" py="xs">
                      No components yet.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              )}
              {solution.components.map((comp) => {
                const compName = comp.solutionId
                  ? `↰ ${getSolutionName(comp.solutionId)}`
                  : getMaterialName(comp.materialId ?? "")
                const filteredSolutionIdSet = new Set(
                  [...solutionIdSet].filter((id) => id !== solution.id),
                )
                const filteredGrouped = groupedComponentOptions.map((group) =>
                  group.group === "Solution"
                    ? {
                        ...group,
                        items: group.items.filter(
                          (opt) => opt.value !== solution.id,
                        ),
                      }
                    : group,
                )
                return (
                  <ComponentRow
                    key={comp.id}
                    component={comp}
                    onChange={() => {}}
                    onDelete={() => deleteComponent(comp.id)}
                    componentName={compName}
                    editing={editingComponentId === comp.id}
                    onStartEdit={() => {
                      setEditingComponentId(comp.id)
                      setComponentBuffer({ ...comp })
                    }}
                    onCommit={commitComponent}
                    onCancel={() => cancelComponent(comp.id)}
                    buffer={
                      editingComponentId === comp.id ? componentBuffer : null
                    }
                    onBufferChange={setComponentBuffer}
                    groupedComponentOptions={filteredGrouped}
                    solutionIdSet={filteredSolutionIdSet}
                    materialUnitById={materialUnitById}
                    componentColorMap={componentColorMap}
                  />
                )
              })}
            </Table.Tbody>
          </Table>
        </ScrollArea>
        <Group mt="xs" justify="flex-end">
          <Button
            size="xs"
            leftSection={<IconPlus size={12} />}
            variant="light"
            onClick={addComponent}
          >
            Add Component
          </Button>
        </Group>
      </Collapse>
    </Paper>
  )
}

// ── Solutions page ────────────────────────────────────────────────────────────

export function SolutionsPage() {
  const {
    materials,
    solutions,
    setSolutions,
    setProcesses,
    experiments,
    processes,
    planes,
    updateElement,
    removeCollectionRefs,
    pendingCollectionLink,
    setPendingCollectionLink,
    activeCollectionId,
    activePlaneId,
    activeEntity,
    setActiveEntity,
    lastSelectedByKind,
    updateLastSelected,
  } = useAppContext()
  const {
    getEntityColor,
    isEntityVisible,
    getEntityPlane,
    getEntityCollection,
    isEntityOnActivePlane,
  } = useEntityCollection()
  const [selectedSolutionId, setSelectedSolutionId] = useState<string | null>(
    () => lastSelectedByKind.solution ?? null,
  )
  const [editingSolutionId, setEditingSolutionId] = useState<string | null>(
    null,
  )
  const processedPendingRequestIdsRef = useRef<Set<string>>(new Set())
  const returnToRef = useRef<string | null>(null)
  const returnSolutionIdRef = useRef<string | null>(null)
  const returnToProcessIdRef = useRef<string | null>(null)
  const navigate = useNavigate()
  const [collectionModalOpen, setCollectionModalOpen] = useState(false)
  const [autoAddComponentId, setAutoAddComponentId] = useState<string | null>(
    null,
  )

  const selectSolution = (id: string | null) => {
    setSelectedSolutionId(id)
    if (id) updateLastSelected("solution", id)
  }

  useEffect(() => {
    if (!editingSolutionId) {
      if (activeEntity?.kind === "process") return
      setActiveEntity(null)
      return
    }

    const editingSolution = solutions.find((s) => s.id === editingSolutionId)
    if (!editingSolution || !isEntityVisible("solution", editingSolutionId)) {
      setEditingSolutionId(null)
      setActiveEntity(null)
      return
    }

    setActiveEntity({ kind: "solution", id: editingSolutionId })
  }, [
    editingSolutionId,
    isEntityVisible,
    setActiveEntity,
    solutions,
    activeEntity?.kind,
  ])

  useEffect(() => {
    if (activeEntity?.kind !== "solution") return
    if (!isEntityVisible("solution", activeEntity.id)) return
    setSelectedSolutionId(activeEntity.id)
  }, [activeEntity, isEntityVisible])

  const materialOptions = useMemo(
    () =>
      materials
        .filter(
          (m) => (m.category ?? "chemical_compound") !== "substrate_material",
        )
        .filter((m) => m.type !== "solvent")
        .filter((m) => isEntityOnActivePlane("material", m.id))
        .map((m) => ({
          value: m.id,
          label: m.name || m.inventoryLabel || m.casNumber || m.id,
        })),
    [materials, isEntityOnActivePlane],
  )

  const solventOptions = useMemo(
    () =>
      materials
        .filter(
          (m) => (m.category ?? "chemical_compound") !== "substrate_material",
        )
        .filter((m) => m.type === "solvent")
        .filter((m) => isEntityOnActivePlane("material", m.id))
        .map((m) => ({
          value: m.id,
          label: m.name || m.inventoryLabel || m.casNumber || m.id,
        })),
    [materials, isEntityOnActivePlane],
  )

  const materialUnitById = useMemo(() => {
    const map = new Map<string, "mg" | "ml">()
    for (const material of materials) {
      if ((material.category ?? "chemical_compound") === "substrate_material")
        continue
      map.set(material.id, getDefaultUnitForMaterial(material))
    }
    return map
  }, [materials])

  const materialColorMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const m of materials) {
      const color = getEntityColor("material", m.id)
      if (color) map.set(m.id, color)
    }
    return map
  }, [materials, getEntityColor])

  const getMaterialName = (id: string) => {
    const m = materials.find((mat) => mat.id === id)
    return m ? m.name || m.inventoryLabel || m.casNumber || id : id
  }

  const allSolutionOptions = useMemo(
    () =>
      solutions
        .filter((s) => isEntityOnActivePlane("solution", s.id))
        .map((s) => ({ value: s.id, label: s.name || s.id })),
    [solutions, isEntityOnActivePlane],
  )

  const solutionColorMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const s of solutions) {
      const color = getEntityColor("solution", s.id)
      if (color) map.set(s.id, color)
    }
    return map
  }, [solutions, getEntityColor])

  const componentColorMap = useMemo(() => {
    const map = new Map<string, string>()
    for (const [id, color] of materialColorMap) map.set(id, color)
    for (const [id, color] of solutionColorMap) map.set(id, color)
    return map
  }, [materialColorMap, solutionColorMap])

  const groupedComponentOptions = useMemo(
    () => [
      ...(materialOptions.length > 0
        ? [{ group: "Material", items: materialOptions }]
        : []),
      ...(solventOptions.length > 0
        ? [{ group: "Solvent", items: solventOptions }]
        : []),
      ...(allSolutionOptions.length > 0
        ? [{ group: "Solution", items: allSolutionOptions }]
        : []),
    ],
    [materialOptions, solventOptions, allSolutionOptions],
  )

  const solutionIdSet = useMemo(
    () => new Set(allSolutionOptions.map((o) => o.value)),
    [allSolutionOptions],
  )

  const solventIdSet = useMemo(
    () => new Set(solventOptions.map((o) => o.value)),
    [solventOptions],
  )

  const getSolutionName = (id: string) => {
    const s = solutions.find((sol) => sol.id === id)
    return s ? s.name || id : id
  }

  const visibleSolutions = solutions.filter((s) =>
    isEntityVisible("solution", s.id),
  )

  useEffect(() => {
    if (
      selectedSolutionId &&
      !visibleSolutions.some((solution) => solution.id === selectedSolutionId)
    ) {
      selectSolution(null)
    }
  }, [selectedSolutionId, visibleSolutions, selectSolution])

  const handleSolutionEditingChange = (id: string, isEditing: boolean) => {
    setEditingSolutionId((current) => {
      if (isEditing) return id
      return current === id ? null : current
    })
    if (
      !isEditing &&
      id === returnSolutionIdRef.current &&
      returnToRef.current
    ) {
      const route = returnToRef.current
      returnToRef.current = null
      returnSolutionIdRef.current = null
      const processId = returnToProcessIdRef.current
      returnToProcessIdRef.current = null
      if (processId) setActiveEntity({ kind: "process", id: processId })
      void navigate({ to: route as never })
    }
  }

  const doAddSolution = ({ planeId, collection }: CollectionConfirmParams) => {
    const s = newSolution()
    setSolutions((prev) => [...prev, s])
    updateElement(planeId, {
      ...collection,
      refs: [...collection.refs, { kind: "solution" as const, id: s.id }],
    })
    selectSolution(s.id)
    setAutoAddComponentId(s.id)
  }

  const addSolution = () => {
    if (activeCollectionId && activePlaneId) {
      const plane = planes.find((p) => p.id === activePlaneId)
      const col = plane?.elements.find((e) => e.id === activeCollectionId)
      if (col && col.type === "collection") {
        doAddSolution({
          planeId: activePlaneId,
          collectionId: activeCollectionId,
          collection: col as CanvasCollectionElement,
        })
        return
      }
    }
    setCollectionModalOpen(true)
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on pendingCollectionLink change
  useEffect(() => {
    if (!pendingCollectionLink || pendingCollectionLink.kind !== "solution")
      return
    if (
      processedPendingRequestIdsRef.current.has(pendingCollectionLink.requestId)
    )
      return
    processedPendingRequestIdsRef.current.add(pendingCollectionLink.requestId)

    const { collectionId, planeId, processAttachment, returnTo } =
      pendingCollectionLink
    setPendingCollectionLink(null)

    const s = newSolution()
    setSolutions((prev) => [...prev, s])
    setAutoAddComponentId(s.id)

    if (returnTo) {
      returnToRef.current = returnTo
      returnSolutionIdRef.current = s.id
      if (processAttachment?.processId) {
        returnToProcessIdRef.current = processAttachment.processId
      }
    }

    if (
      processAttachment?.target === "step-solution" &&
      processAttachment.stepId
    ) {
      setProcesses((prev) =>
        prev.map((process) =>
          process.id === processAttachment.processId
            ? {
                ...process,
                stages: process.stages.map((stage) => ({
                  ...stage,
                  alternatives: stage.alternatives.map((step) =>
                    step.id === processAttachment.stepId
                      ? { ...step, solutionId: s.id, materialId: undefined }
                      : step,
                  ),
                })),
              }
            : process,
        ),
      )
    }

    const plane = planes.find((p) => p.id === planeId)
    if (plane) {
      const col = plane.elements.find((e) => e.id === collectionId)
      if (col && col.type === "collection") {
        updateElement(planeId, {
          ...col,
          refs: [...col.refs, { kind: "solution" as const, id: s.id }],
        })
      }
    }
  }, [
    pendingCollectionLink,
    planes,
    setPendingCollectionLink,
    setSolutions,
    updateElement,
  ])

  const updateSolution = (updated: Solution) => {
    setSolutions((prev) => prev.map((s) => (s.id === updated.id ? updated : s)))
  }

  const copySolution = (id: string) => {
    const original = solutions.find((s) => s.id === id)
    if (!original) return
    const copied: Solution = {
      ...original,
      id: crypto.randomUUID(),
      name: `Copy of ${original.name}`,
      components: original.components.map((c) => ({
        ...c,
        id: crypto.randomUUID(),
      })),
    }
    setSolutions((prev) => [...prev, copied])
    const owner = getEntityCollection("solution", id)
    if (owner) {
      updateElement(owner.plane.id, {
        ...owner.collection,
        refs: [
          ...owner.collection.refs,
          { kind: "solution" as const, id: copied.id },
        ],
      })
    }
  }

  const deleteSolution = (id: string) => {
    const sol = solutions.find((s) => s.id === id)
    const dependents = getDependentLocations("solution", id, {
      solutions,
      experiments,
      processes,
      planes,
    })
    if (dependents.length > 0) {
      modals.open({
        title: "Cannot delete solution",
        children: (
          <DependencyBlockModal
            itemName={sol?.name ?? id}
            dependents={dependents}
          />
        ),
      })
      return
    }
    modals.openConfirmModal({
      title: "Delete solution",
      children: (
        <Text size="sm">
          Are you sure you want to delete this solution? This cannot be undone.
        </Text>
      ),
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => {
        setSolutions((prev) => prev.filter((s) => s.id !== id))
        removeCollectionRefs("solution", [id])
        if (id === selectedSolutionId) selectSolution(null)
      },
    })
  }

  const sharedCardProps = {
    groupedComponentOptions,
    solutionIdSet,
    solventIdSet,
    materialUnitById,
    getMaterialName,
    getSolutionName,
    componentColorMap,
    onEditingChange: handleSolutionEditingChange,
  }

  return (
    <>
      <Container fluid>
        <Group justify="space-between" mb="md" mt="md">
          <Title order={2}>Solutions</Title>
          <Button leftSection={<IconPlus size={16} />} onClick={addSolution}>
            New Solution
          </Button>
        </Group>

        {visibleSolutions.length === 0 && (
          <Text c="dimmed">
            {solutions.length === 0
              ? 'No solutions yet. Click "New Solution" to get started.'
              : "No solutions in the selected collection."}
          </Text>
        )}

        <Stack gap={0}>
          {(() => {
            if (!activePlaneId) {
              const groups = new Map<
                string,
                { planeName: string; items: typeof visibleSolutions }
              >()
              const orphans: typeof visibleSolutions = []
              for (const solution of visibleSolutions) {
                const plane = getEntityPlane("solution", solution.id)
                if (plane) {
                  const group = groups.get(plane.id)
                  if (group) {
                    group.items.push(solution)
                  } else {
                    groups.set(plane.id, {
                      planeName: plane.name,
                      items: [solution],
                    })
                  }
                } else {
                  orphans.push(solution)
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
                    mt="md"
                    mb={4}
                    px={4}
                  >
                    {planeName}
                  </Text>,
                )
                sections.push(
                  ...items.map((solution) => (
                    <SolutionCard
                      key={solution.id}
                      solution={solution}
                      onUpdate={updateSolution}
                      onDelete={() => deleteSolution(solution.id)}
                      onCopy={() => copySolution(solution.id)}
                      {...sharedCardProps}
                      collectionColor={
                        getEntityColor("solution", solution.id) ?? undefined
                      }
                      isSelected={selectedSolutionId === solution.id}
                      onSelect={selectSolution}
                      autoAddComponent={autoAddComponentId === solution.id}
                      onAutoAdded={() => setAutoAddComponentId(null)}
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
                    mt="md"
                    mb={4}
                    px={4}
                  >
                    Unassigned
                  </Text>,
                )
                sections.push(
                  ...orphans.map((solution) => (
                    <SolutionCard
                      key={solution.id}
                      solution={solution}
                      onUpdate={updateSolution}
                      onDelete={() => deleteSolution(solution.id)}
                      onCopy={() => copySolution(solution.id)}
                      {...sharedCardProps}
                      collectionColor={
                        getEntityColor("solution", solution.id) ?? undefined
                      }
                      isSelected={selectedSolutionId === solution.id}
                      onSelect={selectSolution}
                      autoAddComponent={autoAddComponentId === solution.id}
                      onAutoAdded={() => setAutoAddComponentId(null)}
                    />
                  )),
                )
              }
              return sections
            }
            return visibleSolutions.map((solution) => (
              <SolutionCard
                key={solution.id}
                solution={solution}
                onUpdate={updateSolution}
                onDelete={() => deleteSolution(solution.id)}
                onCopy={() => copySolution(solution.id)}
                {...sharedCardProps}
                collectionColor={
                  getEntityColor("solution", solution.id) ?? undefined
                }
                isSelected={selectedSolutionId === solution.id}
                onSelect={selectSolution}
                autoAddComponent={autoAddComponentId === solution.id}
                onAutoAdded={() => setAutoAddComponentId(null)}
              />
            ))
          })()}
        </Stack>
      </Container>
      <SelectCollectionModal
        opened={collectionModalOpen}
        onClose={() => setCollectionModalOpen(false)}
        onConfirm={doAddSolution}
        confirmLabel="Add Solution"
      />
    </>
  )
}
