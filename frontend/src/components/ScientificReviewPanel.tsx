import {
  Accordion,
  Badge,
  Button,
  Group,
  Modal,
  NumberInput,
  Select,
  Stack,
  Text,
  TextInput,
} from "@mantine/core"
import { notifications } from "@mantine/notifications"
import {
  IconBan,
  IconHistory,
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
  const [busy, setBusy] = useState(false)
  const [history, setHistory] = useState<CorrectionHistory[] | null>(null)

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
            }
          : r,
      ),
    )
  }

  const toggleExclude = async () => {
    if (!excludeTarget) return
    setBusy(true)
    try {
      const op = excludeTarget.excluded ? "restore" : "exclude"
      await applyCorrection(result.id, {
        measurement_id: excludeTarget.id,
        operation: op,
        reason:
          excludeReason.trim() ||
          (op === "exclude"
            ? "Excluded by researcher"
            : "Restored by researcher"),
      })
      applyLocal({ ...excludeTarget, excluded: !excludeTarget.excluded })
      notifications.show({
        title:
          op === "exclude" ? "Measurement excluded" : "Measurement restored",
        message: "Correction recorded.",
        color: "green",
      })
      setExcludeTarget(null)
      setExcludeReason("")
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
    if (!scaleTarget) return
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
      await applyCorrection(result.id, {
        measurement_id: scaleTarget.id,
        operation: "scale",
        field: scaleField,
        factor,
        reason: scaleReason.trim() || "Researcher-applied scale factor",
      })
      applyLocal({ ...scaleTarget, [scaleField]: old * factor })
      notifications.show({
        title: "Scaling applied",
        message: "Correction recorded.",
        color: "green",
      })
      setScaleTarget(null)
      setScaleReason("")
      setScaleFactor(1)
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

  const filesWithAttention = findingsByFile.filter(
    ({ findings, file }) => findings.length > 0 || file.excluded,
  )

  return (
    <Stack gap="sm">
      <SectionLabel>Scientific review</SectionLabel>
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

      {filesWithAttention.length === 0 ? (
        <Text size="xs" c="dimmed">
          No findings — all JV records are within typical ranges.
        </Text>
      ) : (
        <Accordion variant="separated" multiple>
          {filesWithAttention.map(({ file, findings }) => (
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
                      }}
                    >
                      Scale
                    </Button>
                  </Group>
                </Stack>
              </Accordion.Panel>
            </Accordion.Item>
          ))}
        </Accordion>
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
    </Stack>
  )
}
