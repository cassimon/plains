import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { getTokenSync } from "../lib/keycloakInstance"
import {
  type AppSnapshot,
  type BackendAdapter,
  HttpBackend,
  InMemoryBackend,
  UNLOAD_BACKUP_KEY,
} from "./backend"

// ── Material ────────────────────────────────────────────────────────────────

export type MaterialCategory =
  | "chemical_compound"
  | "commercial_mixture"
  | "substrate_material"

export type MaterialStateAtRt = "" | "liquid" | "solid" | "gas"

export type MaterialSubstrateRigidity = "" | "flexible" | "rigid"

export type Material = {
  id: string
  category: MaterialCategory
  type: string
  name: string
  supplier: string
  supplierNumber: string
  casNumber: string
  pubchemCid: string
  inventoryLabel: string
  purity: string
  stateAtRt: MaterialStateAtRt
  substrateRigidity: MaterialSubstrateRigidity
  heightMm: string
}

export function newMaterial(
  category: MaterialCategory = "chemical_compound",
): Material {
  return {
    id: crypto.randomUUID(),
    category,
    type: "",
    name: "",
    supplier: "",
    supplierNumber: "",
    casNumber: "",
    pubchemCid: "",
    inventoryLabel: "",
    purity: "",
    stateAtRt: "",
    substrateRigidity: "",
    heightMm: "",
  }
}

export type ProcessSubstrateDimension = {
  lengthCm: string
  widthCm: string
  surfaceRoughnessRmsNm?: string
}

// ── Experiment ───────────────────────────────────────────────────────────────

/** Process parameter mode: constant value or varied across substrates */
export type ParamMode = "constant" | "variation"

/** A single process parameter with its value and mode */
export type ProcessParam = {
  value: string
  mode: ParamMode
  // variationValues stored separately when needed
}

export type ProcessParameterKey =
  | "depositionMethod"
  | "depositionStartTime"
  | "substrateTemp"
  | "depositionAtmosphere"
  | "depositionParameters"
  | "solutionVolume"
  | "dryingMethod"
  | "annealingStartTime"
  | "annealingTime"
  | "annealingTemp"
  | "annealingAtmosphere"

/** Deposition/processing layer in an experiment */
export type ExperimentLayer = {
  id: string
  name: string
  color: string
  layerType?: "etl" | "htl" | "perovskite" | "additional" | "back_contact" // Layer category
  materialId?: string // reference to Material
  solutionId?: string // reference to Solution
  // Process parameters - all optional, encourage adding over requiring
  depositionMethod?: ProcessParam
  depositionStartTime?: ProcessParam
  substrateTemp?: ProcessParam
  depositionAtmosphere?: ProcessParam
  depositionParameters?: ProcessParam
  solutionVolume?: ProcessParam
  dryingMethod?: ProcessParam
  annealingStartTime?: ProcessParam
  annealingTime?: ProcessParam
  annealingTemp?: ProcessParam
  annealingAtmosphere?: ProcessParam
  notes?: string
}

/** Process step category (menu options) */
export type ProcessStepCategory =
  | "wet_deposition"
  | "dry_deposition"
  | "surface_treatment"
  | "doping_aging"
  | "substrate_preparation"

/** A single process step in a Process, reusing ProcessParam schema */
export type ProcessStep = {
  id: string
  name: string // user-friendly label, e.g. "Perovskite Deposition"
  stepCategory: ProcessStepCategory
  color: string
  materialId?: string // reference to Material
  solutionId?: string // reference to Solution
  // Parameters - all optional, encourage adding over requiring
  depositionMethod?: ProcessParam
  depositionStartTime?: ProcessParam
  substrateTemp?: ProcessParam
  depositionAtmosphere?: ProcessParam
  depositionParameters?: ProcessParam
  solutionVolume?: ProcessParam
  dryingMethod?: ProcessParam
  annealingStartTime?: ProcessParam
  annealingTime?: ProcessParam
  annealingTemp?: ProcessParam
  annealingAtmosphere?: ProcessParam
  notes?: string
}

/** A single stage in a process flow, containing one or more alternative steps */
export type ProcessStage = {
  index: number // 0-based, 0 is bottom
  alternatives: ProcessStep[] // >= 1 step per stage (usually 1, multiple for alternatives)
}

/** Persisted generated layer for process-derived stack editor */
export type ProcessGeneratedStackLayer = {
  id: string
  name: string
  color: string
  isSubstrate: boolean
  layerType: string
  thicknessNm: string
  bandgapEv: string
  perovskiteA: string
  perovskiteB: string
  perovskiteX: string
}

/** Persisted generated stack for a process */
export type ProcessGeneratedStack = {
  layers: ProcessGeneratedStackLayer[]
  combination: number
  architecture?: string
  buildDevice?: "Yes" | "No"
  pixelAreaCm2?: string
  numberOfPixels?: string
}

/** An abstract thin-film deposition process template */
export type Process = {
  id: string
  name: string
  description?: string
  substrateIds: string[] // references to substrate Materials
  substrateDimensionsById?: Record<string, ProcessSubstrateDimension>
  stages: ProcessStage[] // ordered from bottom (index 0) upward
  /** Persisted generated stacks for process editor UI */
  generatedStacks?: ProcessGeneratedStack[]
  /** Persisted hidden/deleted stack combinations in process editor UI */
  deletedStackCombinations?: number[]
}

/** Helper to create a new process step */
export function newProcessStep(
  index: number,
  category: ProcessStepCategory,
): ProcessStep {
  return {
    id: crypto.randomUUID(),
    name: `Step ${index + 1}`,
    stepCategory: category,
    color: LAYER_COLORS[index % LAYER_COLORS.length],
  }
}

/** Helper to create a new process with initial stage */
export function newProcess(): Process {
  return {
    id: crypto.randomUUID(),
    name: "New Process",
    description: "",
    substrateIds: [],
    stages: [],
  }
}

