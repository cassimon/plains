import {
  Accordion,
  Alert,
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core"
import { notifications } from "@mantine/notifications"
import {
  IconBan,
  IconHistory,
  IconInfoCircle,
  IconRotateClockwise,
  IconScaleOutline,
} from "@tabler/icons-react"
import { useEffect, useMemo, useState } from "react"
import {
  applyCorrection,
  type CorrectionHistory,
  listCorrections,
} from "@/lib/corrections"
import { type QualityFinding, qualityFindings } from "@/lib/quality"
import {
  type ExperimentResults,
  type MeasurementFile,
  useAppContext,
} from "@/store/AppContext"
import { SectionLabel } from "./SectionLabel"

const SCALEABLE = ["value", "voc", "jsc", "ff"] as const
const SCALE_LABELS: Record<(typeof SCALEABLE)[number], string> = {
  value: "PCE (%)",
  voc: "Voc (V)",
  jsc: "Jsc (mA/cm²)",
  ff: "FF (%)",
}

// API field name (snake_case, matches the backend column) → frontend field.
const EDIT_FIELDS: {
  value: string
  label: string
  frontend: keyof MeasurementFile
}[] = [
  { value: "device_name", label: "Device name", frontend: "deviceName" },
  { value: "cell", label: "Cell", frontend: "cell" },
  { value: "pixel_label", label: "Pixel", frontend: "pixel" },
  {
    value: "measurement_date",
    label: "Measurement date",
    frontend: "measurementDate",
  },
  { value: "measurement_user", label: "Measurement user", frontend: "user" },
]

function severityColor(s: QualityFinding["severity"]): string {
  return s === "invalid" ? "red" : s === "warning" ? "orange" : "gray"
}

export function ScientificReviewPanel({
  result,
}: {
  result: ExperimentResults
}) {
  const { setResults } = useAppContext()
  const [excludeTarget, setExcludeTarget] = useState<MeasurementFile | null>(
    null,
  )
  const [excludeReason, setExcludeReason] = useState("")
  const [scaleTarget, setScaleTarget] = useState<MeasurementFile | null>(null)
  const [scaleField, setScaleField] =
    useState<(typeof SCALEABLE)[number]>("value")
  const [scaleFactor, setScaleFactor] = useState<number | string>(1)
  const [scaleReason, setScaleReason] = useState("")
  const [editTarget, setEditTarget] = useState<MeasurementFile | null>(null)
  const [editField, setEditField] = useState<string>("device_name")
  const [editValue, setEditValue] = useState("")
  const [editReason, setEditReason] = useState("")
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<CorrectionHistory[] | null>(null)
  const [requestId, setRequestId] = useState<string | null>(null)
  const [reviewSearch, setReviewSearch] = useState("")
  const [reviewFilter, setReviewFilter] = useState<
    "all" | "findings" | "excluded"
  >("all")

  const findingsByFile = useMemo(
    () =>
      result.files.map((file) => ({ file, findings: qualityFindings(file) })),
    [result.files],
  )
  const summary = useMemo(() => {
    let invalid = 0
    let warning = 0
    let missing = 0
    for (const { findings } of findingsByFile) {
      for (const f of findings) {
        if (f.severity === "invalid") invalid += 1
        else if (f.severity === "warning") warning += 1
        else missing += 1
      }
    }
    return {
      invalid,
      warning,
      missing,
      excluded: result.files.filter((f) => f.excluded).length,
    }
  }, [findingsByFile, result.files])

  const applyLocal = (updatedFile: MeasurementFile) => {
    setResults((prev) =>
      prev.map((r) =>
        r.id === result.id
          ? {
              ...r,
              files: r.files.map((f) =>
                f.id === updatedFile.id ? updatedFile : f,
              ),
              // The same measurement also lives in the grouped copy; keep it in
              // sync so every consumer sees the authoritative corrected value.
              deviceGroups: r.deviceGroups.map((g) => ({
                ...g,
                files: g.files.map((f) =>
                  f.id === updatedFile.id ? updatedFile : f,
                ),
              })),
            }
          : r,
      ),
    )
  }

  const refreshHistory = () => {
    void listCorrections(result.id)
      .then(setHistory)
      .catch(() => setHistory([]))
  }

  const requireReason = (reason: string): boolean => {
    if (reason.trim()) return true
    notifications.show({
      title: "Reason required",
      message: "Provide an explicit scientific reason for this correction.",
      color: "red",
    })
    return false
  }

  const toggleExclude = async () => {
    if (!excludeTarget || !requireReason(excludeReason)) return
    setBusy(true)
    try {
      const op = excludeTarget.excluded ? "restore" : "exclude"
      const correction = await applyCorrection(result.id, {
        measurement_id: excludeTarget.id,
        operation: op,
        reason: excludeReason.trim(),
        request_id: requestId ?? undefined,
      })
      // Use the server-confirmed exclusion state, not a local toggle.
      applyLocal({
        ...excludeTarget,
        excluded: correction.new_value === "true",
      })
      refreshHistory()
      notifications.show({
        title:
          op === "exclude" ? "Measurement excluded" : "Measurement restored",
        message: "Correction recorded.",
        color: "green",
      })
      setExcludeTarget(null)
      setExcludeReason("")
      setRequestId(null)
    } catch (err) {
      notifications.show({
        title: "Correction failed",
        message: err instanceof Error ? err.message : String(err),
        color: "red",
      })
    } finally {
      setBusy(false)
    }
  }

  const applyEdit = async () => {
    if (!editTarget || !editValue.trim() || !requireReason(editReason)) return
    const field = EDIT_FIELDS.find((f) => f.value === editField)
    if (!field) return
    setBusy(true)
    try {
      const correction = await applyCorrection(result.id, {
        measurement_id: editTarget.id,
        operation: "edit",
        field: editField,
        value: editValue.trim(),
        reason: editReason.trim(),
        request_id: requestId ?? undefined,
      })
      // Use the server-confirmed value for the edited field.
      applyLocal({
        ...editTarget,
        [field.frontend]: correction.new_value ?? "",
      })
      refreshHistory()
      notifications.show({
        title: "Metadata updated",
        message: "Correction recorded.",
        color: "green",
      })
      setEditTarget(null)
      setEditReason("")
      setEditValue("")
      setRequestId(null)
    } catch (err) {
      notifications.show({
        title: "Correction failed",
        message: err instanceof Error ? err.message : String(err),
        color: "red",
      })
    } finally {
      setBusy(false)
    }
  }

  const applyScale = async () => {
    if (!scaleTarget || !requireReason(scaleReason)) return
    const factor = Number(scaleFactor)
    if (!Number.isFinite(factor) || factor === 0) {
      notifications.show({ title: "Invalid factor", message: "", color: "red" })
      return
    }
    const old = scaleTarget[scaleField]
    if (old == null) {
      notifications.show({
        title: "Nothing to scale",
        message: "",
        color: "red",
      })
      return
    }
    setBusy(true)
    try {
      const correction = await applyCorrection(result.id, {
        measurement_id: scaleTarget.id,
        operation: "scale",
        field: scaleField,
        factor,
        reason: scaleReason.trim(),
        request_id: requestId ?? undefined,
      })
      // Use the server-confirmed effective value rather than a local recompute.
      applyLocal({
        ...scaleTarget,
        [scaleField]: Number(correction.new_value),
      })
      refreshHistory()
      notifications.show({
        title: "Scaling applied",
        message: "Correction recorded.",
        color: "green",
      })
      setScaleTarget(null)
      setScaleReason("")
      setScaleFactor(1)
      setRequestId(null)
    } catch (err) {
      notifications.show({
        title: "Correction failed",
        message: err instanceof Error ? err.message : String(err),
        color: "red",
      })
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    void listCorrections(result.id)
      .then((h) => {
        if (!cancelled) setHistory(h)
      })
      .catch(() => {
        if (!cancelled) setHistory([])
      })
    return () => {
      cancelled = true
    }
  }, [result.id])

  // Every measurement is reviewable — including normal records without any
  // automatic finding (correction/exclusion must be available for all).
  const reviewableFiles = useMemo(() => {
    const q = reviewSearch.trim().toLowerCase()
    const filtered = findingsByFile.filter(({ file, findings }) => {
      if (
        reviewFilter === "findings" &&
        findings.length === 0 &&
        !file.excluded
      )
        return false
      if (reviewFilter === "excluded" && !file.excluded) return false
      if (!q) return true
      return (
        (file.deviceName || "").toLowerCase().includes(q) ||
        (file.fileName || "").toLowerCase().includes(q)
      )
    })
    // Prioritise records with findings/exclusions over clean records.
    return filtered.sort((a, b) => {
      const aScore = (a.findings.length > 0 ? 2 : 0) + (a.file.excluded ? 1 : 0)
      const bScore = (b.findings.length > 0 ? 2 : 0) + (b.file.excluded ? 1 : 0)
      return bScore - aScore
    })
  }, [findingsByFile, reviewSearch, reviewFilter])

  return (
    <Stack gap="sm">
      <SectionLabel>Scientific review</SectionLabel>
      <Alert
        variant="light"
        color="gray"
        icon={<IconInfoCircle size={16} />}
        p="xs"
      >
        <Text size="xs">
          Findings are advisory and never auto-exclude a measurement.
          Corrections (scale, exclude/restore, metadata) are recorded with their
          before and after values and an explicit reason.
        </Text>
      </Alert>
      <Group gap="xs" wrap="wrap">
        <Badge variant="light">{findingsByFile.length} records</Badge>
        {summary.invalid > 0 && (
          <Badge variant="light" color="red">
            {summary.invalid} invalid
          </Badge>
        )}
        {summary.warning > 0 && (
          <Badge variant="light" color="orange">
            {summary.warning} warning
          </Badge>
        )}
        {summary.missing > 0 && (
          <Badge variant="light" color="gray">
            {summary.missing} missing
          </Badge>
        )}
        {summary.excluded > 0 && (
          <Badge variant="light" color="dark">
            {summary.excluded} excluded
          </Badge>
        )}
      </Group>

      <Group gap="xs" wrap="nowrap">
        <TextInput
          size="xs"
          placeholder="Search device or file…"
          value={reviewSearch}
          onChange={(e) => setReviewSearch(e.currentTarget.value)}
          style={{ flex: 1 }}
        />
        <SegmentedControl
          size="xs"
          value={reviewFilter}
          onChange={(v) =>
            setReviewFilter(v as "all" | "findings" | "excluded")
          }
          data={[
            { label: "All", value: "all" },
            { label: "Findings", value: "findings" },
            { label: "Excluded", value: "excluded" },
          ]}
        />
      </Group>

      {reviewableFiles.length === 0 ? (
        <Text size="xs" c="dimmed">
          No measurements to review.
        </Text>
      ) : (
        <ScrollArea.Autosize mah={420}>
          <Accordion variant="separated" multiple>
            {reviewableFiles.map(({ file, findings }) => (
              <Accordion.Item key={file.id} value={file.id}>
                <Accordion.Control>
                  <Group gap="xs" wrap="nowrap">
                    <Text size="xs" truncate style={{ flex: 1 }}>
                      {file.deviceName || file.fileName}
                      {file.direction ? ` (${file.direction})` : ""}
                    </Text>
                    {file.excluded && (
                      <Badge size="xs" color="dark" variant="filled">
                        excluded
                      </Badge>
                    )}
                    {findings.map((f, i) => (
                      <Badge
                        key={i}
                        size="xs"
                        color={severityColor(f.severity)}
                        variant="light"
                      >
                        {f.metric}
                      </Badge>
                    ))}
                  </Group>
                </Accordion.Control>
                <Accordion.Panel>
                  <Stack gap="xs">
                    {findings.map((f, i) => (
                      <Group key={i} gap="xs" wrap="nowrap">
                        <Badge
                          size="xs"
                          color={severityColor(f.severity)}
                          variant="light"
                        >
                          {f.severity}
                        </Badge>
                        <Text size="xs" c="dimmed" style={{ flex: 1 }}>
                          {f.message}
                        </Text>
                      </Group>
                    ))}
                    <Group gap="xs">
                      <Button
                        size="xs"
                        variant={file.excluded ? "light" : "outline"}
                        color={file.excluded ? "gray" : "red"}
                        leftSection={
                          file.excluded ? (
                            <IconRotateClockwise size={14} />
                          ) : (
                            <IconBan size={14} />
                          )
                        }
                        onClick={() => {
                          setExcludeTarget(file)
                          setExcludeReason("")
                          setRequestId(crypto.randomUUID())
                        }}
                      >
                        {file.excluded ? "Restore" : "Exclude"}
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        leftSection={<IconScaleOutline size={14} />}
                        onClick={() => {
                          setScaleTarget(file)
                          setScaleField("value")
                          setScaleFactor(1)
                          setScaleReason("")
                          setRequestId(crypto.randomUUID())
                        }}
                      >
                        Scale
                      </Button>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => {
                          setEditTarget(file)
                          setEditField("device_name")
                          setEditValue(file.deviceName ?? "")
                          setEditReason("")
                          setRequestId(crypto.randomUUID())
                        }}
                      >
                        Edit metadata
                      </Button>
                    </Group>
                  </Stack>
                </Accordion.Panel>
              </Accordion.Item>
            ))}
          </Accordion>
        </ScrollArea.Autosize>
      )}

      <Accordion variant="separated">
        <Accordion.Item value="history">
          <Accordion.Control>
            <Group gap="xs" wrap="nowrap">
              <IconHistory size={14} />
              <Text size="sm">Correction history</Text>
            </Group>
          </Accordion.Control>
          <Accordion.Panel>
            {history === null ? (
              <Text size="xs" c="dimmed">
                Loading history…
              </Text>
            ) : history.length === 0 ? (
              <Text size="xs" c="dimmed">
                No corrections recorded.
              </Text>
            ) : (
              <Stack gap="xs">
                {history.map((c) => (
                  <Group key={c.id} gap="xs" wrap="nowrap">
                    <Badge size="xs" variant="light">
                      {c.operation}
                    </Badge>
                    <Text size="xs" c="dimmed" style={{ flex: 1 }}>
                      {c.field || "exclusion"} {c.previous_value} →{" "}
                      {c.new_value}
                      {" — "}
                      {c.reason}
                    </Text>
                    <Text size="xs" c="dimmed">
                      {c.actor_email}
                    </Text>
                  </Group>
                ))}
              </Stack>
            )}
          </Accordion.Panel>
        </Accordion.Item>
      </Accordion>

      {/* Exclude / restore reason modal */}
      <Modal
        opened={excludeTarget !== null}
        onClose={() => setExcludeTarget(null)}
        title={
          excludeTarget?.excluded
            ? "Restore measurement"
            : "Exclude measurement"
        }
        size="sm"
      >
        <Stack gap="md">
          <Text size="sm" c="dimmed">
            {excludeTarget?.deviceName || excludeTarget?.fileName}
          </Text>
          <TextInput
            label="Reason"
            placeholder="Why is this measurement being excluded?"
            value={excludeReason}
            onChange={(e) => setExcludeReason(e.currentTarget.value)}
          />
          <Group justify="flex-end" gap="sm">
            <Button variant="outline" onClick={() => setExcludeTarget(null)}>
              Cancel
            </Button>
            <Button
              color={excludeTarget?.excluded ? "gray" : "red"}
              loading={busy}
              onClick={() => void toggleExclude()}
            >
              {excludeTarget?.excluded ? "Restore" : "Exclude"}
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Scale modal with before/after preview */}
      <Modal
        opened={scaleTarget !== null}
        onClose={() => setScaleTarget(null)}
        title="Scale measurement"
        size="sm"
      >
        <Stack gap="md">
          <Select
            label="Quantity"
            data={SCALEABLE.map((k) => ({ value: k, label: SCALE_LABELS[k] }))}
            value={scaleField}
            onChange={(v) => setScaleField(v as (typeof SCALEABLE)[number])}
          />
          <NumberInput
            label="Factor"
            value={scaleFactor}
            onChange={setScaleFactor}
            decimalScale={6}
          />
          {scaleTarget && Number.isFinite(Number(scaleFactor)) && (
            <Text size="sm">
              {SCALE_LABELS[scaleField]}:{" "}
              <Text component="span" c="dimmed" td="line-through">
                {scaleTarget[scaleField]}
              </Text>{" "}
              →{" "}
              <Text component="span" fw={600}>
                {Number(scaleFactor) === 0
                  ? "—"
                  : (scaleTarget[scaleField] as number) * Number(scaleFactor)}
              </Text>
            </Text>
          )}
          <TextInput
            label="Reason"
            placeholder="e.g. unit conversion, calibration"
            value={scaleReason}
            onChange={(e) => setScaleReason(e.currentTarget.value)}
          />
          <Group justify="flex-end" gap="sm">
            <Button variant="outline" onClick={() => setScaleTarget(null)}>
              Cancel
            </Button>
            <Button loading={busy} onClick={() => void applyScale()}>
              Apply
            </Button>
          </Group>
        </Stack>
      </Modal>

      {/* Metadata edit modal */}
      <Modal
        opened={editTarget !== null}
        onClose={() => setEditTarget(null)}
        title="Edit measurement metadata"
        size="sm"
      >
        <Stack gap="md">
          <Select
            label="Field"
            data={EDIT_FIELDS.map((f) => ({ value: f.value, label: f.label }))}
            value={editField}
            onChange={(v) => setEditField(v ?? "device_name")}
          />
          <TextInput
            label="New value"
            value={editValue}
            onChange={(e) => setEditValue(e.currentTarget.value)}
          />
          <TextInput
            label="Reason"
            placeholder="Why is this metadata being corrected?"
            value={editReason}
            onChange={(e) => setEditReason(e.currentTarget.value)}
          />
          <Group justify="flex-end" gap="sm">
            <Button variant="outline" onClick={() => setEditTarget(null)}>
              Cancel
            </Button>
            <Button loading={busy} onClick={() => void applyEdit()}>
              Apply
            </Button>
          </Group>
        </Stack>
      </Modal>
    </Stack>
  )
}
