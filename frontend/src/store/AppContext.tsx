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
import {
  type AppSnapshot,
  type BackendAdapter,
  InMemoryBackend,
} from "./backend"

// ── Material ────────────────────────────────────────────────────────────────

export type Material = {
  id: string
  type: string
  name: string
  supplier: string
  supplierNumber: string
  casNumber: string
  pubchemCid: string
  inventoryLabel: string
  purity: string
}

export function newMaterial(): Material {
  return {
    id: crypto.randomUUID(),
    type: "",
    name: "",
    supplier: "",
    supplierNumber: "",
    casNumber: "",
    pubchemCid: "",
    inventoryLabel: "",
    purity: "",
  }
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

/** Deposition/processing layer in an experiment */
export type ExperimentLayer = {
  id: string
  name: string
  color: string
  materialId?: string // reference to Material
  solutionId?: string // reference to Solution
  // Process parameters - all optional, encourage adding over requiring
  depositionMethod?: ProcessParam
  substrateTemp?: ProcessParam
  depositionAtmosphere?: ProcessParam
  solutionVolume?: ProcessParam
  dryingMethod?: ProcessParam
  annealingTime?: ProcessParam
  annealingTemp?: ProcessParam
  annealingAtmosphere?: ProcessParam
  notes?: string
}

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
  name: string // e.g. "A1", "A2", "B1"
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
  // Layer stack (ordered from substrate up)
  layers: ExperimentLayer[]
  // Substrates in the experiment
  substrates: Substrate[]
  // Results uploaded (makes experiment "Finished")
  hasResults: boolean
}

/** Fields required for an experiment to be 'ready' */
export function getExperimentMissingFields(exp: Experiment): string[] {
  const missing: string[] = []
  if (!exp.name.trim()) {
    missing.push("name")
  }
  if (!exp.date) {
    missing.push("date")
  }
  if (!exp.numSubstrates || exp.numSubstrates < 1) {
    missing.push("numSubstrates")
  }
  return missing
}

/** Compute experiment status */
export function getExperimentStatus(
  exp: Experiment,
): "incomplete" | "ready" | "finished" {
  if (exp.hasResults) {
    return "finished"
  }
  if (getExperimentMissingFields(exp).length === 0) {
    return "ready"
  }
  return "incomplete"
}

/**
 * Get all parameters marked for variation across all layers.
 * Returns array of { layerId, layerName, paramName, paramKey }
 */