export const PROCESS_PARAMETER_DEFINITIONS: ReadonlyArray<{
  key: ProcessParameterKey
  label: string
  placeholder?: string
  unit?: string
  type?: "text" | "number" | "datetime-local"
}> = [
  {
    key: "depositionMethod",
    label: "Deposition Method",
    placeholder: "e.g. Spin coating",
  },
  {
    key: "depositionStartTime",
    label: "Deposition Start Time",
    type: "datetime-local",
  },
  {
    key: "substrateTemp",
    label: "Substrate Temperature",
    placeholder: "e.g. 25",
    unit: "°C",
    type: "number",
  },
  {
    key: "depositionAtmosphere",
    label: "Deposition Atmosphere",
    placeholder: "e.g. N2 glovebox",
  },
  {
    key: "depositionParameters",
    label: "Deposition Parameters",
    placeholder: "e.g. 4000 rpm for 30 s",
  },
  {
    key: "solutionVolume",
    label: "Solution Volume",
    placeholder: "e.g. 50",
    unit: "µL",
    type: "number",
  },
  {
    key: "dryingMethod",
    label: "Drying/Quenching",
    placeholder: "e.g. Antisolvent drip",
  },
  {
    key: "annealingStartTime",
    label: "Annealing Start Time",
    type: "datetime-local",
  },
  {
    key: "annealingTime",
    label: "Annealing Time",
    placeholder: "e.g. 10",
    unit: "min",
    type: "number",
  },
  {
    key: "annealingTemp",
    label: "Annealing Temperature",
    placeholder: "e.g. 100",
    unit: "°C",
    type: "number",
  },
  {
    key: "annealingAtmosphere",
    label: "Annealing Atmosphere",
    placeholder: "e.g. Air",
  },
] as const

/** Architecture type for solar cell devices */
export type DeviceArchitecture =
  | "n-i-p"
  | "p-i-n"
  | "n-i-p-n"
  | "p-i-n-p"
  | "custom"

/** A single substrate in an experiment */
export type Substrate = {
  id: string
  name: string // e.g. "substrate_1", "substrate_2"
  substrateMaterialId?: string
  notes?: string
  // Per-substrate parameter values for variation mode
  // Key format: "layerId:paramName", Value: string
  parameterValues?: { [key: string]: string }
}

export type Experiment = {
  id: string
  name: string
  description: string
  date: string // fabrication date (ISO string)
  endDate?: string // optional completion date
  // Device configuration
  architecture: DeviceArchitecture
  substrateMaterial: string
  substrateWidth: number // cm
  substrateLength: number // cm
  numSubstrates: number
  devicesPerSubstrate: number
  deviceArea: number // cm²
  deviceType: "film" | "half" | "full" // test film, half device, or full device
  deviceLayoutImage?: string // base64 encoded image (jpg/png)
  // Link to exactly one Process
  processId: string
  // Substrates in the experiment
  substrates: Substrate[]
  // Absolute processing times keyed by process stage id
  processingTimes?: { [stageId: string]: string }
  // Results uploaded (makes experiment "Finished" only if actually uploaded to NOMAD)
  hasResults: boolean
  // Track if at least one NOMAD upload has been completed (needed for "finished" status)
  hasCompletedUpload?: boolean
} // NOTE: Layer stack is now managed in the linked Process

/** Fields required for an experiment to be 'ready' */
export function getExperimentMissingFields(exp: Experiment): string[] {
  const missing: string[] = []
  if (!exp.name.trim()) {
    missing.push("name")
  }
  if (!exp.date) {
    missing.push("date")
  }
  return missing
}

/** Compute experiment status */
export function getExperimentStatus(
  exp: Experiment,
): "incomplete" | "ready" | "finished" {
  // Only mark as "finished" if there's an actual completed NOMAD upload
  if (exp.hasCompletedUpload) {
    return "finished"
  }
  if (getExperimentMissingFields(exp).length === 0) {
    return "ready"
  }
  return "incomplete"
}

/**
 * Get all parameters marked for variation across all process steps.
 * Returns array of { stepId, stepName, paramName, paramKey }
 */
export function getVariedParametersFromProcess(process: Process): Array<{
  stepId: string
  stepName: string
  paramName: string
  paramKey: string // "stepId:paramName"
}> {
  const varied: Array<{
    stepId: string
    stepName: string
    paramName: string
    paramKey: string
  }> = []

  process.stages.forEach((stage) => {
    stage.alternatives.forEach((step) => {
      PROCESS_PARAMETER_DEFINITIONS.forEach(({ key, label }) => {
        const param = step[key as ProcessParameterKey]
        if (param && param.mode === "variation") {
          varied.push({
            stepId: step.id,
            stepName: step.name,
            paramName: label,
            paramKey: `${step.id}:${key}`,
          })
        }
      })
    })
  })

  return varied
}

/**
 * Get all parameters marked for variation across all layers (legacy, for backward compat)
 * Returns array of { layerId, layerName, paramName, paramKey }
 */
export function getVariedParameters(_exp: Experiment): Array<{
  layerId: string
  layerName: string
  paramName: string
  paramKey: string // "layerId:paramName"
}> {
  // Experiments no longer directly own layers; this is now a no-op
  // Kept for backward compatibility during migration
  return []
}

const LAYER_COLORS = [
  "#FF6B6B",
  "#4ECDC4",
  "#45B7D1",
  "#96CEB4",
  "#FFEAA7",
  "#DDA0DD",
  "#98D8C8",
  "#F7DC6F",
  "#BB8FCE",
  "#85C1E2",
]

export function newLayer(index: number): ExperimentLayer {
  return {
    id: crypto.randomUUID(),
    name: `Layer ${index + 1}`,
    color: LAYER_COLORS[index % LAYER_COLORS.length],
  }
}

type SubstrateNameOptions = {
  baseName?: string
  date?: string
  experimentName?: string
  userName?: string
  includeDate?: boolean
  includeExpName?: boolean
  includeUser?: boolean
  startIndex?: number
}

/**
 * Generate substrate names from a base name plus optional metadata.
 */
export function generateSubstrates(
  count: number,
  options?: SubstrateNameOptions,
): Substrate[] {
  const {
    baseName = "substrate",
    date,
    experimentName,
    userName,
    includeDate = false,
    includeExpName = false,
    includeUser = false,
    startIndex = 1,
  } = options ?? {}

  const normalizedBaseName = baseName.trim().replace(/\s+/g, "_") || "substrate"
  const substrates: Substrate[] = []

  for (let i = 0; i < count; i++) {
    const parts: string[] = [normalizedBaseName]
    const index = startIndex + i

    if (includeDate && date) {
      parts.push(date)
    }
    if (includeExpName && experimentName) {
      parts.push(experimentName.replace(/\s+/g, "_"))
    }
    if (includeUser && userName) {
      parts.push(userName.replace(/\s+/g, "_"))
    }

    substrates.push({
      id: crypto.randomUUID(),
      name: `${parts.join("_")}_${index}`,
    })
  }

  return substrates
}

