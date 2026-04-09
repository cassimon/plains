import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Paper,
  ScrollArea,
  SegmentedControl,
  Select,
  Stack,
  Table,
  Text,
  Title,
  Tooltip,
  useMantineTheme,
} from "@mantine/core"
import { Dropzone, MIME_TYPES } from "@mantine/dropzone"
import {
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconFile,
  IconFlask,
  IconTrash,
  IconUpload,
  IconX,
} from "@tabler/icons-react"
import { useCallback, useState } from "react"
import {
  type DeviceGroup,
  type Experiment,
  type ExperimentResults,
  getExperimentStatus,
  type MeasurementFile,
  type MeasurementType,
  newExperimentResults,
  newMeasurementFile,
  useAppContext,
  useEntityCollection,
} from "../store/AppContext"

// ─────────────────────────────────────────────────────────────────────────────
// File Parsing Utilities (ported from Streamlit app)
// ─────────────────────────────────────────────────────────────────────────────

/** Get file category based on extension */
function getFileCategory(fileName: string): MeasurementType | null {
  const lower = fileName.toLowerCase()
  if (lower.endsWith(".txt")) {
    return "Unknown"
  } // Will be determined by content
  if (lower.match(/\.(png|jpg|jpeg|tiff|tif|gif|webp)$/)) {
    return "Image"
  }
  if (lower.match(/\.(pdf|docx?|odt|rtf)$/)) {
    return "Document"
  }
  if (lower.match(/\.(zip|7z|rar|tar|gz)$/)) {
    return "Archive"
  }
  return null
}

/** Extract device name from filename */
function extractDeviceFromFilename(fileName: string): string {
  // Remove extension
  const baseName = fileName.replace(/\.[^/.]+$/, "")

  // Pattern 1: Two uppercase letters followed by 2-3 digits anywhere in the
  // name (e.g. "AI44" inside "2025-11-19_AI44-1C"). Matches the primary
  // substrate-ID convention used in the lab.
  const match1 = baseName.match(/\b([A-Z]{2}\d{2,3})\b/)
  if (match1) {
    return match1[1]
  }

  // Pattern 2: Word containing letters-then-digits at start of basename
  // (e.g. "Device01")
  const match2 = baseName.match(/^([A-Za-z]+\d+)/)
  if (match2) {
    return match2[1].toUpperCase()
  }

  // Pattern 3: Anything before the first underscore or dash
  const match3 = baseName.match(/^([^_\-\s]+)/)
  if (match3) {
    return match3[1]
  }

  return baseName
}

/** Parse device name supporting formats like "AI44-1C" or "3C_C1_2" */
function parseDeviceName(deviceString: string): {
  device: string
  cell: string
  pixel: string
} {
  if (!deviceString) {
    return { device: "", cell: "", pixel: "" }
  }

  const trimmed = deviceString.trim()

  // New format: "AI44-1C"
  if (trimmed.includes("-")) {
    const parts = trimmed.split("-")
    if (parts.length === 2) {
      const device = parts[0]
      const tail = parts[1]
      const cell = tail.replace(/[^0-9]/g, "")
      const pixel = tail.replace(/[^A-Za-z]/g, "").toUpperCase()
      return { device, cell, pixel }
    }
  }

  // Old format: "3C_C1_2"
  const parts = trimmed.split("_")
  if (parts.length >= 3) {
    return {
      device: parts.slice(0, -2).join("_"),
      cell: parts[parts.length - 2],
      pixel: parts[parts.length - 1],
    }
  }
  if (parts.length === 2) {
    return { device: parts[0], cell: "", pixel: parts[1] }
  }

  return { device: trimmed, cell: "", pixel: "" }
}