export function getVariedParameters(exp: Experiment): Array<{
  layerId: string
  layerName: string
  paramName: string
  paramKey: string // "layerId:paramName"
}> {
  const varied: Array<{
    layerId: string
    layerName: string
    paramName: string
    paramKey: string
  }> = []
  const PARAM_KEYS = [
    "depositionMethod",
    "substrateTemp",
    "depositionAtmosphere",
    "solutionVolume",
    "dryingMethod",
    "annealingTime",
    "annealingTemp",
    "annealingAtmosphere",
  ] as const

  exp.layers.forEach((layer) => {
    PARAM_KEYS.forEach((paramKey) => {
      const param = layer[paramKey as keyof typeof layer] as
        | ProcessParam
        | undefined
      if (param && param.mode === "variation") {
        varied.push({
          layerId: layer.id,
          layerName: layer.name,
          paramName: paramKey.replace(/([A-Z])/g, " $1").trim(),
          paramKey: `${layer.id}:${paramKey}`,
        })
      }
    })
  })

  return varied
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

/**
 * Generate substrate names based on parameters (like Streamlit app)
 * Supports: date_expname_user format with automatic deduplication
 */
export function generateSubstrates(
  count: number,
  options?: {
    date?: string
    experimentName?: string
    userName?: string
    includeDate?: boolean
    includeExpName?: boolean
    includeUser?: boolean
  },
): Substrate[] {
  const {
    date,
    experimentName,
    userName,
    includeDate = true,
    includeExpName = true,
    includeUser = false,
  } = options ?? {}

  const substrates: Substrate[] = []
  const nameCounts: Record<string, number> = {}

  for (let i = 1; i <= count; i++) {
    const parts: string[] = []

    if (includeDate && date) {
      parts.push(date)
    }
    if (includeExpName && experimentName) {
      parts.push(experimentName.replace(/\s+/g, "_"))
    }
    if (includeUser && userName) {
      parts.push(userName.replace(/\s+/g, "_"))
    }

    // If no parts selected, use index-based names (A1, A2, etc.)
    if (parts.length === 0) {
      const cols = Math.ceil(Math.sqrt(count))
      const row = Math.floor((i - 1) / cols)
      const col = (i - 1) % cols
      const rowLetter = String.fromCharCode(65 + row)
      const colNumber = col + 1
      substrates.push({
        id: crypto.randomUUID(),
        name: `${rowLetter}${colNumber}`,
      })
    } else {
      const baseName = parts.join("_")
      nameCounts[baseName] = (nameCounts[baseName] ?? 0) + 1
      const finalName =
        nameCounts[baseName] > 1
          ? `${baseName}_${nameCounts[baseName]}`
          : baseName
      substrates.push({ id: crypto.randomUUID(), name: finalName })
    }
  }

  return substrates
}

/**
 * Regenerate substrate names with same options, preserving IDs
 */
export function regenerateSubstrateNames(
  existingSubstrates: Substrate[],
  options?: {
    date?: string
    experimentName?: string
    userName?: string
    includeDate?: boolean
    includeExpName?: boolean
    includeUser?: boolean
  },
): Substrate[] {
  const newSubstrates = generateSubstrates(existingSubstrates.length, options)
  return existingSubstrates.map((sub, idx) => ({
    ...newSubstrates[idx],
    id: sub.id,
  }))
}

export function newExperiment(): Experiment {
  return {
    id: crypto.randomUUID(),
    name: "New Experiment",
    description: "",
    date: new Date().toISOString().slice(0, 10),
    architecture: "n-i-p",
    substrateMaterial: "Glass/ITO",
    substrateWidth: 2.5,
    substrateLength: 2.5,
    numSubstrates: 1,
    devicesPerSubstrate: 4,
    deviceArea: 0.09,
    deviceType: "film",
    layers: [newLayer(0)],
    substrates: generateSubstrates(1),
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
  components: SolutionComponent[]
}

export function newSolution(): Solution {
  return { id: crypto.randomUUID(), name: "New Solution", components: [] }
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
  color?: string
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
}

/**
 * A Collection is a named folder placed on the canvas that groups references
 * to Materials, Solutions and (extensibly) other app entities.
 */
export type CollectionRef = {
  kind: "material" | "solution" | "experiment" | "result" | "analysis"
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
}

export function newPlane(name?: string): Plane {
  return { id: crypto.randomUUID(), name: name ?? "New Plane", elements: [] }
}

function newTextElement(position: Vec2): CanvasTextElement {
  return {
    id: crypto.randomUUID(),
    type: "text",
    position,
    size: { x: 200, y: 80 },
    content: "",
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
    name: "New Collection",
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
  itemKind: "solution" | "experiment" | "result"
  itemName: string
  itemId: string
}

/**
 * Returns all items that depend on a given entity. Used for delete protection UI:
 * show the user where an item is still used before allowing deletion.
 *
 * Dependency graph:
 *   material  ← solution.components[].materialId, experiment.layers[].materialId
 *   solution  ← solution.components[].solutionId, experiment.layers[].solutionId
 *   experiment ← result.experimentId
 */
export function getDependentLocations(
  kind: "material" | "solution" | "experiment",
  id: string,
  data: {
    solutions: Solution[]
    experiments: Experiment[]
    results: ExperimentResults[]
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
          return { planeName: plane.name, collectionName: (el as CanvasCollectionElement).name }
        }
      }
    }
    return { planeName: "(No plane)", collectionName: "(No collection)" }
  }

  if (kind === "material") {
    for (const sol of data.solutions) {
      if (sol.components.some((c) => c.materialId === id)) {
        const host = findHost("solution", sol.id)
        locations.push({ ...host, itemKind: "solution", itemName: sol.name, itemId: sol.id })
      }
    }
    for (const exp of data.experiments) {
      if (exp.layers.some((l) => l.materialId === id)) {
        const host = findHost("experiment", exp.id)
        locations.push({ ...host, itemKind: "experiment", itemName: exp.name, itemId: exp.id })
      }
    }
  } else if (kind === "solution") {
    for (const sol of data.solutions) {
      if (sol.components.some((c) => c.solutionId === id)) {
        const host = findHost("solution", sol.id)
        locations.push({ ...host, itemKind: "solution", itemName: sol.name, itemId: sol.id })
      }
    }
    for (const exp of data.experiments) {
      if (exp.layers.some((l) => l.solutionId === id)) {
        const host = findHost("experiment", exp.id)
        locations.push({ ...host, itemKind: "experiment", itemName: exp.name, itemId: exp.id })
      }
    }
  } else if (kind === "experiment") {
    for (const res of data.results) {
      if (res.experimentId === id) {
        const host = findHost("result", res.id)
        locations.push({ ...host, itemKind: "result", itemName: `Result ${res.id.slice(0, 6)}`, itemId: res.id })
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
  results: ExperimentResults[]
  setResults: React.Dispatch<React.SetStateAction<ExperimentResults[]>>
  planes: Plane[]

  // ── Plane repository ──────────────────────────────────────────────────────
  addPlane: (name?: string) => Plane
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
  } | null
  setPendingCollectionLink: (
    v: {
      collectionId: string
      planeId: string
      kind: CollectionRef["kind"]
    } | null,
  ) => void

  /** The single entity currently focused in a page's detail view */
  activeEntity: {
    kind: "experiment" | "material" | "solution"
    id: string
  } | null
  setActiveEntity: (
    e: { kind: "experiment" | "material" | "solution"; id: string } | null,
  ) => void

  /** Immediately persist the current state (call before logout). */
  flushSave: () => Promise<void>
}

const AppContext = createContext<AppContextValue | null>(null)

const DEFAULT_BACKEND = new InMemoryBackend({ planes: [newPlane("Plane 1")] })

/** Auto-save interval in milliseconds */
const SAVE_INTERVAL_MS = 5_000

export function AppProvider({
  children,
  backend = DEFAULT_BACKEND,
}: {
  children: ReactNode
  backend?: BackendAdapter
}) {
  const [materials, setMaterials] = useState<Material[]>([])
  const [solutions, setSolutions] = useState<Solution[]>([])
  const [experiments, setExperiments] = useState<Experiment[]>([])
  const [results, setResults] = useState<ExperimentResults[]>([])
  const [planes, setPlanes] = useState<Plane[]>([newPlane("Plane 1")])
  const [activeCollectionId, setActiveCollectionId] = useState<string | null>(
    null,
  )
  const [activePlaneId, setActivePlaneId] = useState<string | null>(null)
  const [pendingCollectionLink, setPendingCollectionLink] = useState<{
    collectionId: string
    planeId: string
    kind: CollectionRef["kind"]
  } | null>(null)
  const [activeEntity, setActiveEntity] = useState<{
    kind: "experiment" | "material" | "solution"
    id: string
  } | null>(null)
  const [loaded, setLoaded] = useState(false)

  // Refs for save — avoids stale closure in the interval callback
  const stateRef = useRef<AppSnapshot>({
    materials,
    solutions,
    experiments,
    results,
    planes,
  })
  stateRef.current = { materials, solutions, experiments, results, planes }

  // ── Load persisted state on mount ──────────────────────────────────────────

  useEffect(() => {
    let cancelled = false
    backend.load().then((snapshot) => {
      if (cancelled) {
        return
      }
      if (snapshot.materials.length > 0) {
        setMaterials(snapshot.materials)
      }
      if (snapshot.solutions.length > 0) {
        setSolutions(snapshot.solutions)
      }
      if (snapshot.experiments.length > 0) {
        setExperiments(snapshot.experiments)
      }
      if (snapshot.results.length > 0) {
        setResults(snapshot.results)
      }
      if (snapshot.planes.length > 0) {
        setPlanes(snapshot.planes)
      }
      setLoaded(true)
    })
    return () => {
      cancelled = true
    }
  }, [backend])

  // ── Auto-save at interval + on unload ──────────────────────────────────────

  useEffect(() => {
    if (!loaded) {
      return
    }

    const save = () => backend.save(stateRef.current)

    const interval = setInterval(save, SAVE_INTERVAL_MS)
    const handleUnload = () => {
      save()
    }
    window.addEventListener("beforeunload", handleUnload)

    return () => {
      clearInterval(interval)
      window.removeEventListener("beforeunload", handleUnload)
      save() // save on unmount
    }
  }, [backend, loaded])

  // ── Plane mutations ────────────────────────────────────────────────────────

  const addPlane = useCallback((name?: string): Plane => {
    const p = newPlane(name)
    setPlanes((prev) => [...prev, p])
    return p
  }, [])

  const updatePlane = useCallback((plane: Plane) => {
    setPlanes((prev) => prev.map((p) => (p.id === plane.id ? plane : p)))
  }, [])

  const deletePlane = useCallback((id: string) => {
    setPlanes((prev) => prev.filter((p) => p.id !== id))
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
      setPlanes((prev) =>
        prev.map((p) =>
          p.id === planeId ? { ...p, elements: [...p.elements, el] } : p,
        ),
      )
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
        results,
        setResults,
        planes,
        addPlane,
        updatePlane,
        deletePlane,
        addTextElement,
        addPlainTextElement,
        addLineElement,
        addCollectionElement,
        updateElement,
        deleteElement,
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
        flushSave: () => backend.save(stateRef.current),
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
    [activeCollection, activePlane, planeReferencedEntities, allReferencedEntities],
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

  return { getEntityColor, isEntityVisible, getEntityPlane, activePlane }
}
