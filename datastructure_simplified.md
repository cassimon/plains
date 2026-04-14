# Plains Simplified Data Infrastructure - Implementation Plan

> **Status**: Ready for Implementation  
> **Target**: Load all user data on login (no lazy loading)  
> **Model**: Claude Haiku 4.5 optimized - sequential task list

---

## Overview

This plan implements a proper database-backed data layer while maintaining the existing bulk-load pattern. All user entities are fetched on login via a loading screen, identical to the current JSON blob behavior but with normalized tables.

**What changes:**
- API routes complete for all entity types
- HttpBackend replaces InMemoryBackend
- Data persists to PostgreSQL instead of localStorage/JSONB

**What stays the same:**
- AppContext interface unchanged
- Full data loaded on login
- Same UI behavior

---

## Pre-Implementation Checklist

Before starting, verify:
- [ ] PostgreSQL database running (`docker compose up -d db`)
- [ ] Backend dev server works (`cd backend && uvicorn app.main:app --reload`)
- [ ] Frontend dev server works (`cd frontend && npm run dev`)
- [ ] Can login to the app and see the GUI

---

## Phase 1: Complete Missing Backend Routes

### Task 1.1: Create Materials Route File

**File**: `backend/app/api/routes/materials.py`

```python
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import func, select

from app.api.deps import CurrentUser, SessionDep
from app.models import (
    Material,
    MaterialCreate,
    MaterialPublic,
    MaterialsPublic,
    MaterialUpdate,
    Message,
)

router = APIRouter(prefix="/materials", tags=["materials"])


@router.get("/", response_model=MaterialsPublic)
def read_materials(
    session: SessionDep,
    current_user: CurrentUser,
    skip: int = 0,
    limit: int = 100,
) -> Any:
    """Retrieve materials for current user."""
    if current_user.is_superuser:
        count_statement = select(func.count()).select_from(Material)
        count = session.exec(count_statement).one()
        statement = select(Material).offset(skip).limit(limit)
    else:
        count_statement = (
            select(func.count())
            .select_from(Material)
            .where(Material.owner_id == current_user.id)
        )
        count = session.exec(count_statement).one()
        statement = (
            select(Material)
            .where(Material.owner_id == current_user.id)
            .offset(skip)
            .limit(limit)
        )
    materials = session.exec(statement).all()
    return MaterialsPublic(data=materials, count=count)


@router.get("/{id}", response_model=MaterialPublic)
def read_material(
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
) -> Any:
    """Get material by ID."""
    material = session.get(Material, id)
    if not material:
        raise HTTPException(status_code=404, detail="Material not found")
    if not current_user.is_superuser and material.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized")
    return material


@router.post("/", response_model=MaterialPublic)
def create_material(
    session: SessionDep,
    current_user: CurrentUser,
    material_in: MaterialCreate,
) -> Any:
    """Create new material."""
    material = Material.model_validate(
        material_in, update={"owner_id": current_user.id}
    )
    session.add(material)
    session.commit()
    session.refresh(material)
    return material


@router.put("/{id}", response_model=MaterialPublic)
def update_material(
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    material_in: MaterialUpdate,
) -> Any:
    """Update material."""
    material = session.get(Material, id)
    if not material:
        raise HTTPException(status_code=404, detail="Material not found")
    if not current_user.is_superuser and material.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized")
    update_data = material_in.model_dump(exclude_unset=True)
    material.sqlmodel_update(update_data)
    session.add(material)
    session.commit()
    session.refresh(material)
    return material


@router.delete("/{id}", response_model=Message)
def delete_material(
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
) -> Any:
    """Delete material."""
    material = session.get(Material, id)
    if not material:
        raise HTTPException(status_code=404, detail="Material not found")
    if not current_user.is_superuser and material.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized")
    session.delete(material)
    session.commit()
    return Message(message="Material deleted successfully")
```

### Task 1.2: Create Planes Route File

**File**: `backend/app/api/routes/planes.py`

