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
import type { UploadFlow } from "../lib/uploadFlow"
import {
  type AppSnapshot,
  type BackendAdapter,
  HttpBackend,
  InMemoryBackend,
  type TrashEntry,
  UNLOAD_BACKUP_KEY,
} from "./backend"

// Kept in sync with the exported constant in ../lib/uploadFlow. Defined locally
// so AppContext's dependency on uploadFlow stays type-only (no runtime cycle).
const UPLOAD_FLOW_INACTIVITY_MS = 30 * 60 * 1000

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
  heightMm?: string
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

/** Inline material defined directly on a process step (no separate entity) */
export type ProcessStepInlineMaterial = {
  name: string
  type?: string // same options as Material.type: "n-type (ETL)", "p-type (HTL)", etc.
  pubchemCid?: string
  /** For mixtures (e.g. PEDOT:PSS): PubChem CIDs of the individual components */
  componentCids?: string[]
  molarMass?: number // g/mol
  density?: number // g/mL
}

/** Inline substrate defined directly in a process (no separate Material entity) */
export type ProcessInlineSubstrate = {
  id: string
  name: string
  rigidity?: "rigid" | "flexible"
  lengthCm?: string
  widthCm?: string
  heightMm?: string
  surfaceRoughnessRmsNm?: string
}

