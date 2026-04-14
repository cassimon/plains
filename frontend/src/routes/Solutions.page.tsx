import {
  ActionIcon,
  Alert,
  Badge,
  Box,
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
  SegmentedControl,
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
  IconInfoCircle,
  IconPencil,
  IconPlus,
  IconTrash,
  IconX,
} from "@tabler/icons-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { DependencyBlockModal } from "../components/DependencyBlockModal"
import {
  getDependentLocations,
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

// ── Component row (material/solution + amount + unit) ─────────────────────────

type ComponentRowProps = {
  component: SolutionComponent
  onChange: (updated: SolutionComponent) => void
  onDelete: () => void
  /** Pre-computed display name for the referenced material or solution */
  componentName: string
  editing: boolean
  onStartEdit: () => void
  onCommit: () => void
  onCancel: () => void
  buffer: SolutionComponent | null
  onBufferChange: (b: SolutionComponent) => void
  materialOptions: { value: string; label: string }[]
  /** Solution options (already filtered to exclude self-reference) */
  solutionOptions: { value: string; label: string }[]
  materialColorMap?: Map<string, string>
  solutionColorMap?: Map<string, string>
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
  materialOptions,
  solutionOptions,
  materialColorMap,
  solutionColorMap,
}: ComponentRowProps) {
  // Derive which type is being edited from the buffer state
  const editType: "material" | "solution" =
    editing && buffer && buffer.solutionId !== undefined
      ? "solution"
      : "material"

  return (
    <Table.Tr>
      <Table.Td>
        {editing && buffer ? (
          <Stack gap={4}>
            <SegmentedControl
              size="xs"
              value={editType}
              onChange={(t) => {
                if (t === "material") {
                  onBufferChange({
                    ...buffer,
                    materialId: buffer.materialId ?? "",
                    solutionId: undefined,
                  })
                } else {
                  onBufferChange({
                    ...buffer,
                    solutionId: buffer.solutionId ?? "",
                    materialId: undefined,
                  })
                }
              }}
              data={[
                { label: "Material", value: "material" },
                { label: "Solution ↰", value: "solution" },
              ]}
            />
            {editType === "material" ? (
              <Select
                size="xs"
                value={buffer.materialId || null}
                onChange={(v) =>
                  onBufferChange({
                    ...buffer,
                    materialId: v ?? "",
                    solutionId: undefined,
                  })
                }
                data={materialOptions}
                placeholder="— select material —"
                clearable
                searchable
                renderOption={({ option }) => {
                  const color = materialColorMap?.get(option.value)
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
              <Select
                size="xs"
                value={buffer.solutionId || null}
                onChange={(v) =>
                  onBufferChange({
                    ...buffer,
                    solutionId: v ?? "",
                    materialId: undefined,
                  })
                }
                data={solutionOptions}
                placeholder="— select solution —"
                clearable
                searchable
                renderOption={({ option }) => {
                  const color = solutionColorMap?.get(option.value)
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
            )}
          </Stack>
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
  materialOptions: { value: string; label: string }[]
  getMaterialName: (id: string) => string
  /** All solutions (used to build solution-as-component options) */
  allSolutionOptions: { value: string; label: string }[]
  getSolutionName: (id: string) => string
  materialColorMap?: Map<string, string>
  solutionColorMap?: Map<string, string>
  collectionColor?: string
  isSelected?: boolean
  onSelect?: (id: string | null) => void
  onEditingChange?: (id: string, isEditing: boolean) => void
}

function SolutionCard({
  solution,
  onUpdate,
  onDelete,
  onCopy,
  materialOptions,
  getMaterialName,
  allSolutionOptions,
  getSolutionName,
  materialColorMap,
  solutionColorMap,
  collectionColor,
  isSelected,
  onSelect,
  onEditingChange,
}: SolutionCardProps) {
  const [open, setOpen] = useState(isSelected ?? false)

  useEffect(() => {
    setOpen(Boolean(isSelected))
  }, [isSelected])

  const handleToggleOpen = (newOpen: boolean) => {
    if (!newOpen) {
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
    setCreationTimeBuffer(toDateTimeLocalValue(solution.creationTime))
  }, [solution.creationTime, solution.handling])

  const commitName = () => {
    onUpdate({ ...solution, name: nameBuffer.trim() || solution.name })
    setEditingName(false)
  }

  const addComponent = () => {
    const c = newComponent()
    const updated = { ...solution, components: [...solution.components, c] }
    onUpdate(updated)
    setEditingComponentId(c.id)
    setComponentBuffer(c)
  }

  const commitHandling = () => {
    if ((solution.handling ?? "") === handlingBuffer) {
      return
    }
    onUpdate({ ...solution, handling: handlingBuffer })
  }

  const commitCreationTime = () => {
    const parsed = fromDateTimeLocalValue(creationTimeBuffer)
    if (!parsed) {
      setCreationTimeBuffer(toDateTimeLocalValue(solution.creationTime))
      return
    }
    if (parsed === solution.creationTime) {
      return
    }
    onUpdate({ ...solution, creationTime: parsed })
  }

  const commitComponent = () => {
    if (!componentBuffer) {
      return
    }
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
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitName()
                  }
                  if (e.key === "Escape") {
                    setEditingName(false)
                    setNameBuffer(solution.name)
                  }
                }}
                autoFocus
                style={{ width: rem(200) }}
              />
              <ActionIcon
                size="sm"
                variant="subtle"
                color="green"
                onClick={commitName}
              >
                <IconCheck size={14} />
              </ActionIcon>
              <ActionIcon
                size="sm"
                variant="subtle"
                color="gray"
                onClick={() => {
                  setEditingName(false)
                  setNameBuffer(solution.name)
                }}
              >
                <IconX size={14} />
              </ActionIcon>
            </Group>
          ) : (
            <Group gap={4} wrap="nowrap">
              <Text
                fw={600}
                style={{ cursor: "pointer" }}
                onClick={() => handleToggleOpen(!open)}
              >
                {solution.name}
              </Text>
              <ActionIcon
                size="xs"
                variant="subtle"
                color="gray"
                onClick={() => setEditingName(true)}
              >
                <IconPencil size={12} />
              </ActionIcon>
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
              if (e.key === "Enter") {
                commitHandling()
              }
            }}
            placeholder="e.g. Store under nitrogen"
          />
          <TextInput
            label="Creation Time"
            size="xs"
            type="datetime-local"
            value={creationTimeBuffer}
            onChange={(e) => setCreationTimeBuffer(e.currentTarget.value)}
            onBlur={commitCreationTime}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitCreationTime()
              }
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
                // Exclude self to prevent circular references
                const filteredSolutionOptions = allSolutionOptions.filter(
                  (opt) => opt.value !== solution.id,
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
                    materialOptions={materialOptions}
                    solutionOptions={filteredSolutionOptions}
                    materialColorMap={materialColorMap}
                    solutionColorMap={solutionColorMap}
                  />
                )
              })}
            </Table.Tbody>
          </Table>
        </ScrollArea>
        <Box mt="xs">
          <Button
            size="xs"
            leftSection={<IconPlus size={12} />}
            variant="light"
            onClick={addComponent}
          >
            Add Component
          </Button>
        </Box>
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
    experiments,
    results,
    planes,
    updateElement,
    removeCollectionRefs,
    pendingCollectionLink,
    setPendingCollectionLink,
    activeCollectionId,
    activePlaneId,
    setActiveEntity,
  } = useAppContext()
  const {
    getEntityColor,
    isEntityVisible,
    getEntityPlane,
    getEntityCollection,
    isEntityOnActivePlane,
  } = useEntityCollection()
  const [selectedSolutionId, setSelectedSolutionId] = useState<string | null>(
    null,
  )
  const [editingSolutionId, setEditingSolutionId] = useState<string | null>(
    null,
  )
  const processedPendingRequestIdsRef = useRef<Set<string>>(new Set())

  const selectSolution = (id: string | null) => {
    setSelectedSolutionId(id)
  }

  useEffect(() => {
    if (!editingSolutionId) {
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
  }, [editingSolutionId, isEntityVisible, setActiveEntity, solutions])

  const materialOptions = useMemo(
    () =>
      materials
        .filter((m) => isEntityOnActivePlane("material", m.id))
        .map((m) => ({
          value: m.id,
          label: m.name || m.inventoryLabel || m.casNumber || m.id,
        })),
    [materials, isEntityOnActivePlane],
  )

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
        .map((s) => ({
          value: s.id,
          label: s.name || s.id,
        })),
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
  }, [selectedSolutionId, visibleSolutions])

  const handleSolutionEditingChange = (id: string, isEditing: boolean) => {
    setEditingSolutionId((current) => {
      if (isEditing) {
        return id
      }
      return current === id ? null : current
    })
  }

  const addSolution = () => {
    const s = newSolution()
    setSolutions((prev) => [...prev, s])
    if (activeCollectionId && activePlaneId) {
      const plane = planes.find((p) => p.id === activePlaneId)
      if (plane) {
        const col = plane.elements.find((e) => e.id === activeCollectionId)
        if (col && col.type === "collection") {
          updateElement(activePlaneId, {
            ...col,
            refs: [...col.refs, { kind: "solution" as const, id: s.id }],
          })
        }
      }
    }
  }

  // Auto-create solution + link to collection when navigated from action bubble
  useEffect(() => {
    if (!pendingCollectionLink || pendingCollectionLink.kind !== "solution") {
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

    const s = newSolution()
    setSolutions((prev) => [...prev, s])

    const plane = planes.find((p) => p.id === planeId)
    if (plane) {
      const col = plane.elements.find((e) => e.id === collectionId)
      if (col && col.type === "collection") {
        const updated = {
          ...col,
          refs: [...col.refs, { kind: "solution" as const, id: s.id }],
        }
        updateElement(planeId, updated)
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
        refs: [...owner.collection.refs, { kind: "solution" as const, id: copied.id }],
      })
    }
  }

  const deleteSolution = (id: string) => {
    const sol = solutions.find((s) => s.id === id)
    const dependents = getDependentLocations("solution", id, {
      solutions,
      experiments,
      results,
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
        if (id === selectedSolutionId) {
          selectSolution(null)
        }
      },
    })
  }

  return (
    <Container fluid>
      <Group justify="space-between" mb="md" mt="md">
        <Title order={2}>Solutions</Title>
        <Button
          leftSection={<IconPlus size={16} />}
          onClick={addSolution}
          disabled={!activeCollectionId}
        >
          New Solution
        </Button>
      </Group>

      {!activeCollectionId && (
        <Alert icon={<IconInfoCircle size={16} />} color="blue" mb="md">
          Select or create a collection in the Organization tab to add
          solutions.
        </Alert>
      )}

      {visibleSolutions.length === 0 && activeCollectionId && (
        <Text c="dimmed">
          {solutions.length === 0
            ? 'No solutions yet. Click "New Solution" to get started.'
            : "No solutions in the selected collection."}
        </Text>
      )}

      <Stack gap={0}>
        {(() => {
          if (!activePlaneId) {
            // General mode: group by plane
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
                    materialOptions={materialOptions}
                    getMaterialName={getMaterialName}
                    allSolutionOptions={allSolutionOptions}
                    getSolutionName={getSolutionName}
                    materialColorMap={materialColorMap}
                    solutionColorMap={solutionColorMap}
                    collectionColor={
                      getEntityColor("solution", solution.id) ?? undefined
                    }
                    isSelected={selectedSolutionId === solution.id}
                    onSelect={selectSolution}
                    onEditingChange={handleSolutionEditingChange}
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
                    materialOptions={materialOptions}
                    getMaterialName={getMaterialName}
                    allSolutionOptions={allSolutionOptions}
                    getSolutionName={getSolutionName}
                    materialColorMap={materialColorMap}
                    solutionColorMap={solutionColorMap}
                    collectionColor={
                      getEntityColor("solution", solution.id) ?? undefined
                    }
                    isSelected={selectedSolutionId === solution.id}
                    onSelect={selectSolution}
                    onEditingChange={handleSolutionEditingChange}
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
              materialOptions={materialOptions}
              getMaterialName={getMaterialName}
              allSolutionOptions={allSolutionOptions}
              getSolutionName={getSolutionName}
              materialColorMap={materialColorMap}
              solutionColorMap={solutionColorMap}
              collectionColor={
                getEntityColor("solution", solution.id) ?? undefined
              }
              isSelected={selectedSolutionId === solution.id}
              onSelect={selectSolution}
              onEditingChange={handleSolutionEditingChange}
            />
          ))
        })()}
      </Stack>
    </Container>
  )
}
