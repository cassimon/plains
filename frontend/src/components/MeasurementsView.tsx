import { Badge, Box, Group, Paper, Stack, Table, Text } from "@mantine/core"
import EChartsReact from "echarts-for-react"
import { useMemo, useState } from "react"
import type { ExperimentResults, MeasurementFile } from "@/store/AppContext"
import { SectionLabel } from "./SectionLabel"

function fmt(v: number | undefined | null): string {
  return v == null ? "—" : String(v)
}

/** The unambiguous FW/RV counterpart: same source, opposite direction. */
function counterpart(
  files: MeasurementFile[],
  file: MeasurementFile,
): MeasurementFile | null {
  if (!file.sourcePath && !file.sourceFileId) return null
  return (
    files.find(
      (f) =>
        f.id !== file.id &&
        f.direction !== file.direction &&
        (f.sourceFileId === file.sourceFileId ||
          (f.sourcePath && f.sourcePath === file.sourcePath)),
    ) ?? null
  )
}

export function MeasurementsView({ result }: { result: ExperimentResults }) {
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const files = result.files

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
      files.map((f) => (
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
            <Badge
              size="xs"
              variant="light"
              color={f.direction === "FW" ? "blue" : "grape"}
            >
              {f.direction ?? "—"}
            </Badge>
          </Table.Td>
          <Table.Td>{fmt(f.voc)}</Table.Td>
          <Table.Td>{fmt(f.jsc)}</Table.Td>
          <Table.Td>{fmt(f.ff)}</Table.Td>
          <Table.Td>{fmt(f.value)}</Table.Td>
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
    [files, selectedId],
  )

  return (
    <Stack gap="sm">
      <Group gap="xs" wrap="wrap" align="center">
        <SectionLabel>Measurements</SectionLabel>
        <Badge variant="light">{counts.measurements} records</Badge>
        <Badge variant="light" color="indigo">
          {counts.candidateGroups} candidate groups
        </Badge>
        <Badge variant="light" color="teal">
          {counts.curves} with curves
        </Badge>
        {counts.excluded > 0 && (
          <Badge variant="light" color="dark">
            {counts.excluded} excluded
          </Badge>
        )}
      </Group>

      <Paper withBorder radius="md" style={{ overflow: "hidden" }}>
        <Table striped highlightOnHover>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Device</Table.Th>
              <Table.Th>Scan</Table.Th>
              <Table.Th>Voc (V)</Table.Th>
              <Table.Th>Jsc (mA/cm²)</Table.Th>
              <Table.Th>FF (%)</Table.Th>
              <Table.Th>PCE (%)</Table.Th>
              <Table.Th />
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>{rows}</Table.Tbody>
        </Table>
      </Paper>

      {selected && (
        <Paper withBorder p="sm" radius="md">
          {(selected.curve?.length ?? 0) > 0 ? (
            <Box style={{ height: 280 }}>
              <EChartsReact
                option={chartOption}
                style={{ width: "100%", height: "100%" }}
                opts={{ renderer: "canvas" }}
              />
            </Box>
          ) : (
            <Text size="xs" c="dimmed" ta="center" py="md">
              No JV curve available for this record (summary-only).
            </Text>
          )}
          <Group gap="md" mt="xs" wrap="wrap">
            {(
              [
                ["Vmpp (V)", selected.vmpp],
                ["Jmpp (mA/cm²)", selected.jmpp],
                ["Pmpp (mW/cm²)", selected.pmpp],
                ["Rs (Ω)", selected.rs],
                ["Rsh (Ω)", selected.rsh],
              ] as const
            ).map(([label, v]) => (
              <Text key={label} size="xs" c="dimmed">
                {label}: {fmt(v)}
              </Text>
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
    </Stack>
  )
}
