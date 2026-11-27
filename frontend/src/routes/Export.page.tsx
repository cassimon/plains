import { Alert, Button, Group, Select, Stack, Text, Title } from "@mantine/core"
import { notifications } from "@mantine/notifications"
import { IconDownload, IconInfoCircle } from "@tabler/icons-react"
import { useState } from "react"
import { OpenAPI } from "@/client/core/OpenAPI"
import { getTokenAsync } from "@/lib/keycloakInstance"
import { useAppContext } from "@/store/AppContext"

/**
 * Local scientific export: download one experiment's accepted scientific dataset
 * as a self-contained ZIP (measurements, curves, correction history, manifest
 * and unchanged original files). This is independent of NOMAD deposition.
 */
export function ExportPage() {
  const { experiments, results, flushSave } = useAppContext()
  const [experimentId, setExperimentId] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)

  const exportable = experiments.filter((e) =>
    results.some((r) => r.experimentId === e.id && r.files.length > 0),
  )

  const downloadExport = async () => {
    if (!experimentId) return
    setExporting(true)
    try {
      // Flush any pending debounced save so the export reflects the latest
      // committed state (never a stale local snapshot).
      await flushSave()
      const token = await getTokenAsync()
      const res = await fetch(
        `${OpenAPI.BASE}/api/v1/export/experiments/${experimentId}`,
        { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
      )
      if (!res.ok) {
        let detail: string | undefined
        try {
          detail = (await res.json())?.detail
        } catch {
          /* non-JSON error */
        }
        notifications.show({
          title: "Export failed",
          message: detail ?? `Request failed (${res.status})`,
          color: "red",
        })
        return
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = "experiment-export.zip"
      a.click()
      URL.revokeObjectURL(url)
      notifications.show({
        title: "Export ready",
        message: "Download started",
        color: "green",
      })
    } catch (err) {
      notifications.show({
        title: "Export failed",
        message: err instanceof Error ? err.message : String(err),
        color: "red",
      })
    } finally {
      setExporting(false)
    }
  }

  return (
    <Stack gap="md" p="md">
      <Title order={2}>Local scientific export</Title>
      <Alert
        variant="light"
        color="gray"
        icon={<IconInfoCircle size={16} />}
        p="xs"
      >
        <Text size="sm">
          Download an experiment's accepted scientific dataset locally, without
          depositing to NOMAD. The ZIP contains the effective (corrected)
          measurements, the original raw curves, the correction history, a
          provenance manifest, and the unchanged original source files.
        </Text>
      </Alert>

      {exportable.length === 0 ? (
        <Text size="sm" c="dimmed">
          No experiments with imported measurements are available to export.
        </Text>
      ) : (
        <Group align="end" gap="sm">
          <Select
            label="Experiment"
            placeholder="Select an experiment"
            data={exportable.map((e) => ({
              value: e.id,
              label: e.name || "Untitled",
            }))}
            value={experimentId}
            onChange={setExperimentId}
            style={{ width: 320 }}
            searchable
          />
          <Button
            leftSection={<IconDownload size={16} />}
            loading={exporting}
            disabled={!experimentId}
            onClick={() => void downloadExport()}
          >
            Download ZIP
          </Button>
        </Group>
      )}
    </Stack>
  )
}
