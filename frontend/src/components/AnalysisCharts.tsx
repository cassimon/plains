import {
  Alert,
  Group,
  MultiSelect,
  Paper,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
} from "@mantine/core"
import { IconInfoCircle } from "@tabler/icons-react"
import EChartsReact from "echarts-for-react"
import { useMemo, useState } from "react"
import {
  descriptiveStats,
  groupKey,
  histogram,
  hysteresisPct,
  isMetricValid,
  METRIC_LABELS,
  type MetricKey,
  pairedValues,
  pairFwRv,
  pearson,
  selectMetricValues,
  selectMetricValuesByGroup,
} from "@/lib/analysis"
import type { ExperimentResults } from "@/store/AppContext"
import { SectionLabel } from "./SectionLabel"

const METRIC_OPTIONS = (Object.keys(METRIC_LABELS) as MetricKey[]).map((k) => ({
  value: k,
  label: METRIC_LABELS[k],
}))

/** Real ECharts for one experiment: histogram, box plot by group, selectable JV
 *  curves, hysteresis and an X/Y correlation scatter. FW and RV are always kept
 *  separate — there is no pooling "All" population. */
export function AnalysisCharts({ result }: { result: ExperimentResults }) {
  const [metric, setMetric] = useState<MetricKey>("value")
  const [direction, setDirection] = useState<"FW" | "RV">("FW")
  const [group, setGroup] = useState<string>("__all__")
  const [xMetric, setXMetric] = useState<MetricKey>("value")
  const [yMetric, setYMetric] = useState<MetricKey>("voc")
  const [curveIds, setCurveIds] = useState<string[]>([])

  const groups = useMemo(() => {
    const s = new Set<string>()
    for (const f of result.files) {
      if (!f.excluded) s.add(groupKey(f))
    }
    return Array.from(s).sort()
  }, [result.files])

  // Map a reliable group key (device-group id) back to its display name.
  const groupLabel = useMemo(() => {
    const byId = new Map<string, string>()
    for (const g of result.deviceGroups) byId.set(g.id, g.deviceName || g.id)
    return (key: string) => byId.get(key) ?? key
  }, [result.deviceGroups])

  const groupFiles = useMemo(
    () =>
      result.files.filter(
        (f) => !f.excluded && (group === "__all__" || groupKey(f) === group),
      ),
    [result.files, group],
  )

  const files = useMemo(
    () => groupFiles.filter((f) => f.direction === direction),
    [groupFiles, direction],
  )

  const selection = useMemo(
    () => selectMetricValues(files, metric),
    [files, metric],
  )
  const stats = useMemo(() => descriptiveStats(selection.values), [selection])
  const hist = useMemo(() => histogram(selection.values, 12), [selection])

  const curveOptions = useMemo(() => {
    const withCurve = result.files.filter(
      (f) => !f.excluded && (f.curve?.length ?? 0) > 0,
    )
    return withCurve.map((f) => ({
      value: f.id,
      label: `${f.deviceName || f.fileName} (${f.direction ?? "?"})`,
    }))
  }, [result.files])

  const selectedCurves = useMemo(() => {
    const ids =
      curveIds.length > 0
        ? curveIds
        : curveOptions.slice(0, 6).map((c) => c.value)
    // Re-filter on every render: a selected curve that became excluded (or lost
    // its curve) must drop out of the overlay.
    return result.files.filter(
      (f) => !f.excluded && (f.curve?.length ?? 0) > 0 && ids.includes(f.id),
    )
  }, [curveIds, curveOptions, result.files])

  const boxByGroup = useMemo(
    () =>
      selectMetricValuesByGroup(files, metric)
        .map(({ group: g, selection }) => {
          const s = descriptiveStats(selection.values)
          return s
            ? {
                name: groupLabel(g),
                box: [s.min, s.q1, s.median, s.q3, s.max] as number[],
              }
            : null
        })
        .filter((x): x is { name: string; box: number[] } => x !== null),
    [files, metric, groupLabel],
  )

  const histogramOption = useMemo(
    () => ({
      title: {
        text: `${METRIC_LABELS[metric]} (${direction}) distribution`,
        left: "center",
        textStyle: { fontSize: 13 },
      },
      tooltip: { trigger: "axis" },
      grid: { left: 48, right: 16, top: 36, bottom: 32 },
      xAxis: {
        type: "category",
        data: hist ? hist.edges.slice(0, -1).map((e) => e.toFixed(2)) : [],
      },
      yAxis: { type: "value" },
      series: [{ type: "bar", data: hist ? hist.counts : [], barWidth: "80%" }],
    }),
    [hist, metric, direction],
  )

  const boxOption = useMemo(
    () => ({
      title: {
        text: `${METRIC_LABELS[metric]} (${direction}) by candidate group`,
        left: "center",
        textStyle: { fontSize: 13 },
      },
      tooltip: {},
      grid: { left: 48, right: 16, top: 36, bottom: 48 },
      xAxis: {
        type: "category",
        data: boxByGroup.map((g) => g.name),
        axisLabel: { interval: 0, rotate: 20, fontSize: 10 },
      },
      yAxis: { type: "value" },
      series: [{ type: "boxplot", data: boxByGroup.map((g) => g.box) }],
    }),
    [boxByGroup, metric, direction],
  )

  const jvOption = useMemo(
    () => ({
      title: {
        text: "JV curve overlays",
        left: "center",
        textStyle: { fontSize: 13 },
      },
      tooltip: { trigger: "axis" },
      grid: { left: 48, right: 16, top: 36, bottom: 32 },
      xAxis: { type: "value", name: "V (V)", scale: true },
      yAxis: { type: "value", name: "J (mA/cm²)", scale: true },
      series: selectedCurves.map((f) => ({
        name: `${f.deviceName || f.fileName} (${f.direction ?? "?"})`,
        type: "line",
        showSymbol: false,
        data: (f.curve ?? []).map((p) => [p.v, p.j]),
      })),
    }),
    [selectedCurves],
  )

  const hystData = useMemo(
    () =>
      pairFwRv(groupFiles)
        .map(({ fw, rv }) => ({
          pceFw: fw.value,
          hi: hysteresisPct(fw.value, rv.value),
        }))
        .filter(
          (d): d is { pceFw: number; hi: number } =>
            d.hi !== null && Number.isFinite(d.pceFw ?? NaN),
        ),
    [groupFiles],
  )

  const hystOption = useMemo(
    () => ({
      title: {
        text: `PCE vs hysteresis (n=${hystData.length})`,
        left: "center",
        textStyle: { fontSize: 13 },
      },
      tooltip: { trigger: "item" },
      grid: { left: 48, right: 16, top: 36, bottom: 32 },
      xAxis: { type: "value", name: "PCE FW (%)", scale: true },
      yAxis: { type: "value", name: "HI (%)", scale: true },
      series: [{ type: "scatter", data: hystData.map((d) => [d.pceFw, d.hi]) }],
    }),
    [hystData],
  )

  const corrOption = useMemo(() => {
    const pairs = pairedValues(files, xMetric, yMetric)
    const corr = pearson(
      pairs.map((p) => p[0]),
      pairs.map((p) => p[1]),
    )
    return {
      title: {
        text: `${METRIC_LABELS[xMetric]} vs ${METRIC_LABELS[yMetric]}${corr ? ` (r = ${corr.r.toFixed(3)}, n=${corr.n})` : ""}`,
        left: "center",
        textStyle: { fontSize: 13 },
      },
      tooltip: { trigger: "item" },
      grid: { left: 48, right: 16, top: 36, bottom: 32 },
      xAxis: { type: "value", name: METRIC_LABELS[xMetric], scale: true },
      yAxis: { type: "value", name: METRIC_LABELS[yMetric], scale: true },
      series: [{ type: "scatter", data: pairs }],
    }
  }, [files, xMetric, yMetric])

  const ranking = useMemo(() => {
    return files
      .filter((f) => isMetricValid(metric, f[metric]))
      .sort((a, b) => (b[metric] as number) - (a[metric] as number))
      .slice(0, 12)
  }, [files, metric])

  return (
    <Stack gap="sm">
      <Group gap="xs" align="end" wrap="wrap">
        <SectionLabel>Analysis charts</SectionLabel>
        <Select
          size="xs"
          label="Metric"
          data={METRIC_OPTIONS}
          value={metric}
          onChange={(v) => setMetric((v ?? "value") as MetricKey)}
          style={{ width: 150 }}
        />
        <SegmentedControl
          size="xs"
          value={direction}
          onChange={(v) => setDirection(v as "FW" | "RV")}
          data={[
            { label: "FW", value: "FW" },
            { label: "RV", value: "RV" },
          ]}
        />
        <Select
          size="xs"
          label="Candidate group"
          data={[
            { value: "__all__", label: "All groups" },
            ...groups.map((g) => ({ value: g, label: groupLabel(g) })),
          ]}
          value={group}
          onChange={(v) => setGroup(v ?? "__all__")}
          style={{ width: 180 }}
        />
        <Text size="xs" c="dimmed">
          n={selection.values.length} · excluded {selection.excludedCount} ·
          invalid {selection.invalidCount}
          {stats?.std != null ? ` · mean ${stats.mean.toFixed(3)}` : ""}
        </Text>
      </Group>

      <Alert
        variant="light"
        color="gray"
        icon={<IconInfoCircle size={16} />}
        p="xs"
      >
        <Text size="xs">
          FW and RV are kept separate. Fabrication-aware comparisons require
          confirmed device/substrate relationships; when they are missing only
          the measurement-level analysis above is available.
        </Text>
      </Alert>

      <Paper withBorder p="xs" radius="md">
        <EChartsReact
          option={histogramOption}
          style={{ height: 240 }}
          opts={{ renderer: "canvas" }}
        />
      </Paper>
      <Paper withBorder p="xs" radius="md">
        <EChartsReact
          option={boxOption}
          style={{ height: 240 }}
          opts={{ renderer: "canvas" }}
        />
      </Paper>

      <Paper withBorder p="xs" radius="md">
        <Group mb="xs">
          <MultiSelect
            size="xs"
            label="JV curves to overlay"
            data={curveOptions}
            value={curveIds}
            onChange={setCurveIds}
            placeholder={
              curveOptions.length === 0
                ? "No curves available"
                : "Default: first 6"
            }
            style={{ flex: 1 }}
            clearable
            searchable
          />
        </Group>
        <EChartsReact
          option={jvOption}
          style={{ height: 260 }}
          opts={{ renderer: "canvas" }}
        />
      </Paper>

      <Paper withBorder p="xs" radius="md">
        <EChartsReact
          option={hystOption}
          style={{ height: 240 }}
          opts={{ renderer: "canvas" }}
        />
      </Paper>

      <Paper withBorder p="xs" radius="md">
        <Group gap="xs" mb="xs">
          <Select
            size="xs"
            label="X metric"
            data={METRIC_OPTIONS}
            value={xMetric}
            onChange={(v) => setXMetric((v ?? "value") as MetricKey)}
            style={{ width: 150 }}
          />
          <Select
            size="xs"
            label="Y metric"
            data={METRIC_OPTIONS}
            value={yMetric}
            onChange={(v) => setYMetric((v ?? "voc") as MetricKey)}
            style={{ width: 150 }}
          />
        </Group>
        <EChartsReact
          option={corrOption}
          style={{ height: 240 }}
          opts={{ renderer: "canvas" }}
        />
      </Paper>

      <Paper withBorder p="xs" radius="md">
        <Text size="xs" fw={600} mb="xs">
          Performance ranking — {METRIC_LABELS[metric]} ({direction})
        </Text>
        <Table striped>
          <Table.Thead>
            <Table.Tr>
              <Table.Th>Device</Table.Th>
              <Table.Th>Scan</Table.Th>
              <Table.Th>{METRIC_LABELS[metric]}</Table.Th>
            </Table.Tr>
          </Table.Thead>
          <Table.Tbody>
            {ranking.map((f) => (
              <Table.Tr key={f.id}>
                <Table.Td>
                  <Text size="xs">{f.deviceName || f.fileName}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs">{f.direction}</Text>
                </Table.Td>
                <Table.Td>
                  <Text size="xs">{Number(f[metric]).toFixed(3)}</Text>
                </Table.Td>
              </Table.Tr>
            ))}
          </Table.Tbody>
        </Table>
      </Paper>
    </Stack>
  )
}