```python
import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import func, select

from app.api.deps import CurrentUser, SessionDep
from app.models import (
    CanvasElement,
    CanvasElementCreate,
    CanvasElementPublic,
    Message,
    Plane,
    PlaneCreate,
    PlanePublic,
    PlanesPublic,
    PlaneUpdate,
)

router = APIRouter(prefix="/planes", tags=["planes"])


@router.get("/", response_model=PlanesPublic)
def read_planes(
    session: SessionDep,
    current_user: CurrentUser,
    skip: int = 0,
    limit: int = 100,
) -> Any:
    """Retrieve planes for current user."""
    if current_user.is_superuser:
        count_statement = select(func.count()).select_from(Plane)
        count = session.exec(count_statement).one()
        statement = select(Plane).offset(skip).limit(limit)
    else:
        count_statement = (
            select(func.count())
            .select_from(Plane)
            .where(Plane.owner_id == current_user.id)
        )
        count = session.exec(count_statement).one()
        statement = (
            select(Plane)
            .where(Plane.owner_id == current_user.id)
            .offset(skip)
            .limit(limit)
        )
    planes = session.exec(statement).all()
    return PlanesPublic(data=planes, count=count)


@router.get("/{id}", response_model=PlanePublic)
def read_plane(
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
) -> Any:
    """Get plane by ID with elements."""
    plane = session.get(Plane, id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    if not current_user.is_superuser and plane.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized")
    return plane


@router.post("/", response_model=PlanePublic)
def create_plane(
    session: SessionDep,
    current_user: CurrentUser,
    plane_in: PlaneCreate,
) -> Any:
    """Create new plane with optional elements."""
    plane = Plane(
        name=plane_in.name,
        owner_id=current_user.id,
    )
    session.add(plane)
    session.flush()  # Get plane.id
    
    for elem_in in plane_in.elements:
        elem = CanvasElement(
            plane_id=plane.id,
            element_type=elem_in.element_type,
            x=elem_in.x,
            y=elem_in.y,
            width=elem_in.width,
            height=elem_in.height,
            content=elem_in.content,
            color=elem_in.color,
        )
        session.add(elem)
    
    session.commit()
    session.refresh(plane)
    return plane


@router.put("/{id}", response_model=PlanePublic)
def update_plane(
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    plane_in: PlaneUpdate,
) -> Any:
    """Update plane name."""
    plane = session.get(Plane, id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    if not current_user.is_superuser and plane.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    update_data = plane_in.model_dump(exclude_unset=True)
    plane.sqlmodel_update(update_data)
    session.add(plane)
    session.commit()
    session.refresh(plane)
    return plane


@router.delete("/{id}", response_model=Message)
def delete_plane(
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
) -> Any:
    """Delete plane and all its elements."""
    plane = session.get(Plane, id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    if not current_user.is_superuser and plane.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized")
    session.delete(plane)
    session.commit()
    return Message(message="Plane deleted successfully")


# ── Canvas Element Sub-routes ────────────────────────────────────────────────

@router.post("/{plane_id}/elements", response_model=CanvasElementPublic)
def create_element(
    session: SessionDep,
    current_user: CurrentUser,
    plane_id: uuid.UUID,
    element_in: CanvasElementCreate,
) -> Any:
    """Add element to plane."""
    plane = session.get(Plane, plane_id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    if not current_user.is_superuser and plane.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    element = CanvasElement(
        plane_id=plane_id,
        element_type=element_in.element_type,
        x=element_in.x,
        y=element_in.y,
        width=element_in.width,
        height=element_in.height,
        content=element_in.content,
        color=element_in.color,
    )
    session.add(element)
    session.commit()
    session.refresh(element)
    return element


@router.put("/{plane_id}/elements/{element_id}", response_model=CanvasElementPublic)
def update_element(
    session: SessionDep,
    current_user: CurrentUser,
    plane_id: uuid.UUID,
    element_id: uuid.UUID,
    element_in: CanvasElementCreate,
) -> Any:
    """Update canvas element."""
    plane = session.get(Plane, plane_id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    if not current_user.is_superuser and plane.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    element = session.get(CanvasElement, element_id)
    if not element or element.plane_id != plane_id:
        raise HTTPException(status_code=404, detail="Element not found")
    
    element.element_type = element_in.element_type
    element.x = element_in.x
    element.y = element_in.y
    element.width = element_in.width
    element.height = element_in.height
    element.content = element_in.content
    element.color = element_in.color
    
    session.add(element)
    session.commit()
    session.refresh(element)
    return element


@router.delete("/{plane_id}/elements/{element_id}", response_model=Message)
def delete_element(
    session: SessionDep,
    current_user: CurrentUser,
    plane_id: uuid.UUID,
    element_id: uuid.UUID,
) -> Any:
    """Delete canvas element."""
    plane = session.get(Plane, plane_id)
    if not plane:
        raise HTTPException(status_code=404, detail="Plane not found")
    if not current_user.is_superuser and plane.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not authorized")
    
    element = session.get(CanvasElement, element_id)
    if not element or element.plane_id != plane_id:
        raise HTTPException(status_code=404, detail="Element not found")
    
    session.delete(element)
    session.commit()
    return Message(message="Element deleted successfully")
```

