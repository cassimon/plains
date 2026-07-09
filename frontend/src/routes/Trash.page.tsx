import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Select,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from "@mantine/core"
import { modals } from "@mantine/modals"
import { notifications } from "@mantine/notifications"
import { IconArrowBackUp, IconTrash, IconTrashX } from "@tabler/icons-react"
import { Fragment, useCallback, useEffect, useMemo, useState } from "react"
import type { TrashEntry } from "@/store/backend"
import { useAppContext } from "../store/AppContext"

const TYPE_LABEL: Record<string, string> = {
  process: "Process",
  experiment: "Experiment",
  result: "Result",
  analysis: "Analysis",
  plane: "Plane",
  collection: "Collection",
}

// Plural section headings, in the default category display order.
const TYPE_SECTION: Array<{ type: string; heading: string }> = [
  { type: "plane", heading: "Planes" },
  { type: "collection", heading: "Collections" },
  { type: "process", heading: "Processes" },
  { type: "experiment", heading: "Experiments" },
  { type: "result", heading: "Results" },
  { type: "analysis", heading: "Analyses" },
]

const TYPE_COLOR: Record<string, string> = {
  process: "blue",
  experiment: "grape",
  result: "teal",
  analysis: "orange",
  plane: "indigo",
  collection: "cyan",
}

const LOOSE_TYPES = new Set(["process", "experiment", "result", "analysis"])