/**
 * Regenerate substrate names with same options, preserving IDs
 */
export function regenerateSubstrateNames(
  existingSubstrates: Substrate[],
  options?: SubstrateNameOptions,
): Substrate[] {
  const newSubstrates = generateSubstrates(existingSubstrates.length, options)
  return existingSubstrates.map((sub, idx) => ({
    ...newSubstrates[idx],
    id: sub.id,
  }))
}

export function newExperiment(processId: string): Experiment {
  return {
    id: crypto.randomUUID(),
    name: "New Experiment",
    description: "",
    date: new Date().toISOString().slice(0, 10),
    processId, // required link to exactly one process
    architecture: "n-i-p",
    substrateMaterial: "Glass/ITO",
    substrateWidth: 2.5,
    substrateLength: 2.5,
    numSubstrates: 0,
    devicesPerSubstrate: 4,
    deviceArea: 0.09,
    deviceType: "film",
    substrates: [],
    processingTimes: {},
    hasResults: false,
  }
}

// ── Solution ─────────────────────────────────────────────────────────────────

export type SolutionComponent = {
  id: string
  /** Reference to a material (either materialId or solutionId must be set) */
  materialId?: string
  /** Reference to another solution used as a mixture component */
  solutionId?: string
  amount: string
  unit: "mg" | "ml"
}

export type Solution = {
  id: string
  name: string
  /** Handling instructions before use, e.g. "PVDF 0.22 µm filter before use" */
  handling: string
  /** Storage conditions, e.g. "N2 Glovebox" */
  storage?: string
  creationTime: string
  components: SolutionComponent[]
}

export function newSolution(): Solution {
  return {
    id: crypto.randomUUID(),
    name: "New Solution",
    handling: "",
    storage: "",
    creationTime: new Date().toISOString(),
    components: [],
  }
}

export function newComponent(): SolutionComponent {
  return { id: crypto.randomUUID(), materialId: "", amount: "", unit: "mg" }
}

// ── Results ──────────────────────────────────────────────────────────────────

/** Measurement type detected from file content/extension */
export type MeasurementType =
  | "JV"
  | "Dark JV"
  | "IPCE"
  | "Stability (JV)"
  | "Stability (Tracking)"
  | "Stability (Parameters)"
  | "Document"
  | "Image"
  | "Archive"
  | "Unknown"

/** A measurement file uploaded by the user */
export type MeasurementFile = {
  id: string
  fileName: string
  fileType: MeasurementType
  /** Device name extracted from filename/content (e.g., "AI44") */
  deviceName: string
  /** Cell identifier if parsed (e.g., "1") */
  cell: string
  /** Pixel identifier if parsed (e.g., "C") */
  pixel: string
  /** File content as base64 for storage (optional for large files) */
  content?: string
  /** Parsed value (e.g., PCE percentage) */
  value?: number
  /** Open-circuit voltage in V (from JV file) */
  voc?: number
  /** Short-circuit current density in mA/cm² (from JV or EQE file) */
  jsc?: number
  /** Fill factor in % (from JV file) */
  ff?: number
  /** Date from measurement file */
  measurementDate?: string
  /** User from measurement file */
  user?: string
}

/** A group of measurement files with the same device name */
export type DeviceGroup = {
  id: string
  deviceName: string
  files: MeasurementFile[]
  /** Substrate ID this group is assigned to (null = unmatched) */
  assignedSubstrateId: string | null
  /** Match quality score (0-1) for fuzzy matching */
  matchScore?: number
}

/** NOMAD upload information */
export type NomadUploadInfo = {
  upload_id?: string
  // Deprecated: entry_ids is no longer used, replaced by entries count
  entry_ids?: string[]
  upload_time?: string
  status?: string
  mainfile?: string
  /** Number of entries in the upload (NOMAD API returns this as int) */
  entries?: number
}

/** All results data for an experiment */
export type ExperimentResults = {
  id: string
  experimentId: string
  /** All uploaded measurement files */
  files: MeasurementFile[]
  /** File groups by device name */
  deviceGroups: DeviceGroup[]
  /** Grouping strategy used */
  groupingStrategy: "exact" | "search" | "fuzzy"
  /** Matching strategy used */
  matchingStrategy: "fuzzy" | "sequential" | "manual"
  /** Last updated timestamp */
  updatedAt: string
  /** NOMAD upload information (if uploaded) */
  nomad?: NomadUploadInfo
}

export function newMeasurementFile(fileName: string): MeasurementFile {
  return {
    id: crypto.randomUUID(),
    fileName,
    fileType: "Unknown",
    deviceName: "",
    cell: "",
    pixel: "",
  }
}

export function newExperimentResults(experimentId: string): ExperimentResults {
  return {
    id: crypto.randomUUID(),
    experimentId,
    files: [],
    deviceGroups: [],
    groupingStrategy: "search",
    matchingStrategy: "fuzzy",
    updatedAt: new Date().toISOString(),
  }
}

// ── Organization / Canvas ─────────────────────────────────────────────────────
//
// Data model designed for future backend integration:
//   - All entities have stable `id` (UUID) keys
//   - Mutations go through typed repository functions on the context
//   - The context surface (useAppContext) is the sole interface that a backend
//     adapter needs to replace — swap useState for API calls without touching UI

export type CanvasElementType = "text" | "plaintext" | "line" | "collection"

export type Vec2 = { x: number; y: number }

export type CanvasTextElement = {
  id: string
  type: "text"
  position: Vec2
  size: Vec2
  content: string
  color: string // text color, default black
  formatting: TextFormatting
}

export type TextFormatting = {
  bold?: boolean
  italic?: boolean
  underline?: boolean
}

export type CanvasPlainTextElement = {
  id: string
  type: "plaintext"
  position: Vec2
  size: Vec2
  content: string
  color: string // text color, default black
  formatting: TextFormatting
}