### Task 1.3: Register Routes in API Main

**File**: `backend/app/api/main.py`

Add these imports and router includes:

```python
from app.api.routes import materials, planes

# Add to existing router includes:
api_router.include_router(materials.router)
api_router.include_router(planes.router)
```

### Task 1.4: Create Bulk Load Endpoint

**File**: `backend/app/api/routes/state.py` (update existing)

Add a new endpoint that loads all entities in one call:

```python
@router.get("/bulk", response_model=BulkStateResponse)
def get_bulk_state(
    session: SessionDep,
    current_user: CurrentUser,
) -> Any:
    """Load all user entities in a single request."""
    # Materials
    materials = session.exec(
        select(Material).where(Material.owner_id == current_user.id)
    ).all()
    
    # Solutions with components
    solutions = session.exec(
        select(Solution).where(Solution.owner_id == current_user.id)
    ).all()
    
    # Experiments with substrates and layers
    experiments = session.exec(
        select(Experiment).where(Experiment.owner_id == current_user.id)
    ).all()
    
    # Results with files and groups
    results = session.exec(
        select(ExperimentResults).where(ExperimentResults.owner_id == current_user.id)
    ).all()
    
    # Planes with elements
    planes = session.exec(
        select(Plane).where(Plane.owner_id == current_user.id)
    ).all()
    
    return BulkStateResponse(
        materials=materials,
        solutions=solutions,
        experiments=experiments,
        results=results,
        planes=planes,
    )
```

Add the response model to `backend/app/models.py`:

```python
class BulkStateResponse(SQLModel):
    """Full application state for bulk loading."""
    materials: list[MaterialPublic]
    solutions: list[SolutionPublic]
    experiments: list[ExperimentPublic]
    results: list[ExperimentResultsPublic]
    planes: list[PlanePublic]
```

---

## Phase 2: Align Frontend Types with Backend

### Task 2.1: Create Type Mapping Utilities

**File**: `frontend/src/store/apiTypes.ts`

```typescript
/**
 * Type converters between API response format and AppContext format.
 * The backend uses snake_case, frontend uses camelCase.
 */

import type {
  Material,
  Solution,
  SolutionComponent,
  Experiment,
  ExperimentLayer,
  Substrate,
  ExperimentResults,
  MeasurementFile,
  DeviceGroup,
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

function tryParseJson(s: string): any {
  try {
    return JSON.parse(s)
  } catch {
    return null
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
```

---

## Phase 3: Implement HTTP Backend

### Task 3.1: Create HttpBackend Class

**File**: `frontend/src/store/HttpBackend.ts`

