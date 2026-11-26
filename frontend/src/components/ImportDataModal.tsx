import {
  Accordion,
  Alert,
  Badge,
  Button,
  Code,
  Divider,
  Group,
  List,
  Modal,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core"
import { Dropzone, MIME_TYPES } from "@mantine/dropzone"
import { modals } from "@mantine/modals"
import { notifications } from "@mantine/notifications"
import {
  IconCheck,
  IconFile,
  IconFolder,
  IconInfoCircle,
  IconUpload,
} from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import { useRef, useState } from "react"
import {
  importMeasurementSources,
  type ParseResult,
  parseMeasurementFilesPreview,
  serverMeasurementToFile,
} from "@/lib/parseMeasurements"
import {
  type DeviceGroup,
  type ExperimentResults,
  type MeasurementFile,
  newExperimentResults,
  newImportedExperiment,
  useAppContext,
} from "@/store/AppContext"
import { reconcileGroupIds } from "@/store/resultLifecycle"
import { syncResultRefsForExperiment } from "@/store/resultRefs"
import { SectionLabel } from "./SectionLabel"

type FileWithPath = File & { webkitRelativePath?: string }

function relativePaths(files: File[]): string[] {
  return files.map((f) => (f as FileWithPath).webkitRelativePath || f.name)
}

/** Group imported files into unassigned candidate device groups (never a
 *  confirmed substrate/device identity). */
function buildCandidateGroups(files: MeasurementFile[]): DeviceGroup[] {
  const map = new Map<string, DeviceGroup>()
  for (const f of files) {
    const key = f.substrateGroup || f.deviceName || f.fileName
    let g = map.get(key)
    if (!g) {
      g = {
        id: crypto.randomUUID(),
        deviceName: key,
        files: [],
        assignedSubstrateId: null,
      }
      map.set(key, g)
    }
    g.files.push(f)
  }
  return Array.from(map.values())
}

export function ImportDataModal({
  opened,
  onClose,
}: {
  opened: boolean
  onClose: () => void
}) {
  const navigate = useNavigate()
  const {
    experiments,
    results,
    planes,
    setResults,
    setExperiments,
    updateElement,
    setEntityPlaneId,
    flushSave,
    setActiveEntity,
    updateLastSelected,
  } = useAppContext()
  const [files, setFiles] = useState<File[]>([])
  const [paths, setPaths] = useState<string[]>([])
  const [parseResult, setParseResult] = useState<ParseResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [destinationMode, setDestinationMode] = useState<"existing" | "new">(
    "existing",
  )
  const [destinationId, setDestinationId] = useState<string | null>(null)
  const [newExperimentName, setNewExperimentName] = useState("")
  const [importing, setImporting] = useState(false)
  const previewRequestIdRef = useRef(0)
  const importIdRef = useRef<string | null>(null)
  const createdExperimentIdRef = useRef<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const dirInputRef = useRef<HTMLInputElement>(null)

  const runPreview = async (nextFiles: File[]) => {
    if (nextFiles.length === 0) return
    const requestId = ++previewRequestIdRef.current
    setFiles(nextFiles)
    setPaths(relativePaths(nextFiles))
    setParseResult(null)
    setError(null)
    setDestinationId(null)
    importIdRef.current = null
    createdExperimentIdRef.current = null
    setLoading(true)
    try {
      const result = await parseMeasurementFilesPreview(
        nextFiles,
        relativePaths(nextFiles),
      )
      if (requestId !== previewRequestIdRef.current) return
      setParseResult(result)
    } catch (err) {
      if (requestId !== previewRequestIdRef.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (requestId === previewRequestIdRef.current) setLoading(false)
    }
  }

  const measurements = parseResult?.measurements ?? []
  const fwCount = measurements.filter((m) => m.direction === "FW").length
  const rvCount = measurements.filter((m) => m.direction === "RV").length
  const inSummary = measurements.filter((m) => m.in_summary === true).length
  const additional = measurements.filter((m) => m.in_summary === false).length
  const unknownCoverage = measurements.filter(
    (m) => m.in_summary == null,
  ).length
  const candidateGroups = Array.from(
    new Set(measurements.map((m) => m.substrate_group).filter(Boolean)),
  )
  const hasMeasurements = measurements.length > 0
  const inventory = parseResult?.inventory ?? []
  const otherFiles = parseResult?.other_files ?? []
  const skipped = parseResult?.skipped ?? []

  const duplicatesFor = (targetId: string | null): number => {
    if (!parseResult || targetId == null) return 0
    const existing = results.find((r) => r.experimentId === targetId)
    if (!existing) return 0
    const seen = new Set(
      existing.files
        .map((f) => `${f.sourcePath ?? ""}|${f.direction ?? ""}`)
        .filter((k) => k !== "|"),
    )
    return measurements.filter(
      (m) => seen.has(`${m.source}|${m.direction ?? ""}`) && m.source,
    ).length
  }

  const performImport = async (targetId: string | null) => {
    if (!parseResult || measurements.length === 0 || files.length === 0) return
    if (targetId != null && !experiments.some((e) => e.id === targetId)) {
      notifications.show({
        title: "Destination missing",
        message: "The selected experiment no longer exists.",
        color: "red",
      })
      return
    }

    const dupes = duplicatesFor(targetId)
    if (dupes > 0) {
      const proceed = await new Promise<boolean>((resolve) => {
        modals.openConfirmModal({
          title: "Possible duplicate import",
          children: (
            <Text size="sm">
              {dupes} record{dupes === 1 ? "" : "s"} appear to share the same
              source and scan direction as measurements already in this
              experiment. Append them anyway?
            </Text>
          ),
          labels: { confirm: "Append anyway", cancel: "Cancel" },
          confirmProps: { color: "orange" },
          onConfirm: () => resolve(true),
          onCancel: () => resolve(false),
          onClose: () => resolve(false),
        })
      })
      if (!proceed) return
    }

    setImporting(true)
    try {
      let destination: string
      if (targetId == null) {
        // Create (or reuse on retry) the process-free destination and persist
        // it BEFORE importing sources, so the backend can bind sources to a
        // row that already exists in PostgreSQL.
        destination = createdExperimentIdRef.current ?? crypto.randomUUID()
        createdExperimentIdRef.current = destination
        if (!experiments.some((e) => e.id === destination)) {
          const exp = newImportedExperiment(
            newExperimentName.trim() || "Imported Experiment",
          )
          setExperiments((prev) => [...prev, { ...exp, id: destination }])
          await new Promise((resolve) => setTimeout(resolve, 0))
          const expSaved = await flushSave()
          if (!expSaved) {
            notifications.show({
              title: "Could not create experiment",
              message: "The destination experiment could not be saved.",
              color: "red",
            })
            return
          }
        }
      } else {
        destination = targetId
      }

      const importId = importIdRef.current ?? crypto.randomUUID()
      importIdRef.current = importId

      // Persist original sources server-side and get measurements linked to
      // their stored source evidence (idempotent per importId).
      const imported = await importMeasurementSources(
        destination,
        importId,
        files,
        paths,
      )

      const existing = results.find((r) => r.experimentId === destination)
      const hadUpload = !!existing?.nomad?.upload_id
      const existingObservations = new Set(
        (existing?.files ?? [])
          .map((f) => `${f.sourceFileId ?? ""}|${f.sourceRecordLocator ?? ""}`)
          .filter((k) => k !== "|"),
      )

      // Retry only missing observations: a source file may contain several
      // records, distinguished by their record locator (direction + row).
      const newFiles = imported.measurements
        .map((m) => ({ ...serverMeasurementToFile(m), localOnly: true }))
        .filter(
          (f) =>
            !f.sourceFileId ||
            !existingObservations.has(
              `${f.sourceFileId}|${f.sourceRecordLocator ?? ""}`,
            ),
        )
      const newGroups = buildCandidateGroups(newFiles)

      const updated: ExperimentResults = existing
        ? {
            ...existing,
            files: [...existing.files, ...newFiles],
            deviceGroups: [...existing.deviceGroups, ...newGroups],
            groupingStrategy: "import",
          }
        : {
            ...newExperimentResults(destination),
            files: newFiles,
            deviceGroups: newGroups,
            groupingStrategy: "import",
          }
      const reconciled = reconcileGroupIds(updated)

      if (newFiles.length > 0) {
        setResults((prev) => {
          const idx = prev.findIndex((r) => r.experimentId === destination)
          if (idx >= 0) {
            return prev.map((r, i) => (i === idx ? reconciled : r))
          }
          return [...prev, reconciled]
        })
        setExperiments((prev) =>
          prev.map((e) =>
            e.id === destination ? { ...e, hasResults: true } : e,
          ),
        )
        // Keep Collection result-refs consistent with the persisted result
        // (same shared helper the Results page uses).
        syncResultRefsForExperiment(
          destination,
          [reconciled.id],
          reconciled.id,
          planes,
          updateElement,
          setEntityPlaneId,
        )
        // Let React commit the state update before flushing.
        await new Promise((resolve) => setTimeout(resolve, 0))
      }

      const saved = await flushSave()

      if (!saved) {
        notifications.show({
          title: "Import not saved",
          message:
            "Measurements are kept locally and will be retried automatically. Click Import again to retry.",
          color: "red",
        })
        return
      }

      notifications.show({
        title: "Import complete",
        message: `${imported.measurements.length} measurement record${
          imported.measurements.length === 1 ? "" : "s"
        } imported (${imported.source_files.length} source file${
          imported.source_files.length === 1 ? "" : "s"
        } stored).`,
        color: "green",
      })
      if (hadUpload) {
        notifications.show({
          title: "Local-only measurements",
          message:
            "This experiment already has a NOMAD upload. The new measurements are local-only and were not uploaded.",
          color: "yellow",
        })
      }
      setFiles([])
      setPaths([])
      setParseResult(null)
      setDestinationId(null)
      importIdRef.current = null
      createdExperimentIdRef.current = null
      onClose()
      setActiveEntity({ kind: "experiment", id: destination })
      updateLastSelected("experiment", destination)
      void navigate({ to: "/results" })
    } catch (err) {
      notifications.show({
        title: "Import failed",
        message: err instanceof Error ? err.message : String(err),
        color: "red",
      })
    } finally {
      setImporting(false)
    }
  }

  return (
    <Modal
      opened={opened}
      onClose={onClose}
      title="Import Data"
      size="lg"
      styles={{ content: { overflow: "hidden" } }}
    >
      <Stack gap="md">
        <Dropzone
          onDrop={runPreview}
          loading={loading || importing}
          accept={[
            "application/zip",
            "application/x-zip-compressed",
            MIME_TYPES.csv,
            "text/plain",
            "text/tab-separated-values",
          ]}
          maxSize={128 * 1024 ** 2}
          style={{
            borderStyle: "dashed",
            borderWidth: 2,
            borderColor: "var(--mantine-color-gray-4)",
          }}
        >
          <Group justify="center" gap="xl" style={{ pointerEvents: "none" }}>
            <div>
              <Text size="xl" inline>
                <IconUpload size={18} style={{ verticalAlign: -3 }} />
              </Text>
              <Text size="sm" inline mt={8}>
                Drop a ZIP archive or CHOSE measurement files here
              </Text>
            </div>
          </Group>
        </Dropzone>

        <Group gap="xs">
          <Button
            size="xs"
            variant="default"
            leftSection={<IconFile size={14} />}
            onClick={() => fileInputRef.current?.click()}
            disabled={importing}
          >
            Choose files
          </Button>
          <Button
            size="xs"
            variant="default"
            leftSection={<IconFolder size={14} />}
            onClick={() => dirInputRef.current?.click()}
            disabled={importing}
          >
            Choose folder
          </Button>
          <Text size="xs" c="dimmed" style={{ flex: 1 }} ta="right">
            {files.length > 0
              ? `${files.length} source${files.length === 1 ? "" : "s"}`
              : ""}
          </Text>
        </Group>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const list = Array.from(e.currentTarget.files ?? [])
            e.currentTarget.value = ""
            void runPreview(list)
          }}
        />
        <input
          ref={dirInputRef}
          type="file"
          multiple
          hidden
          // @ts-expect-error webkitdirectory is not in the TS DOM typings
          webkitdirectory=""
          onChange={(e) => {
            const list = Array.from(e.currentTarget.files ?? [])
            e.currentTarget.value = ""
            void runPreview(list)
          }}
        />

        {error && (
          <Alert
            icon={<IconInfoCircle size={16} />}
            color="red"
            title="Could not inspect files"
          >
            {error}
          </Alert>
        )}

        {parseResult && !error && (
          <>
            <Divider />
            <SectionLabel>Preview</SectionLabel>

            {!hasMeasurements ? (
              <Alert
                icon={<IconInfoCircle size={16} />}
                color="yellow"
                title="No importable measurements found"
              >
                No supported measurement records were recognised in the selected
                sources.
              </Alert>
            ) : (
              <Group gap="sm" wrap="wrap">
                <Badge variant="light">
                  {parseResult.original_file_count} original file
                  {parseResult.original_file_count === 1 ? "" : "s"}
                </Badge>
                <Badge variant="light" color="grape">
                  {parseResult.recognized_file_count} recognized
                </Badge>
                <Badge variant="light" color="blue">
                  {measurements.length} measurement record
                  {measurements.length === 1 ? "" : "s"}
                </Badge>
                <Badge variant="light" color="cyan">
                  {fwCount} FW
                </Badge>
                <Badge variant="light" color="grape">
                  {rvCount} RV
                </Badge>
                <Badge variant="light" color="teal">
                  {inSummary} in summary
                </Badge>
                {additional > 0 && (
                  <Badge variant="light" color="orange">
                    {additional} additional
                  </Badge>
                )}
                {unknownCoverage > 0 && (
                  <Badge variant="light" color="gray">
                    {unknownCoverage} unknown coverage
                  </Badge>
                )}
                <Badge variant="light" color="indigo">
                  {candidateGroups.length} candidate device group
                  {candidateGroups.length === 1 ? "" : "s"}
                </Badge>
              </Group>
            )}

            <Accordion variant="separated" multiple defaultValue={[]}>
              {candidateGroups.length > 0 && (
                <Accordion.Item value="groups">
                  <Accordion.Control>
                    Candidate device groups ({candidateGroups.length})
                  </Accordion.Control>
                  <Accordion.Panel>
                    <Text size="xs" c="dimmed" mb={4}>
                      Candidate identities are unconfirmed; no physical device
                      is asserted.
                    </Text>
                    <Group gap="xs" wrap="wrap">
                      {candidateGroups.map((g) => (
                        <Badge key={g} size="xs" variant="outline">
                          {g}
                        </Badge>
                      ))}
                    </Group>
                  </Accordion.Panel>
                </Accordion.Item>
              )}

              <Accordion.Item value="inventory">
                <Accordion.Control>
                  File inventory ({inventory.length})
                </Accordion.Control>
                <Accordion.Panel>
                  <ScrollArea.Autosize mah={180}>
                    <List size="xs" c="dimmed">
                      {inventory.map((e) => (
                        <List.Item key={e.name}>
                          <Code>{e.name}</Code>{" "}
                          {e.recognized ? (
                            <Badge size="xs" variant="light" color="green">
                              recognized
                            </Badge>
                          ) : (
                            <Badge size="xs" variant="light" color="gray">
                              {e.type}
                            </Badge>
                          )}
                        </List.Item>
                      ))}
                    </List>
                  </ScrollArea.Autosize>
                </Accordion.Panel>
              </Accordion.Item>

              <Accordion.Item value="measurements">
                <Accordion.Control>
                  Parsed measurements ({measurements.length})
                </Accordion.Control>
                <Accordion.Panel>
                  <ScrollArea.Autosize mah={200}>
                    <List size="xs" c="dimmed">
                      {measurements.slice(0, 200).map((m, i) => (
                        <List.Item key={`${m.source}-${m.direction}-${i}`}>
                          <Code>{m.device || m.filename}</Code> ·{" "}
                          {m.direction ?? "?"} · eff{" "}
                          {m.eff != null ? `${m.eff}%` : "—"} · {m.source}
                        </List.Item>
                      ))}
                    </List>
                  </ScrollArea.Autosize>
                </Accordion.Panel>
              </Accordion.Item>

              {(otherFiles.length > 0 || skipped.length > 0) && (
                <Accordion.Item value="unsupported">
                  <Accordion.Control>
                    Unsupported / skipped ({otherFiles.length + skipped.length})
                  </Accordion.Control>
                  <Accordion.Panel>
                    <ScrollArea.Autosize mah={160}>
                      <List size="xs" c="dimmed">
                        {otherFiles.map((o) => (
                          <List.Item key={o.filename}>
                            <Code>{o.filename}</Code> — recognized but not
                            importable by this workflow
                          </List.Item>
                        ))}
                        {skipped.map((s) => (
                          <List.Item key={s.file}>
                            <Code>{s.file}</Code> — {s.reason}
                          </List.Item>
                        ))}
                      </List>
                    </ScrollArea.Autosize>
                  </Accordion.Panel>
                </Accordion.Item>
              )}
            </Accordion>

            {(parseResult.warnings?.length ?? 0) > 0 && (
              <Alert
                icon={<IconInfoCircle size={16} />}
                color="yellow"
                title="Warnings"
              >
                <List size="xs">
                  {parseResult.warnings.map((w) => (
                    <List.Item key={w}>{w}</List.Item>
                  ))}
                </List>
              </Alert>
            )}

            {hasMeasurements && (
              <>
                <Divider />
                <SectionLabel>Import destination</SectionLabel>
                <SegmentedControl
                  value={destinationMode}
                  onChange={(v) => setDestinationMode(v as "existing" | "new")}
                  data={[
                    { label: "Existing experiment", value: "existing" },
                    { label: "New experiment", value: "new" },
                  ]}
                  disabled={importing}
                />

                {destinationMode === "existing" ? (
                  experiments.length === 0 ? (
                    <Alert
                      icon={<IconInfoCircle size={16} />}
                      color="yellow"
                      title="No experiments yet"
                    >
                      Switch to “New experiment” to create one from this data.
                    </Alert>
                  ) : (
                    <Select
                      label="Import into experiment"
                      placeholder="Choose an experiment…"
                      searchable
                      data={experiments.map((e) => ({
                        value: e.id,
                        label: e.name || "Untitled",
                      }))}
                      value={destinationId}
                      onChange={setDestinationId}
                      disabled={importing}
                    />
                  )
                ) : (
                  <>
                    <TextInput
                      label="Experiment name"
                      placeholder="Imported Experiment"
                      value={newExperimentName}
                      onChange={(e) =>
                        setNewExperimentName(e.currentTarget.value)
                      }
                      disabled={importing}
                    />
                    <Text size="xs" c="dimmed">
                      The new experiment has no fabrication recipe. Original
                      files are stored durably and linked to each measurement.
                    </Text>
                  </>
                )}

                <Group justify="flex-end" gap="sm">
                  <Button
                    variant="outline"
                    onClick={onClose}
                    disabled={importing}
                  >
                    Cancel
                  </Button>
                  <Button
                    leftSection={<IconCheck size={16} />}
                    onClick={() =>
                      void performImport(
                        destinationMode === "existing" ? destinationId : null,
                      )
                    }
                    loading={importing}
                    disabled={
                      importing ||
                      (destinationMode === "existing" && !destinationId)
                    }
                  >
                    {destinationMode === "existing"
                      ? "Import measurements"
                      : "Create & import"}
                  </Button>
                </Group>
              </>
            )}
          </>
        )}
      </Stack>
    </Modal>
  )
}
