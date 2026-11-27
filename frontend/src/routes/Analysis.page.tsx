import { Box, Group, Paper, ScrollArea, Stack, Text } from "@mantine/core"
import { useLocation } from "@tanstack/react-router"
import { useState } from "react"
import { AnalysisCharts } from "@/components/AnalysisCharts"
import { ScientificOverview } from "@/components/ScientificOverview"
import type { Experiment } from "../store/AppContext"
import { useAppContext } from "../store/AppContext"

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

/** Generate example box plot data for PCE by layer parameter */
function ExperimentListItem({
  experiment,
  isSelected,
  onSelect,
}: {
  experiment: Experiment
  isSelected: boolean
  onSelect: () => void
}) {
  return (
    <Paper
      withBorder
      p="sm"
      radius="md"
      style={{
        cursor: "pointer",
        background: isSelected
          ? "light-dark(var(--mantine-color-blue-0), var(--mantine-color-dark-5))"
          : undefined,
        borderColor: isSelected ? "var(--mantine-color-blue-4)" : undefined,
      }}
      onClick={onSelect}
    >
      <Group justify="space-between" wrap="nowrap">
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group gap="xs" mb={4}>
            <Text size="sm" fw={600} truncate>
              {experiment.name || "Untitled"}
            </Text>
          </Group>
          <Group gap="xs">
            <Text size="xs" c="dimmed">
              {experiment.date || "No date"}
            </Text>
            <Text size="xs" c="dimmed">
              •
            </Text>
            <Text size="xs" c="dimmed">
              {experiment.substrates.length} substrate
              {experiment.substrates.length !== 1 ? "s" : ""}
            </Text>
          </Group>
        </Box>
      </Group>
    </Paper>
  )
}

// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────

export function AnalysisPage() {
  const { experiments, results, lastSelectedByKind, updateLastSelected } =
    useAppContext()
  const location = useLocation()
  const experimentId = (location.search as Record<string, unknown>)
    .experimentId as string | undefined
  // Single selection mechanism: the experimentId URL query parameter (set by
  // the Results "Analyze" action) is authoritative and survives reload; the
  // last-selected experiment is the fallback for plain navigation.
  const [selectedExperimentId, setSelectedExperimentId] = useState<
    string | null
  >(() => experimentId ?? lastSelectedByKind.experiment ?? null)

  const selectExperiment = (id: string | null) => {
    setSelectedExperimentId(id)
    if (id) updateLastSelected("experiment", id)
  }

  const selectedExperiment = experiments.find(
    (e) => e.id === selectedExperimentId,
  )
  const selectedResult = selectedExperiment
    ? (results.find((r) => r.experimentId === selectedExperiment.id) ?? null)
    : null

  // Snap to grid helper

  // Handle drag start
  // Handle resize start
  // Delete widget

  return (
    <Box
      style={{
        display: "flex",
        height: "calc(100vh - 60px)",
        flexDirection: "column",
      }}
    >
      <Box style={{ display: "flex", flex: 1, minHeight: 0 }}>
        {/* Main: Plot Plane */}
        <ScrollArea style={{ flex: 1 }} p="md">
          {selectedResult ? (
            <Stack gap="md">
              <ScientificOverview result={selectedResult} />
              <AnalysisCharts result={selectedResult} />
            </Stack>
          ) : (
            <Text size="sm" c="dimmed" ta="center" mt="xl">
              Select an experiment with imported measurements to see scientific
              analysis.
            </Text>
          )}
        </ScrollArea>

        {/* Right Sidebar: Experiment & Configuration */}
        <Box
          style={{
            width: 300,
            borderLeft: "1px solid var(--mantine-color-default-border)",
            display: "flex",
            flexDirection: "column",
            background: "light-dark(white, var(--mantine-color-dark-6))",
            minHeight: 0,
          }}
        >
          {/* Experiment List Header */}
          <Group
            justify="space-between"
            p="md"
            style={{
              borderBottom: "1px solid var(--mantine-color-default-border)",
              flexShrink: 0,
            }}
          >
            <Text size="sm" fw={600}>
              Experiments
            </Text>
          </Group>

          {/* Experiment List */}
          <ScrollArea
            style={{
              flex: 1,
              borderBottom: "1px solid var(--mantine-color-default-border)",
              minHeight: 0,
            }}
            p="sm"
          >
            <Stack gap="sm">
              {experiments.length === 0 ? (
                <Paper
                  p="lg"
                  ta="center"
                  style={{
                    background:
                      "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))",
                  }}
                >
                  <Text size="sm" c="dimmed">
                    No experiments
                  </Text>
                </Paper>
              ) : (
                experiments.map((exp) => (
                  <ExperimentListItem
                    key={exp.id}
                    experiment={exp}
                    isSelected={selectedExperimentId === exp.id}
                    onSelect={() => selectExperiment(exp.id)}
                  />
                ))
              )}
            </Stack>
          </ScrollArea>

          {/* Data Source Configuration */}
          <Box
            style={{
              flexShrink: 0,
              borderTop: "1px solid var(--mantine-color-default-border)",
              overflow: "auto",
              maxHeight: "40%",
            }}
            p="sm"
          >
            <Stack gap="xs">
              <Text size="xs" fw={600}>
                Data source
              </Text>
              <Text size="xs" c="dimmed">
                Analysis uses the experiment's imported measurements (corrected
                effective values). Fabrication-aware comparisons are not shown
                when confirmed device/substrate relationships are unavailable.
              </Text>
            </Stack>
          </Box>
        </Box>
      </Box>
    </Box>
  )
}