```typescript
import type { BackendAdapter, AppSnapshot } from "./backend"
import type {
  Material,
  Solution,
  Experiment,
  ExperimentResults,
  Plane,
  CanvasElement,
} from "./AppContext"
import {
  type ApiBulkState,
  apiMaterialToMaterial,
  apiSolutionToSolution,
  apiExperimentToExperiment,
  apiResultsToResults,
  apiPlaneToPlane,
  materialToApiCreate,
  solutionToApiCreate,
  experimentToApiCreate,
  planeToApiCreate,
  canvasElementToApiCreate,
} from "./apiTypes"

const API_BASE = "/api/v1"

export class HttpBackend implements BackendAdapter {
  private getToken: () => string | null

  constructor(getToken: () => string | null) {
    this.getToken = getToken
  }

  private async fetch<T>(path: string, options: RequestInit = {}): Promise<T> {
    const token = this.getToken()
    if (!token) {
      throw new Error("Not authenticated")
    }

    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
        ...options.headers,
      },
    })

    if (!response.ok) {
      const error = await response.json().catch(() => ({ detail: "Request failed" }))
      throw new Error(error.detail || `HTTP ${response.status}`)
    }

    return response.json()
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async load(): Promise<AppSnapshot> {
    const data = await this.fetch<ApiBulkState>("/state/bulk")
    
    const materials = data.materials.map(apiMaterialToMaterial)
    const solutions = data.solutions.map(apiSolutionToSolution)
    const experiments = data.experiments.map(apiExperimentToExperiment)
    const results = data.results.map(apiResultsToResults)
    const planes = data.planes.map(apiPlaneToPlane)

    // Mark experiments with results
    const experimentIdsWithResults = new Set(results.map((r) => r.experimentId))
    for (const exp of experiments) {
      exp.hasResults = experimentIdsWithResults.has(exp.id)
    }

    return { materials, solutions, experiments, results, planes }
  }

  async save(_snapshot: AppSnapshot): Promise<void> {
    // No-op: individual mutations are saved immediately
    // This method exists for interface compatibility
  }

  // ── Materials ──────────────────────────────────────────────────────────────

  async getMaterials(): Promise<Material[]> {
    const data = await this.fetch<{ data: any[]; count: number }>("/materials/")
    return data.data.map(apiMaterialToMaterial)
  }

  async createMaterial(material: Material): Promise<Material> {
    const created = await this.fetch<any>("/materials/", {
      method: "POST",
      body: JSON.stringify(materialToApiCreate(material)),
    })
    return apiMaterialToMaterial(created)
  }

  async updateMaterial(material: Material): Promise<Material> {
    const updated = await this.fetch<any>(`/materials/${material.id}`, {
      method: "PUT",
      body: JSON.stringify(materialToApiCreate(material)),
    })
    return apiMaterialToMaterial(updated)
  }

  async deleteMaterial(id: string): Promise<void> {
    await this.fetch(`/materials/${id}`, { method: "DELETE" })
  }

  // ── Solutions ──────────────────────────────────────────────────────────────

  async getSolutions(): Promise<Solution[]> {
    const data = await this.fetch<{ data: any[]; count: number }>("/solutions/")
    return data.data.map(apiSolutionToSolution)
  }

  async createSolution(solution: Solution): Promise<Solution> {
    const created = await this.fetch<any>("/solutions/", {
      method: "POST",
      body: JSON.stringify(solutionToApiCreate(solution)),
    })
    return apiSolutionToSolution(created)
  }

  async updateSolution(solution: Solution): Promise<Solution> {
    const updated = await this.fetch<any>(`/solutions/${solution.id}`, {
      method: "PUT",
      body: JSON.stringify(solutionToApiCreate(solution)),
    })
    return apiSolutionToSolution(updated)
  }

  async deleteSolution(id: string): Promise<void> {
    await this.fetch(`/solutions/${id}`, { method: "DELETE" })
  }

  // ── Experiments ────────────────────────────────────────────────────────────

  async getExperiments(): Promise<Experiment[]> {
    const data = await this.fetch<{ data: any[]; count: number }>("/experiments/")
    return data.data.map(apiExperimentToExperiment)
  }

  async createExperiment(experiment: Experiment): Promise<Experiment> {
    const created = await this.fetch<any>("/experiments/", {
      method: "POST",
      body: JSON.stringify(experimentToApiCreate(experiment)),
    })
    return apiExperimentToExperiment(created)
  }

  async updateExperiment(experiment: Experiment): Promise<Experiment> {
    const updated = await this.fetch<any>(`/experiments/${experiment.id}`, {
      method: "PUT",
      body: JSON.stringify(experimentToApiCreate(experiment)),
    })
    return apiExperimentToExperiment(updated)
  }

  async deleteExperiment(id: string): Promise<void> {
    await this.fetch(`/experiments/${id}`, { method: "DELETE" })
  }

  // ── Results ────────────────────────────────────────────────────────────────

  async getResults(): Promise<ExperimentResults[]> {
    const data = await this.fetch<{ data: any[]; count: number }>("/results/")
    return data.data.map(apiResultsToResults)
  }

  async createResults(results: ExperimentResults): Promise<ExperimentResults> {
    const created = await this.fetch<any>("/results/", {
      method: "POST",
      body: JSON.stringify({
        experiment_id: results.experimentId,
        notes: null,
        measurement_files: results.files.map((f) => ({
          filename: f.fileName,
          file_type: f.fileType,
          file_path: null,
          notes: null,
        })),
        device_groups: results.deviceGroups.map((g) => ({
          name: g.deviceName,
          substrate_name: null,
        })),
      }),
    })
    return apiResultsToResults(created)
  }

  async updateResults(results: ExperimentResults): Promise<ExperimentResults> {
    const updated = await this.fetch<any>(`/results/${results.id}`, {
      method: "PUT",
      body: JSON.stringify({ notes: null }),
    })
    return apiResultsToResults(updated)
  }

  async deleteResults(id: string): Promise<void> {
    await this.fetch(`/results/${id}`, { method: "DELETE" })
  }

  // ── Planes ─────────────────────────────────────────────────────────────────

  async getPlanes(): Promise<Plane[]> {
    const data = await this.fetch<{ data: any[]; count: number }>("/planes/")
    return data.data.map(apiPlaneToPlane)
  }

  async createPlane(plane: Plane): Promise<Plane> {
    const created = await this.fetch<any>("/planes/", {
      method: "POST",
      body: JSON.stringify(planeToApiCreate(plane)),
    })
    return apiPlaneToPlane(created)
  }

  async updatePlane(plane: Plane): Promise<Plane> {
    // Update plane name only - elements are managed separately
    const updated = await this.fetch<any>(`/planes/${plane.id}`, {
      method: "PUT",
      body: JSON.stringify({ name: plane.name }),
    })
    return apiPlaneToPlane(updated)
  }

  async deletePlane(id: string): Promise<void> {
    await this.fetch(`/planes/${id}`, { method: "DELETE" })
  }

  // ── Canvas Elements ────────────────────────────────────────────────────────

  async createElement(planeId: string, element: CanvasElement): Promise<CanvasElement> {
    const created = await this.fetch<any>(`/planes/${planeId}/elements`, {
      method: "POST",
      body: JSON.stringify(canvasElementToApiCreate(element)),
    })
    // Return original element with server-assigned ID
    return { ...element, id: created.id }
  }

  async updateElement(planeId: string, element: CanvasElement): Promise<CanvasElement> {
    await this.fetch(`/planes/${planeId}/elements/${element.id}`, {
      method: "PUT",
      body: JSON.stringify(canvasElementToApiCreate(element)),
    })
    return element
  }

  async deleteElement(planeId: string, elementId: string): Promise<void> {
    await this.fetch(`/planes/${planeId}/elements/${elementId}`, { method: "DELETE" })
  }
}
```