function formatDate(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return d.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

export function TrashPage() {
  const {
    trashEntries,
    refreshTrash,
    restoreTrash,
    placeRestoredItems,
    purgeTrash,
    emptyTrash,
    reloadFromBackend,
    planes,
  } = useAppContext()
  const [loading, setLoading] = useState(true)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      await refreshTrash()
    } finally {
      setLoading(false)
    }
  }, [refreshTrash])

  useEffect(() => {
    void refresh()
  }, [refresh])

  // Group by category, sections in the fixed display order.
  const sections = useMemo(() => {
    return TYPE_SECTION.map(({ type, heading }) => ({
      heading,
      rows: trashEntries.filter((e) => e.entityType === type),
    })).filter((s) => s.rows.length > 0)
  }, [trashEntries])

  const doRestore = useCallback(
    async (entry: TrashEntry, destinationPlaneId?: string) => {
      setBusyId(entry.entityId)
      try {
        const unplaced = await restoreTrash(
          entry.entityType,
          entry.entityId,
          destinationPlaneId,
        )
        // Safety net: the prediction below missed (e.g. the original plane was
        // trashed by another session), so the server had nowhere to put these.
        // State is post-reload clean now, so placing them client-side is safe.
        if (unplaced.length > 0) {
          const fallback = destinationPlaneId ?? planes[0]?.id
          if (fallback) placeRestoredItems(fallback, unplaced)
        }
        notifications.show({
          color: "green",
          title: "Restored",
          message: `“${entry.name || TYPE_LABEL[entry.entityType]}” is back${
            entry.childCount > 0 ? " with everything it contained" : ""
          }.`,
        })
        await refresh()
      } catch (err) {
        notifications.show({
          color: "red",
          title: "Restore failed",
          message: String(err),
        })
      } finally {
        setBusyId(null)
      }
    },
    [restoreTrash, placeRestoredItems, planes, refresh],
  )

  const handleRestore = useCallback(
    (entry: TrashEntry) => {
      // Ask for a destination only when the item *had* a plane and that plane is
      // gone. Everything else the server re-attaches on its own: an item whose
      // collection vanished lands in a "Restored: …" collection on its original
      // plane, and an item that never sat on a canvas stays unplaced (asking
      // would invent a placement it never had). Planes restore whole.
      const originalPlaneGone =
        !!entry.originalPlaneId &&
        !planes.some((p) => p.id === entry.originalPlaneId)
      const needsDestination =
        entry.entityType !== "plane" &&
        (LOOSE_TYPES.has(entry.entityType) ||
          entry.entityType === "collection") &&
        originalPlaneGone

      if (!needsDestination) {
        void doRestore(entry)
        return
      }

      if (planes.length === 0) {
        notifications.show({
          color: "red",
          title: "No plane to restore onto",
          message: "Create a plane first, then restore this item.",
        })
        return
      }

      let selected = planes[0]?.id ?? ""
      modals.openConfirmModal({
        title: "Choose a plane",
        children: (
          <Stack gap="xs">
            <Text size="sm">
              The plane this item lived on no longer exists. Pick a plane to
              restore it onto —{" "}
              {entry.entityType === "collection"
                ? "the collection moves there with everything in it."
                : "it will be placed in a collection on free cells."}
            </Text>
            <Select
              data={planes.map((p) => ({ value: p.id, label: p.name }))}
              defaultValue={selected}
              onChange={(v) => {
                selected = v ?? selected
              }}
              allowDeselect={false}
              comboboxProps={{ withinPortal: true }}
            />
          </Stack>
        ),
        labels: { confirm: "Restore here", cancel: "Cancel" },
        onConfirm: () => void doRestore(entry, selected),
      })
    },
    [planes, doRestore],
  )

  const handlePurge = useCallback(
    (entry: TrashEntry) => {
      modals.openConfirmModal({
        title: "Delete permanently?",
        children: (
          <Text size="sm">
            “{entry.name || TYPE_LABEL[entry.entityType]}”
            {entry.childCount > 0 ? " and everything it contains" : ""} will be
            permanently deleted. This cannot be undone.
          </Text>
        ),
        labels: { confirm: "Delete permanently", cancel: "Cancel" },
        confirmProps: { color: "red" },
        onConfirm: async () => {
          setBusyId(entry.entityId)
          try {
            await purgeTrash(entry.entityType, entry.entityId)
            await refresh()
          } catch (err) {
            notifications.show({
              color: "red",
              title: "Delete failed",
              message: String(err),
            })
          } finally {
            setBusyId(null)
          }
        },
      })
    },
    [purgeTrash, refresh],
  )

  const handleEmpty = useCallback(() => {
    modals.openConfirmModal({
      title: "Empty the trash?",
      children: (
        <Text size="sm">
          Every item in the trash will be <b>permanently deleted</b>, along with
          everything each one contains. This cannot be undone.
        </Text>
      ),
      labels: { confirm: "Empty trash", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: async () => {
        try {
          await emptyTrash()
          await reloadFromBackend()
          await refresh()
          notifications.show({ color: "green", message: "Trash emptied" })
        } catch (err) {
          notifications.show({
            color: "red",
            title: "Could not empty trash",
            message: String(err),
          })
        }
      },
    })
  }, [emptyTrash, reloadFromBackend, refresh])

  const renderRow = (entry: TrashEntry) => (
    <Table.Tr key={`${entry.entityType}:${entry.entityId}`}>
      <Table.Td>
        <Group gap="xs" wrap="nowrap">
          <Badge
            color={TYPE_COLOR[entry.entityType] ?? "gray"}
            variant="light"
            size="sm"
          >
            {TYPE_LABEL[entry.entityType] ?? entry.entityType}
          </Badge>
          <Text>{entry.name || "(untitled)"}</Text>
        </Group>
      </Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed">
          {entry.summary || (entry.childCount === 0 ? "—" : "")}
        </Text>
      </Table.Td>
      <Table.Td>
        <Text size="sm" c="dimmed">
          {formatDate(entry.deletedAt)}
        </Text>
      </Table.Td>
      <Table.Td>
        <Group gap="xs" justify="flex-end" wrap="nowrap">
          <Tooltip label="Restore">
            <ActionIcon
              variant="subtle"
              color="green"
              loading={busyId === entry.entityId}
              onClick={() => handleRestore(entry)}
              aria-label="Restore"
            >
              <IconArrowBackUp size={18} />
            </ActionIcon>
          </Tooltip>
          <Tooltip label="Delete permanently">
            <ActionIcon
              variant="subtle"
              color="red"
              loading={busyId === entry.entityId}
              onClick={() => handlePurge(entry)}
              aria-label="Delete permanently"
            >
              <IconTrashX size={18} />
            </ActionIcon>
          </Tooltip>
        </Group>
      </Table.Td>
    </Table.Tr>
  )

  return (
    <Stack p="lg" gap="md" maw={960} mx="auto">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>Trash</Title>
          <Text size="sm" c="dimmed">
            Deleted items are kept for 30 days, then removed automatically. Only
            the top-level item you deleted is shown; restoring it brings back
            everything it contained, back in the collection and plane it came
            from. If its original plane is gone, you'll be asked where to put
            it.
          </Text>
        </div>
        <Button
          leftSection={<IconTrash size={16} />}
          color="red"
          variant="light"
          disabled={trashEntries.length === 0}
          onClick={handleEmpty}
        >
          Empty trash
        </Button>
      </Group>

      <Card withBorder padding={0} radius="md">
        {loading && trashEntries.length === 0 ? (
          <Group justify="center" p="xl">
            <Loader size="sm" />
          </Group>
        ) : trashEntries.length === 0 ? (
          <Group justify="center" p="xl">
            <Text c="dimmed">The trash is empty.</Text>
          </Group>
        ) : (
          <Table highlightOnHover verticalSpacing="sm" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Contents</Table.Th>
                <Table.Th>Deleted</Table.Th>
                <Table.Th style={{ width: 110, textAlign: "right" }}>
                  Actions
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {sections.map((section) => (
                <Fragment key={`section:${section.heading}`}>
                  <Table.Tr>
                    <Table.Td colSpan={4} style={{ paddingTop: 14 }}>
                      <Text fw={600} size="xs" tt="uppercase" c="dimmed">
                        {section.heading}
                      </Text>
                    </Table.Td>
                  </Table.Tr>
                  {section.rows.map(renderRow)}
                </Fragment>
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Card>
    </Stack>
  )
}