export type CanvasLineElement = {
  id: string
  type: "line"
  points: Vec2[] // sequence of absolute canvas coordinates
  color?: string
  kind?: "line" | "pen" | "rectangle"
  strokeWidth?: number
}

/**
 * A Collection is a named folder placed on the canvas that groups references
 * to Materials, Solutions, Processes, and other app entities.
 */
export type CollectionRef = {
  kind:
    | "material"
    | "solution"
    | "experiment"
    | "result"
    | "analysis"
    | "process"
  id: string
}

export type CanvasCollectionElement = {
  id: string
  type: "collection"
  position: Vec2
  size: Vec2
  name: string
  refs: CollectionRef[]
  color?: string
}

export type CanvasElement =
  | CanvasTextElement
  | CanvasPlainTextElement
  | CanvasLineElement
  | CanvasCollectionElement

export type Plane = {
  id: string
  name: string
  elements: CanvasElement[]
  ownerId?: string
  owner?: { id: string; email: string; full_name: string | null }
  sharedWith?: Array<{ id: string; email: string; full_name: string | null }>
}

export function newPlane(name?: string, ownerId?: string): Plane {
  return {
    id: crypto.randomUUID(),
    name: name ?? "New Plane",
    elements: [],
    ownerId,
  }
}

function newTextElement(position: Vec2): CanvasTextElement {
  return {
    id: crypto.randomUUID(),
    type: "text",
    position,
    size: { x: 200, y: 80 },
    content: "",
    color: "#000000",
    formatting: {
      bold: false,
      italic: false,
      underline: false,
    },
  }
}

function newPlainTextElement(
  position: Vec2,
  color: string,
  formatting: TextFormatting,
): CanvasPlainTextElement {
  return {
    id: crypto.randomUUID(),
    type: "plaintext",
    position,
    size: { x: 200, y: 40 },
    content: "",
    color,
    formatting,
  }
}

function newLineElement(start: Vec2): CanvasLineElement {
  // Initialize with two points so the line is immediately visible during drag
  return {
    id: crypto.randomUUID(),
    type: "line",
    points: [start, { ...start }],
  }
}

function newCollectionElement(position: Vec2): CanvasCollectionElement {
  return {
    id: crypto.randomUUID(),
    type: "collection",
    position,
    size: { x: 200, y: 160 },
    name: "Data Collection",
    refs: [],
  }
}

export {
  newTextElement,
  newPlainTextElement,
  newLineElement,
  newCollectionElement,
}

// ── Dependency tracking ───────────────────────────────────────────────────────

export type DependencyLocation = {
  planeName: string
  collectionName: string
  itemKind: "solution" | "experiment" | "result" | "process"
  itemName: string
  itemId: string
}

/**
 * Returns all items that depend on a given entity. Used for delete protection UI:
 * show the user where an item is still used before allowing deletion.
 *
 * Dependency graph:
 *   material  ← solution.components[].materialId, process.stages[].alternatives[].materialId (*no materialId yet in ProcessStep*)
 *   solution  ← solution.components[].solutionId, process.stages[].alternatives[].solutionId (*no solutionId yet in ProcessStep*)
 *   experiment ← result.experimentId
 *   process   ← experiment.processId
 */
export function getDependentLocations(
  kind: "material" | "solution" | "experiment" | "process",
  id: string,
  data: {
    solutions: Solution[]
    experiments: Experiment[]
    processes: Process[]
    planes: Plane[]
  },
): DependencyLocation[] {
  const locations: DependencyLocation[] = []

  /** Find which (plane, collection) hosts a given item ref */
  function findHost(
    refKind: CollectionRef["kind"],
    refId: string,
  ): { planeName: string; collectionName: string } {
    for (const plane of data.planes) {
      for (const el of plane.elements) {
        if (
          el.type === "collection" &&
          (el as CanvasCollectionElement).refs.some(
            (r) => r.kind === refKind && r.id === refId,
          )
        ) {
          return {
            planeName: plane.name,
            collectionName: (el as CanvasCollectionElement).name,
          }
        }
      }
    }
    return { planeName: "(No plane)", collectionName: "(No collection)" }
  }

  if (kind === "material") {
    for (const sol of data.solutions) {
      if (sol.components.some((c) => c.materialId === id)) {
        const host = findHost("solution", sol.id)
        locations.push({
          ...host,
          itemKind: "solution",
          itemName: sol.name,
          itemId: sol.id,
        })
      }
    }
    // Materials may be used in process steps (future); add process checks here if/when ProcessStep gets materialId
  } else if (kind === "solution") {
    for (const sol of data.solutions) {
      if (sol.components.some((c) => c.solutionId === id)) {
        const host = findHost("solution", sol.id)
        locations.push({
          ...host,
          itemKind: "solution",
          itemName: sol.name,
          itemId: sol.id,
        })
      }
    }
    // Solutions may be used in process steps (future); add process checks here if/when ProcessStep gets solutionId
  } else if (kind === "process") {
    for (const exp of data.experiments) {
      if (exp.processId === id) {
        const host = findHost("experiment", exp.id)
        locations.push({
          ...host,
          itemKind: "experiment",
          itemName: exp.name,
          itemId: exp.id,
        })
      }
    }
  }

  return locations
}

// ── Context ───────────────────────────────────────────────────────────────────