### Task 3.2: Update AppContext to Use HttpBackend

**File**: `frontend/src/store/AppContext.tsx`

Find the initialization section and update:

```typescript
// Near the top, add import
import { HttpBackend } from "./HttpBackend"

// In AppProvider component, replace backend initialization:
export function AppProvider({
  children,
  backend: providedBackend,
}: {
  children: ReactNode
  backend?: BackendAdapter
}) {
  // Use HttpBackend by default, fall back to InMemory if no token
  const getToken = useCallback(() => localStorage.getItem("access_token"), [])
  
  const defaultBackend = useMemo(() => {
    const token = getToken()
    if (token) {
      return new HttpBackend(getToken)
    }
    return new InMemoryBackend()
  }, [getToken])
  
  const backend = providedBackend ?? defaultBackend
  
  // ... rest of the component
}
```

### Task 3.3: Add Loading Screen

**File**: `frontend/src/components/LoadingScreen.tsx`

```typescript
export function LoadingScreen({ message = "Loading your data..." }: { message?: string }) {
  return (
    <div className="flex h-screen w-screen items-center justify-center bg-background">
      <div className="flex flex-col items-center gap-4">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
        <p className="text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  )
}
```

### Task 3.4: Update App Entry to Show Loading

**File**: Update where AppProvider is used (likely `main.tsx` or route component)

