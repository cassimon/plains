import {
  Box,
  Button,
  Group,
  Modal,
  Paper,
  Stack,
  Text,
  TextInput,
} from "@mantine/core"
import { IconFolderPlus, IconPlus } from "@tabler/icons-react"
import { useEffect, useState } from "react"
import useAuth from "../hooks/useAuth"
import {
  type CanvasCollectionElement,
  type CanvasElement,
  type Plane,
  useAppContext,
  type Vec2,
} from "../store/AppContext"

/**
 * Finds a free grid position near the canvas origin that does not overlap
 * with existing non-line elements (with a small safety margin).
 */
function findEmptyPosition(elements: CanvasElement[]): Vec2 {
  const GRID = 240
  const COLS = 5
  const ROWS = 5
  const MARGIN = 20

  type Rect = { x: number; y: number; w: number; h: number }
  const occupied: Rect[] = elements
    .filter((e) => e.type !== "line")
    .map((e) => {
      const pos = (e as { position?: Vec2 }).position ?? { x: 0, y: 0 }
      const size = (e as { size?: Vec2 }).size ?? { x: 200, y: 160 }
      return { x: pos.x, y: pos.y, w: size.x, h: size.y }
    })

  for (let row = 0; row < ROWS; row++) {
    for (let col = 0; col < COLS; col++) {
      const x = 40 + col * GRID
      const y = 40 + row * GRID
      const w = 200
      const h = 160
      const overlaps = occupied.some(
        (o) =>
          x < o.x + o.w + MARGIN &&
          x + w + MARGIN > o.x &&
          y < o.y + o.h + MARGIN &&
          y + h + MARGIN > o.y,
      )
      if (!overlaps) return { x, y }
    }
  }

  // Fallback: place below all existing elements
  const maxY = occupied.reduce((m, o) => Math.max(m, o.y + o.h), 0)
  return { x: 40, y: maxY + 40 }
}

export type CollectionConfirmParams = {
  planeId: string
  collectionId: string
  /** The collection element at the time of confirmation — use this for updateElement calls */
  collection: CanvasCollectionElement
}

type Props = {
  opened: boolean
  onClose: () => void
  /**
   * Called after the user confirms their plane + collection selection.
   * The modal has already called setActivePlaneId and setActiveCollectionId.
   * The page should create its entity and link it via updateElement.
   */
  onConfirm: (params: CollectionConfirmParams) => void
  /** Label for the final confirm button */
  confirmLabel?: string
}

/**
 * Two-step modal that guides the user to select (or create) a plane and then a
 * collection before adding a new entity.
 *
 * Step 1 (plane selection) is only shown when no plane is currently active.
 * Step 2 (collection selection) is always shown.
 */
