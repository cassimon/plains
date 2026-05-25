import {
  Accordion,
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
  Paper,
  ScrollArea,
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
import { useBlocker } from "@tanstack/react-router"
import {
  Fragment,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { OpenAPI } from "../client/core/OpenAPI"
import { NomadService } from "../client/sdk.gen"
import type {
  NomadConfigResponse,
  NomadUploadResponse,
} from "../client/types.gen"
import { getTokenSync } from "../lib/keycloakInstance"
import {
  type CanvasCollectionElement,
  type DeviceGroup,
  type Experiment,
  type ExperimentResults,
  getExperimentStatus,
  type Material,
  type MeasurementFile,
  type MeasurementType,
  newExperimentResults,
  newMeasurementFile,
  useAppContext,
  useEntityCollection,
} from "../store/AppContext"

// Type for NOMAD upload request (not exported in generated types because it's a Form field)
type NomadUploadRequest = {
  experiment_id: string
  experiment_name: string
  substrates: Array<{
    id: string
    name: string
  }>
  measurement_files: Array<{
    fileName: string
    fileType: string
    deviceName: string
    cell?: string
    pixel?: string
    value?: number
    voc?: number
    jsc?: number
    ff?: number
    user?: string
    measurementDate?: string
  }>
  device_groups: Array<{
    id: string
    deviceName: string
    assignedSubstrateId?: string
    files?: Array<{
      fileName: string
      fileType: string
      deviceName: string
      cell?: string
      pixel?: string
      value?: number
      voc?: number
      jsc?: number
      ff?: number
      user?: string
      measurementDate?: string
    }>
  }>
  notes?: string
  custom_metadata?: Record<string, any>
}

type NomadStepArchivePaths = {
  step1: string | null
  step2: string | null
  step3: string | null
}

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
  let voc: number | undefined
  let jsc: number | undefined
  let ff: number | undefined
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
    const pceMatch = line.match(/pce[:\s=]*(\d+\.?\d*)\s*%?/i)
    if (pceMatch) {
      value = parseFloat(pceMatch[1])
    }

    // Extract Voc (V)
    const vocMatch = line.match(/voc[:\s=]*(\d+\.?\d*)\s*v?/i)
    if (vocMatch) {
      voc = parseFloat(vocMatch[1])
    }

    // Extract Jsc (mA/cm²) — also catches EQE-integrated Jsc
    const jscMatch = line.match(
      /(?:integrated\s+)?jsc[:\s=]*(\d+\.?\d*)\s*(?:ma\/cm2?|ma)?/i,
    )
    if (jscMatch) {
      jsc = parseFloat(jscMatch[1])
    }

    // Extract FF (%) — accept decimal (0.xx) or percentage (xx.x)
    const ffMatch = line.match(/(?:fill\s+factor|ff)[:\s=]*(\d+\.?\d*)\s*%?/i)
    if (ffMatch) {
      const raw = parseFloat(ffMatch[1])
      // Normalise: if value is ≤ 1.0 it is a fraction → convert to %
      ff = raw <= 1.0 ? raw * 100 : raw
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
    voc,
    jsc,
    ff,
    user,
    measurementDate,
  }
}

/** Compute similarity score between two strings (0-1) */
/** Parse a name into components: base name, numeric indices, and letter indices */
function parseNameComponents(name: string): {
  baseName: string
  numericIndices: number[]
  letterIndices: string[]
} {
  const lowerName = name.toLowerCase()
  const numericIndices: number[] = []
  const letterIndices: string[] = []
  let baseName = lowerName

  // Extract standalone letter indices like "_A", "_B", "_C" etc.
  const letterPattern = /_([a-z])(?:_|$)/gi
  const letterMatches = Array.from(lowerName.matchAll(letterPattern))
  for (const match of letterMatches) {
    letterIndices.push(match[1].toUpperCase())
  }
  // Remove standalone letter indices from base name
  baseName = baseName.replace(/_[a-z](?:_|$)/gi, "_")

  // Extract numeric indices like "35" or "44"
  const numPattern = /(\d+)/g
  let numMatch
  while ((numMatch = numPattern.exec(baseName)) !== null) {
    numericIndices.push(parseInt(numMatch[1], 10))
  }
  // Remove all numbers from base name
  baseName = baseName.replace(/\d+/g, "")
  // Clean up underscores and dashes
  baseName = baseName.replace(/[_-]+/g, "_").replace(/^_+|_+$/g, "")

  return { baseName, numericIndices, letterIndices }
}

/** Compare two parsed name components with exact matching for indices */
function compareNameComponents(
  fileComp: ReturnType<typeof parseNameComponents>,
  substrateComp: ReturnType<typeof parseNameComponents>,
): number {
  // Rule 1: Numeric indices must match exactly
  if (fileComp.numericIndices.length !== substrateComp.numericIndices.length) {
    return 0 // No match if different number of numeric indices
  }
  for (let i = 0; i < fileComp.numericIndices.length; i++) {
    if (fileComp.numericIndices[i] !== substrateComp.numericIndices[i]) {
      return 0 // Numeric indices must match exactly
    }
  }

  // Rule 2: Letter indices must match exactly
  if (fileComp.letterIndices.length !== substrateComp.letterIndices.length) {
    return 0 // No match if different number of letter indices
  }
  for (let i = 0; i < fileComp.letterIndices.length; i++) {
    if (fileComp.letterIndices[i] !== substrateComp.letterIndices[i]) {
      return 0 // Letter indices must match exactly
    }
  }

  // Rule 3: Fuzzy match base names (only if indices matched)
  // Use length-relative threshold for fuzzy matching
  const s1 = fileComp.baseName
  const s2 = substrateComp.baseName

  if (s1 === s2) {
    return 1
  }
  if (s1.length === 0 || s2.length === 0) {
    return 0.5 // If one is empty, it's a weak match since indices matched
  }

  // Simple fuzzy matching
  const longer = s1.length > s2.length ? s1 : s2
  const shorter = s1.length > s2.length ? s2 : s1

  if (longer.includes(shorter)) {
    return 0.9 // Very good match if one contains the other
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

  const baseSimilarity = (2 * matches) / (s1.length + s2.length)
  // Scale fuzzy match to 0.6-1.0 range (indices already matched perfectly)
  return 0.6 + baseSimilarity * 0.4
}

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

/** Search for substrate names within a filename using smart component matching */
function findSubstrateNamesInFile(
  fileName: string,
  substrates: { id: string; name: string }[],
): { id: string; name: string; confidence: number }[] {
  const baseName = fileName.replace(/\.[^/.]+$/, "")
  const fileComp = parseNameComponents(baseName)
  const matches: { id: string; name: string; confidence: number }[] = []

  for (const substrate of substrates) {
    const substrateComp = parseNameComponents(substrate.name)
    const componentScore = compareNameComponents(fileComp, substrateComp)

    // Only accept matches where indices matched perfectly (score > 0)
    if (componentScore > 0) {
      matches.push({ ...substrate, confidence: componentScore })
    } else {
      // Fallback: try exact substring match for backwards compatibility
      const baseLower = baseName.toLowerCase()
      const subNameLower = substrate.name.toLowerCase()
      if (baseLower.includes(subNameLower)) {
        matches.push({ ...substrate, confidence: 1.0 })
      }
    }
  }

  // Sort by confidence (highest first)
  return matches.sort((a, b) => b.confidence - a.confidence)
}

/** Resolve the stable automatic unmatched group label for a file */
function getAutoUnmatchedGroupName(
  file: MeasurementFile,
  substrates: { id: string; name: string }[],
): string {
  const matches = findSubstrateNamesInFile(file.fileName, substrates)
  if (matches.length > 0) {
    return matches[0].name
  }

  const extracted = (file.deviceName || "").trim()
  if (extracted.length > 0) {
    return extracted.toUpperCase()
  }

  return "Miscellaneous"
}

/** Group files by substrate names found within them */
function groupFilesBySubstrateMatch(
  files: MeasurementFile[],
  substrates: { id: string; name: string }[],
): DeviceGroup[] {
  const groups: DeviceGroup[] = []
  const groupsBySubstrate = new Map<
    string,
    { files: MeasurementFile[]; confidence: number }
  >()

  // First pass: group files by substrate names found in them
  for (const file of files) {
    const matchedSubstrates = findSubstrateNamesInFile(
      file.fileName,
      substrates,
    )
    if (matchedSubstrates.length > 0) {
      // Use the highest confidence match
      const best = matchedSubstrates[0]
      const key = best.id
      const existing = groupsBySubstrate.get(key) ?? {
        files: [],
        confidence: 0,
      }
      existing.files.push(file)
      existing.confidence = Math.max(existing.confidence, best.confidence)
      groupsBySubstrate.set(key, existing)
    }
  }

  // Convert to DeviceGroups with substrate assignments
  for (const [
    substrateId,
    { files: groupFiles, confidence },
  ] of groupsBySubstrate) {
    const substrate = substrates.find((s) => s.id === substrateId)
    groups.push({
      id: crypto.randomUUID(),
      deviceName: substrate?.name ?? `substrate-${substrateId}`,
      files: groupFiles,
      assignedSubstrateId: substrateId,
      matchScore: confidence,
    })
  }

  // Second pass: create groups for files without substrate matches (using device name extraction)
  const assignedFileIds = new Set(
    Array.from(groupsBySubstrate.values()).flatMap((g) =>
      g.files.map((f) => f.id),
    ),
  )
  const unassignedFiles = files.filter((f) => !assignedFileIds.has(f.id))

  if (unassignedFiles.length > 0) {
    // Group by extracted device name
    const filesByDevice = new Map<string, MeasurementFile[]>()
    for (const file of unassignedFiles) {
      const key = getAutoUnmatchedGroupName(file, substrates)
      const existing = filesByDevice.get(key) ?? []
      existing.push(file)
      filesByDevice.set(key, existing)
    }

    for (const [deviceName, groupFiles] of filesByDevice.entries()) {
      groups.push({
        id: crypto.randomUUID(),
        deviceName,
        files: groupFiles,
        assignedSubstrateId: null,
        matchScore: 0,
      })
    }
  }

  return groups
}

// ─────────────────────────────────────────────────────────────────────────────
// Experiment List Item (read-only version)
// ─────────────────────────────────────────────────────────────────────────────

function ExperimentListItem({
  experiment,
  isSelected,
  onSelect,
  collectionColor,
  hasUnfinishedUpload,
}: {
  experiment: Experiment
  isSelected: boolean
  onSelect: () => void
  collectionColor?: string
  hasUnfinishedUpload?: boolean
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
            {hasUnfinishedUpload && (
              <Badge size="xs" color="orange" variant="light">
                Unfinished
              </Badge>
            )}
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
// Substrate Card - Shows matched files for a specific substrate
// ─────────────────────────────────────────────────────────────────────────────

function SubstrateCard({
  substrate,
  substrateMaterial,
  files,
  onUnmatchFile,
  onUnmatchFiles,
  onDeleteFiles,
  onDropFile,
  onDropGroup,
  onDragEnter,
  onDragLeave,
  isDropTarget,
  expanded,
  onToggleExpand,
  selectedFileIds,
  onToggleSelectFile,
  onToggleSelectAll,
}: {
  substrate: { id: string; name: string; substrateMaterialId?: string }
  substrateMaterial?: Material
  files: MeasurementFile[]
  onUnmatchFile: (fileId: string) => void
  onUnmatchFiles: (fileIds: string[]) => void
  onDeleteFiles: (fileIds: string[]) => void
  onDropFile: (fileId: string) => void
  onDropGroup: (groupId: string) => void
  onDragEnter: () => void
  onDragLeave: () => void
  isDropTarget: boolean
  expanded: boolean
  onToggleExpand: () => void
  selectedFileIds: Set<string>
  onToggleSelectFile: (fileId: string, checked: boolean) => void
  onToggleSelectAll: (checked: boolean) => void
}) {
  const selectedCount = files.filter((f) => selectedFileIds.has(f.id)).length
  const allSelected = files.length > 0 && selectedCount === files.length

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
        const data = e.dataTransfer.getData("text/plain")
        if (data) {
          // Check if it's a group or file ID
          if (data.startsWith("group:")) {
            const groupId = data.substring(6)
            onDropGroup(groupId)
          } else {
            onDropFile(data)
          }
        }
        onDragLeave()
      }}
      style={{
        borderColor: isDropTarget ? "var(--mantine-color-green-5)" : undefined,
        background: isDropTarget ? "var(--mantine-color-green-0)" : undefined,
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
          <div>
            <Text fw={600} size="sm">
              {substrate.name}
            </Text>
            {substrateMaterial && (
              <Text size="xs" c="dimmed">
                ({substrateMaterial.type || substrateMaterial.name})
              </Text>
            )}
          </div>
        </Group>

        <Badge
          size="xs"
          variant="light"
          color={files.length > 0 ? "green" : "gray"}
        >
          {files.length} file{files.length !== 1 ? "s" : ""}
        </Badge>
      </Group>

      {expanded && files.length > 0 && (
        <Box mt="sm" pl="xl">
          <Group justify="space-between" mb="xs">
            <Group gap="xs">
              <Checkbox
                size="xs"
                checked={allSelected}
                indeterminate={
                  selectedCount > 0 && selectedCount < files.length
                }
                onChange={(e) => onToggleSelectAll(e.currentTarget.checked)}
                aria-label={`Select all files in ${substrate.name}`}
              />
              <Text size="xs" c="dimmed">
                {selectedCount} selected
              </Text>
            </Group>
            <Group gap="xs">
              <Button
                size="xs"
                variant="light"
                disabled={selectedCount === 0}
                onClick={() =>
                  onUnmatchFiles(
                    files
                      .filter((f) => selectedFileIds.has(f.id))
                      .map((f) => f.id),
                  )
                }
              >
                Move {selectedCount} to unmatched
              </Button>
              <Button
                size="xs"
                color="red"
                variant="light"
                disabled={selectedCount === 0}
                onClick={() =>
                  onDeleteFiles(
                    files
                      .filter((f) => selectedFileIds.has(f.id))
                      .map((f) => f.id),
                  )
                }
              >
                Delete {selectedCount}
              </Button>
            </Group>
          </Group>
          <Table striped>
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ width: 36 }} />
                <Table.Th>File</Table.Th>
                <Table.Th>Type</Table.Th>
                <Table.Th>Cell</Table.Th>
                <Table.Th>Pixel</Table.Th>
                <Table.Th>Value</Table.Th>
                <Table.Th style={{ width: 40 }} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {files.map((file) => (
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
                      size="xs"
                      checked={selectedFileIds.has(file.id)}
                      onChange={(e) =>
                        onToggleSelectFile(file.id, e.currentTarget.checked)
                      }
                      aria-label={`Select file ${file.fileName}`}
                    />
                  </Table.Td>
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
                    <Tooltip label="Move to unmatched" withArrow>
                      <ActionIcon
                        size="xs"
                        variant="subtle"
                        color="red"
                        onClick={() => onUnmatchFile(file.id)}
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
  onUpdateExperiment,
}: {
  experiment: Experiment
  experimentResults: ExperimentResults | null
  onUpdateResults: (results: ExperimentResults) => void
  onUpdateExperiment: (experiment: Experiment) => void
}) {
  const [expandedSubstrates, setExpandedSubstrates] = useState<Set<string>>(
    new Set(),
  )
  const [expandedUnmatchedGroups, setExpandedUnmatchedGroups] = useState<
    Set<string>
  >(new Set())
  const [selectedUnmatchedFileIds, setSelectedUnmatchedFileIds] = useState<
    Set<string>
  >(new Set())
  const [
    selectedSubstrateFileIdsBySubstrate,
    setSelectedSubstrateFileIdsBySubstrate,
  ] = useState<Record<string, Set<string>>>({})
  const [batchAssignTargetSubstrateId, setBatchAssignTargetSubstrateId] =
    useState<string | null>(null)
  const seenUnmatchedGroupIdsRef = useRef<Set<string>>(new Set())
  const { materials, processes } = useAppContext()
  const theme = useMantineTheme()

  // NOMAD upload state
  const [nomadConfig, setNomadConfig] = useState<NomadConfigResponse | null>(
    null,
  )
  const [nomadUploading, setNomadUploading] = useState(false)
  const [preparingUpload, setPreparingUpload] = useState(false)
  const [lastArchivePath, setLastArchivePath] = useState<string | null>(null)
  const [stepArchivePaths, setStepArchivePaths] =
    useState<NomadStepArchivePaths>({
      step1: null,
      step2: null,
      step3: null,
    })
  const [workflowStep, setWorkflowStep] = useState<1 | 2 | 3>(1)
  const [isResultsCardOpen, setIsResultsCardOpen] = useState(false)
  const [reviewConfirmed, setReviewConfirmed] = useState(false)
  const [nomadUploadHistory, setNomadUploadHistory] = useState<
    Array<{ uploadId: string; entryIds: string[]; uploadTime?: string }>
  >([])
  const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(
    null,
  )
  const [isReviewDragActive, setIsReviewDragActive] = useState(false)
  const reviewScrollViewportRef = useRef<HTMLDivElement | null>(null)
  const reviewDragPositionRef = useRef<number | null>(null)
  const reviewAutoScrollRafRef = useRef<number | null>(null)

  const stopReviewAutoScroll = useCallback(() => {
    if (reviewAutoScrollRafRef.current !== null) {
      cancelAnimationFrame(reviewAutoScrollRafRef.current)
      reviewAutoScrollRafRef.current = null
    }
  }, [])

  useEffect(() => {
    if (!isReviewDragActive || workflowStep !== 2) {
      stopReviewAutoScroll()
      return
    }

    const EDGE_PX = 96
    const MAX_SCROLL_STEP = 22

    const tick = () => {
      const viewport = reviewScrollViewportRef.current
      const clientY = reviewDragPositionRef.current

      if (viewport && clientY !== null) {
        const rect = viewport.getBoundingClientRect()
        let delta = 0

        if (clientY < rect.top + EDGE_PX) {
          const intensity = (rect.top + EDGE_PX - clientY) / EDGE_PX
          delta = -Math.ceil(intensity * MAX_SCROLL_STEP)
        } else if (clientY > rect.bottom - EDGE_PX) {
          const intensity = (clientY - (rect.bottom - EDGE_PX)) / EDGE_PX
          delta = Math.ceil(intensity * MAX_SCROLL_STEP)
        }

        if (delta !== 0) {
          viewport.scrollTop += delta
        }
      }

      reviewAutoScrollRafRef.current = requestAnimationFrame(tick)
    }

    reviewAutoScrollRafRef.current = requestAnimationFrame(tick)

    return () => {
      stopReviewAutoScroll()
    }
  }, [isReviewDragActive, stopReviewAutoScroll, workflowStep])

  useEffect(() => {
    const handleDragFinished = () => {
      setIsReviewDragActive(false)
      reviewDragPositionRef.current = null
      stopReviewAutoScroll()
    }

    window.addEventListener("dragend", handleDragFinished, true)
    window.addEventListener("drop", handleDragFinished, true)

    return () => {
      window.removeEventListener("dragend", handleDragFinished, true)
      window.removeEventListener("drop", handleDragFinished, true)
    }
  }, [stopReviewAutoScroll])

  const handleReviewDragOverCapture = useCallback(
    (e: React.DragEvent) => {
      if (workflowStep !== 2) {
        return
      }

      reviewDragPositionRef.current = e.clientY
      if (!isReviewDragActive) {
        setIsReviewDragActive(true)
      }
    },
    [isReviewDragActive, workflowStep],
  )

  const handleReviewWheelWhileDragging = useCallback(
    (e: React.WheelEvent) => {
      if (!isReviewDragActive || workflowStep !== 2) {
        return
      }

      const viewport = reviewScrollViewportRef.current
      if (!viewport) {
        return
      }

      // Keep wheel scrolling responsive while HTML drag-and-drop is active.
      viewport.scrollTop += e.deltaY
      e.preventDefault()
    },
    [isReviewDragActive, workflowStep],
  )

  // Fetch NOMAD config on mount
  useEffect(() => {
    NomadService.getNomadConfig()
      .then(setNomadConfig)
      .catch((err: unknown) =>
        console.warn("Failed to fetch NOMAD config:", err),
      )
  }, [])

  // Load any persisted archive path for this experiment from the session
  useEffect(() => {
    try {
      const key = `nomad_archive:${experiment.id}`
      const v = sessionStorage.getItem(key)
      if (v) setLastArchivePath(v)
    } catch (_e) {
      // ignore sessionStorage errors in restrictive environments
    }
  }, [experiment.id])

  useEffect(() => {
    try {
      const key = `nomad_step_archives:${experiment.id}`
      const raw = sessionStorage.getItem(key)
      if (!raw) {
        setStepArchivePaths({ step1: null, step2: null, step3: null })
        return
      }
      const parsed = JSON.parse(raw) as Partial<NomadStepArchivePaths>
      setStepArchivePaths({
        step1: parsed.step1 ?? null,
        step2: parsed.step2 ?? null,
        step3: parsed.step3 ?? null,
      })
    } catch (_e) {
      setStepArchivePaths({ step1: null, step2: null, step3: null })
    }
  }, [experiment.id])

  useEffect(() => {
    try {
      const key = `nomad_step_archives:${experiment.id}`
      sessionStorage.setItem(key, JSON.stringify(stepArchivePaths))
    } catch (_e) {
      // ignore sessionStorage errors
    }
  }, [experiment.id, stepArchivePaths])

  useEffect(() => {
    try {
      const key = `nomad_uploads:${experiment.id}`
      const raw = sessionStorage.getItem(key)
      if (!raw) {
        setNomadUploadHistory([])
        return
      }
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) {
        setNomadUploadHistory(parsed)
      }
    } catch (_e) {
      setNomadUploadHistory([])
    }
  }, [experiment.id])

  useEffect(() => {
    try {
      const key = `nomad_uploads:${experiment.id}`
      sessionStorage.setItem(key, JSON.stringify(nomadUploadHistory))
    } catch (_e) {
      // ignore sessionStorage errors
    }
  }, [experiment.id, nomadUploadHistory])

  const fallbackResults = useMemo(
    () => newExperimentResults(experiment.id),
    [experiment.id],
  )
  const results = experimentResults ?? fallbackResults

  const discardArchiveByPath = useCallback(async (archivePath: string | null) => {
    if (!archivePath) {
      return
    }

    try {
      const form = new FormData()
      form.append("archive_path", archivePath)
      const token =
        typeof OpenAPI.TOKEN === "function"
          ? await OpenAPI.TOKEN({} as any)
          : (OpenAPI.TOKEN ?? undefined)

      await fetch(`${OpenAPI.BASE}/api/v1/nomad/upload/archive/discard`, {
        method: "POST",
        headers: token ? { Authorization: `Bearer ${token}` } : undefined,
        body: form,
      })
    } catch (_e) {
      // best effort cleanup
    }

  }, [])

  const discardTemporaryArchive = useCallback(async () => {
    await discardArchiveByPath(lastArchivePath)
    await discardArchiveByPath(stepArchivePaths.step1)
    await discardArchiveByPath(stepArchivePaths.step2)
    await discardArchiveByPath(stepArchivePaths.step3)

    try {
      sessionStorage.removeItem(`nomad_archive:${experiment.id}`)
      sessionStorage.removeItem(`nomad_step_archives:${experiment.id}`)
    } catch (_e) {
      // ignore
    }

    setLastArchivePath(null)
    setStepArchivePaths({ step1: null, step2: null, step3: null })
  }, [
    discardArchiveByPath,
    experiment.id,
    lastArchivePath,
    stepArchivePaths.step1,
    stepArchivePaths.step2,
    stepArchivePaths.step3,
  ])

  useEffect(() => {
    const hasInProgress =
      results.files.length > 0 ||
      !!lastArchivePath ||
      !!stepArchivePaths.step1 ||
      !!stepArchivePaths.step2 ||
      !!stepArchivePaths.step3
    if (!hasInProgress) {
      return
    }

    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ""

      const token = getTokenSync()
      const paths = [
        lastArchivePath,
        stepArchivePaths.step1,
        stepArchivePaths.step2,
        stepArchivePaths.step3,
      ].filter((p): p is string => Boolean(p))
      for (const path of paths) {
        const form = new FormData()
        form.append("archive_path", path)
        fetch(`${OpenAPI.BASE}/api/v1/nomad/upload/archive/discard`, {
          method: "POST",
          headers: token ? { Authorization: `Bearer ${token}` } : undefined,
          body: form,
          keepalive: true,
        }).catch(() => {})
      }
    }

    window.addEventListener("beforeunload", onBeforeUnload)
    return () => {
      window.removeEventListener("beforeunload", onBeforeUnload)
    }
  }, [
    lastArchivePath,
    results.files.length,
    stepArchivePaths.step1,
    stepArchivePaths.step2,
    stepArchivePaths.step3,
  ])

  const toggleSubstrateExpand = (substrateId: string) => {
    setExpandedSubstrates((prev) => {
      const next = new Set(prev)
      if (next.has(substrateId)) {
        next.delete(substrateId)
      } else {
        next.add(substrateId)
      }
      return next
    })
  }

  const toggleUnmatchedGroupExpand = (groupId: string) => {
    setExpandedUnmatchedGroups((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) {
        next.delete(groupId)
      } else {
        next.add(groupId)
      }
      return next
    })
  }

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

      // Upload dropped files to create a temporary archive on the server
      ;(async () => {
        try {
          const filesToSend = droppedFiles.filter(
            (f) => getFileCategory(f.name) !== null,
          )
          if (filesToSend.length === 0) return

          const form = new FormData()
          form.append("experiment_id", experiment.id)
          form.append("experiment_name", experiment.name)
          for (const f of filesToSend) {
            form.append("files", f)
          }

          const token =
            typeof OpenAPI.TOKEN === "function"
              ? await OpenAPI.TOKEN({} as any)
              : (OpenAPI.TOKEN ?? undefined)

          const res = await fetch(`${OpenAPI.BASE}/api/v1/nomad/upload/files`, {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token}`,
            },
            body: form,
          })

          if (!res.ok) {
            const text = await res.text()
            notifications.show({
              title: "Upload Error",
              message: `Failed to upload files: ${res.status} ${text}`,
              color: "red",
            })
            return
          }

          const data = await res.json()
          // Persist archive path in session state so it survives reloads this session
          if (data?.archive_path) {
            try {
              const key = `nomad_archive:${experiment.id}`
              sessionStorage.setItem(key, data.archive_path)
              sessionStorage.removeItem(`nomad_step_archives:${experiment.id}`)
            } catch (_e) {
              // ignore
            }
            setLastArchivePath(data.archive_path)
            setStepArchivePaths({ step1: null, step2: null, step3: null })
          }
          notifications.show({
            title: "Files Uploaded",
            message: data.archive_path
              ? `Created archive: ${data.archive_path}`
              : "Files uploaded successfully",
            color: "green",
          })
        } catch (err) {
          console.error("upload files error", err)
          notifications.show({
            title: "Upload Error",
            message: err instanceof Error ? err.message : String(err),
            color: "red",
          })
        }
      })()

      // Group files by device name while preserving existing ungrouped files
      const allFiles = [...results.files, ...newFiles]

      // Step 1: Try intelligent substrate matching (group by substrate names found in files)
      // This function returns BOTH substrate-matched groups AND unmatched groups (grouped by device name)
      const allGroups = groupFilesBySubstrateMatch(
        newFiles,
        experiment.substrates,
      )

      // Step 2: Separate matched from unmatched groups
      const matchedSubstrateGroups = allGroups.filter(
        (g) => g.assignedSubstrateId !== null,
      )
      const unmatchedSubstrateGroups = allGroups.filter(
        (g) => g.assignedSubstrateId === null,
      )

      // Step 3: Get available substrates (not yet assigned)
      const assignedSubstrateIds = new Set(
        matchedSubstrateGroups
          .map((g) => g.assignedSubstrateId)
          .filter(Boolean),
      )
      const availableSubstrates = experiment.substrates.filter(
        (s) => !assignedSubstrateIds.has(s.id),
      )

      // Step 4: Fuzzy match unmatched groups to available substrates
      const matchedRemainingGroups = matchGroupsToSubstrates(
        unmatchedSubstrateGroups,
        availableSubstrates,
        "fuzzy",
      )

      // Step 5: Combine all groups and keep prior manual review state
      const matchedGroups = [
        ...results.deviceGroups,
        ...matchedSubstrateGroups,
        ...matchedRemainingGroups,
      ]

      onUpdateResults({
        ...results,
        files: allFiles,
        deviceGroups: matchedGroups,
        updatedAt: new Date().toISOString(),
      })
      setIsResultsCardOpen(true)
      setReviewConfirmed(false)
      setWorkflowStep(2)
    },
    [
      experiment.substrates,
      results,
      onUpdateResults,
      matchGroupsToSubstrates,
      experiment.id,
      experiment.name,
    ],
  )

  // Handle manual assignment of unmatched group to substrate
  const handleAssignGroupToSubstrate = (
    groupId: string,
    substrateId: string,
  ) => {
    const updatedGroups = results.deviceGroups.map((g) =>
      g.id === groupId ? { ...g, assignedSubstrateId: substrateId } : g,
    )

    onUpdateResults({
      ...results,
      deviceGroups: updatedGroups,
      updatedAt: new Date().toISOString(),
    })
  }

  const assignFilesToSubstrate = useCallback(
    (fileIds: string[], substrateId: string) => {
      if (fileIds.length === 0) {
        return
      }

      const fileIdSet = new Set(fileIds)
      const filesToAssign = results.files.filter((f) => fileIdSet.has(f.id))
      if (filesToAssign.length === 0) {
        return
      }

      const withoutFiles = results.deviceGroups
        .map((g) => ({
          ...g,
          files: g.files.filter((f) => !fileIdSet.has(f.id)),
        }))
        .filter((g) => g.files.length > 0)

      const existingGroup = withoutFiles.find(
        (g) => g.assignedSubstrateId === substrateId,
      )

      const updatedGroups = existingGroup
        ? withoutFiles.map((g) =>
            g.id === existingGroup.id
              ? { ...g, files: [...g.files, ...filesToAssign] }
              : g,
          )
        : [
            ...withoutFiles,
            {
              id: crypto.randomUUID(),
              deviceName:
                filesToAssign.length === 1
                  ? filesToAssign[0].deviceName
                  : "Manual Assignment",
              files: filesToAssign,
              assignedSubstrateId: substrateId,
              matchScore: 1,
            },
          ]

      onUpdateResults({
        ...results,
        deviceGroups: updatedGroups,
        updatedAt: new Date().toISOString(),
      })
    },
    [onUpdateResults, results],
  )

  const moveFilesToUnmatched = useCallback(
    (fileIds: string[]) => {
      if (fileIds.length === 0) {
        return
      }

      const fileIdSet = new Set(fileIds)
      const filesToMove = results.files.filter((f) => fileIdSet.has(f.id))
      if (filesToMove.length === 0) {
        return
      }

      const retainedGroups = results.deviceGroups
        .map((g) => ({
          ...g,
          files: g.files.filter((f) => !fileIdSet.has(f.id)),
        }))
        .filter((g) => g.files.length > 0)

      const unmatchedGroups = retainedGroups.filter(
        (g) => !g.assignedSubstrateId,
      )
      const matchedGroups = retainedGroups.filter((g) => g.assignedSubstrateId)

      for (const file of filesToMove) {
        const targetGroupName = getAutoUnmatchedGroupName(
          file,
          experiment.substrates,
        )
        const existing = unmatchedGroups.find(
          (g) => g.deviceName === targetGroupName,
        )
        if (existing) {
          existing.files = [...existing.files, file]
        } else {
          unmatchedGroups.push({
            id: crypto.randomUUID(),
            deviceName: targetGroupName,
            files: [file],
            assignedSubstrateId: null,
            matchScore: 0,
          })
        }
      }

      onUpdateResults({
        ...results,
        deviceGroups: [...matchedGroups, ...unmatchedGroups],
        updatedAt: new Date().toISOString(),
      })
    },
    [experiment.substrates, onUpdateResults, results],
  )

  // Move a file from substrate back to its automatic unmatched group
  const handleUnmatchFile = (fileId: string, _fromSubstrateId: string) => {
    moveFilesToUnmatched([fileId])
  }

  const handleDeleteFiles = useCallback(
    (fileIds: string[]) => {
      if (fileIds.length === 0) {
        return
      }

      const fileIdSet = new Set(fileIds)
      const updatedFiles = results.files.filter((f) => !fileIdSet.has(f.id))
      const updatedGroups = results.deviceGroups
        .map((g) => ({
          ...g,
          files: g.files.filter((f) => !fileIdSet.has(f.id)),
        }))
        .filter((g) => g.files.length > 0)

      onUpdateResults({
        ...results,
        files: updatedFiles,
        deviceGroups: updatedGroups,
        updatedAt: new Date().toISOString(),
      })
    },
    [onUpdateResults, results],
  )

  // Assign file from unmatched to substrate
  const handleAssignFileToSubstrate = (fileId: string, substrateId: string) => {
    assignFilesToSubstrate([fileId], substrateId)
    setSelectedUnmatchedFileIds((prev) => {
      if (!prev.has(fileId)) {
        return prev
      }
      const next = new Set(prev)
      next.delete(fileId)
      return next
    })
  }

  const handleBatchAssignSelectedFiles = () => {
    if (!batchAssignTargetSubstrateId || selectedUnmatchedFileIds.size === 0) {
      return
    }

    assignFilesToSubstrate(
      Array.from(selectedUnmatchedFileIds),
      batchAssignTargetSubstrateId,
    )
    setSelectedUnmatchedFileIds(new Set())
  }

  const toggleSelectUnmatchedFile = (fileId: string, checked: boolean) => {
    setSelectedUnmatchedFileIds((prev) => {
      const next = new Set(prev)
      if (checked) {
        next.add(fileId)
      } else {
        next.delete(fileId)
      }
      return next
    })
  }

  const toggleSelectSubstrateFile = (
    substrateId: string,
    fileId: string,
    checked: boolean,
  ) => {
    setSelectedSubstrateFileIdsBySubstrate((prev) => {
      const next = { ...prev }
      const current = new Set(next[substrateId] ?? [])
      if (checked) {
        current.add(fileId)
      } else {
        current.delete(fileId)
      }
      next[substrateId] = current
      return next
    })
  }

  const toggleSelectAllSubstrateFiles = (
    substrateId: string,
    fileIds: string[],
    checked: boolean,
  ) => {
    setSelectedSubstrateFileIdsBySubstrate((prev) => {
      const next = { ...prev }
      const current = new Set(next[substrateId] ?? [])
      for (const id of fileIds) {
        if (checked) {
          current.add(id)
        } else {
          current.delete(id)
        }
      }
      next[substrateId] = current
      return next
    })
  }

  const handleClearAll = () => {
    onUpdateResults({
      ...results,
      files: [],
      deviceGroups: [],
      updatedAt: new Date().toISOString(),
    })
    setStepArchivePaths({ step1: null, step2: null, step3: null })
    setWorkflowStep(1)
    setReviewConfirmed(false)
    setIsResultsCardOpen(false)
    void discardTemporaryArchive()
  }

  const substrates = experiment.substrates.map((s) => ({
    id: s.id,
    name: s.name,
  }))

  const buildNomadUploadRequest = useCallback((): NomadUploadRequest => {
    const linkedProcess =
      processes.find((p) => p.id === experiment.processId) ?? null
    return {
      experiment_id: experiment.id,
      experiment_name: experiment.name,
      custom_metadata: {
        experiment,
        process: linkedProcess,
      },
      substrates,
      measurement_files: results.files.map((f) => ({
        fileName: f.fileName,
        fileType: f.fileType,
        deviceName: f.deviceName,
        cell: f.cell,
        pixel: f.pixel,
        value: f.value,
        voc: f.voc,
        jsc: f.jsc,
        ff: f.ff,
        user: f.user,
        measurementDate: f.measurementDate,
      })),
      device_groups: results.deviceGroups.map((g) => ({
        id: g.id,
        deviceName: g.deviceName,
        assignedSubstrateId: g.assignedSubstrateId ?? undefined,
        files: g.files.map((f) => ({
          fileName: f.fileName,
          fileType: f.fileType,
          deviceName: f.deviceName,
          cell: f.cell,
          pixel: f.pixel,
          value: f.value,
          voc: f.voc,
          jsc: f.jsc,
          ff: f.ff,
          user: f.user,
          measurementDate: f.measurementDate,
        })),
      })),
    }
  }, [experiment, processes, results.deviceGroups, results.files, substrates])

  const handlePrepareUpload = useCallback(async (): Promise<boolean> => {
    if (!lastArchivePath) {
      notifications.show({
        title: "No Archive",
        message: "Please upload files first",
        color: "orange",
      })
      return false
    }

    setPreparingUpload(true)
    try {
      const requestData = buildNomadUploadRequest()

      const formData = new FormData()
      formData.append("archive_path", lastArchivePath)
      formData.append("request_json", JSON.stringify(requestData))

      const token =
        typeof OpenAPI.TOKEN === "function"
          ? await OpenAPI.TOKEN({} as any)
          : (OpenAPI.TOKEN ?? undefined)

      const res = await fetch(
        `${OpenAPI.BASE}/api/v1/nomad/upload/steps/create`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: formData,
        },
      )

      if (!res.ok) {
        const text = await res.text()
        notifications.show({
          title: "Preparation Error",
          message: `Failed to prepare upload: ${res.status} ${text}`,
          color: "red",
        })
        return false
      }

      const data = (await res.json()) as {
        step_archive_paths?: {
          step1?: string
          step2?: string
          step3?: string
        }
        metadata_counts?: {
          step1?: number
          step2?: number
          step3?: number
        }
      }

      const nextPaths: NomadStepArchivePaths = {
        step1: data.step_archive_paths?.step1 ?? null,
        step2: data.step_archive_paths?.step2 ?? null,
        step3: data.step_archive_paths?.step3 ?? null,
      }
      setStepArchivePaths(nextPaths)
      try {
        sessionStorage.setItem(
          `nomad_step_archives:${experiment.id}`,
          JSON.stringify(nextPaths),
        )
      } catch (_e) {
        // ignore
      }

      const c1 = data.metadata_counts?.step1 ?? 0
      const c2 = data.metadata_counts?.step2 ?? 0
      const c3 = data.metadata_counts?.step3 ?? 0

      setReviewConfirmed(true)
      setWorkflowStep(3)

      notifications.show({
        title: "Upload Prepared",
        message: `Created discrete archives (step1=${c1}, step2=${c2}, step3=${c3})`,
        color: "green",
      })
      return true
    } catch (err) {
      console.error("prepare upload error", err)
      notifications.show({
        title: "Preparation Error",
        message: err instanceof Error ? err.message : String(err),
        color: "red",
      })
      return false
    } finally {
      setPreparingUpload(false)
    }
  }, [buildNomadUploadRequest, experiment.id, lastArchivePath])

  const handleUploadToNomad = useCallback(async () => {
    if (!nomadConfig?.enabled) {
      notifications.show({
        title: "NOMAD Not Configured",
        message:
          "Please configure NOMAD credentials in the auth file (../sensitive config/.nomad_auth)",
        color: "orange",
      })
      return
    }

    setNomadUploading(true)
    try {
      const requestData = buildNomadUploadRequest()

      if (
        !stepArchivePaths.step1 ||
        !stepArchivePaths.step2 ||
        !stepArchivePaths.step3
      ) {
        notifications.show({
          title: "Upload Not Prepared",
          message: "Please prepare NOMAD step archives first",
          color: "orange",
        })
        return
      }

      const formData = new FormData()
      formData.append("request_json", JSON.stringify(requestData))
      formData.append("step1_archive_path", stepArchivePaths.step1)
      formData.append("step2_archive_path", stepArchivePaths.step2)
      formData.append("step3_archive_path", stepArchivePaths.step3)

      const token =
        typeof OpenAPI.TOKEN === "function"
          ? await OpenAPI.TOKEN({} as any)
          : (OpenAPI.TOKEN ?? undefined)
      const response = await fetch(
        `${OpenAPI.BASE}/api/v1/nomad/upload/nomad/discrete`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
          },
          body: formData,
        },
      )

      const result: NomadUploadResponse = await response.json()
      if (!result.success) {
        notifications.show({
          title: "Upload Failed",
          message: result.message || "Unknown error occurred",
          color: "red",
        })
        return
      }

      if (result.upload_id) {
        setNomadUploadHistory((prev) => [
          {
            uploadId: result.upload_id as string,
            entryIds: result.entry_ids ?? [],
            uploadTime: result.upload_create_time ?? undefined,
          },
          ...prev,
        ])
      }

      await discardTemporaryArchive()

      onUpdateResults({
        ...results,
        files: [],
        deviceGroups: [],
        nomad: {
          upload_id: result.upload_id ?? undefined,
          entry_ids: result.entry_ids ?? undefined,
          upload_time: result.upload_create_time ?? undefined,
          status: result.processing_status ?? undefined,
        },
        updatedAt: new Date().toISOString(),
      })

      // Mark experiment as having completed upload
      onUpdateExperiment({
        ...experiment,
        hasCompletedUpload: true,
      })

      setReviewConfirmed(false)
      setIsResultsCardOpen(false)
      setWorkflowStep(1)

      notifications.show({
        title: "Upload Successful",
        message: `Created NOMAD upload ${result.upload_id}`,
        color: "green",
      })
    } catch (err) {
      notifications.show({
        title: "Upload Error",
        message:
          err instanceof Error ? err.message : "Failed to upload to NOMAD",
        color: "red",
      })
    } finally {
      setNomadUploading(false)
    }
  }, [
    buildNomadUploadRequest,
    discardTemporaryArchive,
    nomadConfig?.enabled,
    onUpdateExperiment,
    onUpdateResults,
    results,
    stepArchivePaths.step1,
    stepArchivePaths.step2,
    stepArchivePaths.step3,
    experiment,
  ])

  const openStepMetadataPreview = useCallback(async (step: 1 | 2 | 3) => {
    const archivePath =
      step === 1
        ? stepArchivePaths.step1
        : step === 2
          ? stepArchivePaths.step2
          : stepArchivePaths.step3

    if (!archivePath) {
      notifications.show({
        title: "No Archive",
        message: `Please prepare NOMAD upload step ${step} first`,
        color: "orange",
      })
      return
    }

    try {
      const formData = new FormData()
      formData.append("archive_path", archivePath)

      const token =
        typeof OpenAPI.TOKEN === "function"
          ? await OpenAPI.TOKEN({} as any)
          : (OpenAPI.TOKEN ?? undefined)

      const res = await fetch(`${OpenAPI.BASE}/api/v1/nomad/metadata/preview`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
        },
        body: formData,
      })

      if (!res.ok) {
        const text = await res.text()
        notifications.show({
          title: "Preview Error",
          message: `Failed to load preview: ${res.status} ${text}`,
          color: "red",
        })
        return
      }

      const data = await res.json()

      modals.open({
        title: `Review NOMAD Upload Step ${step}`,
        size: "xl",
        children: (
          <ScrollArea>
            <Stack gap="md">
              <Alert color="blue" title="Archive Preview">
                <Text size="sm">
                  Archive contains {data.total_file_count} files total:{" "}
                  {data.metadata_count} metadata files and{" "}
                  {data.total_file_count - data.metadata_count} measurement
                  files.
                </Text>
              </Alert>

              {/* YAML Files Section */}
              {data.metadata_count > 0 && (
                <>
                  <Title order={4}>Metadata Files (YAML)</Title>
                  <Accordion variant="separated">
                    {Object.entries(data.yaml_files).map(
                      ([filename, content]) => (
                        <Accordion.Item key={filename} value={filename}>
                          <Accordion.Control>
                            <Group gap="xs">
                              <IconFile size={16} />
                              <Text size="sm" fw={500}>
                                {filename}
                              </Text>
                            </Group>
                          </Accordion.Control>
                          <Accordion.Panel>
                            <ScrollArea h={300}>
                              <Code block style={{ fontSize: "11px" }}>
                                {String(content)}
                              </Code>
                            </ScrollArea>
                          </Accordion.Panel>
                        </Accordion.Item>
                      ),
                    )}
                  </Accordion>
                </>
              )}

              {/* Other Files Section */}
              <Divider />
              <Title order={4}>Measurement Files</Title>
              <Stack gap="xs">
                {data.all_files
                  .filter(
                    (f: string) => !f.endsWith(".yaml") && !f.endsWith(".yml"),
                  )
                  .map((filename: string) => (
                    <Group key={filename} gap="xs">
                      <IconFile size={14} />
                      <Text size="xs" c="dimmed">
                        {filename}
                      </Text>
                    </Group>
                  ))}
              </Stack>
            </Stack>
          </ScrollArea>
        ),
      })
    } catch (err) {
      console.error("preview error", err)
      notifications.show({
        title: "Preview Error",
        message:
          err instanceof Error ? err.message : "Failed to load archive preview",
        color: "red",
      })
    }
  }, [stepArchivePaths.step1, stepArchivePaths.step2, stepArchivePaths.step3])

  // Separate matched groups (assigned to substrates) from unmatched
  const matchedGroups = useMemo(
    () => results.deviceGroups.filter((g) => g.assignedSubstrateId),
    [results.deviceGroups],
  )
  const unmatchedGroups = useMemo(
    () => results.deviceGroups.filter((g) => !g.assignedSubstrateId),
    [results.deviceGroups],
  )

  useEffect(() => {
    const currentUnmatchedIds = new Set(unmatchedGroups.map((g) => g.id))

    setExpandedUnmatchedGroups((prev) => {
      const next = new Set<string>()

      for (const id of prev) {
        if (currentUnmatchedIds.has(id)) {
          next.add(id)
        }
      }

      for (const id of currentUnmatchedIds) {
        if (!seenUnmatchedGroupIdsRef.current.has(id)) {
          next.add(id)
        }
      }

      return next
    })

    seenUnmatchedGroupIdsRef.current = currentUnmatchedIds

    setSelectedUnmatchedFileIds((prev) => {
      const validFileIds = new Set<string>([
        ...unmatchedGroups.flatMap((g) => g.files.map((f) => f.id)),
      ])
      const next = new Set<string>()
      for (const id of prev) {
        if (validFileIds.has(id)) {
          next.add(id)
        }
      }
      return next
    })

    setSelectedSubstrateFileIdsBySubstrate((prev) => {
      const next: Record<string, Set<string>> = {}
      for (const substrate of experiment.substrates) {
        const currentSelection = prev[substrate.id] ?? new Set<string>()
        const currentFileIds = new Set(
          results.deviceGroups
            .filter((g) => g.assignedSubstrateId === substrate.id)
            .flatMap((g) => g.files.map((f) => f.id)),
        )
        const filtered = new Set<string>()
        for (const id of currentSelection) {
          if (currentFileIds.has(id)) {
            filtered.add(id)
          }
        }
        next[substrate.id] = filtered
      }
      return next
    })
  }, [experiment.substrates, results.deviceGroups, unmatchedGroups])

  // Get files for each substrate
  const getSubstrateFiles = (substrateId: string) => {
    const groups = matchedGroups.filter(
      (g) => g.assignedSubstrateId === substrateId,
    )
    return groups.flatMap((g) => g.files)
  }

  const totalUnmatchedFiles = unmatchedGroups.reduce(
    (sum, g) => sum + g.files.length,
    0,
  )
  const allFilesMatched =
    results.files.length > 0 && unmatchedGroups.length === 0
  const canOpenUpload = allFilesMatched && reviewConfirmed

  useEffect(() => {
    if (results.files.length > 0) {
      setIsResultsCardOpen(true)
    }
  }, [results.files.length])

  useEffect(() => {
    if (totalUnmatchedFiles > 0 && reviewConfirmed) {
      setReviewConfirmed(false)
    }
  }, [reviewConfirmed, totalUnmatchedFiles])

  const instructionText = preparingUpload
    ? "Preparing upload..."
    : workflowStep === 1
      ? "Drag and drop files here"
      : workflowStep === 2
        ? totalUnmatchedFiles > 0
          ? "You have to assign unmatched files by drag and drop"
          : "Review all matched files"
        : "Upload to NOMAD"

  const goToStep = (step: 1 | 2 | 3) => {
    if (step === 1) {
      setWorkflowStep(1)
      return
    }
    if (step === 2) {
      if (results.files.length > 0) {
        setWorkflowStep(2)
      }
      return
    }
    if (canOpenUpload) {
      setWorkflowStep(3)
    }
  }

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

      <ScrollArea
        style={{ flex: 1 }}
        p="md"
        viewportRef={reviewScrollViewportRef}
      >
        <Stack gap="lg">
          {nomadUploadHistory.length > 0 && (
            <Alert
              icon={<IconCheck size={16} />}
              color="green"
              radius="md"
              title="NOMAD Uploads"
            >
              <Stack gap="xs">
                {nomadUploadHistory.map((upload) => (
                  <Group
                    key={upload.uploadId}
                    justify="space-between"
                    wrap="nowrap"
                  >
                    <Text size="sm">
                      <Text span fw={600}>
                        Upload ID:
                      </Text>{" "}
                      <Code>{upload.uploadId}</Code>
                    </Text>
                    <Button
                      size="xs"
                      variant="light"
                      leftSection={<IconExternalLink size={14} />}
                      onClick={() => {
                        const nomadUrl = nomadConfig?.url?.replace(
                          "/api/v1",
                          "",
                        )
                        if (!nomadUrl) {
                          return
                        }
                        window.open(
                          `${nomadUrl}/user/uploads/upload/id/${upload.uploadId}`,
                          "_blank",
                        )
                      }}
                    >
                      Open
                    </Button>
                  </Group>
                ))}
              </Stack>
            </Alert>
          )}

          {!isResultsCardOpen && (
            <Button
              color="blue"
              onClick={() => {
                setIsResultsCardOpen(true)
                setWorkflowStep(1)
              }}
            >
              + Add Results
            </Button>
          )}

          {isResultsCardOpen && (
            <Paper withBorder radius="md" p="md">
              {isResultsCardOpen && (
                <>
                  <Paper
                    withBorder
                    p="xs"
                    radius="md"
                    style={{ background: "var(--mantine-color-gray-0)" }}
                  >
                    <Group justify="space-between" align="center">
                      <Text
                        size="sm"
                        fw={600}
                        c={
                          workflowStep === 2 && totalUnmatchedFiles > 0
                            ? "red"
                            : undefined
                        }
                      >
                        {instructionText}
                      </Text>
                      <Group gap="xs">
                        {workflowStep === 1 && (
                          <Button
                            size="xs"
                            disabled={results.files.length === 0}
                            onClick={() => goToStep(2)}
                          >
                            Next
                          </Button>
                        )}
                        {workflowStep === 2 && totalUnmatchedFiles > 0 && (
                          <Button size="xs" disabled>
                            Assign unmatched first
                          </Button>
                        )}
                        {workflowStep === 2 && totalUnmatchedFiles === 0 && (
                          <Button
                            size="xs"
                            color="green"
                            onClick={() => {
                              void (async () => {
                                if (reviewConfirmed) {
                                  setWorkflowStep(3)
                                  return
                                }

                                await handlePrepareUpload()
                              })()
                            }}
                            loading={preparingUpload}
                            disabled={preparingUpload}
                          >
                            {preparingUpload
                              ? "Preparing upload..."
                              : "Confirm review and proceed"}
                          </Button>
                        )}
                        {workflowStep === 3 && (
                          <Button
                            size="xs"
                            color="green"
                            leftSection={
                              nomadUploading ? (
                                <Loader size={14} color="white" />
                              ) : (
                                <IconCloudUpload size={14} />
                              )
                            }
                            disabled={
                              nomadUploading ||
                              !nomadConfig?.enabled ||
                              !canOpenUpload
                            }
                            onClick={handleUploadToNomad}
                          >
                            {nomadUploading
                              ? "Uploading..."
                              : "Upload all 3 NOMAD steps"}
                          </Button>
                        )}
                      </Group>
                    </Group>
                  </Paper>

                  <Divider label="Pipeline" labelPosition="center" />

                  <Group align="flex-start" wrap="nowrap" gap="md">
                    <Paper
                      withBorder
                      p="sm"
                      radius="md"
                      style={{ width: 230, flexShrink: 0 }}
                    >
                      <Stack gap="xs">
                        <Text size="sm" fw={700}>
                          Process Flow
                        </Text>
                        <Button
                          size="xs"
                          variant={workflowStep === 1 ? "filled" : "light"}
                          onClick={() => goToStep(1)}
                        >
                          1. File Upload
                        </Button>
                        <Button
                          size="xs"
                          variant={workflowStep === 2 ? "filled" : "light"}
                          disabled={results.files.length === 0}
                          onClick={() => goToStep(2)}
                        >
                          2. Review
                        </Button>
                        <Button
                          size="xs"
                          variant={workflowStep === 3 ? "filled" : "light"}
                          disabled={!canOpenUpload}
                          onClick={() => goToStep(3)}
                        >
                          3. Upload to NOMAD
                        </Button>
                      </Stack>
                    </Paper>

                    <Box style={{ flex: 1, minWidth: 0 }}>
                      {workflowStep === 1 && (
                        <Stack gap="xs">
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
                                <IconX
                                  size={48}
                                  color={theme.colors.red[6]}
                                  stroke={1.5}
                                />
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
                                    : nomadUploadHistory.length > 0
                                      ? "Add Files"
                                      : "Drop Results here"}
                                </Text>
                                <Text size="sm" c="dimmed" inline mt={7}>
                                  {results.files.length > 0
                                    ? "Drop more files to add them"
                                    : nomadUploadHistory.length > 0
                                      ? "Start a new upload cycle (Upload -> Review -> NOMAD)"
                                      : "Drag & drop measurement files (.txt, images, documents)"}
                                </Text>
                              </div>
                            </Group>
                          </Dropzone>

                          {lastArchivePath && (
                            <Text size="xs" c="dimmed">
                              Last created archive: {lastArchivePath}
                            </Text>
                          )}
                        </Stack>
                      )}
                      <Group
                        align="flex-start"
                        grow
                        wrap="nowrap"
                        onDragOverCapture={handleReviewDragOverCapture}
                        onWheelCapture={handleReviewWheelWhileDragging}
                        style={{
                          display: workflowStep === 2 ? undefined : "none",
                        }}
                      >
                        {totalUnmatchedFiles > 0 && (
                          <Paper
                            withBorder
                            p="sm"
                            radius="md"
                            style={{
                              flex: 1,
                              minWidth: 0,
                              borderColor: "var(--mantine-color-red-4)",
                              background: "var(--mantine-color-red-0)",
                            }}
                          >
                            <Stack gap="sm">
                              <Group justify="space-between" align="center">
                                <Group gap="xs">
                                  <Text size="sm" fw={600}>
                                    Unmatched Files
                                  </Text>
                                  <Badge
                                    size="xs"
                                    variant="light"
                                    color={
                                      totalUnmatchedFiles > 0
                                        ? "orange"
                                        : "green"
                                    }
                                  >
                                    {totalUnmatchedFiles}
                                  </Badge>
                                </Group>
                              </Group>

                              <Stack gap="sm">
                                <Group justify="space-between" align="center">
                                  <Text size="xs" c="dimmed">
                                    Drag individual files or groups onto a
                                    substrate, or mark files for batch
                                    assignment.
                                  </Text>
                                  <Group gap="xs" wrap="nowrap">
                                    <Select
                                      size="xs"
                                      placeholder="Batch assign to..."
                                      value={batchAssignTargetSubstrateId}
                                      onChange={setBatchAssignTargetSubstrateId}
                                      data={substrates.map((s) => ({
                                        value: s.id,
                                        label: s.name,
                                      }))}
                                      style={{ minWidth: 180 }}
                                    />
                                    <Button
                                      size="xs"
                                      variant="light"
                                      disabled={
                                        !batchAssignTargetSubstrateId ||
                                        selectedUnmatchedFileIds.size === 0
                                      }
                                      onClick={handleBatchAssignSelectedFiles}
                                    >
                                      Assign {selectedUnmatchedFileIds.size}{" "}
                                      selected
                                    </Button>
                                  </Group>
                                </Group>

                                {/* Automatically Grouped Files */}
                                {unmatchedGroups.length > 0 && (
                                  <Paper withBorder p="sm" radius="md">
                                    <Text size="xs" fw={600} mb="xs" c="dimmed">
                                      Automatically Grouped Files
                                    </Text>
                                    <Table striped>
                                      <Table.Thead>
                                        <Table.Tr>
                                          <Table.Th style={{ width: 36 }} />
                                          <Table.Th>Group Name</Table.Th>
                                          <Table.Th>Files</Table.Th>
                                          <Table.Th>Match Score</Table.Th>
                                          <Table.Th style={{ width: 180 }}>
                                            Assign to
                                          </Table.Th>
                                        </Table.Tr>
                                      </Table.Thead>
                                      <Table.Tbody>
                                        {unmatchedGroups.map((group) => {
                                          const expanded =
                                            expandedUnmatchedGroups.has(
                                              group.id,
                                            )
                                          const allInGroupSelected =
                                            group.files.length > 0 &&
                                            group.files.every((f) =>
                                              selectedUnmatchedFileIds.has(
                                                f.id,
                                              ),
                                            )

                                          return (
                                            <Fragment key={group.id}>
                                              <Table.Tr
                                                draggable
                                                onDragStart={(e) => {
                                                  e.dataTransfer.setData(
                                                    "text/plain",
                                                    `group:${group.id}`,
                                                  )
                                                  e.dataTransfer.effectAllowed =
                                                    "move"
                                                }}
                                                style={{ cursor: "grab" }}
                                              >
                                                <Table.Td>
                                                  <ActionIcon
                                                    variant="subtle"
                                                    size="sm"
                                                    onClick={() =>
                                                      toggleUnmatchedGroupExpand(
                                                        group.id,
                                                      )
                                                    }
                                                  >
                                                    {expanded ? (
                                                      <IconChevronDown
                                                        size={14}
                                                      />
                                                    ) : (
                                                      <IconChevronRight
                                                        size={14}
                                                      />
                                                    )}
                                                  </ActionIcon>
                                                </Table.Td>
                                                <Table.Td>
                                                  <Group gap={4} wrap="nowrap">
                                                    <IconFile
                                                      size={14}
                                                      style={{ flexShrink: 0 }}
                                                    />
                                                    <Text size="xs" fw={500}>
                                                      {group.deviceName ||
                                                        "(Unknown Device)"}
                                                    </Text>
                                                  </Group>
                                                </Table.Td>
                                                <Table.Td>
                                                  <Badge
                                                    size="xs"
                                                    variant="light"
                                                  >
                                                    {group.files.length}
                                                  </Badge>
                                                </Table.Td>
                                                <Table.Td>
                                                  {group.matchScore !==
                                                  undefined ? (
                                                    <Badge
                                                      size="xs"
                                                      color={
                                                        group.matchScore > 0.8
                                                          ? "green"
                                                          : group.matchScore >
                                                              0.5
                                                            ? "yellow"
                                                            : "red"
                                                      }
                                                    >
                                                      {(
                                                        group.matchScore * 100
                                                      ).toFixed(0)}
                                                      %
                                                    </Badge>
                                                  ) : (
                                                    <Text size="xs" c="dimmed">
                                                      —
                                                    </Text>
                                                  )}
                                                </Table.Td>
                                                <Table.Td>
                                                  <Select
                                                    size="xs"
                                                    placeholder="Select substrate..."
                                                    value={null}
                                                    onChange={(v) =>
                                                      v &&
                                                      handleAssignGroupToSubstrate(
                                                        group.id,
                                                        v,
                                                      )
                                                    }
                                                    data={substrates.map(
                                                      (s) => ({
                                                        value: s.id,
                                                        label: s.name,
                                                      }),
                                                    )}
                                                  />
                                                </Table.Td>
                                              </Table.Tr>
                                              {expanded && (
                                                <Table.Tr>
                                                  <Table.Td colSpan={5}>
                                                    <Table striped>
                                                      <Table.Thead>
                                                        <Table.Tr>
                                                          <Table.Th
                                                            style={{
                                                              width: 36,
                                                            }}
                                                          >
                                                            <Checkbox
                                                              size="xs"
                                                              checked={
                                                                allInGroupSelected
                                                              }
                                                              onChange={(e) => {
                                                                const checked =
                                                                  e
                                                                    .currentTarget
                                                                    .checked
                                                                for (const file of group.files) {
                                                                  toggleSelectUnmatchedFile(
                                                                    file.id,
                                                                    checked,
                                                                  )
                                                                }
                                                              }}
                                                              aria-label={`Select all files in ${group.deviceName}`}
                                                            />
                                                          </Table.Th>
                                                          <Table.Th>
                                                            File
                                                          </Table.Th>
                                                          <Table.Th>
                                                            Type
                                                          </Table.Th>
                                                          <Table.Th>
                                                            Device
                                                          </Table.Th>
                                                        </Table.Tr>
                                                      </Table.Thead>
                                                      <Table.Tbody>
                                                        {group.files.map(
                                                          (file) => (
                                                            <Table.Tr
                                                              key={file.id}
                                                              draggable
                                                              onDragStart={(
                                                                e,
                                                              ) => {
                                                                e.dataTransfer.setData(
                                                                  "text/plain",
                                                                  file.id,
                                                                )
                                                                e.dataTransfer.effectAllowed =
                                                                  "move"
                                                              }}
                                                              style={{
                                                                cursor: "grab",
                                                              }}
                                                            >
                                                              <Table.Td>
                                                                <Checkbox
                                                                  size="xs"
                                                                  checked={selectedUnmatchedFileIds.has(
                                                                    file.id,
                                                                  )}
                                                                  onChange={(
                                                                    e,
                                                                  ) =>
                                                                    toggleSelectUnmatchedFile(
                                                                      file.id,
                                                                      e
                                                                        .currentTarget
                                                                        .checked,
                                                                    )
                                                                  }
                                                                  aria-label={`Select file ${file.fileName}`}
                                                                />
                                                              </Table.Td>
                                                              <Table.Td>
                                                                <Text size="xs">
                                                                  {
                                                                    file.fileName
                                                                  }
                                                                </Text>
                                                              </Table.Td>
                                                              <Table.Td>
                                                                <FileTypeBadge
                                                                  type={
                                                                    file.fileType
                                                                  }
                                                                />
                                                              </Table.Td>
                                                              <Table.Td>
                                                                <Text size="xs">
                                                                  {file.deviceName ||
                                                                    "—"}
                                                                </Text>
                                                              </Table.Td>
                                                            </Table.Tr>
                                                          ),
                                                        )}
                                                      </Table.Tbody>
                                                    </Table>
                                                  </Table.Td>
                                                </Table.Tr>
                                              )}
                                            </Fragment>
                                          )
                                        })}
                                      </Table.Tbody>
                                    </Table>
                                  </Paper>
                                )}
                              </Stack>
                            </Stack>
                          </Paper>
                        )}

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
                                  Substrates
                                </Text>
                                <Badge size="xs" variant="light">
                                  {experiment.substrates.length}
                                </Badge>
                              </Group>
                            </Group>

                            {experiment.substrates.length === 0 ? (
                              <Text size="sm" c="dimmed" ta="center" py="md">
                                No substrates in this experiment.
                              </Text>
                            ) : (
                              <Stack gap="sm">
                                {experiment.substrates.map((substrate) => {
                                  const substrateMaterial = materials.find(
                                    (m) =>
                                      m.id === substrate.substrateMaterialId,
                                  )
                                  const files = getSubstrateFiles(substrate.id)
                                  return (
                                    <SubstrateCard
                                      key={substrate.id}
                                      substrate={substrate}
                                      substrateMaterial={substrateMaterial}
                                      files={files}
                                      onUnmatchFile={(fileId) =>
                                        handleUnmatchFile(fileId, substrate.id)
                                      }
                                      onUnmatchFiles={(fileIds) => {
                                        moveFilesToUnmatched(fileIds)
                                        setSelectedSubstrateFileIdsBySubstrate(
                                          (prev) => ({
                                            ...prev,
                                            [substrate.id]: new Set<string>(),
                                          }),
                                        )
                                      }}
                                      onDeleteFiles={(fileIds) => {
                                        handleDeleteFiles(fileIds)
                                        setSelectedSubstrateFileIdsBySubstrate(
                                          (prev) => ({
                                            ...prev,
                                            [substrate.id]: new Set<string>(),
                                          }),
                                        )
                                      }}
                                      onDropFile={(fileId) =>
                                        handleAssignFileToSubstrate(
                                          fileId,
                                          substrate.id,
                                        )
                                      }
                                      onDropGroup={(groupId) =>
                                        handleAssignGroupToSubstrate(
                                          groupId,
                                          substrate.id,
                                        )
                                      }
                                      onDragEnter={() =>
                                        setDropTargetGroupId(substrate.id)
                                      }
                                      onDragLeave={() =>
                                        setDropTargetGroupId((prev) =>
                                          prev === substrate.id ? null : prev,
                                        )
                                      }
                                      isDropTarget={
                                        dropTargetGroupId === substrate.id
                                      }
                                      expanded={expandedSubstrates.has(
                                        substrate.id,
                                      )}
                                      onToggleExpand={() =>
                                        toggleSubstrateExpand(substrate.id)
                                      }
                                      selectedFileIds={
                                        selectedSubstrateFileIdsBySubstrate[
                                          substrate.id
                                        ] ?? new Set<string>()
                                      }
                                      onToggleSelectFile={(fileId, checked) =>
                                        toggleSelectSubstrateFile(
                                          substrate.id,
                                          fileId,
                                          checked,
                                        )
                                      }
                                      onToggleSelectAll={(checked) =>
                                        toggleSelectAllSubstrateFiles(
                                          substrate.id,
                                          files.map((f) => f.id),
                                          checked,
                                        )
                                      }
                                    />
                                  )
                                })}
                              </Stack>
                            )}
                          </Stack>
                        </Paper>
                      </Group>
                      {workflowStep === 3 && (
                        <Paper withBorder p="md" radius="md">
                          <Stack gap="sm">
                            {results.files.length > 0 && (
                              <Alert title="Unfinished Upload" color="blue">
                                <Text size="sm">
                                  You have {results.files.length} file
                                  {results.files.length !== 1 ? "s" : ""} ready
                                  to upload to NOMAD.
                                </Text>
                              </Alert>
                            )}

                            <Text size="sm">
                              Ready to upload {results.files.length} file
                              {results.files.length !== 1 ? "s" : ""} to NOMAD.
                            </Text>
                            <Text size="xs" c="dimmed">
                              If needed, use Process Flow to go back and add
                              more files.
                            </Text>

                            <Group wrap="wrap" gap="xs">
                              <Button
                                size="xs"
                                variant="default"
                                onClick={() => void openStepMetadataPreview(1)}
                                disabled={!reviewConfirmed || !stepArchivePaths.step1}
                              >
                                NOMAD upload step 1
                              </Button>
                              <Button
                                size="xs"
                                variant="default"
                                onClick={() => void openStepMetadataPreview(2)}
                                disabled={!reviewConfirmed || !stepArchivePaths.step2}
                              >
                                NOMAD upload step 2
                              </Button>
                              <Button
                                size="xs"
                                variant="default"
                                onClick={() => void openStepMetadataPreview(3)}
                                disabled={!reviewConfirmed || !stepArchivePaths.step3}
                              >
                                NOMAD upload step 3
                              </Button>
                            </Group>

                            <Button
                              size="sm"
                              color="green"
                              leftSection={
                                nomadUploading ? (
                                  <Loader size={14} color="white" />
                                ) : (
                                  <IconCloudUpload size={14} />
                                )
                              }
                              disabled={
                                nomadUploading ||
                                !nomadConfig?.enabled ||
                                !canOpenUpload
                              }
                              onClick={handleUploadToNomad}
                              fullWidth
                            >
                              {nomadUploading
                                ? "Uploading..."
                                : "Upload all 3 NOMAD steps"}
                            </Button>
                          </Stack>
                        </Paper>
                      )}
                    </Box>
                  </Group>
                </>
              )}
            </Paper>
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
    removeCollectionRefs,
    pendingCollectionLink,
    setPendingCollectionLink,
    setActiveEntity,
    lastSelectedByKind,
    updateLastSelected,
  } = useAppContext()
  const { getEntityColor, isEntityVisible } = useEntityCollection()
  const [selectedExperimentId, setSelectedExperimentId] = useState<
    string | null
  >(() => lastSelectedByKind.experiment ?? null)

  const discardArchiveForExperiment = useCallback(
    async (experimentId: string) => {
      try {
        const archivePaths: string[] = []
        const key = `nomad_archive:${experimentId}`
        const archivePath = sessionStorage.getItem(key)
        if (archivePath) {
          archivePaths.push(archivePath)
        }
        const stepKey = `nomad_step_archives:${experimentId}`
        const rawStep = sessionStorage.getItem(stepKey)
        if (rawStep) {
          try {
            const parsed = JSON.parse(rawStep) as Partial<NomadStepArchivePaths>
            if (parsed.step1) archivePaths.push(parsed.step1)
            if (parsed.step2) archivePaths.push(parsed.step2)
            if (parsed.step3) archivePaths.push(parsed.step3)
          } catch (_e) {
            // ignore malformed session value
          }
        }

        if (archivePaths.length === 0) {
          return
        }

        const token =
          typeof OpenAPI.TOKEN === "function"
            ? await OpenAPI.TOKEN({} as any)
            : (OpenAPI.TOKEN ?? undefined)

        for (const path of archivePaths) {
          const form = new FormData()
          form.append("archive_path", path)
          await fetch(`${OpenAPI.BASE}/api/v1/nomad/upload/archive/discard`, {
            method: "POST",
            headers: token ? { Authorization: `Bearer ${token}` } : undefined,
            body: form,
          })
        }

        sessionStorage.removeItem(key)
        sessionStorage.removeItem(stepKey)
      } catch (_e) {
        // best effort cleanup
      }
    },
    [],
  )

  const getInProgressExperimentIds = useCallback((): string[] => {
    const inProgress = new Set<string>()

    for (const result of results) {
      if (result.files.length > 0) {
        inProgress.add(result.experimentId)
      }
    }

    try {
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i)
        if (!key) {
          continue
        }

        if (key.startsWith("nomad_archive:")) {
          const experimentId = key.slice("nomad_archive:".length)
          if (experimentId) {
            inProgress.add(experimentId)
          }
          continue
        }

        if (key.startsWith("nomad_step_archives:")) {
          const experimentId = key.slice("nomad_step_archives:".length)
          if (experimentId) {
            inProgress.add(experimentId)
          }
        }
      }
    } catch (_e) {
      // ignore sessionStorage errors in restrictive environments
    }

    return Array.from(inProgress)
  }, [results])

  const discardInProgressPipelines = useCallback(
    async (experimentIds: string[]) => {
      for (const experimentId of experimentIds) {
        await discardArchiveForExperiment(experimentId)
      }

      if (experimentIds.length > 0) {
        const idSet = new Set(experimentIds)
        const resultIdsToRemove = results
          .filter((r) => idSet.has(r.experimentId))
          .map((r) => r.id)
        setResults((prev) => prev.filter((r) => !idSet.has(r.experimentId)))
        if (resultIdsToRemove.length > 0) {
          removeCollectionRefs("result", resultIdsToRemove)
        }
      }
    },
    [discardArchiveForExperiment, setResults, removeCollectionRefs, results],
  )

  useBlocker({
    shouldBlockFn: async ({ current, next }) => {
      if (current.pathname === next.pathname) {
        return false
      }

      const inProgressIds = getInProgressExperimentIds()
      if (inProgressIds.length === 0) {
        return false
      }

      const shouldDiscard = window.confirm(
        "You are leaving in the middle of the upload process. Your current data and temporary archive will be discarded. Continue?",
      )

      if (!shouldDiscard) {
        return true
      }

      await discardInProgressPipelines(inProgressIds)
      return false
    },
  })

  const selectExperiment = async (id: string | null) => {
    if (selectedExperimentId && id !== selectedExperimentId) {
      const activeResult = results.find(
        (r) => r.experimentId === selectedExperimentId,
      )
      const hasInProgressPipeline =
        (!!activeResult && activeResult.files.length > 0) ||
        (() => {
          try {
            return !!sessionStorage.getItem(
              `nomad_archive:${selectedExperimentId}`,
            )
          } catch (_e) {
            return false
          }
        })()

      if (hasInProgressPipeline) {
        const shouldDiscard = window.confirm(
          "You are leaving in the middle of the upload process. Your current data and temporary archive will be discarded. Continue?",
        )
        if (!shouldDiscard) {
          return
        }

        await discardArchiveForExperiment(selectedExperimentId)

        const resultToRemove = results.find(
          (r) => r.experimentId === selectedExperimentId,
        )
        setResults((prev) =>
          prev.filter((r) => r.experimentId !== selectedExperimentId),
        )
        if (resultToRemove) {
          removeCollectionRefs("result", [resultToRemove.id])
        }
      }
    }

    setSelectedExperimentId(id)
    setActiveEntity(id ? { kind: "experiment", id } : null)
    if (id) updateLastSelected("experiment", id)
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

    const { collectionId, planeId, selectedExperimentId } =
      pendingCollectionLink
    setPendingCollectionLink(null)

    if (selectedExperimentId) {
      selectExperiment(selectedExperimentId)
      return
    }

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

    // Keep experiment.hasResults in sync so the status propagates everywhere.
    // Treat "finished" as equivalent to all device groups assigned.
    const totalGroups = updatedResults.deviceGroups.length
    const matchedCount = updatedResults.deviceGroups.filter(
      (g) => g.assignedSubstrateId,
    ).length
    const allAssigned = totalGroups > 0 && matchedCount === totalGroups

    setExperiments((prev) =>
      prev.map((e) =>
        e.id === updatedResults.experimentId
          ? { ...e, hasResults: hasFiles || allAssigned }
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
  }, [selectedExperimentId, visibleExperiments, selectExperiment])

  return (
    <Box style={{ display: "flex", height: "calc(100vh - 60px)" }}>
      {/* Main: Results Detail */}
      <Box style={{ flex: 1, background: "var(--mantine-color-gray-0)" }}>
        {selectedExperiment ? (
          <ResultsDetail
            experiment={selectedExperiment}
            experimentResults={experimentResults}
            onUpdateResults={updateResults}
            onUpdateExperiment={(updatedExp) => {
              setExperiments((prev) =>
                prev.map((e) => (e.id === updatedExp.id ? updatedExp : e)),
              )
            }}
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
              visibleExperiments.map((exp) => {
                const expResults = results.find(
                  (r) => r.experimentId === exp.id,
                )
                const hasUnfinishedUpload =
                  !!expResults &&
                  expResults.files.length > 0 &&
                  !exp.hasCompletedUpload
                return (
                  <ExperimentListItem
                    key={exp.id}
                    experiment={exp}
                    isSelected={selectedExperimentId === exp.id}
                    onSelect={() => selectExperiment(exp.id)}
                    collectionColor={
                      getEntityColor("experiment", exp.id) ?? undefined
                    }
                    hasUnfinishedUpload={hasUnfinishedUpload}
                  />
                )
              })
            )}
          </Stack>
        </ScrollArea>
      </Box>
    </Box>
  )
}
