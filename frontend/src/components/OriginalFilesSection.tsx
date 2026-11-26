import {
  ActionIcon,
  Badge,
  Group,
  Paper,
  Stack,
  Text,
  Tooltip,
} from "@mantine/core"
import { notifications } from "@mantine/notifications"
import { IconDownload } from "@tabler/icons-react"
import { useEffect, useState } from "react"
import { OpenAPI } from "@/client/core/OpenAPI"
import { getTokenAsync } from "@/lib/keycloakInstance"

type SourceInfo = {
  id: string
  original_filename: string
  relative_path: string | null
  file_type: string | null
  size: number
  available: boolean
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Compact "Original files" panel: lists the durable source files stored for an
 * experiment and offers an authenticated download action. Not a file manager —
 * read-only, uses the existing listing + download endpoints.
 */
export function OriginalFilesSection({
  experimentId,
}: {
  experimentId: string
}) {
  const [sources, setSources] = useState<SourceInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [downloadingId, setDownloadingId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const token = await getTokenAsync()
        const res = await fetch(
          `${OpenAPI.BASE}/api/v1/zip-explorer/experiments/${experimentId}/sources`,
          { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
        )
        if (!res.ok) throw new Error(`Failed to list sources (${res.status})`)
        const data = (await res.json()) as { sources?: SourceInfo[] }
        if (!cancelled) setSources(data.sources ?? [])
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [experimentId])

  const download = async (id: string, filename: string) => {
    setDownloadingId(id)
    try {
      const token = await getTokenAsync()
      const res = await fetch(
        `${OpenAPI.BASE}/api/v1/zip-explorer/sources/${id}/download`,
        { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
      )
      if (!res.ok) throw new Error(`Download failed (${res.status})`)
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = filename
      a.click()
      URL.revokeObjectURL(url)
    } catch (err) {
      notifications.show({
        title: "Download failed",
        message: err instanceof Error ? err.message : String(err),
        color: "red",
      })
    } finally {
      setDownloadingId(null)
    }
  }

  if (error) {
    return (
      <Text size="xs" c="dimmed">
        Original files unavailable: {error}
      </Text>
    )
  }
  if (sources === null || sources.length === 0) {
    return null
  }

  return (
    <Paper withBorder p="xs" radius="md">
      <Group justify="space-between" mb={4}>
        <Text size="sm" fw={600}>
          Original files
        </Text>
        <Badge size="xs" variant="light">
          {sources.length}
        </Badge>
      </Group>
      <Stack gap={4}>
        {sources.map((s) => (
          <Group key={s.id} justify="space-between" wrap="nowrap" gap="xs">
            <Stack gap={0} style={{ minWidth: 0 }}>
              <Text size="xs" truncate>
                {s.original_filename}
              </Text>
              <Text size="xs" c="dimmed" truncate>
                {s.relative_path ?? s.original_filename} ·{" "}
                {s.file_type ?? "unknown"} · {formatSize(s.size)}
              </Text>
            </Stack>
            <Tooltip
              label={s.available ? "Download" : "File missing"}
              withArrow
            >
              <ActionIcon
                size="sm"
                variant="subtle"
                disabled={!s.available}
                loading={downloadingId === s.id}
                onClick={() => void download(s.id, s.original_filename)}
                aria-label={`Download ${s.original_filename}`}
              >
                <IconDownload size={14} />
              </ActionIcon>
            </Tooltip>
          </Group>
        ))}
      </Stack>
    </Paper>
  )
}