export function SelectCollectionModal({
  opened,
  onClose,
  onConfirm,
  confirmLabel = "Add to Collection",
}: Props) {
  const {
    planes,
    activePlaneId,
    addPlane,
    addCollectionElement,
    updateElement,
    setActivePlaneId,
    setActiveCollectionId,
  } = useAppContext()
  const { user } = useAuth()

  const needsPlaneStep = activePlaneId === null

  const [step, setStep] = useState<"plane" | "collection">(
    needsPlaneStep ? "plane" : "collection",
  )
  const [chosenPlaneId, setChosenPlaneId] = useState<string | null>(
    activePlaneId,
  )
  const [createNewPlane, setCreateNewPlane] = useState(false)
  const [newPlaneName, setNewPlaneName] = useState("")

  const [selectedCollectionId, setSelectedCollectionId] = useState<
    string | null
  >(null)
  const [createNewCollection, setCreateNewCollection] = useState(false)
  const [newCollectionName, setNewCollectionName] = useState("New Collection")

  // Reset all state whenever the modal opens
  useEffect(() => {
    if (!opened) return
    const noPlane = activePlaneId === null
    setStep(noPlane ? "plane" : "collection")
    setChosenPlaneId(activePlaneId)
    setCreateNewPlane(false)
    setNewPlaneName(`Plane ${planes.length + 1}`)
    setSelectedCollectionId(null)
    setCreateNewCollection(false)
    setNewCollectionName("New Collection")
  }, [opened, activePlaneId, planes.length]) // eslint-disable-line react-hooks/exhaustive-deps

  // ── Derived ───────────────────────────────────────────────────────────────

  /** The plane the user has chosen (undefined while choosing "create new") */
  const chosenPlane: Plane | undefined = createNewPlane
    ? undefined
    : planes.find((p) => p.id === chosenPlaneId)

  /** Collections on the chosen plane (empty when creating a new plane) */
  const collections: CanvasCollectionElement[] = createNewPlane
    ? []
    : ((chosenPlane?.elements.filter((e) => e.type === "collection") ??
        []) as CanvasCollectionElement[])

  // ── Step 1 handlers ───────────────────────────────────────────────────────

  const handlePlaneNext = () => {
    if (createNewPlane && !newPlaneName.trim()) return
    if (!createNewPlane && !chosenPlaneId) return
    setStep("collection")
    setSelectedCollectionId(null)
    setCreateNewCollection(false)
  }

  const handleBack = () => {
    setStep("plane")
    setSelectedCollectionId(null)
    setCreateNewCollection(false)
  }

  // ── Step 2 / Confirm handler ───────────────────────────────────────────────

  const handleConfirm = () => {
    let finalPlaneId: string

    // Create plane now if requested (plane creation is deferred until Confirm
    // so that cancelling from step 2 doesn't leave a ghost plane)
    if (createNewPlane) {
      if (!newPlaneName.trim()) return
      const p = addPlane(newPlaneName.trim(), user?.id)
      finalPlaneId = p.id
    } else {
      if (!chosenPlaneId) return
      finalPlaneId = chosenPlaneId
    }

    let collectionId: string
    let collection: CanvasCollectionElement

    if (createNewCollection) {
      // Find empty position — plane might have just been created (no elements yet)
      const existingElements = createNewPlane
        ? []
        : (planes.find((p) => p.id === finalPlaneId)?.elements ?? [])
      const pos = findEmptyPosition(existingElements)
      const col = addCollectionElement(finalPlaneId, pos)
      // Override with user-provided name if they typed one
      const name = newCollectionName.trim()
      if (name) {
        updateElement(finalPlaneId, { ...col, name })
        collection = { ...col, name }
      } else {
        collection = col
      }
      collectionId = col.id
    } else {
      if (!selectedCollectionId) return
      const col = collections.find((c) => c.id === selectedCollectionId)
      if (!col) return
      collectionId = selectedCollectionId
      collection = col
    }

    setActivePlaneId(finalPlaneId)
    setActiveCollectionId(collectionId)
    onConfirm({ planeId: finalPlaneId, collectionId, collection })
    onClose()
  }

  // ── Validation ─────────────────────────────────────────────────────────────

  const canProceedPlane = createNewPlane
    ? newPlaneName.trim().length > 0
    : chosenPlaneId !== null

  const canConfirmCollection = createNewCollection
    ? true // allow empty name (falls back to default)
    : selectedCollectionId !== null

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title={step === "plane" ? "Choose a Plane" : "Choose a Collection"}
      size="sm"
    >
      {step === "plane" ? (
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            Select which plane to organize this item on.
          </Text>

          <Stack gap="xs">
            {planes.map((p) => (
              <Paper
                key={p.id}
                withBorder
                p="sm"
                radius="md"
                style={{
                  cursor: "pointer",
                  background:
                    chosenPlaneId === p.id && !createNewPlane
                      ? "var(--mantine-color-blue-0)"
                      : undefined,
                  borderColor:
                    chosenPlaneId === p.id && !createNewPlane
                      ? "var(--mantine-color-blue-4)"
                      : undefined,
                }}
                onClick={() => {
                  setChosenPlaneId(p.id)
                  setCreateNewPlane(false)
                }}
              >
                <Text size="sm" fw={500}>
                  {p.name}
                </Text>
                <Text size="xs" c="dimmed">
                  {p.elements.filter((e) => e.type === "collection").length}{" "}
                  collection(s)
                </Text>
              </Paper>
            ))}

            <Paper
              withBorder
              p="sm"
              radius="md"
              style={{
                cursor: "pointer",
                borderStyle: "dashed",
                background: createNewPlane
                  ? "var(--mantine-color-green-0)"
                  : undefined,
                borderColor: createNewPlane
                  ? "var(--mantine-color-green-4)"
                  : undefined,
              }}
              onClick={() => {
                setCreateNewPlane(true)
                setChosenPlaneId(null)
              }}
            >
              <Group gap="xs">
                <IconPlus size={16} color="var(--mantine-color-green-6)" />
                <Text size="sm" fw={500} c="green">
                  Create new plane
                </Text>
              </Group>
            </Paper>
          </Stack>

          {createNewPlane && (
            <TextInput
              label="Plane name"
              placeholder="e.g. Experiment Set 1"
              value={newPlaneName}
              onChange={(e) => setNewPlaneName(e.currentTarget.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handlePlaneNext()
              }}
            />
          )}

          <Group justify="flex-end" gap="sm">
            <Button variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handlePlaneNext} disabled={!canProceedPlane}>
              Next
            </Button>
          </Group>
        </Stack>
      ) : (
        <Stack gap="md">
          {/* Show context: which plane */}
          {(chosenPlane || createNewPlane) && (
            <Box>
              <Text size="xs" c="dimmed" tt="uppercase" fw={600}>
                Plane
              </Text>
              <Text size="sm" fw={500}>
                {createNewPlane
                  ? newPlaneName || "New Plane"
                  : chosenPlane?.name}
              </Text>
            </Box>
          )}

          <Text size="sm" c="dimmed">
            Choose an existing collection or create a new one to group this
            item.
          </Text>

          <Stack gap="xs">
            {collections.map((col) => (
              <Paper
                key={col.id}
                withBorder
                p="sm"
                radius="md"
                style={{
                  cursor: "pointer",
                  background:
                    selectedCollectionId === col.id && !createNewCollection
                      ? "var(--mantine-color-blue-0)"
                      : undefined,
                  borderColor:
                    selectedCollectionId === col.id && !createNewCollection
                      ? "var(--mantine-color-blue-4)"
                      : undefined,
                }}
                onClick={() => {
                  setSelectedCollectionId(col.id)
                  setCreateNewCollection(false)
                }}
              >
                <Text size="sm" fw={500}>
                  {col.name}
                </Text>
                <Text size="xs" c="dimmed">
                  {col.refs.length} item(s)
                </Text>
              </Paper>
            ))}

            {collections.length === 0 && !createNewCollection && (
              <Text size="sm" c="dimmed" ta="center" py="xs">
                No collections on this plane yet.
              </Text>
            )}

            <Paper
              withBorder
              p="sm"
              radius="md"
              style={{
                cursor: "pointer",
                borderStyle: "dashed",
                background: createNewCollection
                  ? "var(--mantine-color-green-0)"
                  : undefined,
                borderColor: createNewCollection
                  ? "var(--mantine-color-green-4)"
                  : undefined,
              }}
              onClick={() => {
                setCreateNewCollection(true)
                setSelectedCollectionId(null)
              }}
            >
              <Group gap="xs">
                <IconFolderPlus
                  size={16}
                  color="var(--mantine-color-green-6)"
                />
                <Text size="sm" fw={500} c="green">
                  Create new collection
                </Text>
              </Group>
            </Paper>
          </Stack>

          {createNewCollection && (
            <TextInput
              label="Collection name"
              placeholder="e.g. Batch 1"
              value={newCollectionName}
              onChange={(e) => setNewCollectionName(e.currentTarget.value)}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && canConfirmCollection) handleConfirm()
              }}
            />
          )}

          <Group justify="flex-end" gap="sm">
            {needsPlaneStep ? (
              <Button variant="outline" onClick={handleBack}>
                Back
              </Button>
            ) : (
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
            )}
            <Button onClick={handleConfirm} disabled={!canConfirmCollection}>
              {confirmLabel}
            </Button>
          </Group>
        </Stack>
      )}
    </Modal>
  )
}
