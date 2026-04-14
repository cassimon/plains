import {
  ActionIcon,
  Alert,
  Box,
  Button,
  Container,
  Group,
  rem,
  ScrollArea,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core"
import { modals } from "@mantine/modals"
import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconCopy,
  IconInfoCircle,
  IconPencil,
  IconPlus,
  IconSelector,
  IconTrash,
  IconX,
} from "@tabler/icons-react"
import { useEffect, useRef, useState } from "react"
import { DependencyBlockModal } from "../components/DependencyBlockModal"
import {
  getDependentLocations,
  type Material,
  newMaterial,
  useAppContext,
  useEntityCollection,
} from "../store/AppContext"

type Column = {
  key: keyof Material
  label: string
}

const COLUMNS: Column[] = [
  { key: "type", label: "Type" },
  { key: "name", label: "Name" },
  { key: "supplier", label: "Supplier" },
  { key: "supplierNumber", label: "Supplier Number" },
  { key: "casNumber", label: "CAS Number" },
  { key: "pubchemCid", label: "PubChem CID" },
  { key: "inventoryLabel", label: "Inventory Label" },
  { key: "purity", label: "Purity" },
]

type SortState = { key: keyof Material; direction: "asc" | "desc" } | null

function SortIcon({
  sorted,
  direction,
}: {
  sorted: boolean
  direction: "asc" | "desc"
}) {
  if (!sorted) {
    return <IconSelector size={14} />
  }
  return direction === "asc" ? (
    <IconChevronUp size={14} />
  ) : (
    <IconChevronDown size={14} />
  )
}