/** Parse .txt file content to determine measurement type and extract data */
function parseTxtContent(
  content: string,
  fileName: string,
): Partial<MeasurementFile> {
  const lines = content.split("\n").map((l) => l.trim())

  let measurementType: MeasurementType = "Document"
  let value: number | undefined
  let deviceName = ""
  let user = ""
  let measurementDate = ""

  for (const line of lines) {
    const lower = line.toLowerCase()

    // Detect JV measurement
    if (
      lower.includes("jv") ||
      lower.includes("i-v") ||
      lower.includes("current-voltage")
    ) {
      measurementType = "JV"
    }
    // Detect Dark JV
    if (
      lower.includes("dark") &&
      (lower.includes("jv") || lower.includes("i-v"))
    ) {
      measurementType = "Dark JV"
    }
    // Detect IPCE
    if (
      lower.includes("ipce") ||
      lower.includes("eqe") ||
      lower.includes("quantum efficiency")
    ) {
      measurementType = "IPCE"
    }
    // Detect Stability measurements
    if (lower.includes("stability")) {
      if (lower.includes("tracking") || lower.includes("mpp")) {
        measurementType = "Stability (Tracking)"
      } else if (lower.includes("parameter")) {
        measurementType = "Stability (Parameters)"
      } else {
        measurementType = "Stability (JV)"
      }
    }

    // Extract PCE value
    const pceMatch = line.match(/pce[:\s]*(\d+\.?\d*)\s*%?/i)
    if (pceMatch) {
      value = parseFloat(pceMatch[1])
    }

    // Extract device name
    const deviceMatch = line.match(/device[:\s]*([^\s,]+)/i)
    if (deviceMatch) {
      deviceName = deviceMatch[1]
    }

    // Extract user
    const userMatch = line.match(/user[:\s]*([^\s,]+)/i)
    if (userMatch) {
      user = userMatch[1]
    }

    // Extract date
    const dateMatch = line.match(/date[:\s]*(\d{4}[-/]\d{2}[-/]\d{2})/i)
    if (dateMatch) {
      measurementDate = dateMatch[1]
    }
  }

  // If no device found in content, extract from filename
  if (!deviceName) {
    deviceName = extractDeviceFromFilename(fileName)
  }

  return {
    fileType: measurementType,
    deviceName,
    value,
    user,
    measurementDate,
  }
}

/** Compute similarity score between two strings (0-1) */
function stringSimilarity(str1: string, str2: string): number {
  const s1 = str1.toLowerCase()
  const s2 = str2.toLowerCase()

  if (s1 === s2) {
    return 1
  }
  if (s1.length === 0 || s2.length === 0) {
    return 0
  }

  // Simple Levenshtein-based similarity
  const longer = s1.length > s2.length ? s1 : s2
  const shorter = s1.length > s2.length ? s2 : s1

  if (longer.includes(shorter)) {
    return shorter.length / longer.length
  }

  // Count matching characters in order
  let matches = 0
  let j = 0
  for (let i = 0; i < longer.length && j < shorter.length; i++) {
    if (longer[i] === shorter[j]) {
      matches++
      j++
    }
  }

  return (2 * matches) / (s1.length + s2.length)
}

// ─────────────────────────────────────────────────────────────────────────────
// Experiment List Item (read-only version)
// ─────────────────────────────────────────────────────────────────────────────