/** A single process step in a Process, reusing ProcessParam schema */
export type ProcessStep = {
  id: string
  name: string // user-friendly label, e.g. "Perovskite Deposition"
  stepCategory: ProcessStepCategory
  color: string
  materialId?: string // reference to Material (legacy, kept for backward compat)
  solutionId?: string // reference to Solution (legacy, kept for backward compat)
  chemRecipeId?: string // references process.solutionRecipes[].id
  inlineMaterial?: ProcessStepInlineMaterial // material defined directly, no entity
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

export type ProcessChemIngredient = {
  id: string
  name: string
  pubchemCid: string
  /** For mixtures (e.g. PEDOT:PSS): PubChem CIDs of the individual components */
  componentCids?: string[]
  molarMass?: number // g/mol
  density?: number // g/mL
}

export type ProcessSolvent = ProcessChemIngredient & {
  volumeRatio: number
  color: string
}

export type ProcessSolute = ProcessChemIngredient & {
  amount: string
  unit: "mg" | "ml" | "mol"
  color: string
}

export type ProcessAddedSolution = {
  recipeId: string
  volumeMl: string
}

export type ProcessSolutionRecipe = {
  id: string
  name: string
  type?: string // same options as Material.type: "n-type (ETL)", "p-type (HTL)", etc.
  isCommercial?: boolean // commercial product — composition tracked without amounts; no addedSolutions
  commercialName?: string // commercial product name / catalogue entry
  supplierNumber?: string // supplier catalogue/article number
  handlingPreparation?: string
  handlingBeforeUse?: string
  totalSolventVolumeMl: string
  solvents: ProcessSolvent[]
  solutes: ProcessSolute[]
  addedSolutions?: ProcessAddedSolution[] // other process solutions mixed in (volumes in mL)
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
  /** Source material/solution type (lowercased) — drives molecule/polymer-only fields. */
  materialType?: string
  /** HOMO energy level (eV) — optional, only meaningful for molecule/polymer layers. */
  homoEv?: string
  /** LUMO energy level (eV) — optional, only meaningful for molecule/polymer layers. */
  lumoEv?: string
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
  substrateIds: string[] // references to substrate Materials (legacy, kept for backward compat)
  substrateDimensionsById?: Record<string, ProcessSubstrateDimension>
  inlineSubstrates?: ProcessInlineSubstrate[] // substrates defined directly, no entity
  stages: ProcessStage[] // ordered from bottom (index 0) upward
  /** Persisted generated stacks for process editor UI */
  generatedStacks?: ProcessGeneratedStack[]
  /** Persisted hidden/deleted stack combinations in process editor UI */
  deletedStackCombinations?: number[]
  /** Solution recipes defined in the Chemistry tab */
  solutionRecipes?: ProcessSolutionRecipe[]
  /** User explicitly marked Step 1 (Chemistry) as not applicable */
  skipChemistry?: boolean
}

/** Compute process completion status */
export function getProcessStatus(process: Process): "incomplete" | "complete" {
  if (!process.name.trim()) return "incomplete"

  // Step 1: Chemistry — has at least one solution recipe, or chemistry is skipped
  const chemistryDone =
    !!process.skipChemistry || (process.solutionRecipes?.length ?? 0) > 0

  // Step 2: Deposition — has substrates AND at least one non-prep deposition step
  const hasSubstrate =
    (process.substrateIds ?? []).length > 0 ||
    (process.inlineSubstrates ?? []).length > 0
  const hasDepositionStep = process.stages.some((stage) =>
    stage.alternatives.some(
      (step) =>
        step.stepCategory !== "surface_treatment" &&
        step.stepCategory !== "substrate_preparation",
    ),
  )
  const depositionDone = hasSubstrate && hasDepositionStep

  // Step 3: Stacks & Devices — at least one stack has been generated
  const deviceDone = (process.generatedStacks?.length ?? 0) > 0

  return chemistryDone && depositionDone && deviceDone
    ? "complete"
    : "incomplete"
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

export type SubstrateOutcomeStatus = "complete" | "incomplete" | "discarded"

export type SubstrateOutcome = {
  status: SubstrateOutcomeStatus
  stoppedAtStep?: string // for "incomplete": stage index as string
  discardReason?: string // for "discarded": optional free-text reason
}

/** A single substrate in an experiment */
export type Substrate = {
  id: string
  name: string // e.g. "substrate_1", "substrate_2"
  substrateMaterialId?: string
  notes?: string
  outcome?: SubstrateOutcome
  // Per-substrate parameter values for variation mode
  // Key format: "layerId:paramName", Value: string
  parameterValues?: { [key: string]: string }
}

export type ExperimentSolutionBatch = {
  mode: "make" | "take"
  totalVolumeMl?: string // for "make" with recipe: target volume in mL
  multiplier?: string // for "make" with entity solution: scale factor (×)
  preparedAt?: string // for "make": datetime-local when this batch was prepared
  vialLabel?: string // for "make": user-editable vial label, defaults to "{SolutionName}_{Date}"
  takenFromExpId?: string // for "take": source experiment id
  takenFromBatchId?: string // for "take": source batch key
}

export type ExperimentChemicalsPrep = {
  prepTime?: string // datetime-local when chemicals were prepared
  materialOverrides?: Record<
    string,
    {
      // keyed by materialId
      inventoryLabel?: string
      purity?: string
      supplier?: string
      productId?: string
    }
  >
  solutionBatches?: Record<string, ExperimentSolutionBatch> // keyed by "sol:{id}" or "recipe:{id}"
  /** Collection IDs imported from other planes — always shown in chemistry suggestions */
  importedCollectionIds?: string[]
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
  // Chemicals preparation data (Step 1)
  chemicalsPrep?: ExperimentChemicalsPrep
  // Whether the user has confirmed the experiment summary (Step 3). Sticky:
  // once confirmed it stays confirmed even if the summary is later edited.
  summaryConfirmed?: boolean
  hasResults: boolean
  hasCompletedUpload?: boolean
} // NOTE: Layer stack is now managed in the linked Process

/** Fields required for an experiment to be complete */
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
): "incomplete" | "complete" {
  if (getExperimentMissingFields(exp).length === 0) {
    return "complete"
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
    date: "", // start date is not defaulted — the user sets it in the Summary step
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
  /** Material/layer type: "n-type (ETL)", "p-type (HTL)", "perovskite precursor", etc. */
  type?: string
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
    type: "",
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
  /** Best-matching substrate even when score was too low to auto-assign */
  suggestedSubstrateId?: string
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
  /** NOMAD's human-readable status line (surfaced from the status poll). */
  lastStatusMessage?: string
  /** NOMAD error diagnostics for a failed upload (shown inline on Results). */
  errors?: unknown[]
  /** NOMAD warning diagnostics for the upload. */
  warnings?: unknown[]
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
  fontSize?: number
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
  kind: "experiment" | "result" | "analysis" | "process"
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
  /** Folder this plane belongs to, or null/undefined when ungrouped. */
  folderId?: string | null
  /** Ordering key: among top-level strip items when ungrouped, within its
   *  folder when grouped. Lower comes first. */
  position?: number
}

/**
 * A PlaneFolder groups planes in the Organization tab strip (Firefox-bookmark
 * style) and the overview. Flat — folders never nest. Every plane belongs to at
 * most one folder.
 */
export type PlaneFolder = {
  id: string
  name: string
  position: number
  ownerId?: string
}

export function newPlane(name?: string, ownerId?: string): Plane {
  return {
    id: crypto.randomUUID(),
    name: name ?? "New Plane",
    elements: [],
    ownerId,
  }
}

export function newPlaneFolder(name?: string, position = 0): PlaneFolder {
  return {
    id: crypto.randomUUID(),
    name: name ?? "New Folder",
    position,
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
  newCollectionElement,
  newLineElement,
  newPlainTextElement,
  newTextElement,
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
  kind: "process",
  id: string,
  data: {
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

  if (kind === "process") {
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
  experiments: Experiment[]
  setExperiments: React.Dispatch<React.SetStateAction<Experiment[]>>
  processes: Process[]
  setProcesses: React.Dispatch<React.SetStateAction<Process[]>>
  results: ExperimentResults[]
  setResults: React.Dispatch<React.SetStateAction<ExperimentResults[]>>
  planes: Plane[]
  setPlanes: React.Dispatch<React.SetStateAction<Plane[]>>
  folders: PlaneFolder[]
  setFolders: React.Dispatch<React.SetStateAction<PlaneFolder[]>>

  // ── Plane repository ──────────────────────────────────────────────────────
  addPlane: (name?: string, userId?: string) => Plane
  updatePlane: (plane: Plane) => void
  deletePlane: (id: string) => void

  // ── Folder repository ─────────────────────────────────────────────────────
  addFolder: (name?: string) => PlaneFolder
  updateFolder: (folder: PlaneFolder) => void
  /** Delete a folder; its planes survive, un-foldered (folderId → null). */
  deleteFolder: (id: string) => void
  /** Move a plane into a folder (or out, with folderId=null); appends to end. */
  assignPlaneToFolder: (planeId: string, folderId: string | null) => void
  /** Persist a new ordering of the given ids (planes and/or folders). */
  reorderTopLevel: (
    orderedIds: Array<{ id: string; kind: "plane" | "folder" }>,
  ) => void

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
    kind: "experiment" | "process"
    id: string
  } | null
  setActiveEntity: (
    e: {
      kind: "experiment" | "process"
      id: string
    } | null,
  ) => void

  /** Last-selected entity ID per kind — restored when navigating back to a page */
  lastSelectedByKind: Partial<Record<"experiment" | "process", string>>
  updateLastSelected: (kind: "experiment" | "process", id: string) => void

  /** Immediately persist the current state (call before logout). */
  flushSave: () => Promise<void>

  // ── Trash (soft-delete) ────────────────────────────────────────────────────
  /** Fetch the current user's trashed items. */
  getTrash: () => Promise<TrashEntry[]>
  /** Restore an item (+ its upward dependency closure), then reload state. */
  restoreTrash: (entityType: string, id: string) => Promise<void>
  /** Permanently delete a single trashed item. */
  purgeTrash: (entityType: string, id: string) => Promise<void>
  /** Permanently delete everything in trash. */
  emptyTrash: () => Promise<void>
  /** Re-apply the authoritative server snapshot (replaces local arrays). */
  reloadFromBackend: () => Promise<void>

  // ── Upload flow ("File Upload" critical status) ───────────────────────────
  /** The single active upload flow, or null. Only one may exist at a time. */
  uploadFlow: UploadFlow | null
  /**
   * Start a new upload flow. Returns false (and no-ops) if one already exists —
   * this enforces the single-active-flow rule at one chokepoint.
   */
  startUploadFlow: (
    init: Partial<Omit<UploadFlow, "id" | "createdAt" | "lastActivityAt">> & {
      origin: UploadFlow["origin"]
    },
  ) => boolean
  /** Patch the active flow (also refreshes its inactivity timer). */
  updateUploadFlow: (patch: Partial<UploadFlow>) => void
  /**
   * Append files to the active flow — both the raw `File` bytes (for upload)
   * and their display metadata. Used when the user drops more files onto the
   * same target ("add to the zip"). No-op when there is no active flow.
   */
  addFilesToUploadFlow: (files: File[]) => void
  /** Drop the active flow (user abort / logout / inactivity). */
  cancelUploadFlow: () => void
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
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [processes, setProcesses] = useState<Process[]>([])
  const [results, setResults] = useState<ExperimentResults[]>([])
  const [planes, setPlanes] = useState<Plane[]>(INITIAL_PLANES)
  const [folders, setFolders] = useState<PlaneFolder[]>([])
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
    processAttachment?: {
      processId: string
      target: "substrate" | "step-material" | "step-solution"
      stepId?: string
    }
    returnTo?: string
    requestId: string
  } | null>(null)
  const [activeEntity, setActiveEntity] = useState<{
    kind: "experiment" | "process"
    id: string
  } | null>(null)
  // ── Upload flow state ──────────────────────────────────────────────────────
  // Ephemeral (mirrors activeEntity / pendingCollectionLink): an in-progress
  // flow must not survive logout or an inactivity window — incomplete flow data
  // is dropped rather than persisted.
  const [uploadFlow, setUploadFlow] = useState<UploadFlow | null>(null)
  const startUploadFlow = useCallback(
    (
      init: Partial<Omit<UploadFlow, "id" | "createdAt" | "lastActivityAt">> & {
        origin: UploadFlow["origin"]
      },
    ): boolean => {
      let started = false
      setUploadFlow((prev) => {
        // Single-flow rule: refuse to start a second flow.
        if (prev) {
          return prev
        }
        started = true
        const now = Date.now()
        return {
          id: crypto.randomUUID(),
          origin: init.origin,
          processId: init.processId ?? null,
          experimentId: init.experimentId ?? null,
          targetCollectionId: init.targetCollectionId ?? null,
          targetPlaneId: init.targetPlaneId ?? null,
          pendingFiles: init.pendingFiles,
          files: init.files ?? [],
          autoCreateSubstrates: init.autoCreateSubstrates ?? false,
          autoCreatedSubstrateIds: [],
          pendingDigests: init.pendingDigests,
          createdAt: new Date(now).toISOString(),
          lastActivityAt: now,
        }
      })
      return started
    },
    [],
  )
  const updateUploadFlow = useCallback((patch: Partial<UploadFlow>) => {
    setUploadFlow((prev) =>
      prev ? { ...prev, ...patch, lastActivityAt: Date.now() } : prev,
    )
  }, [])
  const addFilesToUploadFlow = useCallback((files: File[]) => {
    if (files.length === 0) {
      return
    }
    setUploadFlow((prev) => {
      if (!prev) {
        return prev
      }
      return {
        ...prev,
        files: [...(prev.files ?? []), ...files],
        pendingFiles: [
          ...(prev.pendingFiles ?? []),
          ...files.map((f) => ({ name: f.name, size: f.size })),
        ],
        // New files may carry new device-group names — re-enable the
        // "Import substrate names" button so they can be imported.
        substrateNamesImported: false,
        lastActivityAt: Date.now(),
      }
    })
  }, [])
  const cancelUploadFlow = useCallback(() => setUploadFlow(null), [])

  // Drop an inactive flow after the inactivity window. The timer re-arms
  // whenever lastActivityAt changes (every update bumps it).
  const uploadFlowActivity = uploadFlow?.lastActivityAt
  useEffect(() => {
    if (uploadFlowActivity === undefined) {
      return
    }
    const elapsed = Date.now() - uploadFlowActivity
    const remaining = Math.max(0, UPLOAD_FLOW_INACTIVITY_MS - elapsed)
    const timer = window.setTimeout(() => {
      setUploadFlow((prev) => {
        if (!prev) {
          return prev
        }
        if (Date.now() - prev.lastActivityAt >= UPLOAD_FLOW_INACTIVITY_MS) {
          return null
        }
        return prev
      })
    }, remaining)
    return () => window.clearTimeout(timer)
  }, [uploadFlowActivity])

  const [lastSelectedByKind, setLastSelectedByKind] = useState<
    Partial<Record<"experiment" | "process", string>>
  >({})
  const updateLastSelected = useCallback(
    (kind: "experiment" | "process", id: string) => {
      setLastSelectedByKind((prev) => {
        if (prev[kind] === id) return prev
        return { ...prev, [kind]: id }
      })
    },
    [],
  )
  const [loaded, setLoaded] = useState(false)

  // Refs for save — avoids stale closure in the interval callback
  const stateRef = useRef<AppSnapshot>({
    experiments,
    processes,
    results,
    planes,
    folders,
  })
  // Incomplete results (files uploaded but no NOMAD upload_id) must never be
  // persisted — they represent an in-progress workflow that should not survive
  // a page refresh/crash/tab-close. Filter them out of every save snapshot so
  // this invariant holds regardless of how navigation or unmounting occurs.
  const persistableResults = results.filter(
    (r) => r.files.length === 0 || !!r.nomad?.upload_id,
  )
  stateRef.current = {
    experiments,
    processes,
    results: persistableResults,
    planes,
    folders,
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

  // ── Trash (soft-delete) ────────────────────────────────────────────────────
  // Authoritatively re-apply the server snapshot. Used after a trash
  // restore/purge/empty, where local arrays must be replaced (not merged) so
  // restored items appear and purged ones stay gone. Pending edits are flushed
  // first so nothing is lost.
  const reloadFromBackend = useCallback(async () => {
    dirtyRef.current = true
    await persistDirtyState()
    const snapshot = await backend.load()
    setExperiments(snapshot.experiments)
    setProcesses(snapshot.processes)
    const staleResultIds = new Set(
      snapshot.results
        .filter((r) => r.files.length > 0 && !r.nomad?.upload_id)
        .map((r) => r.id),
    )
    setResults(snapshot.results.filter((r) => !staleResultIds.has(r.id)))
    setFolders(snapshot.folders ?? [])
    setPlanes(
      snapshot.planes.map((plane) => ({
        ...plane,
        elements: plane.elements.map((el) => {
          if (el.type !== "collection") return el
          const col = el as CanvasCollectionElement
          const nextRefs = col.refs.filter(
            (ref) => !(ref.kind === "result" && staleResultIds.has(ref.id)),
          )
          return nextRefs.length === col.refs.length
            ? el
            : { ...col, refs: nextRefs }
        }),
      })),
    )
    setActivePlaneId((current) =>
      current && snapshot.planes.some((p) => p.id === current)
        ? current
        : (snapshot.planes[0]?.id ?? null),
    )
  }, [backend, persistDirtyState])

  const getTrash = useCallback(() => backend.getTrash(), [backend])

  const restoreTrash = useCallback(
    async (entityType: string, id: string) => {
      await backend.restoreTrash(entityType, id)
      await reloadFromBackend()
    },
    [backend, reloadFromBackend],
  )

  const purgeTrash = useCallback(
    async (entityType: string, id: string) => {
      await backend.purgeTrash(entityType, id)
    },
    [backend],
  )

  const emptyTrash = useCallback(async () => {
    await backend.emptyTrash()
  }, [backend])

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
        "experiments:",
        snapshot.experiments.length,
        "processes:",
        snapshot.processes.length,
        "results:",
        snapshot.results.length,
        "planes:",
        snapshot.planes.length,
      )
      if (snapshot.experiments.length > 0) {
        setExperiments(snapshot.experiments)
      }
      if (snapshot.processes.length > 0) {
        setProcesses(snapshot.processes)
      }
      // Strip any incomplete in-progress results that survived a refresh/crash.
      // They should never have been persisted (filtered from the save snapshot),
      // but may exist in older snapshots written before this guard was added.
      const staleResultIds = new Set(
        snapshot.results
          .filter((r) => r.files.length > 0 && !r.nomad?.upload_id)
          .map((r) => r.id),
      )
      const completeResults = snapshot.results.filter(
        (r) => !staleResultIds.has(r.id),
      )
      if (completeResults.length > 0) {
        setResults(completeResults)
      }
      setFolders(snapshot.folders ?? [])
      if (snapshot.planes.length > 0) {
        setPlanes(snapshot.planes)
        // After planes are set, strip collection refs that pointed to stale
        // results (functional update composes on top of the setPlanes above).
        if (staleResultIds.size > 0) {
          setPlanes((prev) =>
            prev.map((plane) => {
              const nextElements = plane.elements.map((el) => {
                if (el.type !== "collection") return el
                const col = el as CanvasCollectionElement
                const nextRefs = col.refs.filter(
                  (ref) =>
                    !(ref.kind === "result" && staleResultIds.has(ref.id)),
                )
                if (nextRefs.length === col.refs.length) return el
                return { ...col, refs: nextRefs }
              })
              return nextElements.some((el, i) => el !== plane.elements[i])
                ? { ...plane, elements: nextElements }
                : plane
            }),
          )
        }
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

  // biome-ignore lint/correctness/useExhaustiveDependencies: planes/folders/experiments/results/processes are intentional triggers — the effect body calls scheduleSave() which reads stateRef (always fresh), so values don't need to be used directly
  useEffect(() => {
    if (!loaded) {
      return
    }
    if (!hydratedRef.current) {
      hydratedRef.current = true
      return
    }
    scheduleSave()
  }, [loaded, scheduleSave, planes, folders, experiments, results, processes])

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
    setPlanes((prev) => {
      const maxPos = prev.reduce((m, x) => Math.max(m, x.position ?? 0), -1)
      return [...prev, { ...p, position: maxPos + 1 }]
    })
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

  // ── Folder mutations ─────────────────────────────────────────────────────
  const addFolder = useCallback((name?: string): PlaneFolder => {
    const f = newPlaneFolder(name)
    setFolders((prev) => {
      const maxPos = prev.reduce((m, x) => Math.max(m, x.position ?? 0), -1)
      return [...prev, { ...f, position: maxPos + 1 }]
    })
    return f
  }, [])

  const updateFolder = useCallback((folder: PlaneFolder) => {
    setFolders((prev) => prev.map((f) => (f.id === folder.id ? folder : f)))
  }, [])

  const deleteFolder = useCallback((id: string) => {
    // Planes in the folder survive as ungrouped.
    setPlanes((prev) =>
      prev.map((p) => (p.folderId === id ? { ...p, folderId: null } : p)),
    )
    setFolders((prev) => prev.filter((f) => f.id !== id))
  }, [])

  const assignPlaneToFolder = useCallback(
    (planeId: string, folderId: string | null) => {
      setPlanes((prev) => {
        // Append to the end of the destination context (folder or top-level).
        const siblings = prev.filter((p) =>
          folderId ? p.folderId === folderId : !p.folderId && p.id !== planeId,
        )
        const maxPos = siblings.reduce(
          (m, x) => Math.max(m, x.position ?? 0),
          -1,
        )
        return prev.map((p) =>
          p.id === planeId ? { ...p, folderId, position: maxPos + 1 } : p,
        )
      })
    },
    [],
  )

  const reorderTopLevel = useCallback(
    (orderedIds: Array<{ id: string; kind: "plane" | "folder" }>) => {
      const posById = new Map(orderedIds.map((it, idx) => [it.id, idx]))
      setPlanes((prev) =>
        prev.map((p) =>
          posById.has(p.id) ? { ...p, position: posById.get(p.id) } : p,
        ),
      )
      setFolders((prev) =>
        prev.map((f) =>
          posById.has(f.id)
            ? { ...f, position: posById.get(f.id) ?? f.position }
            : f,
        ),
      )
    },
    [],
  )

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
        experiments,
        setExperiments,
        processes,
        setProcesses,
        results,
        setResults,
        planes,
        setPlanes,
        folders,
        setFolders,
        addPlane,
        updatePlane,
        deletePlane,
        addFolder,
        updateFolder,
        deleteFolder,
        assignPlaneToFolder,
        reorderTopLevel,
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
        getTrash,
        restoreTrash,
        purgeTrash,
        emptyTrash,
        reloadFromBackend,
        uploadFlow,
        startUploadFlow,
        updateUploadFlow,
        addFilesToUploadFlow,
        cancelUploadFlow,
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
 * Non-throwing variant of {@link useAppContext}. Returns null when rendered
 * outside an AppProvider instead of throwing. Use this in components (e.g.
 * persistent chrome like the sidebar) that can momentarily render during a
 * route transition before/after the provider is mounted, so they degrade
 * gracefully rather than crashing the render.
 */
export function useAppContextOptional() {
  return useContext(AppContext)
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
