import { Alert, Badge, Group, Paper, Stack, Table, Text } from "@mantine/core"
import { IconInfoCircle } from "@tabler/icons-react"
import { useMemo } from "react"
import {
  descriptiveStats,
  hysteresisPct,
  pairedValues,
  pairFwRv,
  pearson,
  selectMetricValues,
} from "@/lib/analysis"
import type { ExperimentResults } from "@/store/AppContext"
import { SectionLabel } from "./SectionLabel"

/** Compact deterministic scientific overview for one experiment's results.
 *  Uses only authoritative corrected/effective values; excluded observations
 *  are dropped and counted. */
export function ScientificOverview({ result }: { result: ExperimentResults }) {
  const overview = useMemo(() => {
    const pce = selectMetricValues(result.files, "value")
    const voc = selectMetricValues(result.files, "voc")
    const jsc = selectMetricValues(result.files, "jsc")
    const ff = selectMetricValues(result.files, "ff")

    const pceStats = descriptiveStats(pce.values)
    const vocStats = descriptiveStats(voc.values)
    const jscStats = descriptiveStats(jsc.values)
    const ffStats = descriptiveStats(ff.values)

    const pairs = pairFwRv(result.files)
    const hyst = pairs
      .map(({ fw, rv }) => hysteresisPct(fw.value, rv.value))
      .filter((v): v is number => v !== null)
    const hystStats = descriptiveStats(hyst)

    // Pearson from complete pairs of the SAME observation.
    const pceVoc = pairedValues(result.files, "value", "voc")
    const pceJsc = pairedValues(result.files, "value", "jsc")
    const pceFf = pairedValues(result.files, "value", "ff")
    const corrPceVoc = pearson(
      pceVoc.map((p) => p[0]),
      pceVoc.map((p) => p[1]),
    )
    const corrPceJsc = pearson(
      pceJsc.map((p) => p[0]),
      pceJsc.map((p) => p[1]),
    )
    const corrPceFf = pearson(
      pceFf.map((p) => p[0]),
      pceFf.map((p) => p[1]),
    )

    return {
      pce,
      excluded: pce.excludedCount,
      invalid: pce.invalidCount,
      pceStats,
      vocStats,
      jscStats,
      ffStats,
      hystStats,
      pairCount: pairs.length,
      corrPceVoc,
      corrPceJsc,
      corrPceFf,
    }
  }, [result.files])

  const metricRows: [string, ReturnType<typeof descriptiveStats>][] = [
    ["PCE (%)", overview.pceStats],
    ["Voc (V)", overview.vocStats],
    ["Jsc (mA/cm²)", overview.jscStats],
    ["FF (%)", overview.ffStats],
  ]

  if (!overview.pceStats && !overview.hystStats) {
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
        <Badge variant="light">{overview.pce.total} records</Badge>
        {overview.excluded > 0 && (
          <Badge variant="light" color="dark">
            {overview.excluded} excluded
          </Badge>
        )}
        {overview.invalid > 0 && (
          <Badge variant="light" color="gray">
            {overview.invalid} missing/non-finite
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
            <Table.Th>n</Table.Th>
            <Table.Th>Mean</Table.Th>
            <Table.Th>Median</Table.Th>
            <Table.Th>Std</Table.Th>
            <Table.Th>Min</Table.Th>
            <Table.Th>Max</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {metricRows.map(([label, s]) => (
            <Table.Tr key={label}>
              <Table.Td>
                <Text size="xs">{label}</Text>
              </Table.Td>
              <Table.Td>{s ? s.n : "—"}</Table.Td>
              <Table.Td>{s ? s.mean.toFixed(3) : "—"}</Table.Td>
              <Table.Td>{s ? s.median.toFixed(3) : "—"}</Table.Td>
              <Table.Td>{s?.std != null ? s.std.toFixed(3) : "—"}</Table.Td>
              <Table.Td>{s ? s.min.toFixed(3) : "—"}</Table.Td>
              <Table.Td>{s ? s.max.toFixed(3) : "—"}</Table.Td>
            </Table.Tr>
          ))}
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