function ExperimentListItem({
  experiment,
  isSelected,
  onSelect,
  collectionColor,
}: {
  experiment: Experiment
  isSelected: boolean
  onSelect: () => void
  collectionColor?: string
}) {
  const status = getExperimentStatus(experiment)
  const statusColor =
    status === "finished" ? "green" : status === "ready" ? "yellow" : "red"
  const statusLabel =
    status === "finished"
      ? "Finished"
      : status === "ready"
        ? "Ready"
        : "Incomplete"

  return (
    <Paper
      withBorder
      p="sm"
      radius="md"
      style={{
        cursor: "pointer",
        background: isSelected ? "var(--mantine-color-blue-0)" : undefined,
        borderColor: isSelected ? "var(--mantine-color-blue-4)" : undefined,
        borderLeft: collectionColor
          ? `4px solid ${collectionColor}`
          : undefined,
      }}
      onClick={onSelect}
    >
      <Group justify="space-between" wrap="nowrap">
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group gap="xs" mb={4}>
            <Text size="sm" fw={600} truncate>
              {experiment.name || "Untitled"}
            </Text>
            <Badge size="xs" color={statusColor} variant="dot">
              {statusLabel}
            </Badge>
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
// File Type Badge
// ─────────────────────────────────────────────────────────────────────────────

function FileTypeBadge({ type }: { type: MeasurementType }) {
  const colors: Record<MeasurementType, string> = {
    JV: "blue",
    "Dark JV": "indigo",
    IPCE: "cyan",
    "Stability (JV)": "teal",
    "Stability (Tracking)": "green",
    "Stability (Parameters)": "lime",
    Document: "gray",
    Image: "orange",
    Archive: "violet",
    Unknown: "gray",
  }

  return (
    <Badge size="xs" color={colors[type]} variant="light">
      {type}
    </Badge>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Device Group Card
// ─────────────────────────────────────────────────────────────────────────────

function DeviceGroupCard({
  group,
  substrates,
  onAssign,
  expanded,
  onToggleExpand,
}: {
  group: DeviceGroup
  substrates: { id: string; name: string }[]
  onAssign: (substrateId: string | null) => void
  expanded: boolean
  onToggleExpand: () => void
}) {
  return (
    <Paper withBorder p="sm" radius="md">
      <Group justify="space-between" mb="xs">
        <Group gap="sm">
          <ActionIcon variant="subtle" size="sm" onClick={onToggleExpand}>
            {expanded ? (
              <IconChevronDown size={14} />
            ) : (
              <IconChevronRight size={14} />
            )}
          </ActionIcon>
          <Text fw={600} size="sm">
            {group.deviceName || "(Unknown Device)"}
          </Text>
          <Badge size="xs" variant="light">
            {group.files.length} file{group.files.length !== 1 ? "s" : ""}
          </Badge>
        </Group>

        <Group gap="xs">
          {group.matchScore !== undefined && (
            <Tooltip
              label={`Match score: ${(group.matchScore * 100).toFixed(0)}%`}
            >
              <Badge
                size="xs"
                color={
                  group.matchScore > 0.8
                    ? "green"
                    : group.matchScore > 0.5
                      ? "yellow"
                      : "red"
                }
                variant="dot"
              >
                {(group.matchScore * 100).toFixed(0)}%
              </Badge>
            </Tooltip>
          )}
          <Select
            size="xs"
            placeholder="Assign to substrate..."
            value={group.assignedSubstrateId}
            onChange={(v) => onAssign(v)}
            data={[
              { value: "", label: "(Not matched)" },
              ...substrates.map((s) => ({ value: s.id, label: s.name })),
            ]}
            style={{ width: 180 }}
            clearable
          />
        </Group>
      </Group>

      {expanded && (
        <Box mt="sm" pl="xl">
          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th>File</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th>Cell</Table.Th>
                <Table.Th>Pixel</Table.Th>
                <Table.Th>Value</Table.Th>
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {group.files.map((file) => (
                <Table.Tr key={file.id}>
                  <Table.Td>
                    <Group gap="xs">
                      <IconFile size={14} />
                      <Text size="xs" truncate style={{ maxWidth: 200 }}>
                        {file.fileName}
                      </Text>
                    </Group>
                  </Table.Td>
                  <Table.Td>
                    <FileTypeBadge type={file.fileType} />
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">{file.cell || "—"}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">{file.pixel || "—"}</Text>
                  </Table.Td>
                  <Table.Td>
                    <Text size="xs">
                      {file.value !== undefined
                        ? `${file.value.toFixed(2)}%`
                        : "—"}
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ))}
            </Table.Tbody>
          </Table>
        </Box>
      )}
    </Paper>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Results Detail View
// ─────────────────────────────────────────────────────────────────────────────

function ResultsDetail({
  experiment,
  experimentResults,
  onUpdateResults,
}: {
  experiment: Experiment
  experimentResults: ExperimentResults | null
  onUpdateResults: (results: ExperimentResults) => void
}) {
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(new Set())
  const theme = useMantineTheme()

  const results = experimentResults ?? newExperimentResults(experiment.id)

  const toggleGroupExpand = (groupId: string) => {
    setExpandedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) {
        next.delete(groupId)
      } else {
        next.add(groupId)
      }
      return next
    })
  }

  // Group files by device name based on strategy
  const groupFilesByDevice = useCallback(
    (
      files: MeasurementFile[],
      strategy: "exact" | "search" | "fuzzy",
    ): DeviceGroup[] => {
      const groups: DeviceGroup[] = []
      const filesByDevice = new Map<string, MeasurementFile[]>()

      if (strategy === "exact") {
        // Group by exact device name
        for (const file of files) {
          const key = file.deviceName
          const existing = filesByDevice.get(key) ?? []
          existing.push(file)
          filesByDevice.set(key, existing)
        }
      } else if (strategy === "search") {
        // Group by exact device name — same as the Python app's
        // "Search by Device Name" which uses groupby("Device Name").
        // Files are only grouped together when their extracted device name
        // is identical (case-insensitive). Substring inclusion was removed
        // because it caused false merges (e.g. "AI4" folded into "AI44").
        for (const file of files) {
          const key = file.deviceName.toUpperCase()
          const existing = filesByDevice.get(key) ?? []
          existing.push(file)
          filesByDevice.set(key, existing)
        }
      } else {
        // Fuzzy matching - group similar names together
        const assigned = new Set<string>()
        for (const file of files) {
          if (assigned.has(file.id)) {
            continue
          }

          const groupFiles = [file]
          assigned.add(file.id)

          for (const other of files) {
            if (assigned.has(other.id)) {
              continue
            }
            const similarity = stringSimilarity(
              file.deviceName,
              other.deviceName,
            )
            if (similarity > 0.8) {
              groupFiles.push(other)
              assigned.add(other.id)
            }
          }

          const key = file.deviceName || `group-${groups.length}`
          filesByDevice.set(key, groupFiles)
        }
      }

      for (const [deviceName, groupFiles] of filesByDevice.entries()) {
        groups.push({
          id: crypto.randomUUID(),
          deviceName,
          files: groupFiles,
          assignedSubstrateId: null,
        })
      }

      return groups
    },
    [],
  )

  // Match groups to substrates
  const matchGroupsToSubstrates = useCallback(
    (
      groups: DeviceGroup[],
      substrates: { id: string; name: string }[],
      strategy: "fuzzy" | "sequential" | "manual",
    ): DeviceGroup[] => {
      if (strategy === "manual") {
        return groups // No auto-matching
      }

      if (strategy === "sequential") {
        return groups.map((group, idx) => ({
          ...group,
          assignedSubstrateId:
            idx < substrates.length ? substrates[idx].id : null,
          matchScore: idx < substrates.length ? 1 : 0,
        }))
      }

      // Fuzzy matching
      return groups.map((group) => {
        let bestMatch: { id: string; score: number } | null = null

        for (const substrate of substrates) {
          const score = stringSimilarity(group.deviceName, substrate.name)
          if (!bestMatch || score > bestMatch.score) {
            bestMatch = { id: substrate.id, score }
          }
        }

        return {
          ...group,
          assignedSubstrateId:
            bestMatch && bestMatch.score > 0.6 ? bestMatch.id : null,
          matchScore: bestMatch?.score ?? 0,
        }
      })
    },
    [],
  )

  // Process dropped files
  const handleDrop = useCallback(
    async (droppedFiles: File[]) => {
      const newFiles: MeasurementFile[] = []

      for (const file of droppedFiles) {
        const measurementFile = newMeasurementFile(file.name)
        const category = getFileCategory(file.name)

        if (category === null) {
          // Unsupported file type, skip
          continue
        }

        if (file.name.toLowerCase().endsWith(".txt")) {
          // Parse text content
          const content = await file.text()
          const parsed = parseTxtContent(content, file.name)
          Object.assign(measurementFile, parsed)

          // Parse device name for cell/pixel
          const { device, cell, pixel } = parseDeviceName(
            measurementFile.deviceName || "",
          )
          if (device) {
            measurementFile.deviceName = device
          }
          if (cell) {
            measurementFile.cell = cell
          }
          if (pixel) {
            measurementFile.pixel = pixel
          }
        } else {
          measurementFile.fileType = category
          measurementFile.deviceName = extractDeviceFromFilename(file.name)
        }

        newFiles.push(measurementFile)
      }

      if (newFiles.length === 0) {
        return
      }

      // Group files by device name
      const allFiles = [...results.files, ...newFiles]
      const deviceGroups = groupFilesByDevice(
        allFiles,
        results.groupingStrategy,
      )

      // Auto-match to substrates if using fuzzy/sequential
      const matchedGroups = matchGroupsToSubstrates(
        deviceGroups,
        experiment.substrates,
        results.matchingStrategy,
      )

      onUpdateResults({
        ...results,
        files: allFiles,
        deviceGroups: matchedGroups,
        updatedAt: new Date().toISOString(),
      })
    },
    [
      experiment.substrates,
      results,
      onUpdateResults,
      groupFilesByDevice,
      matchGroupsToSubstrates,
    ],
  )

  // Handle strategy changes
  const handleGroupingStrategyChange = (strategy: string) => {
    const newStrategy = strategy as "exact" | "search" | "fuzzy"
    const newGroups = groupFilesByDevice(results.files, newStrategy)
    const matchedGroups = matchGroupsToSubstrates(
      newGroups,
      experiment.substrates,
      results.matchingStrategy,
    )

    onUpdateResults({
      ...results,
      groupingStrategy: newStrategy,
      deviceGroups: matchedGroups,
      updatedAt: new Date().toISOString(),
    })
  }

  const handleMatchingStrategyChange = (strategy: string) => {
    const newStrategy = strategy as "fuzzy" | "sequential" | "manual"
    const matchedGroups = matchGroupsToSubstrates(
      results.deviceGroups,
      experiment.substrates,
      newStrategy,
    )

    onUpdateResults({
      ...results,
      matchingStrategy: newStrategy,
      deviceGroups: matchedGroups,
      updatedAt: new Date().toISOString(),
    })
  }

  const handleAssignSubstrate = (
    groupId: string,
    substrateId: string | null,
  ) => {
    const updatedGroups = results.deviceGroups.map((g) =>
      g.id === groupId ? { ...g, assignedSubstrateId: substrateId || null } : g,
    )

    onUpdateResults({
      ...results,
      deviceGroups: updatedGroups,
      updatedAt: new Date().toISOString(),
    })
  }

  const handleClearAll = () => {
    onUpdateResults({
      ...results,
      files: [],
      deviceGroups: [],
      updatedAt: new Date().toISOString(),
    })
  }

  const substrates = experiment.substrates.map((s) => ({
    id: s.id,
    name: s.name,
  }))
  const matchedCount = results.deviceGroups.filter(
    (g) => g.assignedSubstrateId,
  ).length
  const totalGroups = results.deviceGroups.length

  return (
    <Box style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      {/* Header */}
      <Group
        justify="space-between"
        p="md"
        style={{
          borderBottom: "1px solid var(--mantine-color-default-border)",
        }}
      >
        <Group gap="sm">
          <Title order={4}>Results for {experiment.name}</Title>
          <Badge color="blue" variant="light">
            {experiment.substrates.length} substrates
          </Badge>
        </Group>
        {results.files.length > 0 && (
          <Button
            size="xs"
            color="red"
            variant="subtle"
            leftSection={<IconTrash size={14} />}
            onClick={handleClearAll}
          >
            Clear All
          </Button>
        )}
      </Group>

      <ScrollArea style={{ flex: 1 }} p="md">
        <Stack gap="lg">
          {/* Drop Zone */}
          <Dropzone
            onDrop={handleDrop}
            accept={[
              MIME_TYPES.png,
              MIME_TYPES.jpeg,
              MIME_TYPES.gif,
              "text/plain",
              "application/pdf",
              "application/msword",
              "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              "application/zip",
              "application/x-7z-compressed",
              "image/tiff",
            ]}
            maxSize={50 * 1024 ** 2}
            style={{
              borderStyle: "dashed",
              borderWidth: 2,
              borderColor:
                results.files.length > 0
                  ? "var(--mantine-color-green-4)"
                  : "var(--mantine-color-gray-4)",
              background:
                results.files.length > 0
                  ? "var(--mantine-color-green-0)"
                  : "var(--mantine-color-gray-0)",
            }}
          >
            <Group
              justify="center"
              gap="xl"
              mih={120}
              style={{ pointerEvents: "none" }}
            >
              <Dropzone.Accept>
                <IconUpload
                  size={48}
                  color={theme.colors.blue[6]}
                  stroke={1.5}
                />
              </Dropzone.Accept>
              <Dropzone.Reject>
                <IconX size={48} color={theme.colors.red[6]} stroke={1.5} />
              </Dropzone.Reject>
              <Dropzone.Idle>
                {results.files.length > 0 ? (
                  <IconCheck
                    size={48}
                    color={theme.colors.green[6]}
                    stroke={1.5}
                  />
                ) : (
                  <IconUpload
                    size={48}
                    color={theme.colors.gray[4]}
                    stroke={1.5}
                  />
                )}
              </Dropzone.Idle>

              <div>
                <Text size="lg" inline fw={500}>
                  {results.files.length > 0
                    ? `${results.files.length} files uploaded`
                    : "Drop Results here"}
                </Text>
                <Text size="sm" c="dimmed" inline mt={7}>
                  {results.files.length > 0
                    ? "Drop more files to add them"
                    : "Drag & drop measurement files (.txt, images, documents)"}
                </Text>
              </div>
            </Group>
          </Dropzone>

          {results.files.length > 0 && (
            <>
              <Divider label="Grouping & Matching" labelPosition="center" />

              {/* Strategy Controls */}
              <Group grow>
                <Paper withBorder p="sm" radius="md">
                  <Text size="xs" fw={600} mb="xs" c="dimmed">
                    Data Grouping Strategy
                  </Text>
                  <SegmentedControl
                    fullWidth
                    size="xs"
                    value={results.groupingStrategy}
                    onChange={handleGroupingStrategyChange}
                    data={[
                      { value: "exact", label: "Exact Match" },
                      { value: "search", label: "Search" },
                      { value: "fuzzy", label: "Fuzzy" },
                    ]}
                  />
                </Paper>

                <Paper withBorder p="sm" radius="md">
                  <Text size="xs" fw={600} mb="xs" c="dimmed">
                    Substrate Matching Strategy
                  </Text>
                  <SegmentedControl
                    fullWidth
                    size="xs"
                    value={results.matchingStrategy}
                    onChange={handleMatchingStrategyChange}
                    data={[
                      { value: "fuzzy", label: "Fuzzy Match" },
                      { value: "sequential", label: "Sequential" },
                      { value: "manual", label: "Manual" },
                    ]}
                  />
                </Paper>
              </Group>

              {/* Summary */}
              <Paper
                withBorder
                p="sm"
                radius="md"
                style={{ background: "var(--mantine-color-blue-0)" }}
              >
                <Group justify="space-between">
                  <Group gap="lg">
                    <Group gap="xs">
                      <Text size="sm" fw={600}>
                        Device Groups:
                      </Text>
                      <Text size="sm">{totalGroups}</Text>
                    </Group>
                    <Group gap="xs">
                      <Text size="sm" fw={600}>
                        Matched:
                      </Text>
                      <Text
                        size="sm"
                        c={matchedCount === totalGroups ? "green" : "orange"}
                      >
                        {matchedCount} / {totalGroups}
                      </Text>
                    </Group>
                    <Group gap="xs">
                      <Text size="sm" fw={600}>
                        Total Files:
                      </Text>
                      <Text size="sm">{results.files.length}</Text>
                    </Group>
                  </Group>
                </Group>
              </Paper>

              <Divider label="Device Groups" labelPosition="center" />

              {/* Device Groups */}
              <Stack gap="sm">
                {results.deviceGroups.length === 0 ? (
                  <Text size="sm" c="dimmed" ta="center" py="md">
                    No device groups found. Drop files above to get started.
                  </Text>
                ) : (
                  results.deviceGroups.map((group) => (
                    <DeviceGroupCard
                      key={group.id}
                      group={group}
                      substrates={substrates}
                      onAssign={(substrateId) =>
                        handleAssignSubstrate(group.id, substrateId)
                      }
                      expanded={expandedGroups.has(group.id)}
                      onToggleExpand={() => toggleGroupExpand(group.id)}
                    />
                  ))
                )}
              </Stack>
            </>
          )}
        </Stack>
      </ScrollArea>
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────

export function ResultsPage() {
  const { experiments, results, setResults, setActiveEntity } = useAppContext()
  const { getEntityColor, isEntityVisible } = useEntityCollection()
  const [selectedExperimentId, setSelectedExperimentId] = useState<
    string | null
  >(null)

  const selectExperiment = (id: string | null) => {
    setSelectedExperimentId(id)
    setActiveEntity(id ? { kind: "experiment", id } : null)
  }

  const selectedExperiment = experiments.find(
    (e) => e.id === selectedExperimentId,
  )
  const experimentResults =
    results.find((r) => r.experimentId === selectedExperimentId) ?? null

  const updateResults = (updatedResults: ExperimentResults) => {
    setResults((prev) => {
      const exists = prev.some(
        (r) => r.experimentId === updatedResults.experimentId,
      )
      if (exists) {
        return prev.map((r) =>
          r.experimentId === updatedResults.experimentId ? updatedResults : r,
        )
      }
      return [...prev, updatedResults]
    })
  }

  // Filter experiments that are at least "ready" status
  const visibleExperiments = experiments.filter((e) => {
    if (!isEntityVisible("experiment", e.id)) {
      return false
    }
    const status = getExperimentStatus(e)
    // Show experiments that are ready or finished
    return status === "ready" || status === "finished"
  })

  return (
    <Box style={{ display: "flex", height: "calc(100vh - 60px)" }}>
      {/* Main: Results Detail */}
      <Box style={{ flex: 1, background: "var(--mantine-color-gray-0)" }}>
        {selectedExperiment ? (
          <ResultsDetail
            experiment={selectedExperiment}
            experimentResults={experimentResults}
            onUpdateResults={updateResults}
          />
        ) : (
          <Box
            style={{
              height: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
            }}
          >
            <IconFlask size={64} color="var(--mantine-color-gray-4)" />
            <Text size="lg" c="dimmed" mt="md">
              Select an experiment to upload results
            </Text>
            <Text size="sm" c="dimmed" mt="xs">
              Only experiments with "Ready" or "Finished" status are shown
            </Text>
          </Box>
        )}
      </Box>

      {/* Right Sidebar: Experiment List */}
      <Box
        style={{
          width: 280,
          borderLeft: "1px solid var(--mantine-color-default-border)",
          display: "flex",
          flexDirection: "column",
        }}
      >
        <Group
          justify="space-between"
          p="md"
          style={{
            borderBottom: "1px solid var(--mantine-color-default-border)",
          }}
        >
          <Title order={5}>Experiments</Title>
        </Group>

        <ScrollArea style={{ flex: 1 }} p="sm">
          <Stack gap="sm">
            {visibleExperiments.length === 0 ? (
              <Paper
                p="lg"
                ta="center"
                style={{ background: "var(--mantine-color-gray-0)" }}
              >
                <IconFlask size={32} color="var(--mantine-color-gray-5)" />
                <Text size="sm" c="dimmed" mt="sm">
                  No ready experiments
                </Text>
                <Text size="xs" c="dimmed" mt="xs">
                  Complete an experiment first
                </Text>
              </Paper>
            ) : (
              visibleExperiments.map((exp) => (
                <ExperimentListItem
                  key={exp.id}
                  experiment={exp}
                  isSelected={selectedExperimentId === exp.id}
                  onSelect={() => selectExperiment(exp.id)}
                  collectionColor={
                    getEntityColor("experiment", exp.id) ?? undefined
                  }
                />
              ))
            )}
          </Stack>
        </ScrollArea>
      </Box>
    </Box>
  )
}
