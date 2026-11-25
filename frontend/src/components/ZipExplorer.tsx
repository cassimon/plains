import {
  Alert,
  Badge,
  Button,
  Checkbox,
  FileButton,
  Group,
  Loader,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  TextInput,
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
  filename: string
  device: string
  direction: string | null
  voc: number | null
  jsc: number | null
  ff: number | null
  eff: number | null
  source: string
  batch: string
  in_summary: boolean
  cell: string
  pixel: string
}

type ImportResult = {
  dry_run: boolean
  measurements: ImportMeasurement[]
  skipped: { file: string; reason: string }[]
  warnings: string[]
  imported: number
  result_id: string | null
  experiment_id: string | null
  created_experiment: boolean
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
// Original JV files (stability-jv) and directional summaries are importable.
const IMPORTABLE_TYPES = new Set(["stability-jv", "summary-fw", "summary-rv"])

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatMetric(value: number | null | undefined): string {
  return value == null ? "—" : String(value)
}

/**
 * Read-only ZIP archive inspector + optional confirmed import into an existing
 * experiment. Inspection never persists; import happens only via an explicit
 * "Confirm import" action and is performed server-side.
 */
export function ZipExplorer() {
  const {
    experiments,
    planes,
    processes,
    reloadFromBackend,
    setActiveEntity,
    setActivePlaneId,
    setActiveCollectionId,
    updateLastSelected,
  } = useAppContext()
  const navigate = useNavigate()
  const selectedFileRef = useRef<File | null>(null)
  // Re-entry guard: a rapid double-click on Confirm must not fire two imports
  // (React's `importing` state lags one render behind the first click).
  const importingRef = useRef(false)

  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<ZipInspection | null>(null)

  const [experimentId, setExperimentId] = useState<string | null>(null)
  const [importMode, setImportMode] = useState<"new" | "existing">("new")
  const [newName, setNewName] = useState("")
  const [planeId, setPlaneId] = useState<string | null>(null)
  const [collectionId, setCollectionId] = useState<string | null>(null)
  const [processId, setProcessId] = useState<string | null>(null)
  // Original file → corrected device name (editable in the preview).
  const [deviceNames, setDeviceNames] = useState<Record<string, string>>({})
  // Device name → substrate assignment (substrate name for a new experiment,
  // substrate id for an existing experiment).
  const [substrateAssignments, setSubstrateAssignments] = useState<
    Record<string, string>
  >({})
  const [importPreview, setImportPreview] = useState<ImportResult | null>(null)
  const [selectionMode, setSelectionMode] = useState<"summary" | "all">("summary")
  const [selectedBatches, setSelectedBatches] = useState<Set<string>>(new Set())
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
    // A new archive must not reuse state from the previous one.
    setNewName("")
    setPlaneId(null)
    setCollectionId(null)
    setProcessId(null)
    setDeviceNames({})
    setSubstrateAssignments({})
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
    const canSubmit =
      importMode === "new" ? newName.trim().length > 0 : !!experimentId
    if (!file || !canSubmit || importingRef.current) return
    importingRef.current = true
    setImporting(true)
    setImportError(null)
    setImportedResultId(null)
    try {
      const form = new FormData()
      form.append("file", file)
      if (importMode === "new") {
        form.append("experiment_name", newName.trim())
        if (collectionId) form.append("collection_id", collectionId)
        if (planeId) form.append("plane_id", planeId)
        if (processId) form.append("process_id", processId)
      } else {
        form.append("experiment_id", experimentId!)
      }
      if (Object.keys(deviceNames).length > 0) {
        form.append("device_names", JSON.stringify(deviceNames))
      }
      const substrateList = Object.entries(substrateAssignments)
        .filter(([, substrate]) => substrate.trim().length > 0)
        .map(([deviceKey, substrate]) => {
          const device = deviceNames[deviceKey] ?? deviceKey
          return importMode === "new"
            ? { device, substrate_name: substrate.trim() }
            : { device, substrate_id: substrate.trim() }
        })
      if (substrateList.length > 0) {
        form.append("substrate_assignments", JSON.stringify(substrateList))
      }
      if (selectedBatches.size > 0) {
        form.append("selected_batches", JSON.stringify([...selectedBatches]))
      }
      form.append("selection_mode", selectionMode)
      form.append("dry_run", dryRun ? "true" : "false")
      const { ok, status, data } = await postZip("import", form)
      if (!ok) {
        const detail =
          (data as { detail?: string })?.detail ?? `Request failed (${status})`
        throw new Error(detail)
      }
      const parsed = data as ImportResult
      setImportPreview(parsed)
      if (dryRun) {
        // Initialise editable device names from the parsed measurements, but
        // preserve any manual corrections the user already made.
        setDeviceNames((prev) => {
          const next: Record<string, string> = { ...prev }
          for (const m of parsed.measurements) {
            const key = m.device || m.filename || m.file
            if (!(key in next)) next[key] = key
          }
          return next
        })
      }
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
        if (parsed.experiment_id) {
          setActiveEntity({ kind: "experiment", id: parsed.experiment_id })
          // Make the Results page preselect this experiment (it reads
          // `lastSelectedByKind.experiment` on mount).
          updateLastSelected("experiment", parsed.experiment_id)
        }
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

  // Substrates of the selected existing experiment (for assignment).
  const existingSubstrateOptions = (
    experiments.find((e) => e.id === experimentId)?.substrates ?? []
  ).map((s) => ({ value: s.id, label: s.name || s.id }))

  // Collections scoped to the selected plane (no cross-plane collections).
  const collectionOptions = planes
    .filter((plane) => !planeId || plane.id === planeId)
    .flatMap((plane) =>
      plane.elements
        .filter((el) => el.type === "collection")
        .map((el) => ({
          value: el.id,
          label: el.name || "Collection",
        })),
    )

  // Acquisition blocks discovered by the backend, with counts.
  const batchSummary = (() => {
    const map = new Map<string, { total: number; inSummary: number; devices: Set<string> }>()
    for (const m of importPreview?.measurements ?? []) {
      const b = m.batch || "(no batch)"
      const e = map.get(b) ?? { total: 0, inSummary: 0, devices: new Set<string>() }
      e.total += 1
      if (m.in_summary) e.inSummary += 1
      e.devices.add(m.device || m.filename || m.file)
      map.set(b, e)
    }
    return [...map.entries()].map(([batch, e]) => ({
      batch,
      total: e.total,
      inSummary: e.inSummary,
      devices: e.devices.size,
    }))
  })()

  // Selection: batch (default all selected) + summary coverage.
  const effectiveBatches = selectedBatches.size > 0
    ? selectedBatches
    : new Set(batchSummary.map((b) => b.batch))

  const filteredMeasurements = (importPreview?.measurements ?? []).filter(
    (m) =>
      effectiveBatches.has(m.batch || "(no batch)") &&
      (selectionMode === "all" || m.in_summary),
  )

  // Group the SELECTED measurements by device (one row per explicit Device
  // identifier), with FW and RV scans side by side.
  const deviceRows = (() => {
    const map = new Map<string, ImportMeasurement[]>()
    for (const m of filteredMeasurements) {
      const key = m.device || m.filename || m.file
      const list = map.get(key) ?? []
      list.push(m)
      map.set(key, list)
    }
    return [...map.entries()].map(([device, ms]) => ({
      device,
      fw: ms.find((m) => m.direction !== "RV"),
      rv: ms.find((m) => m.direction === "RV"),
      acquisitions: ms.length,
    }))
  })()

  // Corrected device names that collide (two distinct original files assigned
  // the same name) — they will be grouped into one device group.
  const duplicateDeviceNames = (() => {
    const counts = new Map<string, number>()
    for (const d of deviceRows) {
      const name = (deviceNames[d.device] ?? d.device).trim()
      if (!name) continue
      counts.set(name, (counts.get(name) ?? 0) + 1)
    }
    return [...counts.entries()]
      .filter(([, count]) => count > 1)
      .map(([name]) => name)
  })()

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
                <Text fw={600}>Import measurements</Text>
                <Text size="sm" c="dimmed">
                  Select acquisition batches and which measurements to import.
                </Text>

                {batchSummary.length > 0 && (
                  <Stack gap={4}>
                    <Text size="xs" fw={600} c="dimmed">
                      Acquisition batches
                    </Text>
                    {batchSummary.map((b) => (
                      <Checkbox
                        key={b.batch}
                        size="xs"
                        label={`${b.batch} — ${b.total} measurements, ${b.devices} devices`}
                        checked={effectiveBatches.has(b.batch)}
                        onChange={(e) =>
                          setSelectedBatches((prev) => {
                            const next = new Set(prev)
                            if (e.currentTarget.checked) next.add(b.batch)
                            else next.delete(b.batch)
                            return next
                          })
                        }
                      />
                    ))}
                  </Stack>
                )}

                <SegmentedControl
                  value={selectionMode}
                  onChange={(v) => setSelectionMode(v as "summary" | "all")}
                  data={[
                    { label: "Summary only", value: "summary" },
                    { label: "All measurements", value: "all" },
                  ]}
                  fullWidth
                />

                <SegmentedControl
                  value={importMode}
                  onChange={(v) => setImportMode(v as "new" | "existing")}
                  data={[
                    { label: "New experiment", value: "new" },
                    { label: "Existing experiment", value: "existing" },
                  ]}
                  fullWidth
                />

                {importMode === "new" ? (
                  <>
                    <TextInput
                      label="Experiment name"
                      placeholder="e.g. Imported 2026-07-15"
                      value={newName}
                      onChange={(e) => setNewName(e.currentTarget.value)}
                    />
                    <Select
                      label="Plane (optional)"
                      placeholder="Leave unassigned"
                      data={planes.map((p) => ({ value: p.id, label: p.name }))}
                      value={planeId}
                      onChange={(v) => {
                        setPlaneId(v)
                        // A plane change invalidates an incompatible collection.
                        setCollectionId(null)
                      }}
                      searchable
                      clearable
                    />
                    <Select
                      label="Collection (optional)"
                      placeholder="Not placed on a collection"
                      data={collectionOptions}
                      value={collectionId}
                      onChange={(v) => setCollectionId(v)}
                      searchable
                      clearable
                    />
                    <Select
                      label="Process (optional)"
                      placeholder="No process"
                      data={processes.map((p) => ({ value: p.id, label: p.name }))}
                      value={processId}
                      onChange={(v) => setProcessId(v)}
                      searchable
                      clearable
                    />
                  </>
                ) : (
                  <>
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
                        No experiments yet. Switch to "New experiment" to create
                        one from this import.
                      </Text>
                    )}
                  </>
                )}

                <Group gap="sm">
                  <Button
                    variant="light"
                    onClick={() => runImport(true)}
                    disabled={
                      (importMode === "new"
                        ? !newName.trim()
                        : !experimentId) || importing
                    }
                  >
                    Preview import
                  </Button>
                  <Button
                    onClick={() => runImport(false)}
                    disabled={
                      (importMode === "new"
                        ? !newName.trim()
                        : !experimentId) ||
                      !importPreview ||
                      importing
                    }
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
                    <Stack gap={4}>
                      <Text size="sm">
                        Imported {importPreview?.imported ?? 0} measurement
                        {importPreview?.imported === 1 ? "" : "s"} across{" "}
                        {deviceRows.length} device
                        {deviceRows.length === 1 ? "" : "s"}
                        {importPreview && importPreview.skipped.length > 0
                          ? `, ${importPreview.skipped.length} skipped`
                          : ""}
                        .
                      </Text>
                      <Group gap="xs">
                        <Button
                          size="compact-sm"
                          onClick={() => navigate({ to: "/results" })}
                        >
                          Open Results
                        </Button>
                        {(collectionId || planeId) && (
                          <Button
                            variant="light"
                            size="compact-sm"
                            onClick={() => {
                              if (collectionId) {
                                const plane = planes.find((p) =>
                                  p.elements.some((el) => el.id === collectionId),
                                )
                                if (plane) setActivePlaneId(plane.id)
                                setActiveCollectionId(collectionId)
                              } else if (planeId) {
                                setActivePlaneId(planeId)
                                setActiveCollectionId(null)
                              }
                              navigate({ to: "/organization" })
                            }}
                          >
                            Open in Organization
                          </Button>
                        )}
                      </Group>
                    </Stack>
                  </Alert>
                )}

                {importPreview && importPreview.measurements.length > 0 && (
                  <Stack gap="xs">
                    <Text size="sm" fw={600}>
                      {importPreview.dry_run ? "Preview" : "Imported"} —{" "}
                      {deviceRows.length} device
                      {deviceRows.length === 1 ? "" : "s"} (
                      {importPreview.measurements.length} measurement
                      {importPreview.measurements.length === 1 ? "" : "s"})
                    </Text>
                    <Text size="xs" c="dimmed">
                      The device name can be corrected before import. Original
                      filenames are always preserved as provenance.
                    </Text>
                    {duplicateDeviceNames.length > 0 && (
                      <Alert
                        color="yellow"
                        title="Duplicate device names"
                        icon={<IconAlertTriangle size={16} />}
                      >
                        Multiple devices share the same corrected name ({" "}
                        {duplicateDeviceNames.join(", ")} ). They will be grouped
                        into a single device group.
                      </Alert>
                    )}
                    <ScrollArea.Autosize mah={300} type="auto">
                      <Table striped verticalSpacing={5}>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th style={{ minWidth: 220 }}>Device</Table.Th>
                            <Table.Th style={{ minWidth: 160 }}>
                              Substrate
                            </Table.Th>
                            <Table.Th>FW Voc</Table.Th>
                            <Table.Th>FW Jsc</Table.Th>
                            <Table.Th>FW FF</Table.Th>
                            <Table.Th>FW PCE</Table.Th>
                            <Table.Th>RV Voc</Table.Th>
                            <Table.Th>RV Jsc</Table.Th>
                            <Table.Th>RV FF</Table.Th>
                            <Table.Th>RV PCE</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {deviceRows.map((d) => (
                            <Table.Tr key={d.device}>
                              <Table.Td>
                                <TextInput
                                  size="xs"
                                  value={deviceNames[d.device] ?? d.device}
                                  onChange={(e) =>
                                    setDeviceNames((prev) => ({
                                      ...prev,
                                      [d.device]: e.currentTarget.value,
                                    }))
                                  }
                                />
                              </Table.Td>
                              <Table.Td>
                                {importMode === "new" ? (
                                  <TextInput
                                    size="xs"
                                    placeholder="Unassigned"
                                    value={substrateAssignments[d.device] ?? ""}
                                    onChange={(e) =>
                                      setSubstrateAssignments((prev) => ({
                                        ...prev,
                                        [d.device]: e.currentTarget.value,
                                      }))
                                    }
                                  />
                                ) : (
                                  <Select
                                    size="xs"
                                    placeholder="Unassigned"
                                    data={existingSubstrateOptions}
                                    value={substrateAssignments[d.device] ?? null}
                                    onChange={(v) =>
                                      setSubstrateAssignments((prev) => ({
                                        ...prev,
                                        [d.device]: v ?? "",
                                      }))
                                    }
                                    clearable
                                  />
                                )}
                              </Table.Td>
                              <Table.Td>{formatMetric(d.fw?.voc)}</Table.Td>
                              <Table.Td>{formatMetric(d.fw?.jsc)}</Table.Td>
                              <Table.Td>{formatMetric(d.fw?.ff)}</Table.Td>
                              <Table.Td>{formatMetric(d.fw?.eff)}</Table.Td>
                              <Table.Td>{formatMetric(d.rv?.voc)}</Table.Td>
                              <Table.Td>{formatMetric(d.rv?.jsc)}</Table.Td>
                              <Table.Td>{formatMetric(d.rv?.ff)}</Table.Td>
                              <Table.Td>{formatMetric(d.rv?.eff)}</Table.Td>
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
