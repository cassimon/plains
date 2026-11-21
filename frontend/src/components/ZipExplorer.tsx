import {
  Alert,
  Badge,
  Button,
  FileButton,
  Group,
  Loader,
  Paper,
  ScrollArea,
  Select,
  Stack,
  Table,
  Text,
} from "@mantine/core"
import { notifications } from "@mantine/notifications"
import { IconAlertTriangle, IconFileZip } from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import { useRef, useState } from "react"
import { OpenAPI } from "@/client/core/OpenAPI"
import { getTokenAsync } from "@/lib/keycloakInstance"
import { useAppContext } from "@/store/AppContext"

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

type ImportMeasurement = {
  file: string
  direction: string | null
  voc: number | null
  jsc: number | null
  ff: number | null
  eff: number | null
  source: string
}

type ImportResult = {
  dry_run: boolean
  measurements: ImportMeasurement[]
  skipped: { file: string; reason: string }[]
  warnings: string[]
  imported: number
  result_id: string | null
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

// Filename types the backend can import (per-direction JV parameter summaries).
// The combined `summary` file uses a different 6-column layout and stays preview-only.
const IMPORTABLE_TYPES = new Set(["summary-fw", "summary-rv"])

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatMetric(value: number | null): string {
  return value == null ? "—" : String(value)
}

/**
 * Read-only ZIP archive inspector + optional confirmed import into an existing
 * experiment. Inspection never persists; import happens only via an explicit
 * "Confirm import" action and is performed server-side.
 */
export function ZipExplorer() {
  const { experiments, reloadFromBackend } = useAppContext()
  const navigate = useNavigate()
  const selectedFileRef = useRef<File | null>(null)
  // Re-entry guard: a rapid double-click on Confirm must not fire two imports
  // (React's `importing` state lags one render behind the first click).
  const importingRef = useRef(false)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ZipInspection | null>(null)

  const [experimentId, setExperimentId] = useState<string | null>(null)
  const [importPreview, setImportPreview] = useState<ImportResult | null>(null)
  const [importing, setImporting] = useState(false)
  const [importError, setImportError] = useState<string | null>(null)
  const [importedResultId, setImportedResultId] = useState<string | null>(null)

  async function postZip(
    path: string,
    form: FormData,
  ): Promise<{ ok: boolean; status: number; data: unknown }> {
    const token = await getTokenAsync()
    const res = await fetch(`${OpenAPI.BASE}/api/v1/zip-explorer/${path}`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
    })
    let data: unknown = null
    try {
      data = await res.json()
    } catch {
      /* non-JSON body */
    }
    return { ok: res.ok, status: res.status, data }
  }

  async function inspect(file: File | null) {
    if (!file) return
    selectedFileRef.current = file
    setLoading(true)
    setError(null)
    setResult(null)
    setImportPreview(null)
    setImportedResultId(null)
    setExperimentId(null)
    try {
      const form = new FormData()
      form.append("file", file)
      const { ok, status, data } = await postZip("inspect", form)
      if (!ok) {
        const detail =
          (data as { detail?: string })?.detail ?? `Request failed (${status})`
        throw new Error(detail)
      }
      setResult(data as ZipInspection)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  const hasImportable =
    result?.entries.some((e) => IMPORTABLE_TYPES.has(e.type)) ?? false

  async function runImport(dryRun: boolean) {
    const file = selectedFileRef.current
    if (!file || !experimentId || importingRef.current) return
    importingRef.current = true
    setImporting(true)
    setImportError(null)
    setImportedResultId(null)
    try {
      const form = new FormData()
      form.append("file", file)
      form.append("experiment_id", experimentId)
      form.append("dry_run", dryRun ? "true" : "false")
      const { ok, status, data } = await postZip("import", form)
      if (!ok) {
        const detail =
          (data as { detail?: string })?.detail ?? `Request failed (${status})`
        throw new Error(detail)
      }
      const parsed = data as ImportResult
      setImportPreview(parsed)
      if (!dryRun) {
        setImportedResultId(parsed.result_id)
        notifications.show({
          color: "green",
          title: "Import complete",
          message: `Imported ${parsed.imported} JV measurement${parsed.imported === 1 ? "" : "s"}.`,
        })
        // Refresh with the default flush: pending local edits are saved first
        // (never silently discarded), and a failed prerequisite save aborts the
        // reload instead of replacing local state. The flush's delete-
        // reconciliation only touches result ids the client already knows about,
        // so it never removes the just-imported result; load() then re-syncs
        // serverIds to include it.
        await reloadFromBackend()
      }
    } catch (err) {
      setImportError(err instanceof Error ? err.message : String(err))
    } finally {
      importingRef.current = false
      setImporting(false)
    }
  }

  const experimentOptions = experiments.map((e) => ({
    value: e.id,
    label: e.name || e.id,
  }))

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

          {hasImportable && (
            <Paper withBorder radius="md" p="md">
              <Stack gap="sm">
                <Text fw={600}>Import into an experiment</Text>
                <Text size="sm" c="dimmed">
                  This archive contains a supported JV Summary. Choose an
                  existing experiment to import the measurements into.
                </Text>

                <Select
                  label="Destination experiment"
                  placeholder="Select an experiment"
                  data={experimentOptions}
                  value={experimentId}
                  onChange={(v) => setExperimentId(v)}
                  searchable
                  clearable={false}
                  disabled={experimentOptions.length === 0}
                />
                {experimentOptions.length === 0 && (
                  <Text size="xs" c="dimmed">
                    No experiments available. Create one first, then import.
                  </Text>
                )}

                <Group gap="sm">
                  <Button
                    variant="light"
                    onClick={() => runImport(true)}
                    disabled={!experimentId || importing}
                  >
                    Preview import
                  </Button>
                  <Button
                    onClick={() => runImport(false)}
                    disabled={!experimentId || importing}
                    loading={importing}
                  >
                    Confirm import
                  </Button>
                </Group>

                {importError && (
                  <Alert
                    color="red"
                    title="Import failed"
                    icon={<IconAlertTriangle size={16} />}
                  >
                    {importError}
                  </Alert>
                )}

                {importedResultId && (
                  <Alert color="green" title="Import complete">
                    Imported {importPreview?.imported ?? 0} measurement
                    {importPreview?.imported === 1 ? "" : "s"}.{" "}
                    <Button
                      variant="subtle"
                      size="compact-sm"
                      onClick={() => navigate({ to: "/results" })}
                    >
                      Open Results
                    </Button>
                  </Alert>
                )}

                {importPreview && importPreview.measurements.length > 0 && (
                  <Stack gap="xs">
                    <Text size="sm" fw={600}>
                      {importPreview.dry_run ? "Preview" : "Imported"} —{" "}
                      {importPreview.measurements.length} measurement
                      {importPreview.measurements.length === 1 ? "" : "s"}
                    </Text>
                    <ScrollArea.Autosize mah={240} type="auto">
                      <Table striped verticalSpacing={5}>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th>File</Table.Th>
                            <Table.Th>Dir</Table.Th>
                            <Table.Th>Voc (V)</Table.Th>
                            <Table.Th>Jsc (mA/cm²)</Table.Th>
                            <Table.Th>FF (%)</Table.Th>
                            <Table.Th>PCE (%)</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {importPreview.measurements.map((m) => (
                            <Table.Tr key={`${m.file}-${m.direction ?? ""}`}>
                              <Table.Td>{m.file}</Table.Td>
                              <Table.Td>{m.direction ?? "—"}</Table.Td>
                              <Table.Td>{formatMetric(m.voc)}</Table.Td>
                              <Table.Td>{formatMetric(m.jsc)}</Table.Td>
                              <Table.Td>{formatMetric(m.ff)}</Table.Td>
                              <Table.Td>{formatMetric(m.eff)}</Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    </ScrollArea.Autosize>
                  </Stack>
                )}

                {importPreview && importPreview.skipped.length > 0 && (
                  <Stack gap={2}>
                    <Text size="xs" fw={600} c="dimmed">
                      Skipped ({importPreview.skipped.length})
                    </Text>
                    {importPreview.skipped.map((s, i) => (
                      <Text key={`${s.file}-${i}`} size="xs" c="dimmed">
                        {s.file}: {s.reason}
                      </Text>
                    ))}
                  </Stack>
                )}
              </Stack>
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
