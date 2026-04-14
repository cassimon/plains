/**
 * Type converters between API response format and AppContext format.
 * The backend uses snake_case, frontend uses camelCase.
 */

import type {
  Material,
  Solution,
  Experiment,
  ExperimentResults,
  Plane,
  CanvasElement,
} from "./AppContext"

// ── API Response Types (match backend schemas) ──────────────────────────────

export interface ApiMaterial {
  id: string
  name: string
  cas_number: string | null
  molecular_weight: number | null
  density: number | null
  density_unit: string
  supplier: string | null
  notes: string | null
  owner_id: string
  created_at: string | null
}

export interface ApiSolutionComponent {
  id: string
  amount: number
  unit: string
  material_id: string
}

export interface ApiSolution {
  id: string
  name: string
  notes: string | null
  owner_id: string
  created_at: string | null
  components: ApiSolutionComponent[]
}

export interface ApiSubstrate {
  id: string
  name: string
  thickness_nm: number | null
}

export interface ApiExperimentLayer {
  id: string
  name: string
  material_id: string | null
  solution_id: string | null
  temperature: number | null
  temperature_unit: string
  duration: number | null
  duration_unit: string
  notes: string | null
}

export interface ApiExperiment {
  id: string
  name: string
  description: string | null
  device_type: string | null
  active_area_cm2: number | null
  notes: string | null
  owner_id: string
  created_at: string | null
  substrates: ApiSubstrate[]
  layers: ApiExperimentLayer[]
}

export interface ApiMeasurementFile {
  id: string
  filename: string
  file_type: string
  file_path: string | null
  notes: string | null
}

export interface ApiDeviceGroup {
  id: string
  name: string
  substrate_name: string | null
}

export interface ApiExperimentResults {
  id: string
  experiment_id: string
  notes: string | null
  owner_id: string
  created_at: string | null
  measurement_files: ApiMeasurementFile[]
  device_groups: ApiDeviceGroup[]
}

export interface ApiCanvasElement {
  id: string
  element_type: string
  x: number
  y: number
  width: number
  height: number
  content: string | null
  color: string | null
}

export interface ApiPlane {
  id: string
  name: string
  owner_id: string
  created_at: string | null
  elements: ApiCanvasElement[]
}

export interface ApiBulkState {
  materials: ApiMaterial[]
  solutions: ApiSolution[]
  experiments: ApiExperiment[]
  results: ApiExperimentResults[]
  planes: ApiPlane[]
}

// ── Converters: API → AppContext ────────────────────────────────────────────

export function apiMaterialToMaterial(api: ApiMaterial): Material {
  return {
    id: api.id,
    type: "", // Not in API, default empty
    name: api.name,
    supplier: api.supplier ?? "",
    supplierNumber: "", // Not in API
    casNumber: api.cas_number ?? "",
    pubchemCid: "", // Not in API
    inventoryLabel: "", // Not in API
    purity: "", // Not in API
  }
}

export function apiSolutionToSolution(api: ApiSolution): Solution {
  return {
    id: api.id,
    name: api.name,
    components: api.components.map((c) => ({
      id: c.id,
      materialId: c.material_id,
      solutionId: undefined,
      amount: String(c.amount),
      unit: c.unit as "mg" | "ml",
    })),
  }
}

export function apiExperimentToExperiment(api: ApiExperiment): Experiment {
  return {
    id: api.id,
    name: api.name,
    description: api.description ?? "",
    date: api.created_at?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
    architecture: "n-i-p",
    substrateMaterial: "Glass/ITO",
    substrateWidth: 2.5,
    substrateLength: 2.5,
    numSubstrates: api.substrates.length || 1,
    devicesPerSubstrate: 4,
    deviceArea: api.active_area_cm2 ?? 0.09,
    deviceType: (api.device_type as "film" | "half" | "full") ?? "film",
    layers: api.layers.map((l, i) => ({
      id: l.id,
      name: l.name,
      color: ["#FF6B6B", "#4ECDC4", "#45B7D1"][i % 3],
      materialId: l.material_id ?? undefined,
      solutionId: l.solution_id ?? undefined,
      notes: l.notes ?? undefined,
    })),
    substrates: api.substrates.map((s) => ({
      id: s.id,
      name: s.name,
    })),
    hasResults: false, // Will be set based on results presence
  }
}

export function apiResultsToResults(api: ApiExperimentResults): ExperimentResults {
  return {
    id: api.id,
    experimentId: api.experiment_id,
    files: api.measurement_files.map((f) => ({
      id: f.id,
      fileName: f.filename,
      fileType: f.file_type as any,
      deviceName: "",
      cell: "",
      pixel: "",
    })),
    deviceGroups: api.device_groups.map((g) => ({
      id: g.id,
      deviceName: g.name,
      files: [],
      assignedSubstrateId: null,
    })),
    groupingStrategy: "search",
    matchingStrategy: "fuzzy",
    updatedAt: api.created_at ?? new Date().toISOString(),
  }
}

