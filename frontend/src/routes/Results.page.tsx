import {
  ActionIcon,
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Code,
  Divider,
  Group,
  Loader,
  Modal,
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
import { modals } from "@mantine/modals"
import { notifications } from "@mantine/notifications"
import {
  IconArrowBackUp,
  IconCheck,
  IconChevronDown,
  IconChevronRight,
  IconCloudUpload,
  IconExternalLink,
  IconFile,
  IconFlask,
  IconTrash,
  IconUpload,
  IconX,
} from "@tabler/icons-react"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { OpenAPI } from "../client/core/OpenAPI"
import { NomadService } from "../client/sdk.gen"
import type {
  NomadConfigResponse,
  NomadUploadRequest,
  NomadUploadResponse,
} from "../client/types.gen"
import {
  type CanvasCollectionElement,
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
  const s1 = str1.trim().toLowerCase()
  const s2 = str2.trim().toLowerCase()

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
  onDeleteFile,
  onDeleteGroup,
  onDropUngroupedFile,
  onDragEnter,
  onDragLeave,
  isDropTarget,
  expanded,
  onToggleExpand,
}: {
  group: DeviceGroup
  substrates: { id: string; name: string }[]
  onAssign: (substrateId: string | null) => void
  onDeleteFile: (fileId: string) => void
  onDeleteGroup: () => void
  onDropUngroupedFile: (fileId: string) => void
  onDragEnter: () => void
  onDragLeave: () => void
  isDropTarget: boolean
  expanded: boolean
  onToggleExpand: () => void
}) {
  return (
    <Paper
      withBorder
      p="sm"
      radius="md"
      onDragOver={(e) => {
        e.preventDefault()
        onDragEnter()
      }}
      onDragLeave={onDragLeave}
      onDrop={(e) => {
        e.preventDefault()
        const fileId = e.dataTransfer.getData("text/plain")
        if (fileId) {
          onDropUngroupedFile(fileId)
        }
        onDragLeave()
      }}
      style={{
        borderColor: isDropTarget ? "var(--mantine-color-blue-5)" : undefined,
        background: isDropTarget ? "var(--mantine-color-blue-0)" : undefined,
      }}
    >
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
          <Tooltip label="Delete group (files become ungrouped)" withArrow>
            <ActionIcon
              size="xs"
              variant="subtle"
              color="red"
              onClick={onDeleteGroup}
            >
              <IconTrash size={12} />
            </ActionIcon>
          </Tooltip>
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
                <Table.Th style={{ width: 40 }} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {group.files.map((file) => (
                <Table.Tr key={file.id}>
                  <Table.Td style={{ maxWidth: 260 }}>
                    <Tooltip
                      label={file.fileName}
                      position="top-start"
                      withArrow
                      openDelay={300}
                    >
                      <Group
                        gap={4}
                        wrap="nowrap"
                        style={{ overflow: "hidden" }}
                      >
                        <IconFile size={14} style={{ flexShrink: 0 }} />
                        <Text
                          size="xs"
                          style={{
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                            whiteSpace: "nowrap",
                            maxWidth: 220,
                            cursor: "default",
                          }}
                        >
                          {file.fileName}
                        </Text>
                      </Group>
                    </Tooltip>
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
                  <Table.Td>
                    <Tooltip label="Move to ungrouped" withArrow>
                      <ActionIcon
                        size="xs"
                        variant="subtle"
                        color="red"
                        onClick={() => onDeleteFile(file.id)}
                      >
                        <IconX size={12} />
                      </ActionIcon>
                    </Tooltip>
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

  // NOMAD upload state
  const [nomadConfig, setNomadConfig] = useState<NomadConfigResponse | null>(
    null,
  )
  const [nomadUploading, setNomadUploading] = useState(false)
  const [nomadMetadataPreview, setNomadMetadataPreview] = useState<
    string | null
  >(null)
  const [showMetadataModal, setShowMetadataModal] = useState(false)
  const [fabricationMetadataPreview, setFabricationMetadataPreview] = useState<
    string | null
  >(null)
  const [showFabricationModal, setShowFabricationModal] = useState(false)
  const [uploadedFiles, setUploadedFiles] = useState<File[]>([])
  const [selectedUngroupedFileIds, setSelectedUngroupedFileIds] = useState<
    Set<string>
  >(new Set())
  const [moveTargetGroupId, setMoveTargetGroupId] = useState<string | null>(
    null,
  )
  const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(
    null,
  )

  // Fetch NOMAD config on mount
  useEffect(() => {
    NomadService.getNomadConfig()
      .then(setNomadConfig)
      .catch((err: unknown) =>
        console.warn("Failed to fetch NOMAD config:", err),
      )
  }, [])

  // Undo-delete state: keeps recently deleted files for a short window
  type DeletedEntry = {
    file: MeasurementFile
    groupId: string
    groupDeviceName: string
    deletedAt: number
  }
  const [deletedFiles, setDeletedFiles] = useState<DeletedEntry[]>([])
  const undoTimerRef = useRef<number | null>(null)

  const fallbackResults = useMemo(
    () => newExperimentResults(experiment.id),
    [experiment.id],
  )
  const results = experimentResults ?? fallbackResults

  const groupedFileIds = useMemo(() => {
    const ids = new Set<string>()
    for (const group of results.deviceGroups) {
      for (const file of group.files) {
        ids.add(file.id)
      }
    }
    return ids
  }, [results.deviceGroups])

  const ungroupedFiles = useMemo(
    () => results.files.filter((file) => !groupedFileIds.has(file.id)),
    [results.files, groupedFileIds],
  )

  useEffect(() => {
    setSelectedUngroupedFileIds((prev) => {
      const next = new Set<string>()
      const validIds = new Set(ungroupedFiles.map((f) => f.id))
      for (const id of prev) {
        if (validIds.has(id)) {
          next.add(id)
        }
      }

      // Avoid unnecessary state updates that can trigger re-render loops.
      if (next.size === prev.size) {
        let changed = false
        for (const id of prev) {
          if (!next.has(id)) {
            changed = true
            break
          }
        }
        if (!changed) {
          return prev
        }
      }

      return next
    })

    if (
      moveTargetGroupId &&
      !results.deviceGroups.some((g) => g.id === moveTargetGroupId)
    ) {
      setMoveTargetGroupId(null)
    }
  }, [ungroupedFiles, moveTargetGroupId, results.deviceGroups])

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

      // Store the actual File objects for NOMAD upload
      setUploadedFiles((prev) => [
        ...prev,
        ...droppedFiles.filter((f) => {
          const category = getFileCategory(f.name)
          return category !== null
        }),
      ])

      // Group files by device name while preserving existing ungrouped files
      const groupedExistingFiles = results.files.filter((f) =>
        groupedFileIds.has(f.id),
      )
      const allFiles = [...results.files, ...newFiles]
      const deviceGroups = groupFilesByDevice(
        [...groupedExistingFiles, ...newFiles],
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
      groupedFileIds,
      onUpdateResults,
      groupFilesByDevice,
      matchGroupsToSubstrates,
    ],
  )

  // Handle strategy changes
  const handleGroupingStrategyChange = (strategy: string) => {
    const newStrategy = strategy as "exact" | "search" | "fuzzy"
    const groupedExistingFiles = results.files.filter((f) =>
      groupedFileIds.has(f.id),
    )
    const newGroups = groupFilesByDevice(groupedExistingFiles, newStrategy)
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

  const moveFilesToGroup = useCallback(
    (fileIds: string[], groupId: string) => {
      if (fileIds.length === 0) {
        return
      }

      const targetGroup = results.deviceGroups.find((g) => g.id === groupId)
      if (!targetGroup) {
        return
      }

      const moveSet = new Set(fileIds)
      const filesToMove = results.files.filter((f) => moveSet.has(f.id))
      if (filesToMove.length === 0) {
        return
      }

      const updatedGroups = results.deviceGroups
        .map((group) => ({
          ...group,
          files: group.files.filter((file) => !moveSet.has(file.id)),
        }))
        .filter((group) => group.files.length > 0 || group.id === groupId)
        .map((group) => {
          if (group.id !== groupId) {
            return group
          }
          const existingIds = new Set(group.files.map((f) => f.id))
          const appended = filesToMove.filter((f) => !existingIds.has(f.id))
          return { ...group, files: [...group.files, ...appended] }
        })

      onUpdateResults({
        ...results,
        deviceGroups: updatedGroups,
        updatedAt: new Date().toISOString(),
      })
      setSelectedUngroupedFileIds((prev) => {
        const next = new Set(prev)
        for (const id of fileIds) {
          next.delete(id)
        }
        return next
      })
    },
    [results, onUpdateResults],
  )

  const handleMoveSelectedToGroup = () => {
    if (!moveTargetGroupId) {
      notifications.show({
        title: "Select a Group",
        message: "Choose a target group before moving files.",
        color: "orange",
      })
      return
    }
    moveFilesToGroup(Array.from(selectedUngroupedFileIds), moveTargetGroupId)
  }

  const handleDeleteGroup = (groupId: string) => {
    onUpdateResults({
      ...results,
      deviceGroups: results.deviceGroups.filter((g) => g.id !== groupId),
      updatedAt: new Date().toISOString(),
    })
  }

  // ── Per-file ungroup with undo ─────────────────────────────────────────────
  const UNDO_WINDOW_MS = 7000

  const handleDeleteFile = useCallback(
    (fileId: string) => {
      // Find which group owns this file
      const owningGroup = results.deviceGroups.find((g) =>
        g.files.some((f) => f.id === fileId),
      )
      const file = owningGroup?.files.find((f) => f.id === fileId)
      if (!owningGroup || !file) return

      // Push to undo stack
      const entry: DeletedEntry = {
        file,
        groupId: owningGroup.id,
        groupDeviceName: owningGroup.deviceName,
        deletedAt: Date.now(),
      }
      setDeletedFiles((prev) => [entry, ...prev.slice(0, 4)])

      // Reset auto-dismiss timer
      if (undoTimerRef.current !== null)
        window.clearTimeout(undoTimerRef.current)
      undoTimerRef.current = window.setTimeout(() => {
        setDeletedFiles([])
      }, UNDO_WINDOW_MS)

      // Remove from groups; drop group entirely if it becomes empty.
      // Files remain in results.files and show up in "Ungrouped Files".
      const newGroups = results.deviceGroups
        .map((g) =>
          g.id === owningGroup.id
            ? { ...g, files: g.files.filter((f) => f.id !== fileId) }
            : g,
        )
        .filter((g) => g.files.length > 0)

      onUpdateResults({
        ...results,
        deviceGroups: newGroups,
        updatedAt: new Date().toISOString(),
      })
    },
    [results, onUpdateResults],
  )

  const handleUndoDelete = useCallback(() => {
    if (deletedFiles.length === 0) return
    const [entry, ...remaining] = deletedFiles
    setDeletedFiles(remaining)

    // Re-insert into group (or create the group if it was removed)
    const groupExists = results.deviceGroups.some((g) => g.id === entry.groupId)
    const newGroups = groupExists
      ? results.deviceGroups.map((g) =>
          g.id === entry.groupId
            ? { ...g, files: [...g.files, entry.file] }
            : g,
        )
      : [
          ...results.deviceGroups,
          {
            id: entry.groupId,
            deviceName: entry.groupDeviceName,
            files: [entry.file],
            assignedSubstrateId: null,
          },
        ]

    onUpdateResults({
      ...results,
      deviceGroups: newGroups,
      updatedAt: new Date().toISOString(),
    })
  }, [deletedFiles, results, onUpdateResults])

  // Clean up timer on unmount
  useEffect(
    () => () => {
      if (undoTimerRef.current !== null)
        window.clearTimeout(undoTimerRef.current)
    },
    [],
  )

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
  const ungroupedCount = ungroupedFiles.length
  const allAssigned = totalGroups > 0 && matchedCount === totalGroups

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
                    <Group gap="xs">
                      <Text size="sm" fw={600}>
                        Ungrouped:
                      </Text>
                      <Text size="sm">{ungroupedCount}</Text>
                    </Group>
                  </Group>
                </Group>
              </Paper>

              {/* Undo-delete notification */}
              {deletedFiles.length > 0 && (
                <Alert
                  icon={<IconArrowBackUp size={16} />}
                  color="orange"
                  radius="md"
                  withCloseButton
                  onClose={() => setDeletedFiles([])}
                >
                  <Group justify="space-between" wrap="nowrap">
                    <Text size="sm">
                      <Text span fw={600}>
                        {deletedFiles[0].file.fileName}
                      </Text>{" "}
                      moved to ungrouped
                      {deletedFiles.length > 1 &&
                        ` (+${deletedFiles.length - 1} more)`}
                    </Text>
                    <Button
                      size="xs"
                      variant="subtle"
                      color="orange"
                      leftSection={<IconArrowBackUp size={14} />}
                      onClick={handleUndoDelete}
                    >
                      Undo
                    </Button>
                  </Group>
                </Alert>
              )}

              {/* All-assigned completion banner */}
              {allAssigned && (
                <Alert
                  icon={<IconCheck size={18} />}
                  color="green"
                  radius="md"
                  title="All device groups assigned!"
                >
                  <Group justify="space-between" align="center">
                    <Text size="sm">
                      All {totalGroups} device group
                      {totalGroups !== 1 ? "s are" : " is"} matched to a
                      substrate.
                    </Text>
                    <Group gap="xs">
                      <Button
                        size="sm"
                        variant="light"
                        color="blue"
                        onClick={async () => {
                          try {
                            const preview =
                              await NomadService.previewNomadMetadata({
                                requestBody: {
                                  experiment_id: experiment.id,
                                  experiment_name: experiment.name,
                                  custom_metadata: {
                                    experiment,
                                  },
                                  substrates: substrates,
                                  measurement_files: results.files.map((f) => ({
                                    fileName: f.fileName,
                                    fileType: f.fileType,
                                    deviceName: f.deviceName,
                                    cell: f.cell,
                                    pixel: f.pixel,
                                    value: f.value,
                                  })),
                                  device_groups: results.deviceGroups.map(
                                    (g) => ({
                                      id: g.id,
                                      deviceName: g.deviceName,
                                      assignedSubstrateId:
                                        g.assignedSubstrateId,
                                      files: g.files.map((f) => ({
                                        fileName: f.fileName,
                                        fileType: f.fileType,
                                        deviceName: f.deviceName,
                                        cell: f.cell,
                                        pixel: f.pixel,
                                        value: f.value,
                                      })),
                                    }),
                                  ),
                                },
                              })
                            setNomadMetadataPreview(preview.yaml_content)
                            setShowMetadataModal(true)
                          } catch (_err) {
                            notifications.show({
                              title: "Error",
                              message: "Failed to generate metadata preview",
                              color: "red",
                            })
                          }
                        }}
                      >
                        Preview File Metadata
                      </Button>
                      <Button
                        size="sm"
                        variant="light"
                        color="violet"
                        onClick={async () => {
                          try {
                            const preview =
                              await NomadService.previewNomadMetadata({
                                requestBody: {
                                  experiment_id: experiment.id,
                                  experiment_name: experiment.name,
                                  custom_metadata: {
                                    experiment,
                                  },
                                  substrates: substrates,
                                  measurement_files: results.files.map((f) => ({
                                    fileName: f.fileName,
                                    fileType: f.fileType,
                                    deviceName: f.deviceName,
                                    cell: f.cell,
                                    pixel: f.pixel,
                                    value: f.value,
                                  })),
                                  device_groups: results.deviceGroups.map(
                                    (g) => ({
                                      id: g.id,
                                      deviceName: g.deviceName,
                                      assignedSubstrateId:
                                        g.assignedSubstrateId,
                                      files: g.files.map((f) => ({
                                        fileName: f.fileName,
                                        fileType: f.fileType,
                                        deviceName: f.deviceName,
                                        cell: f.cell,
                                        pixel: f.pixel,
                                        value: f.value,
                                      })),
                                    }),
                                  ),
                                },
                              })
                            // Show fabrication metadata JSON (first substrate)
                            console.log(
                              "Fabrication metadata response:",
                              preview,
                            )
                            const jsonStr = JSON.stringify(
                              preview.metadata_json,
                              null,
                              2,
                            )
                            console.log("Stringified metadata:", jsonStr)
                            setFabricationMetadataPreview(
                              jsonStr || "No metadata available",
                            )
                            setShowFabricationModal(true)
                          } catch (_err) {
                            notifications.show({
                              title: "Error",
                              message:
                                "Failed to generate fabrication metadata preview",
                              color: "red",
                            })
                          }
                        }}
                      >
                        Preview Fabrication Metadata
                      </Button>
                      <Button
                        size="sm"
                        color="green"
                        leftSection={
                          nomadUploading ? (
                            <Loader size={14} color="white" />
                          ) : (
                            <IconCloudUpload size={16} />
                          )
                        }
                        disabled={nomadUploading || !nomadConfig?.enabled}
                        onClick={async () => {
                          if (!nomadConfig?.enabled) {
                            notifications.show({
                              title: "NOMAD Not Configured",
                              message:
                                "Please configure NOMAD credentials in the auth file (../sensitive config/.nomad_auth)",
                              color: "orange",
                            })
                            return
                          }

                          modals.openConfirmModal({
                            title: "Save to NOMAD",
                            children: (
                              <Stack gap="sm">
                                <Text size="sm">
                                  This will export all {results.files.length}{" "}
                                  file
                                  {results.files.length !== 1 ? "s" : ""} with
                                  their substrate assignments to NOMAD.
                                </Text>
                                <Text size="xs" c="dimmed">
                                  Using NOMAD URL: {nomadConfig.url}
                                </Text>
                              </Stack>
                            ),
                            labels: {
                              confirm: "Upload to NOMAD",
                              cancel: "Cancel",
                            },
                            confirmProps: {
                              color: "green",
                              leftSection: <IconCloudUpload size={14} />,
                            },
                            onConfirm: async () => {
                              setNomadUploading(true)
                              try {
                                // Build request data
                                const requestData: NomadUploadRequest = {
                                  experiment_id: experiment.id,
                                  experiment_name: experiment.name,
                                  custom_metadata: {
                                    experiment,
                                  },
                                  substrates: substrates,
                                  measurement_files: results.files.map((f) => ({
                                    fileName: f.fileName,
                                    fileType: f.fileType,
                                    deviceName: f.deviceName,
                                    cell: f.cell,
                                    pixel: f.pixel,
                                    value: f.value,
                                  })),
                                  device_groups: results.deviceGroups.map(
                                    (g) => ({
                                      id: g.id,
                                      deviceName: g.deviceName,
                                      assignedSubstrateId:
                                        g.assignedSubstrateId,
                                      files: g.files.map((f) => ({
                                        fileName: f.fileName,
                                        fileType: f.fileType,
                                        deviceName: f.deviceName,
                                        cell: f.cell,
                                        pixel: f.pixel,
                                        value: f.value,
                                      })),
                                    }),
                                  ),
                                }

                                // Create FormData for the upload
                                const formData = new FormData()

                                // Add uploaded files if we have them stored
                                // Note: In production, you'd store the actual File objects
                                // For now, we'll create placeholder files from the metadata
                                for (const file of uploadedFiles) {
                                  formData.append("files", file)
                                }

                                // If no files stored, we need to handle this differently
                                // The backend will need to work with metadata only
                                if (uploadedFiles.length === 0) {
                                  notifications.show({
                                    title: "Note",
                                    message:
                                      "No files to upload. Metadata will be saved.",
                                    color: "blue",
                                  })
                                }

                                // Make the upload request
                                const token =
                                  OpenAPI.TOKEN ||
                                  localStorage.getItem("access_token")
                                const response = await fetch(
                                  `${OpenAPI.BASE}/api/v1/nomad/upload/nomad`,
                                  {
                                    method: "POST",
                                    headers: {
                                      "Content-Type": "application/json",
                                      Authorization: `Bearer ${token}`,
                                    },
                                    body: JSON.stringify(requestData),
                                  },
                                )

                                const result: NomadUploadResponse =
                                  await response.json()

                                if (result.success) {
                                  // Update results with NOMAD info
                                  const updatedResults = {
                                    ...results,
                                    nomad: {
                                      upload_id: result.upload_id ?? undefined,
                                      entry_ids: result.entry_ids ?? undefined,
                                      upload_time:
                                        result.upload_create_time ?? undefined,
                                      status:
                                        result.processing_status ?? undefined,
                                    },
                                    updatedAt: new Date().toISOString(),
                                  }
                                  onUpdateResults(updatedResults)

                                  notifications.show({
                                    title: "Upload Successful!",
                                    message: (
                                      <Stack gap={4}>
                                        <Text size="sm">
                                          Data uploaded to NOMAD.
                                        </Text>
                                        <Text size="xs" c="dimmed">
                                          Upload ID: {result.upload_id}
                                        </Text>
                                      </Stack>
                                    ),
                                    color: "green",
                                    autoClose: 10000,
                                  })

                                  // Show success modal with details
                                  modals.open({
                                    title: "NOMAD Upload Complete",
                                    children: (
                                      <Stack gap="md">
                                        <Alert
                                          color="green"
                                          icon={<IconCheck size={16} />}
                                        >
                                          Successfully uploaded to NOMAD
                                        </Alert>
                                        <Table>
                                          <Table.Tbody>
                                            <Table.Tr>
                                              <Table.Td fw={600}>
                                                Upload ID
                                              </Table.Td>
                                              <Table.Td>
                                                <Code>{result.upload_id}</Code>
                                              </Table.Td>
                                            </Table.Tr>
                                            {result.entry_ids &&
                                              result.entry_ids.length > 0 && (
                                                <Table.Tr>
                                                  <Table.Td fw={600}>
                                                    Entry IDs
                                                  </Table.Td>
                                                  <Table.Td>
                                                    {result.entry_ids.map(
                                                      (
                                                        id: string,
                                                        i: number,
                                                      ) => (
                                                        <Code key={i} block>
                                                          {id}
                                                        </Code>
                                                      ),
                                                    )}
                                                  </Table.Td>
                                                </Table.Tr>
                                              )}
                                            <Table.Tr>
                                              <Table.Td fw={600}>
                                                Upload Time
                                              </Table.Td>
                                              <Table.Td>
                                                {result.upload_create_time}
                                              </Table.Td>
                                            </Table.Tr>
                                            <Table.Tr>
                                              <Table.Td fw={600}>
                                                Status
                                              </Table.Td>
                                              <Table.Td>
                                                <Badge color="blue">
                                                  {result.processing_status ||
                                                    "Processing"}
                                                </Badge>
                                              </Table.Td>
                                            </Table.Tr>
                                          </Table.Tbody>
                                        </Table>
                                        <Button
                                          variant="light"
                                          leftSection={
                                            <IconExternalLink size={14} />
                                          }
                                          onClick={() => {
                                            const nomadUrl =
                                              nomadConfig?.url?.replace(
                                                "/api/v1",
                                                "",
                                              ) ||
                                              "https://nomad-lab.eu/prod/v1/test"
                                            window.open(
                                              `${nomadUrl}/user/uploads/upload/id/${result.upload_id}`,
                                              "_blank",
                                            )
                                          }}
                                        >
                                          View in NOMAD
                                        </Button>
                                      </Stack>
                                    ),
                                  })
                                } else {
                                  notifications.show({
                                    title: "Upload Failed",
                                    message:
                                      result.message ||
                                      "Unknown error occurred",
                                    color: "red",
                                  })
                                }
                              } catch (err) {
                                console.error("NOMAD upload error:", err)
                                notifications.show({
                                  title: "Upload Error",
                                  message:
                                    err instanceof Error
                                      ? err.message
                                      : "Failed to upload to NOMAD",
                                  color: "red",
                                })
                              } finally {
                                setNomadUploading(false)
                              }
                            },
                          })
                        }}
                      >
                        {nomadUploading ? "Uploading..." : "Save to NOMAD"}
                      </Button>
                    </Group>
                  </Group>
                </Alert>
              )}

              {/* NOMAD Info Display (if already uploaded) */}
              {results.nomad?.upload_id && (
                <Alert
                  icon={<IconCloudUpload size={16} />}
                  color="blue"
                  radius="md"
                  title="Uploaded to NOMAD"
                >
                  <Stack gap="xs">
                    <Group gap="lg">
                      <Text size="sm">
                        <Text span fw={600}>
                          Upload ID:
                        </Text>{" "}
                        <Code>{results.nomad.upload_id}</Code>
                      </Text>
                      {results.nomad.entry_ids &&
                        results.nomad.entry_ids.length > 0 && (
                          <Text size="sm">
                            <Text span fw={600}>
                              Entries:
                            </Text>{" "}
                            {results.nomad.entry_ids.length}
                          </Text>
                        )}
                    </Group>
                    <Button
                      size="xs"
                      variant="light"
                      leftSection={<IconExternalLink size={14} />}
                      onClick={() => {
                        const nomadUrl =
                          nomadConfig?.url?.replace("/api/v1", "") ||
                          "https://nomad-lab.eu/prod/v1/test"
                        window.open(
                          `${nomadUrl}/user/uploads/upload/id/${results.nomad?.upload_id}`,
                          "_blank",
                        )
                      }}
                    >
                      View in NOMAD
                    </Button>
                  </Stack>
                </Alert>
              )}

              {/* File Metadata Preview Modal */}
              <Modal
                opened={showMetadataModal}
                onClose={() => setShowMetadataModal(false)}
                title="NOMAD File Metadata Preview"
                size="xl"
              >
                <Stack gap="md">
                  <Text size="sm" c="dimmed">
                    This YAML will be included in your upload to describe the
                    data structure.
                  </Text>
                  <ScrollArea
                    style={{
                      height: "60vh",
                      background: "var(--mantine-color-gray-0)",
                      padding: 8,
                      borderRadius: 6,
                    }}
                  >
                    <pre
                      style={{
                        whiteSpace: "pre-wrap",
                        fontFamily: "monospace",
                        fontSize: 12,
                        margin: 0,
                      }}
                    >
                      {nomadMetadataPreview || ""}
                    </pre>
                  </ScrollArea>
                  <Button onClick={() => setShowMetadataModal(false)}>
                    Close
                  </Button>
                </Stack>
              </Modal>

              {/* Fabrication Metadata Preview Modal */}
              <Modal
                opened={showFabricationModal}
                onClose={() => setShowFabricationModal(false)}
                title="NOMAD Fabrication Metadata Preview (First Substrate)"
                size="xl"
              >
                <Stack gap="md">
                  <Text size="sm" c="dimmed">
                    This shows the perovskite solar cell fabrication metadata
                    that will be uploaded to NOMAD for the first substrate.
                  </Text>
                  <ScrollArea
                    style={{
                      height: "60vh",
                      background: "var(--mantine-color-gray-0)",
                      padding: 8,
                      borderRadius: 6,
                    }}
                  >
                    <pre
                      style={{
                        whiteSpace: "pre-wrap",
                        fontFamily: "monospace",
                        fontSize: 12,
                        margin: 0,
                      }}
                    >
                      {fabricationMetadataPreview || ""}
                    </pre>
                  </ScrollArea>
                  <Button onClick={() => setShowFabricationModal(false)}>
                    Close
                  </Button>
                </Stack>
              </Modal>

              <Divider label="Device Groups" labelPosition="center" />

              <Group align="flex-start" grow wrap="nowrap">
                <Paper
                  withBorder
                  p="sm"
                  radius="md"
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <Stack gap="sm">
                    <Group justify="space-between" align="center">
                      <Group gap="xs">
                        <Text size="sm" fw={600}>
                          Ungrouped Files
                        </Text>
                        <Badge size="xs" variant="light">
                          {ungroupedFiles.length}
                        </Badge>
                      </Group>
                      <Group gap="xs">
                        <Button
                          size="xs"
                          variant="subtle"
                          onClick={() => {
                            if (
                              selectedUngroupedFileIds.size ===
                              ungroupedFiles.length
                            ) {
                              setSelectedUngroupedFileIds(new Set())
                            } else {
                              setSelectedUngroupedFileIds(
                                new Set(ungroupedFiles.map((f) => f.id)),
                              )
                            }
                          }}
                        >
                          {selectedUngroupedFileIds.size ===
                          ungroupedFiles.length
                            ? "Clear"
                            : "Select All"}
                        </Button>
                        <Select
                          size="xs"
                          placeholder="Select group..."
                          value={moveTargetGroupId}
                          onChange={setMoveTargetGroupId}
                          data={results.deviceGroups.map((g) => ({
                            value: g.id,
                            label: `${g.deviceName || "(Unknown Device)"} (${g.files.length})`,
                          }))}
                          style={{ width: 220 }}
                        />
                        <Button
                          size="xs"
                          onClick={handleMoveSelectedToGroup}
                          disabled={
                            selectedUngroupedFileIds.size === 0 ||
                            results.deviceGroups.length === 0
                          }
                        >
                          Move to Group
                        </Button>
                      </Group>
                    </Group>

                    {ungroupedFiles.length === 0 ? (
                      <Text size="sm" c="dimmed">
                        No ungrouped files.
                      </Text>
                    ) : (
                      <Table striped>
                        <Table.Thead>
                          <Table.Tr>
                            <Table.Th style={{ width: 30 }} />
                            <Table.Th>File</Table.Th>
                            <Table.Th>Type</Table.Th>
                            <Table.Th>Device</Table.Th>
                            <Table.Th>Cell</Table.Th>
                            <Table.Th>Pixel</Table.Th>
                          </Table.Tr>
                        </Table.Thead>
                        <Table.Tbody>
                          {ungroupedFiles.map((file) => (
                            <Table.Tr
                              key={file.id}
                              draggable
                              onDragStart={(e) => {
                                e.dataTransfer.setData("text/plain", file.id)
                                e.dataTransfer.effectAllowed = "move"
                              }}
                              style={{ cursor: "grab" }}
                            >
                              <Table.Td>
                                <Checkbox
                                  checked={selectedUngroupedFileIds.has(
                                    file.id,
                                  )}
                                  onChange={(e) => {
                                    const checked = e.currentTarget.checked
                                    setSelectedUngroupedFileIds((prev) => {
                                      const next = new Set(prev)
                                      if (checked) {
                                        next.add(file.id)
                                      } else {
                                        next.delete(file.id)
                                      }
                                      return next
                                    })
                                  }}
                                />
                              </Table.Td>
                              <Table.Td>
                                <Group
                                  gap={4}
                                  wrap="nowrap"
                                  style={{ overflow: "hidden", maxWidth: 280 }}
                                >
                                  <IconFile
                                    size={14}
                                    style={{ flexShrink: 0 }}
                                  />
                                  <Text
                                    size="xs"
                                    style={{
                                      overflow: "hidden",
                                      textOverflow: "ellipsis",
                                      whiteSpace: "nowrap",
                                    }}
                                  >
                                    {file.fileName}
                                  </Text>
                                </Group>
                              </Table.Td>
                              <Table.Td>
                                <FileTypeBadge type={file.fileType} />
                              </Table.Td>
                              <Table.Td>
                                <Text size="xs">{file.deviceName || "—"}</Text>
                              </Table.Td>
                              <Table.Td>
                                <Text size="xs">{file.cell || "—"}</Text>
                              </Table.Td>
                              <Table.Td>
                                <Text size="xs">{file.pixel || "—"}</Text>
                              </Table.Td>
                            </Table.Tr>
                          ))}
                        </Table.Tbody>
                      </Table>
                    )}
                  </Stack>
                </Paper>

                <Paper
                  withBorder
                  p="sm"
                  radius="md"
                  style={{ flex: 1, minWidth: 0 }}
                >
                  <Stack gap="sm">
                    <Group justify="space-between" align="center">
                      <Group gap="xs">
                        <Text size="sm" fw={600}>
                          File Groups
                        </Text>
                        <Badge size="xs" variant="light">
                          {results.deviceGroups.length}
                        </Badge>
                      </Group>
                    </Group>

                    {results.deviceGroups.length === 0 ? (
                      <Text size="sm" c="dimmed" ta="center" py="md">
                        No device groups found. Create groups from uploaded
                        files, then drag ungrouped files into a group.
                      </Text>
                    ) : (
                      <Stack gap="sm">
                        {results.deviceGroups.map((group) => (
                          <DeviceGroupCard
                            key={group.id}
                            group={group}
                            substrates={substrates}
                            onAssign={(substrateId) =>
                              handleAssignSubstrate(group.id, substrateId)
                            }
                            onDeleteFile={handleDeleteFile}
                            onDeleteGroup={() => handleDeleteGroup(group.id)}
                            onDropUngroupedFile={(fileId) =>
                              moveFilesToGroup([fileId], group.id)
                            }
                            onDragEnter={() => setDropTargetGroupId(group.id)}
                            onDragLeave={() =>
                              setDropTargetGroupId((prev) =>
                                prev === group.id ? null : prev,
                              )
                            }
                            isDropTarget={dropTargetGroupId === group.id}
                            expanded={expandedGroups.has(group.id)}
                            onToggleExpand={() => toggleGroupExpand(group.id)}
                          />
                        ))}
                      </Stack>
                    )}
                  </Stack>
                </Paper>
              </Group>
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
  const {
    experiments,
    setExperiments,
    results,
    setResults,
    planes,
    updateElement,
    pendingCollectionLink,
    setPendingCollectionLink,
    setActiveEntity,
  } = useAppContext()
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
  const processedPendingRequestIdsRef = useRef<Set<string>>(new Set())

  // When arriving from a collection's "Add Results" action, preselect the
  // linked experiment to make result linking explicit and predictable.
  useEffect(() => {
    if (!pendingCollectionLink || pendingCollectionLink.kind !== "result") {
      return
    }
    if (
      processedPendingRequestIdsRef.current.has(pendingCollectionLink.requestId)
    ) {
      return
    }
    processedPendingRequestIdsRef.current.add(pendingCollectionLink.requestId)

    const { collectionId, planeId } = pendingCollectionLink
    setPendingCollectionLink(null)

    const plane = planes.find((p) => p.id === planeId)
    const collection = plane?.elements.find((e) => e.id === collectionId)
    if (!collection || collection.type !== "collection") {
      return
    }

    const linkedExperimentId = collection.refs.find(
      (r) => r.kind === "experiment",
    )?.id
    if (linkedExperimentId) {
      selectExperiment(linkedExperimentId)
    }
  }, [
    pendingCollectionLink,
    planes,
    setPendingCollectionLink,
    selectExperiment,
  ])

  const syncResultRefsForExperiment = (
    experimentId: string,
    resultIdsForExperiment: string[],
    nextResultId: string | null,
  ) => {
    const resultIdSet = new Set(resultIdsForExperiment)

    for (const plane of planes) {
      for (const element of plane.elements) {
        if (element.type !== "collection") {
          continue
        }
        const collection = element as CanvasCollectionElement
        const hasExperimentRef = collection.refs.some(
          (ref) => ref.kind === "experiment" && ref.id === experimentId,
        )
        if (!hasExperimentRef) {
          continue
        }

        const withoutOldResultRefs = collection.refs.filter(
          (ref) => !(ref.kind === "result" && resultIdSet.has(ref.id)),
        )
        const nextRefs =
          nextResultId === null
            ? withoutOldResultRefs
            : [
                ...withoutOldResultRefs,
                { kind: "result" as const, id: nextResultId },
              ]

        const refsChanged =
          nextRefs.length !== collection.refs.length ||
          nextRefs.some((ref, idx) => {
            const prev = collection.refs[idx]
            return !prev || prev.kind !== ref.kind || prev.id !== ref.id
          })

        if (refsChanged) {
          updateElement(plane.id, {
            ...collection,
            refs: nextRefs,
          })
        }
      }
    }
  }

  const updateResults = (updatedResults: ExperimentResults) => {
    const hasFiles = updatedResults.files.length > 0
    const existingForExperiment = results.find(
      (r) => r.experimentId === updatedResults.experimentId,
    )
    const resultIdsForExperiment = results
      .filter((r) => r.experimentId === updatedResults.experimentId)
      .map((r) => r.id)

    setResults((prev) => {
      if (!hasFiles) {
        return prev.filter(
          (r) => r.experimentId !== updatedResults.experimentId,
        )
      }

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

    // Keep experiment.hasResults in sync so the status propagates everywhere
    setExperiments((prev) =>
      prev.map((e) =>
        e.id === updatedResults.experimentId
          ? { ...e, hasResults: hasFiles }
          : e,
      ),
    )

    // Keep collection result refs in sync with the effective persisted state.
    syncResultRefsForExperiment(
      updatedResults.experimentId,
      resultIdsForExperiment.length > 0
        ? resultIdsForExperiment
        : existingForExperiment
          ? [existingForExperiment.id]
          : [updatedResults.id],
      hasFiles ? (existingForExperiment?.id ?? updatedResults.id) : null,
    )
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

  useEffect(() => {
    if (
      selectedExperimentId &&
      !visibleExperiments.some(
        (experiment) => experiment.id === selectedExperimentId,
      )
    ) {
      selectExperiment(null)
    }
  }, [selectedExperimentId, visibleExperiments])

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
