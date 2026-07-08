import {
  ActionIcon,
  Badge,
  Button,
  Card,
  Group,
  Loader,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
} from "@mantine/core"
import { modals } from "@mantine/modals"
import { notifications } from "@mantine/notifications"
import { IconArrowBackUp, IconTrash, IconTrashX } from "@tabler/icons-react"
import { useCallback, useEffect, useState } from "react"
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

const TYPE_COLOR: Record<string, string> = {
  process: "blue",
  experiment: "grape",
  result: "teal",
  analysis: "orange",
  plane: "indigo",
  collection: "cyan",
}

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
  const { getTrash, restoreTrash, purgeTrash, emptyTrash, reloadFromBackend } =
    useAppContext()
  const [entries, setEntries] = useState<TrashEntry[] | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    try {
      setEntries(await getTrash())
    } catch (err) {
      console.error("[Trash] failed to load:", err)
      notifications.show({
        color: "red",
        title: "Could not load trash",
        message: String(err),
      })
      setEntries([])
    }
  }, [getTrash])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const handleRestore = useCallback(
    async (entry: TrashEntry) => {
      setBusyId(entry.entityId)
      try {
        await restoreTrash(entry.entityType, entry.entityId)
        notifications.show({
          color: "green",
          title: "Restored",
          message: `“${entry.name || TYPE_LABEL[entry.entityType]}” is back. Dependent items it needs were restored too.`,
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
    [restoreTrash, refresh],
  )

  const handlePurge = useCallback(
    (entry: TrashEntry) => {
      modals.openConfirmModal({
        title: "Delete permanently?",
        children: (
          <Text size="sm">
            “{entry.name || TYPE_LABEL[entry.entityType]}” and everything it
            contains will be permanently deleted. This cannot be undone.
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

  return (
    <Stack p="lg" gap="md" maw={900} mx="auto">
      <Group justify="space-between" align="flex-end">
        <div>
          <Title order={2}>Trash</Title>
          <Text size="sm" c="dimmed">
            Deleted items are kept for 30 days, then removed automatically.
            Restoring an item also brings back anything it depends on. Items
            deleted from a plane that no longer exists are placed on a plane you
            choose when restored.
          </Text>
        </div>
        <Button
          leftSection={<IconTrash size={16} />}
          color="red"
          variant="light"
          disabled={!entries || entries.length === 0}
          onClick={handleEmpty}
        >
          Empty trash
        </Button>
      </Group>

      <Card withBorder padding={0} radius="md">
        {entries === null ? (
          <Group justify="center" p="xl">
            <Loader size="sm" />
          </Group>
        ) : entries.length === 0 ? (
          <Group justify="center" p="xl">
            <Text c="dimmed">The trash is empty.</Text>
          </Group>
        ) : (
          <Table highlightOnHover verticalSpacing="sm" horizontalSpacing="md">
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Name</Table.Th>
                <Table.Th>Deletion date</Table.Th>
                <Table.Th style={{ width: 110, textAlign: "right" }}>
                  Actions
                </Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {entries.map((entry) => (
                <Table.Tr key={`${entry.entityType}:${entry.entityId}`}>
                  <Table.Td>
                    <Group gap="xs">
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
                      {formatDate(entry.deletedAt)}
                    </Text>
                  </Table.Td>
                  <Table.Td>
                    <Group gap="xs" justify="flex-end">
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
              ))}
            </Table.Tbody>
          </Table>
        )}
      </Card>
    </Stack>
  )
}