function tryParseJson(s: string): any {
  try {
    return JSON.parse(s)
  } catch {
    return null
  }
}

export function apiPlaneToPlane(api: ApiPlane): Plane {
  return {
    id: api.id,
    name: api.name,
    elements: api.elements.map((e) => {
      // Parse content as JSON for collection elements
      const parsed = e.content ? tryParseJson(e.content) : null
      
      if (e.element_type === "collection") {
        return {
          id: e.id,
          type: "collection" as const,
          position: { x: e.x, y: e.y },
          size: { x: e.width, y: e.height },
          name: parsed?.name ?? "Collection",
          refs: parsed?.refs ?? [],
          color: e.color ?? undefined,
        }
      } else if (e.element_type === "line") {
        return {
          id: e.id,
          type: "line" as const,
          points: parsed?.points ?? [{ x: e.x, y: e.y }, { x: e.x + e.width, y: e.y + e.height }],
          color: e.color ?? undefined,
        }
      } else if (e.element_type === "plaintext") {
        return {
          id: e.id,
          type: "plaintext" as const,
          position: { x: e.x, y: e.y },
          size: { x: e.width, y: e.height },
          content: parsed?.content ?? e.content ?? "",
          color: e.color ?? "#000000",
          formatting: parsed?.formatting ?? {},
        }
      } else {
        return {
          id: e.id,
          type: "text" as const,
          position: { x: e.x, y: e.y },
          size: { x: e.width, y: e.height },
          content: e.content ?? "",
          color: e.color ?? undefined,
        }
      }
    }),
  }
}

// ── Converters: AppContext → API ────────────────────────────────────────────

export function materialToApiCreate(m: Material) {
  return {
    name: m.name,
    cas_number: m.casNumber || null,
    molecular_weight: null,
    density: null,
    density_unit: "g/cm3",
    supplier: m.supplier || null,
    notes: null,
  }
}

export function solutionToApiCreate(s: Solution) {
  return {
    name: s.name,
    notes: null,
    components: s.components
      .filter((c) => c.materialId)
      .map((c) => ({
        amount: parseFloat(c.amount) || 0,
        unit: c.unit,
        material_id: c.materialId!,
      })),
  }
}

export function experimentToApiCreate(e: Experiment) {
  return {
    name: e.name,
    description: e.description || null,
    device_type: e.deviceType,
    active_area_cm2: e.deviceArea,
    notes: null,
    substrates: e.substrates.map((s) => ({
      name: s.name,
      thickness_nm: null,
    })),
    layers: e.layers.map((l) => ({
      name: l.name,
      material_id: l.materialId || null,
      solution_id: l.solutionId || null,
      temperature: null,
      temperature_unit: "°C",
      duration: null,
      duration_unit: "min",
      notes: l.notes || null,
    })),
  }
}

export function planeToApiCreate(p: Plane) {
  return {
    name: p.name,
    elements: p.elements.map((e) => {
      if (e.type === "collection") {
        return {
          element_type: "collection",
          x: e.position.x,
          y: e.position.y,
          width: e.size.x,
          height: e.size.y,
          content: JSON.stringify({ name: e.name, refs: e.refs }),
          color: e.color || null,
        }
      } else if (e.type === "line") {
        return {
          element_type: "line",
          x: e.points[0]?.x ?? 0,
          y: e.points[0]?.y ?? 0,
          width: 0,
          height: 0,
          content: JSON.stringify({ points: e.points }),
          color: e.color || null,
        }
      } else if (e.type === "plaintext") {
        return {
          element_type: "plaintext",
          x: e.position.x,
          y: e.position.y,
          width: e.size.x,
          height: e.size.y,
          content: JSON.stringify({ content: e.content, formatting: e.formatting }),
          color: e.color,
        }
      } else {
        return {
          element_type: "text",
          x: e.position.x,
          y: e.position.y,
          width: e.size.x,
          height: e.size.y,
          content: e.content,
          color: e.color || null,
        }
      }
    }),
  }
}

export function canvasElementToApiCreate(e: CanvasElement) {
  if (e.type === "collection") {
    return {
      element_type: "collection",
      x: e.position.x,
      y: e.position.y,
      width: e.size.x,
      height: e.size.y,
      content: JSON.stringify({ name: e.name, refs: e.refs }),
      color: e.color || null,
    }
  } else if (e.type === "line") {
    return {
      element_type: "line",
      x: e.points[0]?.x ?? 0,
      y: e.points[0]?.y ?? 0,
      width: 0,
      height: 0,
      content: JSON.stringify({ points: e.points }),
      color: e.color || null,
    }
  } else if (e.type === "plaintext") {
    return {
      element_type: "plaintext",
      x: e.position.x,
      y: e.position.y,
      width: e.size.x,
      height: e.size.y,
      content: JSON.stringify({ content: e.content, formatting: e.formatting }),
      color: e.color,
    }
  } else {
    return {
      element_type: "text",
      x: e.position.x,
      y: e.position.y,
      width: e.size.x,
      height: e.size.y,
      content: e.content,
      color: e.color || null,
    }
  }
}
