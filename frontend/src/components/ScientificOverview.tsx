import { Alert, Badge, Group, Paper, Stack, Table, Text } from "@mantine/core"
import { IconInfoCircle } from "@tabler/icons-react"
import { useMemo } from "react"
import {
  descriptiveStats,
  hysteresisPct,
  METRIC_LABELS,
  type MetricKey,
  pairedValues,
  pairFwRv,
  pearson,
  selectMetricValues,
} from "@/lib/analysis"
import type { ExperimentResults } from "@/store/AppContext"
import { SectionLabel } from "./SectionLabel"

const METRICS: MetricKey[] = ["value", "voc", "jsc", "ff"]

type Row = {
  label: string
  fw: ReturnType<typeof descriptiveStats>
  rv: ReturnType<typeof descriptiveStats>
}

/** Compact deterministic scientific overview for one experiment's results.
 *  FW and RV are reported separately — never silently pooled — using only the
 *  authoritative corrected/effective values; excluded observations are dropped
 *  and counted. */
export function ScientificOverview({ result }: { result: ExperimentResults }) {
  const overview = useMemo(() => {
    const fwFiles = result.files.filter((f) => f.direction === "FW")
    const rvFiles = result.files.filter((f) => f.direction === "RV")

    const rows: Row[] = METRICS.map((metric) => ({
      label: METRIC_LABELS[metric],
      fw: descriptiveStats(selectMetricValues(fwFiles, metric).values),
      rv: descriptiveStats(selectMetricValues(rvFiles, metric).values),
    }))

    const pce = selectMetricValues(result.files, "value")

    // Hysteresis is inherently cross-direction (RV − FW over unambiguous pairs).
    const pairs = pairFwRv(result.files)
    const hyst = pairs
      .map(({ fw, rv }) => hysteresisPct(fw.value, rv.value))
      .filter((v): v is number => v !== null)
    const hystStats = descriptiveStats(hyst)

    // Pearson from complete pairs of the SAME observation (whole-experiment).
    const corrPceVoc = pearson(
      ...splitPairs(pairedValues(result.files, "value", "voc")),
    )
    const corrPceJsc = pearson(
      ...splitPairs(pairedValues(result.files, "value", "jsc")),
    )
    const corrPceFf = pearson(
      ...splitPairs(pairedValues(result.files, "value", "ff")),
    )

    return {
      rows,
      excluded: pce.excludedCount,
      invalid: pce.invalidCount,
      total: pce.total,
      hystStats,
      pairCount: pairs.length,
      corrPceVoc,
      corrPceJsc,
      corrPceFf,
    }
  }, [result.files])

  if (overview.rows.every((r) => !r.fw && !r.rv) && !overview.hystStats) {
    return (
      <Alert
        icon={<IconInfoCircle size={16} />}
        color="gray"
        title="No analysable data"
      >
        Import a JV dataset (or open one in Results) to compute statistics.
      </Alert>
    )
  }

  return (
    <Paper withBorder p="sm" radius="md">
      <Group gap="xs" mb="xs">
        <SectionLabel>Scientific overview</SectionLabel>
        <Badge variant="light">{overview.total} records</Badge>
        {overview.excluded > 0 && (
          <Badge variant="light" color="dark">
            {overview.excluded} excluded
          </Badge>
        )}
        {overview.invalid > 0 && (
          <Badge variant="light" color="gray">
            {overview.invalid} invalid (missing/non-finite/out-of-range)
          </Badge>
        )}
        <Badge variant="light" color="indigo">
          {overview.pairCount} FW/RV pairs
        </Badge>
      </Group>

      <Table striped>
        <Table.Thead>
          <Table.Tr>
            <Table.Th>Metric</Table.Th>
            <Table.Th>Scan</Table.Th>
            <Table.Th>n</Table.Th>
            <Table.Th>Mean</Table.Th>
            <Table.Th>Median</Table.Th>
            <Table.Th>Std</Table.Th>
            <Table.Th>Min</Table.Th>
            <Table.Th>Max</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {overview.rows.flatMap((row) =>
            (["FW", "RV"] as const).map((dir) => {
              const s = dir === "FW" ? row.fw : row.rv
              return (
                <Table.Tr key={`${row.label}-${dir}`}>
                  <Table.Td>
                    <Text size="xs">{row.label}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs" c="dimmed">
                      {dir}
                    </Text>
                  </Table.Td>
                  <Table.Td>{s ? s.n : "—"}</Table.Td>
                  <Table.Td>{s ? s.mean.toFixed(3) : "—"}</Table.Td>
                  <Table.Td>{s ? s.median.toFixed(3) : "—"}</Table.Td>
                  <Table.Td>{s?.std != null ? s.std.toFixed(3) : "—"}</Table.Td>
                  <Table.Td>{s ? s.min.toFixed(3) : "—"}</Table.Td>
                  <Table.Td>{s ? s.max.toFixed(3) : "—"}</Table.Td>
                </Table.Tr>
              )
            }),
          )}
        </Table.Tbody>
      </Table>

      <Stack gap="xs" mt="sm">
        <Text size="xs" fw={600}>
          Hysteresis — HI (%) = 100 × (PCE_RV − PCE_FW) / PCE_RV
        </Text>
        {overview.hystStats ? (
          <Text size="xs" c="dimmed">
            n={overview.hystStats.n} · mean {overview.hystStats.mean.toFixed(2)}
            % · median {overview.hystStats.median.toFixed(2)}% · std{" "}
            {overview.hystStats.std?.toFixed(2) ?? "—"}%
          </Text>
        ) : (
          <Text size="xs" c="dimmed">
            Insufficient unambiguous FW/RV pairs.
          </Text>
        )}

        <Text size="xs" fw={600}>
          Pearson correlations (PCE vs …)
        </Text>
        <Group gap="md">
          {(
            [
              ["Voc", overview.corrPceVoc],
              ["Jsc", overview.corrPceJsc],
              ["FF", overview.corrPceFf],
            ] as const
          ).map(([label, c]) => (
            <Text key={label} size="xs" c="dimmed">
              {label}:{" "}
              {c ? `r = ${c.r.toFixed(3)} (n=${c.n})` : "insufficient data"}
            </Text>
          ))}
        </Group>
        <Text size="xs" c="dimmed">
          Descriptive diagnostics only — no causality or statistical
          significance is inferred.
        </Text>
      </Stack>
    </Paper>
  )
}

function splitPairs(pairs: [number, number][]): [number[], number[]] {
  return [pairs.map((p) => p[0]), pairs.map((p) => p[1])]
}