export function MaterialsPage() {
  const {
    materials,
    setMaterials,
    solutions,
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
  const { getEntityColor, isEntityVisible, getEntityPlane, getEntityCollection } =
    useEntityCollection()
  const [sort, setSort] = useState<SortState>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBuffer, setEditBuffer] = useState<Material | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(
    null,
  )
  const processedPendingRequestIdsRef = useRef<Set<string>>(new Set())

  const selectMaterial = (id: string | null) => {
    setSelectedMaterialId(id)
  }

  const startEdit = (m: Material) => {
    setEditingId(m.id)
    setEditBuffer({ ...m })
  }

  useEffect(() => {
    if (!editingId) {
      setActiveEntity(null)
      return
    }

    const editingMaterial = materials.find((m) => m.id === editingId)
    if (!editingMaterial || !isEntityVisible("material", editingId)) {
      setEditingId(null)
      setEditBuffer(null)
      setActiveEntity(null)
      return
    }

    setActiveEntity({ kind: "material", id: editingId })
  }, [editingId, isEntityVisible, materials, setActiveEntity])

  // Auto-create material + link to collection when navigated from action bubble
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  useEffect(() => {
    if (!pendingCollectionLink || pendingCollectionLink.kind !== "material") {
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

    const m = newMaterial()
    setMaterials((prev) => [...prev, m])

    const plane = planes.find((p) => p.id === planeId)
    if (plane) {
      const col = plane.elements.find((e) => e.id === collectionId)
      if (col && col.type === "collection") {
        const updated = {
          ...col,
          refs: [...col.refs, { kind: "material" as const, id: m.id }],
        }
        updateElement(planeId, updated)
      }
    }

    startEdit(m)
  }, [])

  const toggleSort = (key: keyof Material) => {
    setSort((prev) => {
      if (prev?.key === key) {
        return { key, direction: prev.direction === "asc" ? "desc" : "asc" }
      }
      return { key, direction: "asc" }
    })
  }

  const sorted = [...materials]
    .filter((m) => isEntityVisible("material", m.id))
    .sort((a, b) => {
      if (!sort) {
        return 0
      }
      const av = a[sort.key].toLowerCase()
      const bv = b[sort.key].toLowerCase()
      const cmp = av.localeCompare(bv)
      return sort.direction === "asc" ? cmp : -cmp
    })

  const copyMaterial = (m: Material) => {
    const copied: Material = {
      ...m,
      id: crypto.randomUUID(),
      name: `Copy of ${m.name}`,
    }
    setMaterials((prev) => [...prev, copied])
    const owner = getEntityCollection("material", m.id)
    if (owner) {
      updateElement(owner.plane.id, {
        ...owner.collection,
        refs: [...owner.collection.refs, { kind: "material" as const, id: copied.id }],
      })
    }
    startEdit(copied)
  }

  const deleteMaterial = (id: string) => {
    const mat = materials.find((m) => m.id === id)
    const dependents = getDependentLocations("material", id, {
      solutions,
      experiments,
      results,
      planes,
    })
    if (dependents.length > 0) {
      modals.open({
        title: "Cannot delete material",
        children: (
          <DependencyBlockModal
            itemName={mat?.name ?? id}
            dependents={dependents}
          />
        ),
      })
      return
    }
    modals.openConfirmModal({
      title: "Delete material",
      children: (
        <Text size="sm">
          Are you sure you want to delete the material "{mat?.name || id}"? This
          cannot be undone.
        </Text>
      ),
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => {
        setMaterials((prev) => prev.filter((m) => m.id !== id))
        removeCollectionRefs("material", [id])
        if (selectedMaterialId === id) {
          selectMaterial(null)
        }
      },
    })
  }

  const addMaterial = () => {
    const m = newMaterial()
    setMaterials((prev) => [...prev, m])
    // Link to active collection if one is selected
    if (activeCollectionId && activePlaneId) {
      const plane = planes.find((p) => p.id === activePlaneId)
      if (plane) {
        const col = plane.elements.find((e) => e.id === activeCollectionId)
        if (col && col.type === "collection") {
          updateElement(activePlaneId, {
            ...col,
            refs: [...col.refs, { kind: "material" as const, id: m.id }],
          })
        }
      }
    }
    startEdit(m)
  }

  const commitEdit = () => {
    if (!editBuffer) {
      return
    }
    setMaterials((prev) =>
      prev.map((m) => (m.id === editBuffer.id ? editBuffer : m)),
    )
    setEditingId(null)
    setEditBuffer(null)
  }

  const cancelEdit = (id: string) => {
    const original = materials.find((m) => m.id === id)
    if (original && !COLUMNS.some((c) => original[c.key])) {
      // Row was never filled — remove it
      setMaterials((prev) => prev.filter((m) => m.id !== id))
      removeCollectionRefs("material", [id])
    }
    setEditingId(null)
    setEditBuffer(null)
  }

  const confirmDelete = () => {
    // Build dependency report for all selected materials
    const depReport: { materialName: string; count: number }[] = []
    for (const id of selected) {
      const mat = materials.find((m) => m.id === id)
      const dependents = getDependentLocations("material", id, {
        solutions,
        experiments,
        results,
        planes,
      })
      if (dependents.length > 0) {
        depReport.push({
          materialName: mat?.name || id,
          count: dependents.length,
        })
      }
    }
    if (depReport.length > 0) {
      // Collect all dependents for the first blocked material and show a blocking modal
      const firstBlockedId = [...selected].find(
        (id) =>
          getDependentLocations("material", id, {
            solutions,
            experiments,
            results,
            planes,
          }).length > 0,
      )!
      const firstMat = materials.find((m) => m.id === firstBlockedId)
      const firstDeps = getDependentLocations("material", firstBlockedId, {
        solutions,
        experiments,
        results,
        planes,
      })
      modals.open({
        title: "Cannot delete material",
        children: (
          <DependencyBlockModal
            itemName={firstMat?.name ?? firstBlockedId}
            dependents={firstDeps}
          />
        ),
      })
      return
    }
    modals.openConfirmModal({
      title: "Delete materials",
      children: (
        <Text size="sm">
          Are you sure you want to delete {selected.size} material
          {selected.size > 1 ? "s" : ""}? This cannot be undone.
        </Text>
      ),
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => {
        const deletedIds = [...selected]
        setMaterials((prev) => prev.filter((m) => !selected.has(m.id)))
        removeCollectionRefs("material", deletedIds)
        setSelected(new Set())
        if (selectedMaterialId && selected.has(selectedMaterialId)) {
          selectMaterial(null)
        }
      },
    })
  }

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const renderMaterialRow = (material: Material) => {
    const isEditing = editingId === material.id
    return (
      <Table.Tr
        key={material.id}
        bg={
          selected.has(material.id)
            ? "var(--mantine-color-blue-light)"
            : undefined
        }
        onClick={() => selectMaterial(material.id)}
        style={{ cursor: "pointer" }}
      >
        <Table.Td
          style={{
            padding: 0,
            width: 6,
            minWidth: 6,
            background:
              getEntityColor("material", material.id) ?? "transparent",
          }}
        />
        <Table.Td>
          <input
            type="checkbox"
            checked={selected.has(material.id)}
            onChange={() => toggleSelect(material.id)}
          />
        </Table.Td>
        {COLUMNS.map((col) => (
          <Table.Td key={col.key}>
            {isEditing && editBuffer ? (
              <TextInput
                size="xs"
                value={editBuffer[col.key]}
                onChange={(e) => {
                  const value = e.currentTarget.value
                  setEditBuffer((prev) =>
                    prev ? { ...prev, [col.key]: value } : prev,
                  )
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    commitEdit()
                  }
                  if (e.key === "Escape") {
                    cancelEdit(material.id)
                  }
                }}
                autoFocus={col.key === "type"}
              />
            ) : (
              <Text size="sm">
                {material[col.key] || (
                  <Text span c="dimmed" size="sm">
                    —
                  </Text>
                )}
              </Text>
            )}
          </Table.Td>
        ))}
        <Table.Td>
          <Group gap={4} justify="center">
            {isEditing ? (
              <>
                <Tooltip label="Save">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="green"
                    onClick={commitEdit}
                  >
                    <IconCheck size={14} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Cancel">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="gray"
                    onClick={() => cancelEdit(material.id)}
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
                    onClick={() => startEdit(material)}
                  >
                    <IconPencil size={14} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Duplicate">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="teal"
                    onClick={() => copyMaterial(material)}
                  >
                    <IconCopy size={14} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Delete">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="red"
                    onClick={() => deleteMaterial(material.id)}
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

  return (
    <Container fluid>
      <Group justify="space-between" mb="md" mt="md">
        <Title order={2}>Materials</Title>
        <Group>
          {selected.size > 0 && (
            <Button
              color="red"
              leftSection={<IconTrash size={16} />}
              variant="light"
              onClick={confirmDelete}
            >
              Delete ({selected.size})
            </Button>
          )}
          <Button
            leftSection={<IconPlus size={16} />}
            onClick={addMaterial}
            disabled={!activeCollectionId}
          >
            Add Material
          </Button>
        </Group>
      </Group>

      {!activeCollectionId && (
        <Alert icon={<IconInfoCircle size={16} />} color="blue" mb="md">
          Select or create a collection in the Organization tab to add
          materials.
        </Alert>
      )}

      <ScrollArea>
        <Table
          striped
          highlightOnHover
          withTableBorder
          withColumnBorders
          stickyHeader
        >
          <Table.Thead>
            <Table.Tr>
              <Table.Th style={{ padding: 0, width: 6 }} />
              <Table.Th style={{ width: rem(36) }} />
              {COLUMNS.map((col) => (
                <Table.Th key={col.key}>
                  <UnstyledButton
                    onClick={() => toggleSort(col.key)}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: rem(4),
                    }}
                  >
                    <Text fw={600} size="sm">
                      {col.label}
                    </Text>
                    <SortIcon
                      sorted={sort?.key === col.key}
                      direction={sort?.key === col.key ? sort.direction : "asc"}
                    />
                  </UnstyledButton>
                </Table.Th>
              ))}
              <Table.Th style={{ width: rem(130) }} />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {sorted.length === 0 && (
              <Table.Tr>
                <Table.Td colSpan={COLUMNS.length + 3}>
                  <Text c="dimmed" ta="center" py="md">
                    {materials.length === 0
                      ? 'No materials yet. Click "Add Material" to get started.'
                      : "No materials in the selected collection."}
                  </Text>
                </Table.Td>
              </Table.Tr>
            )}
            {(() => {
              // In General mode (no plane selected), group by plane with subheadings
              if (!activePlaneId) {
                const groups = new Map<
                  string,
                  { planeName: string; items: typeof sorted }
                >()
                const orphans: typeof sorted = []
                for (const material of sorted) {
                  const plane = getEntityPlane("material", material.id)
                  if (plane) {
                    const group = groups.get(plane.id)
                    if (group) {
                      group.items.push(material)
                    } else {
                      groups.set(plane.id, {
                        planeName: plane.name,
                        items: [material],
                      })
                    }
                  } else {
                    orphans.push(material)
                  }
                }
                const sections: React.ReactNode[] = []
                for (const [planeId, { planeName, items }] of groups) {
                  sections.push(
                    <Table.Tr key={`plane-header-${planeId}`}>
                      <Table.Td
                        colSpan={COLUMNS.length + 3}
                        style={{
                          background: "var(--mantine-color-gray-1)",
                          padding: "4px 12px",
                        }}
                      >
                        <Text size="xs" fw={700} c="dimmed" tt="uppercase">
                          {planeName}
                        </Text>
                      </Table.Td>
                    </Table.Tr>,
                  )
                  sections.push(
                    ...items.map((material) => renderMaterialRow(material)),
                  )
                }
                if (orphans.length > 0) {
                  sections.push(
                    <Table.Tr key="plane-header-orphan">
                      <Table.Td
                        colSpan={COLUMNS.length + 3}
                        style={{
                          background: "var(--mantine-color-gray-1)",
                          padding: "4px 12px",
                        }}
                      >
                        <Text size="xs" fw={700} c="dimmed" tt="uppercase">
                          Unassigned
                        </Text>
                      </Table.Td>
                    </Table.Tr>,
                  )
                  sections.push(
                    ...orphans.map((material) => renderMaterialRow(material)),
                  )
                }
                return sections
              }
              return sorted.map((material) => renderMaterialRow(material))
            })()}
          </Table.Tbody>
        </Table>
      </ScrollArea>

      {materials.length > 0 && (
        <Box mt="xs">
          <Text size="xs" c="dimmed">
            {materials.length} material{materials.length > 1 ? "s" : ""}
          </Text>
        </Box>
      )}
    </Container>
  )
}
