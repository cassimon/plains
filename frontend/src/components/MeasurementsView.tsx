import {
  Badge,
  Box,
  Button,
  Group,
  Modal,
  Paper,
  ScrollArea,
  Stack,
  Table,
  Text,
  TextInput,
  Tooltip,
} from "@mantine/core"
import {
  IconArrowsMaximize,
  IconInfoCircle,
  IconPlus,
} from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import EChartsReact from "echarts-for-react"
import { useMemo, useState } from "react"
import type { ExperimentResults, MeasurementFile } from "@/store/AppContext"
import { SectionLabel } from "./SectionLabel"

function fmt(v: number | undefined | null): string {
  if (v == null) return "—"
  if (!Number.isFinite(v)) return String(v)
  // Reduce displayed precision only — stored values are never rounded.
  return String(Number(v.toFixed(4)))
}

const METRIC_HELP: Record<string, string> = {
  "Voc (V)":
    "Voc — open-circuit voltage: the voltage across the cell at zero current.",
  "Jsc (mA/cm²)":
    "Jsc — short-circuit current density: current at zero voltage, per unit area.",
  "FF (%)":
    "FF — fill factor: ratio of maximum power to Voc × Jsc (a quality factor).",
  "PCE (%)":
    "PCE — power conversion efficiency: the cell's electrical output vs incident light.",
}

const EXTRA_METRIC_HELP: Record<string, string> = {
  "Vmpp (V)": "Voltage at the maximum power point.",
  "Jmpp (mA/cm²)": "Current density at the maximum power point.",
  "Pmpp (mW/cm²)": "Maximum output power density.",
  "Rs (Ω)": "Series resistance (from the JV fit).",
  "Rsh (Ω)": "Shunt resistance (from the JV fit).",
}

/** The unambiguous FW/RV counterpart: same durable source id AND explicitly
 *  opposite direction (FW↔RV). Missing source ids or ambiguous paths never
 *  pair. */
function counterpart(
  files: MeasurementFile[],
  file: MeasurementFile,
): MeasurementFile | null {
  if (!file.sourceFileId || !file.direction) return null
  const opposite =
    file.direction === "FW" ? "RV" : file.direction === "RV" ? "FW" : null
  if (!opposite) return null
  const matches = files.filter(
    (f) =>
      f.id !== file.id &&
      f.sourceFileId === file.sourceFileId &&
      f.direction === opposite,
  )
  return matches.length === 1 ? matches[0] : null
}