type AppContextValue = {
  // ── Data ──────────────────────────────────────────────────────────────────
  materials: Material[]
  setMaterials: React.Dispatch<React.SetStateAction<Material[]>>
  solutions: Solution[]
  setSolutions: React.Dispatch<React.SetStateAction<Solution[]>>
  experiments: Experiment[]
  setExperiments: React.Dispatch<React.SetStateAction<Experiment[]>>
  processes: Process[]
  setProcesses: React.Dispatch<React.SetStateAction<Process[]>>
  results: ExperimentResults[]
  setResults: React.Dispatch<React.SetStateAction<ExperimentResults[]>>
  planes: Plane[]
  setPlanes: React.Dispatch<React.SetStateAction<Plane[]>>

  // ── Plane repository ──────────────────────────────────────────────────────
  addPlane: (name?: string, userId?: string) => Plane
  updatePlane: (plane: Plane) => void
  deletePlane: (id: string) => void

  // ── Element repository (operates on a specific plane) ─────────────────────
  addTextElement: (planeId: string, position: Vec2) => CanvasTextElement
  addPlainTextElement: (
    planeId: string,
    position: Vec2,
    color: string,
    formatting: TextFormatting,
  ) => CanvasPlainTextElement
  addLineElement: (planeId: string, start: Vec2) => CanvasLineElement
  addCollectionElement: (
    planeId: string,
    position: Vec2,
  ) => CanvasCollectionElement
  updateElement: (planeId: string, element: CanvasElement) => void
  deleteElement: (planeId: string, elementId: string) => void
  /** Remove refs of a given kind/ids from every collection across all planes */
  removeCollectionRefs: (kind: CollectionRef["kind"], ids: string[]) => void
  /** Remove srcId and dstId, insert merged collection — all in one atomic update */
  fuseCollections: (
    planeId: string,
    srcId: string,
    dstId: string,
    merged: CanvasCollectionElement,
  ) => void

  /**
   * Copy collection refs from one element to a new collection in a target plane.
   * The original element and its refs remain unchanged.
   */
  copyElementToPlane: (
    sourceElement: CanvasCollectionElement,
    targetPlaneId: string,
  ) => void

  /**
   * Move collection refs from one element to a new collection in a target plane.
   * The original element is deleted from its source plane.
   */
  moveElementToPlane: (
    sourceElement: CanvasCollectionElement,
    sourcePlaneId: string,
    targetPlaneId: string,
  ) => void

  // ── Selection ─────────────────────────────────────────────────────────────
  /** ID of the currently focused Collection canvas element, or null */
  activeCollectionId: string | null
  setActiveCollectionId: (id: string | null) => void

  /** ID of the plane currently shown in the Organisation tab */
  activePlaneId: string | null
  setActivePlaneId: (id: string | null) => void

  /**
   * When an action bubble creates a new item and navigates to another page,
   * this holds { collectionId, kind } so that page knows to auto-create an
   * item and link it back to the collection.
   */
  pendingCollectionLink: {
    collectionId: string
    planeId: string
    kind: CollectionRef["kind"]
    selectedProcessId?: string
    selectedExperimentId?: string
    openAddResults?: boolean
    materialCategory?: MaterialCategory
    processAttachment?: {
      processId: string
      target: "substrate" | "step-material" | "step-solution"
      stepId?: string
    }
    /** If set, navigate back to this route after the auto-created item is saved. */
    returnTo?: string
    requestId: string
  } | null
  setPendingCollectionLink: (
    v: {
      collectionId: string
      planeId: string
      kind: CollectionRef["kind"]
      selectedProcessId?: string
      selectedExperimentId?: string
      openAddResults?: boolean
      materialCategory?: MaterialCategory
      processAttachment?: {
        processId: string
        target: "substrate" | "step-material" | "step-solution"
        stepId?: string
      }
      /** If set, navigate back to this route after the auto-created item is saved. */
      returnTo?: string
      requestId: string
    } | null,
  ) => void

  /** The single entity currently focused in a page's detail view */
  activeEntity: {
    kind: "experiment" | "material" | "solution" | "process"
    id: string
  } | null
  setActiveEntity: (
    e: {
      kind: "experiment" | "material" | "solution" | "process"
      id: string
    } | null,
  ) => void

  /** Last-selected entity ID per kind — restored when navigating back to a page */
  lastSelectedByKind: Partial<
    Record<"experiment" | "material" | "solution" | "process", string>
  >
  updateLastSelected: (
    kind: "experiment" | "material" | "solution" | "process",
    id: string,
  ) => void

  /** Immediately persist the current state (call before logout). */
  flushSave: () => Promise<void>
}

const AppContext = createContext<AppContextValue | null>(null)

const DEFAULT_BACKEND = new InMemoryBackend({ planes: [newPlane("Plane 1")] })
const INITIAL_PLANES = [newPlane("Plane 1")]
const ACTIVE_PLANE_STORAGE_KEY = "plains_active_plane_id"

function readPersistedActivePlaneId(): string | null {
  try {
    const value = localStorage.getItem(ACTIVE_PLANE_STORAGE_KEY)
    return value && value.trim().length > 0 ? value : null
  } catch {
    return null
  }
}

/** Auto-save interval in milliseconds */
const SAVE_INTERVAL_MS = 30_000
const SAVE_DEBOUNCE_MS = 2_500