```typescript
import { LoadingScreen } from "./components/LoadingScreen"

// In the route/page component that uses AppProvider:
function GuiPage() {
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  
  // Show loading screen while data loads
  if (isLoading) {
    return <LoadingScreen />
  }
  
  if (error) {
    return <div className="p-4 text-red-500">Failed to load: {error}</div>
  }
  
  return (
    <AppProvider onLoadComplete={() => setIsLoading(false)} onLoadError={setError}>
      {/* GUI content */}
    </AppProvider>
  )
}
```

---

## Phase 4: Database Migration

### Task 4.1: Verify Models Are Up-to-Date

Run to check current migration state:

```bash
cd backend
alembic current
alembic history
```

### Task 4.2: Create Migration If Needed

If models have changed since last migration:

```bash
cd backend
alembic revision --autogenerate -m "complete_domain_models"
alembic upgrade head
```

### Task 4.3: Optional - Drop UserState Table

If you want to remove the JSONB blob storage:

```bash
cd backend
alembic revision -m "drop_userstate"
```

Edit the generated file:

```python
def upgrade():
    op.drop_table('userstate')

def downgrade():
    # Recreate if needed
    pass
```

---

## Phase 5: Testing

### Task 5.1: Test Backend Routes

```bash
# Start backend
cd backend
uvicorn app.main:app --reload

# Test endpoints with curl (replace TOKEN with actual JWT)
TOKEN="your_jwt_token"

# Test materials
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/v1/materials/

# Test planes
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/v1/planes/

# Test bulk load
curl -H "Authorization: Bearer $TOKEN" http://localhost:8000/api/v1/state/bulk
```

### Task 5.2: Test Frontend Integration

1. Start both servers
2. Login to the app
3. Open browser DevTools Network tab
4. Verify `/api/v1/state/bulk` is called on login
5. Create a material, verify POST to `/api/v1/materials/`
6. Refresh page, verify data persists

### Task 5.3: Manual Testing Checklist

- [ ] Login shows loading screen, then GUI
- [ ] Materials CRUD works (create, edit, delete)
- [ ] Solutions CRUD works
- [ ] Experiments CRUD works
- [ ] Results CRUD works  
- [ ] Planes CRUD works
- [ ] Canvas elements work (add text, collection, line)
- [ ] Data persists after page refresh
- [ ] Logout clears session

---

## Implementation Sequence (Copy-Paste Ready)

Execute these tasks in order:

### Backend Tasks

1. **Create `backend/app/api/routes/materials.py`** - Copy code from Task 1.1
2. **Create `backend/app/api/routes/planes.py`** - Copy code from Task 1.2
3. **Update `backend/app/api/main.py`** - Add router imports (Task 1.3)
4. **Update `backend/app/api/routes/state.py`** - Add bulk endpoint (Task 1.4)
5. **Update `backend/app/models.py`** - Add BulkStateResponse model
6. **Run `alembic upgrade head`** - Apply any pending migrations

### Frontend Tasks

7. **Create `frontend/src/store/apiTypes.ts`** - Copy code from Task 2.1
8. **Create `frontend/src/store/HttpBackend.ts`** - Copy code from Task 3.1
9. **Update `frontend/src/store/AppContext.tsx`** - Integrate HttpBackend (Task 3.2)
10. **Create `frontend/src/components/LoadingScreen.tsx`** - Copy code from Task 3.3
11. **Update app entry point** - Add loading state (Task 3.4)

### Verification

12. Run backend tests
13. Run frontend manually
14. Complete testing checklist

---

## Notes for Future Buffering Implementation

This simplified structure is designed to evolve into the full buffered system:

1. **API routes are complete** - Same endpoints will be used with query filters
2. **Type converters exist** - Will be reused by TanStack Query hooks
3. **HttpBackend pattern** - Can be wrapped by buffered hooks
4. **Bulk load endpoint** - Will become plane-scoped load

To add buffering later:
- Add `?plane_id=` filter to entity endpoints
- Create TanStack Query hooks that wrap HttpBackend methods
- Add visibility tracking to AppContext
- Replace direct HttpBackend calls with query hooks

The database schema and API structure remain unchanged.