export function MeasurementsView({
  result,
  onOpenReview,
}: {
  result: ExperimentResults
  onOpenReview?: () => void
}) {
  const navigate = useNavigate()
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [search, setSearch] = useState("")
  const [chartExpanded, setChartExpanded] = useState(false)
  const files = result.files

  const filteredFiles = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return files
    return files.filter(
      (f) =>
        (f.deviceName || "").toLowerCase().includes(q) ||
        (f.fileName || "").toLowerCase().includes(q),
    )
  }, [files, search])

  const selected = files.find((f) => f.id === selectedId) ?? null
  const other = selected ? counterpart(files, selected) : null

  const counts = useMemo(() => {
    const candidateGroups = new Set(
      files
        .map((f) => f.substrateGroup || f.deviceName || f.fileName)
        .filter(Boolean),
    ).size
    return {
      measurements: files.length,
      candidateGroups,
      excluded: files.filter((f) => f.excluded).length,
      curves: files.filter((f) => (f.curve?.length ?? 0) > 0).length,
    }
  }, [files])

  const chartOption = useMemo(() => {
    const series: {
      name: string
      type: "line"
      data: [number, number][]
      showSymbol: boolean
    }[] = []
    if (selected?.curve?.length) {
      series.push({
        name: `${selected.direction ?? ""}`,
        type: "line",
        data: selected.curve.map((p) => [p.v, p.j]),
        showSymbol: false,
      })
    }
    if (other?.curve?.length) {
      series.push({
        name: `${other.direction ?? ""}`,
        type: "line",
        data: other.curve.map((p) => [p.v, p.j]),
        showSymbol: false,
      })
    }
    return {
      title: {
        text: selected ? `${selected.deviceName || selected.fileName}` : "",
        left: "center",
        textStyle: { fontSize: 13 },
      },
      tooltip: { trigger: "axis" },
      grid: { left: 48, right: 16, top: 40, bottom: 32 },
      xAxis: {
        type: "value",
        name: "V (V)",
        scale: true,
      },
      yAxis: {
        type: "value",
        name: "J (mA/cm²)",
        scale: true,
      },
      series,
    }
  }, [selected, other])

  const rows = useMemo(
    () =>
      filteredFiles.map((f) => (
        <Table.Tr
          key={f.id}
          onClick={() => setSelectedId(f.id)}
          style={{
            cursor: "pointer",
            background:
              f.id === selectedId ? "var(--mantine-color-blue-0)" : undefined,
            opacity: f.excluded ? 0.5 : 1,
          }}
        >
          <Table.Td>
            <Text size="xs" truncate>
              {f.deviceName || f.fileName}
            </Text>
          </Table.Td>
          <Table.Td>
            <Badge size="xs" variant="outline">
              {f.fileType || "Unknown"}
            </Badge>
          </Table.Td>
          <Table.Td>
            {f.fileType === "JV" ? (
              <Badge
                size="xs"
                variant="light"
                color={f.direction === "FW" ? "blue" : "grape"}
              >
                {f.direction ?? "—"}
              </Badge>
            ) : (
              <Text size="xs" c="dimmed">
                —
              </Text>
            )}
          </Table.Td>
          <Table.Td>{f.fileType === "JV" ? fmt(f.voc) : "—"}</Table.Td>
          <Table.Td>{f.fileType === "JV" ? fmt(f.jsc) : "—"}</Table.Td>
          <Table.Td>{f.fileType === "JV" ? fmt(f.ff) : "—"}</Table.Td>
          <Table.Td>{f.fileType === "JV" ? fmt(f.value) : "—"}</Table.Td>
          <Table.Td>
            {f.excluded && (
              <Badge size="xs" color="dark" variant="filled">
                excluded
              </Badge>
            )}
            {(f.curve?.length ?? 0) > 0 && (
              <Badge size="xs" color="teal" variant="light">
                curve
              </Badge>
            )}
          </Table.Td>
        </Table.Tr>
      )),
    [filteredFiles, selectedId],
  )

  return (
    <Stack gap="sm">
      <Group gap="xs" wrap="wrap" align="center">
        <SectionLabel>Measurements</SectionLabel>
        <Badge variant="light">{counts.measurements} records</Badge>
        <Tooltip
          label="Candidate device groups are derived from labels only — they are not confirmed physical devices."
          withArrow
        >
          <Badge variant="light" color="indigo">
            {counts.candidateGroups} candidate groups
          </Badge>
        </Tooltip>
        <Tooltip
          label="Records that carry raw JV sweep points (not summary-only)."
          withArrow
        >
          <Badge variant="light" color="teal">
            {counts.curves} with curves
          </Badge>
        </Tooltip>
        {counts.excluded > 0 && (
          <Tooltip
            label="Excluded measurements stay visible and restorable; they are omitted from future analyses."
            withArrow
          >
            <Badge variant="light" color="dark">
              {counts.excluded} excluded
            </Badge>
          </Tooltip>
        )}
        <Box style={{ flex: 1 }} />
        <Button
          size="xs"
          variant="light"
          leftSection={<IconPlus size={14} />}
          onClick={() => void navigate({ to: "/experiments" })}
        >
          Add Data
        </Button>
        <TextInput
          size="xs"
          placeholder="Search device or file…"
          value={search}
          onChange={(e) => setSearch(e.currentTarget.value)}
          style={{ width: 200 }}
        />
      </Group>

      <Paper withBorder radius="md" style={{ overflow: "hidden" }}>
        <ScrollArea.Autosize mah={320}>
          <Table striped highlightOnHover>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>Device</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th>
                  <Tooltip
                    label="FW = forward scan, RV = reverse scan (voltage swept in opposite directions)."
                    withArrow
                  >
                    <Group gap={4} wrap="nowrap" style={{ cursor: "help" }}>
                      <Text component="span" size="sm" fw={500}>
                        Scan
                      </Text>
                      <IconInfoCircle
                        size={12}
                        style={{ color: "var(--mantine-color-gray-5)" }}
                      />
                    </Group>
                  </Tooltip>
                </Table.Th>
                {["Voc (V)", "Jsc (mA/cm²)", "FF (%)", "PCE (%)"].map(
                  (label) => (
                    <Table.Th key={label}>
                      <Tooltip label={METRIC_HELP[label]} withArrow>
                        <Group gap={4} wrap="nowrap" style={{ cursor: "help" }}>
                          <Text component="span" size="sm" fw={500}>
                            {label}
                          </Text>
                          <IconInfoCircle
                            size={12}
                            style={{ color: "var(--mantine-color-gray-5)" }}
                          />
                        </Group>
                      </Tooltip>
                    </Table.Th>
                  ),
                )}
                <Table.Th />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>{rows}</Table.Tbody>
          </Table>
        </ScrollArea.Autosize>
      </Paper>

      {selected && (
        <Paper withBorder p="sm" radius="md">
          {(selected.curve?.length ?? 0) > 0 ? (
            <>
              <Group justify="flex-end" mb={4}>
                <Button
                  size="xs"
                  variant="subtle"
                  leftSection={<IconArrowsMaximize size={14} />}
                  onClick={() => setChartExpanded(true)}
                >
                  Expand
                </Button>
              </Group>
              <Box style={{ height: 280 }}>
                <EChartsReact
                  option={chartOption}
                  style={{ width: "100%", height: "100%" }}
                  opts={{ renderer: "canvas" }}
                />
              </Box>
            </>
          ) : (
            <Text size="xs" c="dimmed" ta="center" py="md">
              No JV curve available for this record (summary-only).
            </Text>
          )}
          <Group gap="md" mt="xs" wrap="wrap">
            {onOpenReview && (
              <Button size="xs" variant="light" onClick={onOpenReview}>
                Correct / Exclude
              </Button>
            )}
            {(
              [
                ["Vmpp (V)", selected.vmpp],
                ["Jmpp (mA/cm²)", selected.jmpp],
                ["Pmpp (mW/cm²)", selected.pmpp],
                ["Rs (Ω)", selected.rs],
                ["Rsh (Ω)", selected.rsh],
              ] as const
            ).map(([label, v]) => (
              <Tooltip key={label} label={EXTRA_METRIC_HELP[label]} withArrow>
                <Text size="xs" c="dimmed" style={{ cursor: "help" }}>
                  {label}: {fmt(v)}
                </Text>
              </Tooltip>
            ))}
            {selected.measurementDate && (
              <Text size="xs" c="dimmed">
                Date: {selected.measurementDate}
              </Text>
            )}
            {selected.user && (
              <Text size="xs" c="dimmed">
                User: {selected.user}
              </Text>
            )}
          </Group>
        </Paper>
      )}

      <Modal
        opened={chartExpanded}
        onClose={() => setChartExpanded(false)}
        title={
          selected
            ? `${selected.deviceName || selected.fileName} — JV curve`
            : "JV curve"
        }
        size="calc(100vw - 160px)"
        centered
      >
        <Box style={{ height: "calc(100vh - 260px)", minHeight: 320 }}>
          <EChartsReact
            option={chartOption}
            style={{ width: "100%", height: "100%" }}
            opts={{ renderer: "canvas" }}
          />
        </Box>
      </Modal>
    </Stack>
  )
}
