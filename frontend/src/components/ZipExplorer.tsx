import {
  Alert,
  Badge,
  Button,
  FileButton,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Stack,
  Table,
  Text,
} from "@mantine/core"
import { IconAlertTriangle, IconFileZip } from "@tabler/icons-react"
import { useState } from "react"
import { OpenAPI } from "@/client/core/OpenAPI"
import { getTokenAsync } from "@/lib/keycloakInstance"

type ZipEntry = {
  name: string
  directory: boolean
  size: number
  type: string
  recognized: boolean
  previewable: boolean
  preview: string | null
  preview_truncated: boolean
}

type ZipInspection = {
  file_count: number
  total_uncompressed_bytes: number
  recognized_files: number
  previewed_files: number
  warnings: string[]
  entries: ZipEntry[]
}

const TYPE_COLOR: Record<string, string> = {
  summary: "teal",
  "summary-fw": "teal",
  "summary-rv": "teal",
  "stability-jv": "blue",
  "stability-parameters": "indigo",
  "stability-tracking": "grape",
  "uv-vis": "cyan",
  text: "gray",
  unknown: "gray",
  directory: "gray",
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * Read-only ZIP archive inspector. Selects an archive, sends it to the
 * backend `zip-explorer/inspect` endpoint (in memory, never persisted) and
 * renders the directory inventory with a bounded preview for text files.
 */
export function ZipExplorer() {
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ZipInspection | null>(null)

  async function inspect(file: File | null) {
    if (!file) return
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const form = new FormData()
      form.append("file", file)
      const token = await getTokenAsync()
      const res = await fetch(`${OpenAPI.BASE}/api/v1/zip-explorer/inspect`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
      })
      if (!res.ok) {
        let detail = `Request failed (${res.status})`
        try {
          const body = (await res.json()) as { detail?: string }
          if (body?.detail) detail = body.detail
        } catch {
          /* keep the status-only message */
        }
        throw new Error(detail)
      }
      setResult((await res.json()) as ZipInspection)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Stack gap="md">
      <Group align="center" gap="sm">
        <FileButton onChange={inspect} accept=".zip,application/zip">
          {(props) => (
            <Button
              {...props}
              leftSection={<IconFileZip size={16} />}
              loading={loading}
            >
              Choose ZIP archive
            </Button>
          )}
        </FileButton>
        {loading && <Loader size="sm" />}
      </Group>

      {error && (
        <Alert
          color="red"
          title="Could not inspect archive"
          icon={<IconAlertTriangle size={16} />}
        >
          {error}
        </Alert>
      )}

      {result && (
        <Stack gap="md">
          <Group gap="xs">
            <Badge variant="light" color="gray">
              {result.file_count} file{result.file_count === 1 ? "" : "s"}
            </Badge>
            <Badge variant="light" color="teal">
              {result.recognized_files} recognized
            </Badge>
            <Badge variant="light" color="blue">
              {result.previewed_files} previewed
            </Badge>
            <Text size="xs" c="dimmed">
              {formatBytes(result.total_uncompressed_bytes)} uncompressed
            </Text>
          </Group>

          {result.warnings.length > 0 && (
            <Alert
              color="yellow"
              title="Warnings"
              icon={<IconAlertTriangle size={16} />}
            >
              <Stack gap={4}>
                {result.warnings.map((w) => (
                  <Text key={w} size="sm">
                    {w}
                  </Text>
                ))}
              </Stack>
            </Alert>
          )}

          {result.entries.length === 0 ? (
            <Text c="dimmed" size="sm">
              The archive is empty.
            </Text>
          ) : (
            <Paper withBorder radius="md">
              <ScrollArea.Autosize mah={480} type="auto">
                <Table striped verticalSpacing={6}>
                  <Table.Thead>
                    <Table.Tr>
                      <Table.Th>Name</Table.Th>
                      <Table.Th>Type</Table.Th>
                      <Table.Th>Size</Table.Th>
                    </Table.Tr>
                  </Table.Thead>
                  <Table.Tbody>
                    {result.entries.map((entry) => (
                      <EntryRows key={entry.name} entry={entry} />
                    ))}
                  </Table.Tbody>
                </Table>
              </ScrollArea.Autosize>
            </Paper>
          )}
        </Stack>
      )}

      {!result && !error && !loading && (
        <Text size="sm" c="dimmed" fs="italic">
          No archive inspected yet. The archive is opened read-only and never
          stored or imported.
        </Text>
      )}
    </Stack>
  )
}

function EntryRows({ entry }: { entry: ZipEntry }) {
  const color = TYPE_COLOR[entry.type] ?? "gray"
  return (
    <>
      <Table.Tr>
        <Table.Td style={{ maxWidth: 320 }}>
          <Text size="sm" truncate={!entry.previewable}>
            {entry.directory ? (
              <span style={{ fontWeight: 600 }}>{entry.name}</span>
            ) : (
              entry.name
            )}
          </Text>
        </Table.Td>
        <Table.Td>
          <Badge size="xs" variant="light" color={color}>
            {entry.type}
          </Badge>
        </Table.Td>
        <Table.Td>
          <Text size="xs" c="dimmed">
            {entry.directory ? "—" : formatBytes(entry.size)}
          </Text>
        </Table.Td>
      </Table.Tr>
      {entry.preview != null && (
        <Table.Tr>
          <Table.Td colSpan={3} style={{ padding: 0 }}>
            <Paper
              p="sm"
              radius={0}
              style={{
                background:
                  "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-8))",
              }}
            >
              <ScrollArea.Autosize mah={160} type="auto">
                <pre
                  style={{
                    margin: 0,
                    fontSize: 12,
                    lineHeight: 1.4,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                  }}
                >
                  {entry.preview}
                  {entry.preview_truncated ? "\n…" : ""}
                </pre>
              </ScrollArea.Autosize>
            </Paper>
          </Table.Td>
        </Table.Tr>
      )}
    </>
  )
}