export function AppProvider({
  children,
  backend: providedBackend,
}: {
  children: ReactNode
  backend?: BackendAdapter
}) {
  // Use HttpBackend by default if user is authenticated, fall back to InMemory
  const getToken = useCallback(() => getTokenSync(), [])

  const defaultBackend = useMemo(() => {
    const token = getToken()
    if (token) {
      return new HttpBackend()
    }
    return DEFAULT_BACKEND
  }, [getToken])

  const backend = providedBackend ?? defaultBackend
  const [materials, setMaterials] = useState<Material[]>([])
  const [solutions, setSolutions] = useState<Solution[]>([])
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [processes, setProcesses] = useState<Process[]>([])
  const [results, setResults] = useState<ExperimentResults[]>([])
  const [planes, setPlanes] = useState<Plane[]>(INITIAL_PLANES)
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(
    null,
  )
  const [activePlaneId, setActivePlaneId] = useState<string | null>(
    () => readPersistedActivePlaneId() ?? INITIAL_PLANES[0]?.id ?? null,
  )
  const [pendingCollectionLink, setPendingCollectionLink] = useState<{
    collectionId: string
    planeId: string
    kind: CollectionRef["kind"]
    selectedProcessId?: string
    selectedExperimentId?: string
    openAddResults?: boolean
    materialCategory?: MaterialCategory
    processAttachment?: {
      processId: string
      target: "substrate" | "step-material" | "step-solution"
      stepId?: string
    }
    returnTo?: string
    requestId: string
  } | null>(null)
  const [activeEntity, setActiveEntity] = useState<{
    kind: "experiment" | "material" | "solution" | "process"
    id: string
  } | null>(null)
  const [lastSelectedByKind, setLastSelectedByKind] = useState<
    Partial<Record<"experiment" | "material" | "solution" | "process", string>>
  >({})
  const updateLastSelected = useCallback(
    (kind: "experiment" | "material" | "solution" | "process", id: string) => {
      setLastSelectedByKind((prev) => ({ ...prev, [kind]: id }))
    },
    [],
  )
  const [loaded, setLoaded] = useState(false)

  // Refs for save — avoids stale closure in the interval callback
  const stateRef = useRef<AppSnapshot>({
    materials,
    solutions,
    experiments,
    processes,
    results,
    planes,
  })
  stateRef.current = {
    materials,
    solutions,
    experiments,
    processes,
    results,
    planes,
  }
  const dirtyRef = useRef(false)
  const saveTimeoutRef = useRef<number | null>(null)
  const hydratedRef = useRef(false)

  const persistDirtyState = useCallback(async () => {
    if (!loaded || !dirtyRef.current) {
      console.log(
        "[AppContext] persistDirtyState skipped: loaded=",
        loaded,
        "dirty=",
        dirtyRef.current,
      )
      return
    }
    dirtyRef.current = false
    console.log("[AppContext] persistDirtyState: saving state...")
    await backend.save(stateRef.current)
    console.log("[AppContext] persistDirtyState: save complete")
  }, [backend, loaded])

  const scheduleSave = useCallback(() => {
    if (!loaded) {
      return
    }
    dirtyRef.current = true
    console.log("[AppContext] scheduleSave: marked dirty, debouncing...")
    if (saveTimeoutRef.current !== null) {
      window.clearTimeout(saveTimeoutRef.current)
    }
    saveTimeoutRef.current = window.setTimeout(() => {
      void persistDirtyState()
    }, SAVE_DEBOUNCE_MS)
  }, [loaded, persistDirtyState])

  // ── Load persisted state on mount ──────────────────────────────────────────

  useEffect(() => {
    let cancelled = false
    console.log(
      "[AppContext] loading state from backend...",
      backend.constructor.name,
    )
    backend.load().then((snapshot) => {
      if (cancelled) {
        return
      }
      console.log(
        "[AppContext] loaded snapshot:",
        "materials:",
        snapshot.materials.length,
        "solutions:",
        snapshot.solutions.length,
        "experiments:",
        snapshot.experiments.length,
        "processes:",
        snapshot.processes.length,
        "results:",
        snapshot.results.length,
        "planes:",
        snapshot.planes.length,
      )
      if (snapshot.materials.length > 0) {
        setMaterials(snapshot.materials)
      }
      if (snapshot.solutions.length > 0) {
        setSolutions(snapshot.solutions)
      }
      if (snapshot.experiments.length > 0) {
        setExperiments(snapshot.experiments)
      }
      if (snapshot.processes.length > 0) {
        setProcesses(snapshot.processes)
      }
      if (snapshot.results.length > 0) {
        setResults(snapshot.results)
      }
      if (snapshot.planes.length > 0) {
        setPlanes(snapshot.planes)
        setActivePlaneId((current) => {
          if (
            current &&
            snapshot.planes.some((plane) => plane.id === current)
          ) {
            return current
          }
          const persisted = readPersistedActivePlaneId()
          if (
            persisted &&
            snapshot.planes.some((plane) => plane.id === persisted)
          ) {
            return persisted
          }
          return snapshot.planes[0]?.id ?? null
        })
      }
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [backend])

  // ── Save trigger on data changes (debounced) ───────────────────────────────

  useEffect(() => {
    if (!loaded) {
      return
    }
    if (!hydratedRef.current) {
      hydratedRef.current = true
      return
    }
    scheduleSave()
  }, [loaded, scheduleSave, materials, solutions, experiments, processes, results, planes])

  // ── Periodic safety flush + unload / visibility watchdog ──────────────────

  useEffect(() => {
    if (!loaded) {
      return
    }

    const flushIfDirty = () => {
      void persistDirtyState()
    }

    // visibilitychange fires while the page is still alive (tab switch, window
    // minimize, reload).  The in-flight fetch can complete here, making this
    // far more reliable than beforeunload for saving unsaved work.
    const handleVisibilityChange = () => {
      if (document.visibilityState === "hidden") {
        if (saveTimeoutRef.current !== null) {
          window.clearTimeout(saveTimeoutRef.current)
          saveTimeoutRef.current = null
        }
        dirtyRef.current = true
        void persistDirtyState()
      }
    }

    // beforeunload fires synchronously right before the page is destroyed.
    // Async fetches are not guaranteed to complete here, so we only write
    // a synchronous emergency snapshot to localStorage.  HttpBackend.load()
    // will pick this up on the next session and push it to the server.
    const handleBeforeUnload = () => {
      if (dirtyRef.current) {
        try {
          localStorage.setItem(
            UNLOAD_BACKUP_KEY,
            JSON.stringify({ snapshot: stateRef.current, savedAt: Date.now() }),
          )
        } catch {
          // Storage full — ignore; the server either already has the data or
          // visibilitychange will have flushed it.
        }
      }
    }

    const interval = window.setInterval(flushIfDirty, SAVE_INTERVAL_MS)
    document.addEventListener("visibilitychange", handleVisibilityChange)
    window.addEventListener("beforeunload", handleBeforeUnload)

    return () => {
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", handleVisibilityChange)
      window.removeEventListener("beforeunload", handleBeforeUnload)
      if (saveTimeoutRef.current !== null) {
        window.clearTimeout(saveTimeoutRef.current)
      }
      // Only persist on unmount if there are unsaved changes
      // (flushSave already clears dirtyRef, so this is a no-op after logout)
      void persistDirtyState()
    }
  }, [loaded, persistDirtyState])

  // Persist the selected plane so the next login/session restores it.
  useEffect(() => {
    if (!loaded) {
      return
    }
    try {
      if (activePlaneId && planes.some((p) => p.id === activePlaneId)) {
        localStorage.setItem(ACTIVE_PLANE_STORAGE_KEY, activePlaneId)
      } else {
        localStorage.removeItem(ACTIVE_PLANE_STORAGE_KEY)
      }
    } catch {
      // Storage unavailable — graceful no-op
    }
  }, [loaded, activePlaneId, planes])

  // ── Plane mutations ────────────────────────────────────────────────────────

  const addPlane = useCallback((name?: string, userId?: string): Plane => {
    const p = newPlane(name, userId)
    setPlanes((prev) => [...prev, p])
    return p
  }, [])

  const updatePlane = useCallback((plane: Plane) => {
    setPlanes((prev) => prev.map((p) => (p.id === plane.id ? plane : p)))
  }, [])

  const deletePlane = useCallback((id: string) => {
    setPlanes((prev) => {
      if (prev.length <= 1) return prev // never delete the last plane
      return prev.filter((p) => p.id !== id)
    })
  }, [])

  // ── Element mutations ──────────────────────────────────────────────────────

  const addTextElement = useCallback(
    (planeId: string, position: Vec2): CanvasTextElement => {
      const el = newTextElement(position)
      setPlanes((prev) =>
        prev.map((p) =>
          p.id === planeId ? { ...p, elements: [...p.elements, el] } : p,
        ),
      )
      return el
    },
    [],
  )

  const addPlainTextElement = useCallback(
    (
      planeId: string,
      position: Vec2,
      color: string,
      formatting: TextFormatting,
    ): CanvasPlainTextElement => {
      const el = newPlainTextElement(position, color, formatting)
      setPlanes((prev) =>
        prev.map((p) =>
          p.id === planeId ? { ...p, elements: [...p.elements, el] } : p,
        ),
      )
      return el
    },
    [],
  )

  const addLineElement = useCallback(
    (planeId: string, start: Vec2): CanvasLineElement => {
      const el = newLineElement(start)
      setPlanes((prev) =>
        prev.map((p) =>
          p.id === planeId ? { ...p, elements: [...p.elements, el] } : p,
        ),
      )
      return el
    },
    [],
  )

  const addCollectionElement = useCallback(
    (planeId: string, position: Vec2): CanvasCollectionElement => {
      const el = newCollectionElement(position)
      setPlanes((prev) => {
        const plane = prev.find((p) => p.id === planeId)
        const existing = new Set(
          plane?.elements
            .filter((e) => e.type === "collection")
            .map((e) => (e as CanvasCollectionElement).name) ?? [],
        )
        if (existing.has(el.name)) {
          let counter = 2
          while (existing.has(`Data Collection ${counter}`)) counter++
          el.name = `Data Collection ${counter}`
        }
        return prev.map((p) =>
          p.id === planeId ? { ...p, elements: [...p.elements, el] } : p,
        )
      })
      return el
    },
    [],
  )

  const updateElement = useCallback(
    (planeId: string, element: CanvasElement) => {
      setPlanes((prev) =>
        prev.map((p) =>
          p.id === planeId
            ? {
                ...p,
                elements: p.elements.map((e) =>
                  e.id === element.id ? element : e,
                ),
              }
            : p,
        ),
      )
    },
    [],
  )

  const deleteElement = useCallback((planeId: string, elementId: string) => {
    setPlanes((prev) =>
      prev.map((p) =>
        p.id === planeId
          ? { ...p, elements: p.elements.filter((e) => e.id !== elementId) }
          : p,
      ),
    )
  }, [])

  const removeCollectionRefs = useCallback(
    (kind: CollectionRef["kind"], ids: string[]) => {
      const idSet = new Set(ids)
      if (idSet.size === 0) {
        return
      }

      setPlanes((prev) =>
        prev.map((plane) => {
          let changed = false
          const nextElements = plane.elements.map((el) => {
            if (el.type !== "collection") {
              return el
            }
            const collection = el as CanvasCollectionElement
            const nextRefs = collection.refs.filter(
              (ref) => !(ref.kind === kind && idSet.has(ref.id)),
            )
            if (nextRefs.length === collection.refs.length) {
              return el
            }
            changed = true
            return { ...collection, refs: nextRefs }
          })

          return changed ? { ...plane, elements: nextElements } : plane
        }),
      )
    },
    [],
  )

  const fuseCollections = useCallback(
    (
      planeId: string,
      srcId: string,
      dstId: string,
      merged: CanvasCollectionElement,
    ) => {
      setPlanes((prev) =>
        prev.map((p) => {
          if (p.id !== planeId) {
            return p
          }
          const kept = p.elements.filter(
            (e) => e.id !== srcId && e.id !== dstId,
          )
          return { ...p, elements: [...kept, merged] }
        }),
      )
    },
    [],
  )

  const copyElementToPlane = useCallback(
    (sourceElement: CanvasCollectionElement, targetPlaneId: string) => {
      const copy: CanvasCollectionElement = {
        ...sourceElement,
        id: crypto.randomUUID(),
        position: { x: 40, y: 40 },
      }
      setPlanes((prev) =>
        prev.map((p) =>
          p.id === targetPlaneId
            ? { ...p, elements: [...p.elements, copy] }
            : p,
        ),
      )
    },
    [],
  )

  const moveElementToPlane = useCallback(
    (
      sourceElement: CanvasCollectionElement,
      sourcePlaneId: string,
      targetPlaneId: string,
    ) => {
      const moved: CanvasCollectionElement = {
        ...sourceElement,
        id: crypto.randomUUID(),
        position: { x: 40, y: 40 },
      }
      setPlanes((prev) =>
        prev.map((p) => {
          if (p.id === sourcePlaneId) {
            return {
              ...p,
              elements: p.elements.filter((e) => e.id !== sourceElement.id),
            }
          }
          if (p.id === targetPlaneId) {
            return { ...p, elements: [...p.elements, moved] }
          }
          return p
        }),
      )
    },
    [],
  )

  return (
    <AppContext.Provider
      value={{
        materials,
        setMaterials,
        solutions,
        setSolutions,
        experiments,
        setExperiments,
        processes,
        setProcesses,
        results,
        setResults,
        planes,
        setPlanes,
        addPlane,
        updatePlane,
        deletePlane,
        addTextElement,
        addPlainTextElement,
        addLineElement,
        addCollectionElement,
        updateElement,
        deleteElement,
        removeCollectionRefs,
        fuseCollections,
        copyElementToPlane,
        moveElementToPlane,
        activeCollectionId,
        setActiveCollectionId,
        activePlaneId,
        setActivePlaneId,
        pendingCollectionLink,
        setPendingCollectionLink,
        activeEntity,
        setActiveEntity,
        lastSelectedByKind,
        updateLastSelected,
        flushSave: async () => {
          console.log("[AppContext] flushSave called (e.g. before logout)")
          dirtyRef.current = true
          await persistDirtyState()
          console.log("[AppContext] flushSave complete")
        },
      }}
    >
      {children}
    </AppContext.Provider>
  )
}

export function useAppContext() {
  const ctx = useContext(AppContext)
  if (!ctx) {
    throw new Error("useAppContext must be used inside AppProvider")
  }
  return ctx
}

/**
 * Returns helpers for filtering entity lists and resolving collection colors
 * based on the currently active plane and collection selection.
 *
 * When activePlaneId is null ("General" view), all entities across all planes
 * are visible. When a specific plane is selected, only entities referenced by
 * collections on that plane are visible (plus un-referenced orphan entities).
 */
export function useEntityCollection() {
  const { planes, activePlaneId, activeCollectionId } = useAppContext()

  const activePlane = useMemo(
    () => planes.find((p) => p.id === activePlaneId) ?? null,
    [planes, activePlaneId],
  )

  /** Set of all entity keys ("kind:id") referenced by any collection on any plane */
  const allReferencedEntities = useMemo(() => {
    const set = new Set<string>()
    for (const plane of planes) {
      for (const el of plane.elements) {
        if (el.type !== "collection") continue
        const col = el as CanvasCollectionElement
        for (const ref of col.refs) {
          set.add(`${ref.kind}:${ref.id}`)
        }
      }
    }
    return set
  }, [planes])

  /** Set of entity keys referenced by collections on the active plane */
  const planeReferencedEntities = useMemo(() => {
    const set = new Set<string>()
    if (!activePlane) return set
    for (const el of activePlane.elements) {
      if (el.type !== "collection") continue
      const col = el as CanvasCollectionElement
      for (const ref of col.refs) {
        set.add(`${ref.kind}:${ref.id}`)
      }
    }
    return set
  }, [activePlane])

  // Map from "kind:id" → the first CanvasCollectionElement that owns it in the active plane
  const entityToCollection = useMemo(() => {
    const map = new Map<string, CanvasCollectionElement>()
    if (!activePlane) {
      // General view: map across all planes
      for (const plane of planes) {
        for (const el of plane.elements) {
          if (el.type !== "collection") continue
          const col = el as CanvasCollectionElement
          for (const ref of col.refs) {
            if (!map.has(`${ref.kind}:${ref.id}`)) {
              map.set(`${ref.kind}:${ref.id}`, col)
            }
          }
        }
      }
      return map
    }
    for (const el of activePlane.elements) {
      if (el.type !== "collection") {
        continue
      }
      const col = el as CanvasCollectionElement
      for (const ref of col.refs) {
        if (!map.has(`${ref.kind}:${ref.id}`)) {
          map.set(`${ref.kind}:${ref.id}`, col)
        }
      }
    }
    return map
  }, [activePlane, planes])

  const activeCollection = useMemo(() => {
    if (!activeCollectionId || !activePlane) {
      return null
    }
    const el = activePlane.elements.find((e) => e.id === activeCollectionId)
    return el?.type === "collection" ? (el as CanvasCollectionElement) : null
  }, [activeCollectionId, activePlane])

  /** Color of the collection that owns this entity in the active plane, or null */
  const getEntityColor = useCallback(
    (kind: CollectionRef["kind"], id: string): string | null =>
      entityToCollection.get(`${kind}:${id}`)?.color ?? null,
    [entityToCollection],
  )

  /**
   * True when entity should be shown.
   * - General view (no plane selected): all entities visible
   * - Plane selected + no collection selected: entities on this plane + orphans (unreferenced by any plane)
   * - Plane selected + collection selected: only entities in that collection
   */
  const isEntityVisible = useCallback(
    (kind: CollectionRef["kind"], id: string): boolean => {
      // If a specific collection is selected, filter to its refs
      if (activeCollection) {
        return activeCollection.refs.some((r) => r.kind === kind && r.id === id)
      }
      // General view: show everything
      if (!activePlane) {
        return true
      }
      // Plane selected, no collection: show items on this plane + orphans
      if (planeReferencedEntities.has(`${kind}:${id}`)) return true
      // Orphan: not referenced by any collection on any plane
      if (!allReferencedEntities.has(`${kind}:${id}`)) return true
      return false
    },
    [
      activeCollection,
      activePlane,
      planeReferencedEntities,
      allReferencedEntities,
    ],
  )

  /**
   * Returns the plane that owns an entity (for grouping in General view).
   * Returns null if the entity is not referenced by any collection.
   */
  const getEntityPlane = useCallback(
    (kind: CollectionRef["kind"], id: string): Plane | null => {
      for (const plane of planes) {
        for (const el of plane.elements) {
          if (el.type !== "collection") continue
          const col = el as CanvasCollectionElement
          if (col.refs.some((r) => r.kind === kind && r.id === id)) {
            return plane
          }
        }
      }
      return null
    },
    [planes],
  )

  /**
   * True when entity belongs to the active plane (ignoring collection filter).
   * Used for filtering picker options to the current plane context.
   * - General view (no plane): always true
   * - Plane selected: true for entities on that plane, or unassigned orphans
   */
  const isEntityOnActivePlane = useCallback(
    (kind: CollectionRef["kind"], id: string): boolean => {
      if (!activePlane) return true
      if (planeReferencedEntities.has(`${kind}:${id}`)) return true
      if (!allReferencedEntities.has(`${kind}:${id}`)) return true // orphan
      return false
    },
    [activePlane, planeReferencedEntities, allReferencedEntities],
  )

  /**
   * Returns { plane, collection } that owns an entity, or null if unowned.
   * Searches all planes (not just the active one) so copy always lands in
   * the right collection regardless of the current view.
   */
  const getEntityCollection = useCallback(
    (
      kind: CollectionRef["kind"],
      id: string,
    ): { plane: Plane; collection: CanvasCollectionElement } | null => {
      for (const plane of planes) {
        for (const el of plane.elements) {
          if (el.type !== "collection") continue
          const col = el as CanvasCollectionElement
          if (col.refs.some((r) => r.kind === kind && r.id === id)) {
            return { plane, collection: col }
          }
        }
      }
      return null
    },
    [planes],
  )

  return {
    getEntityColor,
    isEntityVisible,
    getEntityPlane,
    getEntityCollection,
    activePlane,
    isEntityOnActivePlane,
  }
}
