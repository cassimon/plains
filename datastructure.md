# Plains Data Infrastructure Plan

> **Status**: Draft Plan  
> **Created**: 2026-04-09  
> **Scope**: Database schema, API routes, and frontend caching architecture

---

## Table of Contents

1. [Overview](#overview)
2. [Design Decisions](#design-decisions)
3. [Database Schema](#database-schema)
4. [API Endpoints](#api-endpoints)
5. [Frontend Caching Strategy](#frontend-caching-strategy)
6. [Implementation Phases](#implementation-phases)
7. [Migration Notes](#migration-notes)

---

## Overview

This document outlines a scalable data infrastructure for Plains that replaces the current bulk JSONB state storage (`UserState`) with properly normalized tables and a lazy-loading frontend architecture.

### Goals

- **Normalized storage**: Each entity type has its own table with proper relationships
- **Lazy loading**: Only fetch data when visibility is requested
- **Scalable**: Support large datasets without loading everything upfront
- **Maintainable**: Clear separation between visual layout (Canvas) and domain data

### Core Entities

| Entity | Description | Ownership |
|--------|-------------|-----------|
| **Plane** | Top-level organizational container | Per user |
| **PlaneCanvas** | Visual layout for a Plane (1-to-1) | Follows Plane |
| **Material** | Raw materials with properties | Per user, multi-plane |
| **Solution** | Composed of Materials/Solutions | Per user, multi-plane |
| **Experiment** | Contains layers referencing Materials/Solutions | Per user, multi-plane |
| **ExperimentResults** | Measurement data for an Experiment | 1-to-1 with Experiment |
| **Analysis** | Computed/derived data from Results | Belongs to Experiment |

---

## Design Decisions

### 1. Naming Convention
- **Code**: Use `Plane` / `plane` in all backend and frontend code
- **UI**: Display as "Plain" only in user-facing labels and text

### 2. Plane-Entity Relationships
Materials, Solutions, and Experiments can belong to **multiple Planes** via a join table (`plane_member`). This allows:
- Sharing entities across organizational contexts
- Flexible workspace organization
- No data duplication

### 3. Canvas Architecture
Each Plane has exactly **one Canvas** (1-to-1 relationship):
- `PlaneCanvas` holds display configuration
- `CanvasDecoration` holds visual elements (text, lines, shapes)
- `CanvasEntityPosition` tracks where entities appear on the canvas

### 4. Results and Analysis
- **Results**: Strict 1-to-1 with Experiment (an experiment produces one set of results)
- **Analysis**: Computed data derived from Results + Material properties
  - Stores computed values, notes, and methodology
  - References the source Experiment and optionally specific Materials

### 5. Fresh Start
- Drop existing `UserState` table
- No data migration from JSONB blob
- Clean implementation of normalized schema

---

## Database Schema

### Entity Relationship Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              USER (owner)                                    │
└─────────────────────────────────────────────────────────────────────────────┘
        │
        │ owns
        ▼
┌───────────────────┐       1:1        ┌────────────────────┐
│      Plane        │◄────────────────►│    PlaneCanvas     │
│  - id             │                  │  - id              │
│  - name           │                  │  - plane_id (FK)   │
│  - owner_id (FK)  │                  │  - zoom_level      │
│  - created_at     │                  │  - pan_x, pan_y    │
└───────────────────┘                  │  - owner_id (FK)   │
        │                              └────────────────────┘
        │                                       │
        │ 1:N                                   │ 1:N
        ▼                                       ▼
┌───────────────────┐                  ┌────────────────────┐
│   PlaneMember     │                  │  CanvasDecoration  │
│  - id             │                  │  - id              │
│  - plane_id (FK)  │                  │  - canvas_id (FK)  │
│  - entity_type    │                  │  - element_type    │
│  - entity_id      │                  │  - x, y, w, h      │
│  - position_x     │                  │  - content, color  │
│  - position_y     │                  └────────────────────┘
│  - color          │
└───────────────────┘
        │
        │ references (entity_type + entity_id)
        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              DOMAIN ENTITIES                                 │
├───────────────────┬───────────────────┬─────────────────────────────────────┤
│    Material       │    Solution       │         Experiment                  │
│  - id             │  - id             │  - id                               │
│  - name           │  - name           │  - name                             │
│  - cas_number     │  - notes          │  - description                      │
│  - molecular_wt   │  - owner_id       │  - device_type, active_area         │
│  - density        │  - created_at     │  - owner_id, created_at             │
│  - supplier       │                   │                                     │
│  - notes          │       │           │          │                          │
│  - owner_id       │       │ 1:N       │          │ 1:N                      │
│  - created_at     │       ▼           │          ▼                          │
└───────────────────┤ SolutionComponent │    ExperimentLayer                  │
                    │  - material_id    │    Substrate                        │
                    │  - solution_id    │                                     │
                    │  - amount, unit   │          │                          │
                    └───────────────────┘          │ 1:1                      │
                                                   ▼                          │
                                          ┌───────────────────┐               │
                                          │ ExperimentResults │               │
                                          │  - id             │               │
                                          │  - experiment_id  │               │
                                          │  - notes          │               │
                                          │  - owner_id       │               │
                                          └───────────────────┘               │
                                                   │                          │
                                                   │ 1:N                      │
                                                   ▼                          │
                                          ┌───────────────────┐               │
                                          │     Analysis      │               │
                                          │  - id             │               │
                                          │  - results_id     │               │
                                          │  - name           │               │
                                          │  - methodology    │               │
                                          │  - computed_data  │               │
                                          │  - material_id?   │               │
                                          │  - notes          │               │
                                          │  - owner_id       │               │
                                          └───────────────────┘               │
```

### SQLAlchemy Models

#### Plane & Canvas Models

```python
# backend/app/models.py

class Plane(SQLModel, table=True):
    """Top-level organizational container."""
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    name: str = Field(max_length=255)
    owner_id: uuid.UUID = Field(foreign_key="user.id", nullable=False, ondelete="CASCADE")
    created_at: datetime = Field(default_factory=datetime.utcnow)
    
    # Relationships
    owner: "User" = Relationship(back_populates="planes")
    canvas: Optional["PlaneCanvas"] = Relationship(
        back_populates="plane", 
        sa_relationship_kwargs={"uselist": False, "cascade": "all, delete-orphan"}
    )
    members: list["PlaneMember"] = Relationship(
        back_populates="plane",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )


class PlaneCanvas(SQLModel, table=True):
    """Visual layout configuration for a Plane (1-to-1)."""
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    plane_id: uuid.UUID = Field(
        foreign_key="plane.id", 
        nullable=False, 
        ondelete="CASCADE",
        unique=True  # Enforces 1-to-1
    )
    owner_id: uuid.UUID = Field(foreign_key="user.id", nullable=False, ondelete="CASCADE")
    
    # Canvas viewport state
    zoom_level: float = Field(default=1.0)
    pan_x: float = Field(default=0.0)
    pan_y: float = Field(default=0.0)
    
    # Relationships
    plane: "Plane" = Relationship(back_populates="canvas")
    decorations: list["CanvasDecoration"] = Relationship(
        back_populates="canvas",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )


class CanvasDecoration(SQLModel, table=True):
    """Visual elements on a canvas (text, lines, shapes)."""
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    canvas_id: uuid.UUID = Field(foreign_key="planecanvas.id", nullable=False, ondelete="CASCADE")
    
    element_type: str = Field(max_length=50)  # 'text', 'plaintext', 'line', 'shape'
    x: float = Field(default=0.0)
    y: float = Field(default=0.0)
    width: float = Field(default=100.0)
    height: float = Field(default=50.0)
    content: Optional[str] = Field(default=None, max_length=10000)
    color: Optional[str] = Field(default=None, max_length=50)
    
    # Relationships
    canvas: "PlaneCanvas" = Relationship(back_populates="decorations")


class EntityType(str, Enum):
    """Types of entities that can be members of a Plane."""
    MATERIAL = "material"
    SOLUTION = "solution"
    EXPERIMENT = "experiment"


class PlaneMember(SQLModel, table=True):
    """Join table: links entities to planes with canvas position."""
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    plane_id: uuid.UUID = Field(foreign_key="plane.id", nullable=False, ondelete="CASCADE")
    
    # Polymorphic reference to entity
    entity_type: EntityType
    entity_id: uuid.UUID  # References material.id, solution.id, or experiment.id
    
    # Canvas position for this entity in this plane
    position_x: float = Field(default=0.0)
    position_y: float = Field(default=0.0)
    width: float = Field(default=200.0)
    height: float = Field(default=150.0)
    color: Optional[str] = Field(default=None, max_length=50)
    
    # Relationships
    plane: "Plane" = Relationship(back_populates="members")
    
    class Config:
        # Composite unique constraint: entity can only appear once per plane
        table_args = (
            UniqueConstraint("plane_id", "entity_type", "entity_id"),
        )
```

#### Analysis Model (New)

```python
class Analysis(SQLModel, table=True):
    """Computed/derived data from experiment results."""
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    results_id: uuid.UUID = Field(
        foreign_key="experimentresults.id", 
        nullable=False, 
        ondelete="CASCADE"
    )
    owner_id: uuid.UUID = Field(foreign_key="user.id", nullable=False, ondelete="CASCADE")
    
    name: str = Field(max_length=255)
    methodology: Optional[str] = Field(default=None, max_length=500)
    notes: Optional[str] = Field(default=None)
    
    # Optional reference to material used in analysis
    material_id: Optional[uuid.UUID] = Field(
        foreign_key="material.id", 
        nullable=True, 
        ondelete="SET NULL"
    )
    
    # Computed data stored as JSONB
    computed_data: Optional[dict] = Field(default=None, sa_column=Column(JSONB))
    
    created_at: datetime = Field(default_factory=datetime.utcnow)
    updated_at: datetime = Field(default_factory=datetime.utcnow)
    
    # Relationships
    results: "ExperimentResults" = Relationship(back_populates="analyses")
    material: Optional["Material"] = Relationship()
```

#### Updated Domain Models

```python
# Add to ExperimentResults
class ExperimentResults(SQLModel, table=True):
    # ... existing fields ...
    
    # Add relationship to Analysis
    analyses: list["Analysis"] = Relationship(
        back_populates="results",
        sa_relationship_kwargs={"cascade": "all, delete-orphan"}
    )
```

---

## API Endpoints

### Endpoint Structure

All endpoints follow RESTful conventions with consistent patterns:

```
GET    /api/v1/{resource}/              # List (paginated, filtered)
GET    /api/v1/{resource}/{id}          # Get single
POST   /api/v1/{resource}/              # Create
PUT    /api/v1/{resource}/{id}          # Update
DELETE /api/v1/{resource}/{id}          # Delete
```

### Planes & Canvas

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/planes/` | List user's planes (lightweight: id, name, created_at) |
| GET | `/api/v1/planes/{id}` | Get plane with canvas and member summaries |
| POST | `/api/v1/planes/` | Create plane (auto-creates canvas) |
| PUT | `/api/v1/planes/{id}` | Update plane name |
| DELETE | `/api/v1/planes/{id}` | Delete plane (cascades to canvas, members) |
| GET | `/api/v1/planes/{id}/canvas` | Get full canvas with decorations |
| PUT | `/api/v1/planes/{id}/canvas` | Update canvas (viewport, decorations) |

### Plane Membership

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/planes/{id}/members` | List members with positions |
| POST | `/api/v1/planes/{id}/members` | Add entity to plane |
| PUT | `/api/v1/planes/{id}/members/{member_id}` | Update position/color |
| DELETE | `/api/v1/planes/{id}/members/{member_id}` | Remove from plane |

### Domain Entities

| Resource | Endpoints | Notes |
|----------|-----------|-------|
| Materials | CRUD at `/api/v1/materials/` | Filter: `?plane_id=` |
| Solutions | CRUD at `/api/v1/solutions/` | Filter: `?plane_id=` |
| Experiments | CRUD at `/api/v1/experiments/` | Filter: `?plane_id=` |
| Results | CRUD at `/api/v1/results/` | Filter: `?experiment_id=` |
| Analysis | CRUD at `/api/v1/analysis/` | Filter: `?results_id=`, `?experiment_id=` |

### Query Parameters

All list endpoints support:
- `skip` (int, default=0): Pagination offset
- `limit` (int, default=100): Page size
- `plane_id` (uuid, optional): Filter by plane membership
- `include_counts` (bool, default=false): Include total count

### Response Schemas

#### Lightweight Plane List (for initial load)

```typescript
interface PlaneListItem {
  id: string;
  name: string;
  created_at: string;
  member_count: number;  // Quick summary
}
```

#### Full Plane Response (when selected)

```typescript
interface PlaneDetail {
  id: string;
  name: string;
  created_at: string;
  canvas: {
    id: string;
    zoom_level: number;
    pan_x: number;
    pan_y: number;
    decorations: CanvasDecoration[];
  };
  members: PlaneMemberSummary[];  // Lightweight: id, type, name, position
}
```

---

## Frontend Caching Strategy

### Overview: BufferedComponents Pattern

The key insight is that we **maintain AppContext's interface** but change its internal implementation to use **lazy-loaded, visibility-gated data**.

```
┌─────────────────────────────────────────────────────────────────────┐
│                          AppContext                                  │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    BufferedComponents                        │   │
│  │                                                              │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐    │   │
│  │  │Materials │  │Solutions │  │Experiments│  │ Results  │    │   │
│  │  │ Buffer   │  │ Buffer   │  │  Buffer   │  │  Buffer  │    │   │
│  │  │          │  │          │  │           │  │          │    │   │
│  │  │ visible: │  │ visible: │  │ visible:  │  │ visible: │    │   │
│  │  │ [ids]    │  │ [ids]    │  │ [ids]     │  │ [ids]    │    │   │
│  │  │          │  │          │  │           │  │          │    │   │
│  │  │ loaded:  │  │ loaded:  │  │ loaded:   │  │ loaded:  │    │   │
│  │  │ Map<id,T>│  │ Map<id,T>│  │ Map<id,T> │  │ Map<id,T>│    │   │
│  │  └──────────┘  └──────────┘  └──────────┘  └──────────┘    │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                      │
│  UI State: activePlaneId, activeEntityId, pendingActions           │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              │ delegates to
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│                      TanStack Query                                  │
│                                                                      │
│  Query Keys:                                                        │
│  - ['planes']                     → Plane list                      │
│  - ['planes', planeId]            → Plane detail + canvas           │
│  - ['planes', planeId, 'members'] → Member list                     │
│  - ['materials', { planeId }]     → Materials in plane              │
│  - ['materials', materialId]      → Single material                 │
│  - ['experiments', expId]         → Experiment detail               │
│  - ['experiments', expId, 'results'] → Results for experiment      │
│  - ['analysis', { resultsId }]    → Analysis for results           │
└─────────────────────────────────────────────────────────────────────┘
```

### BufferedComponent Interface

```typescript
// frontend/src/store/BufferedComponent.ts

interface BufferedComponent<T> {
  /**
   * Set of entity IDs that should be visible/loaded.
   * When an ID is added, the component triggers a fetch.
   */
  visibleIds: Set<string>;
  
  /**
   * Loaded entities, keyed by ID.
   * Only entities in visibleIds are guaranteed to be present.
   */
  loaded: Map<string, T>;
  
  /**
   * Loading state per entity (for showing spinners).
   */
  loading: Map<string, boolean>;
  
  /**
   * Errors per entity (for showing error states).
   */
  errors: Map<string, Error | null>;
}

interface BufferedComponentActions<T> {
  /**
   * Mark an entity as visible, triggering load if not cached.
   */
  setVisible(id: string): void;
  
  /**
   * Mark an entity as hidden (allows cache eviction).
   */
  setHidden(id: string): void;
  
  /**
   * Bulk visibility update (e.g., when switching planes).
   */
  setVisibleIds(ids: string[]): void;
  
  /**
   * Get entity if loaded, or undefined.
   */
  get(id: string): T | undefined;
  
  /**
   * Get all currently loaded entities.
   */
  getLoaded(): T[];
  
  /**
   * Optimistic update (for mutations).
   */
  optimisticUpdate(id: string, entity: T): void;
  
  /**
   * Invalidate and refetch.
   */
  invalidate(id: string): void;
}
```

### Implementation: useBufferedMaterials Hook

```typescript
// frontend/src/hooks/useBufferedMaterials.ts

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo } from 'react';

interface UseBufferedMaterialsOptions {
  planeId?: string;  // Filter by plane
}

export function useBufferedMaterials(options: UseBufferedMaterialsOptions = {}) {
  const queryClient = useQueryClient();
  const { planeId } = options;
  
  // Query key includes plane filter for cache segmentation
  const queryKey = planeId 
    ? ['materials', { planeId }] 
    : ['materials'];
  
  // Fetch materials list (lightweight: id, name, cas_number)
  const listQuery = useQuery({
    queryKey,
    queryFn: () => api.getMaterials({ planeId }),
    staleTime: 5 * 60 * 1000,  // 5 minutes
  });
  
  // Fetch single material detail on demand
  const getMaterialDetail = useCallback(async (id: string) => {
    return queryClient.fetchQuery({
      queryKey: ['materials', id],
      queryFn: () => api.getMaterial(id),
      staleTime: 5 * 60 * 1000,
    });
  }, [queryClient]);
  
  // Mutations with automatic cache invalidation
  const createMutation = useMutation({
    mutationFn: api.createMaterial,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['materials'] });
    },
  });
  
  const updateMutation = useMutation({
    mutationFn: ({ id, data }) => api.updateMaterial(id, data),
    onSuccess: (_, { id }) => {
      queryClient.invalidateQueries({ queryKey: ['materials', id] });
      queryClient.invalidateQueries({ queryKey: ['materials'] });
    },
  });
  
  const deleteMutation = useMutation({
    mutationFn: api.deleteMaterial,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['materials'] });
    },
  });
  
  return {
    materials: listQuery.data ?? [],
    isLoading: listQuery.isLoading,
    error: listQuery.error,
    
    getMaterialDetail,
    createMaterial: createMutation.mutate,
    updateMaterial: updateMutation.mutate,
    deleteMaterial: deleteMutation.mutate,
  };
}
```

### AppContext Integration

```typescript
// frontend/src/store/AppContext.tsx (modified)

interface AppContextState {
  // UI State (kept in context)
  activePlaneId: string | null;
  activeEntityId: string | null;
  activeEntityType: EntityType | null;
  pendingCollectionLink: PendingLink | null;
  
  // Visibility tracking (controls what gets loaded)
  visibleMaterialIds: Set<string>;
  visibleSolutionIds: Set<string>;
  visibleExperimentIds: Set<string>;
  visibleResultIds: Set<string>;
}

// AppContext now delegates data access to hooks
function AppContextProvider({ children }: { children: React.ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState);
  
  // TanStack Query hooks
  const planes = usePlanes();
  const materials = useBufferedMaterials({ 
    planeId: state.activePlaneId ?? undefined 
  });
  const solutions = useBufferedSolutions({ 
    planeId: state.activePlaneId ?? undefined 
  });
  const experiments = useBufferedExperiments({ 
    planeId: state.activePlaneId ?? undefined 
  });
  
  // When activePlaneId changes, update visible sets
  useEffect(() => {
    if (state.activePlaneId) {
      // Fetch plane members and update visibility
      planes.getPlaneDetail(state.activePlaneId).then(plane => {
        dispatch({ 
          type: 'SET_VISIBLE_ENTITIES', 
          payload: extractEntityIds(plane.members) 
        });
      });
    }
  }, [state.activePlaneId]);
  
  // Repository interface (maintains existing API)
  const repository = useMemo(() => ({
    // Planes
    get planes() { return planes.planes; },
    addPlane: planes.createPlane,
    updatePlane: planes.updatePlane,
    deletePlane: planes.deletePlane,
    
    // Materials
    get materials() { return materials.materials; },
    addMaterial: materials.createMaterial,
    updateMaterial: materials.updateMaterial,
    deleteMaterial: materials.deleteMaterial,
    
    // ... similar for solutions, experiments, results
    
    // Selection
    setActivePlaneId: (id: string | null) => 
      dispatch({ type: 'SET_ACTIVE_PLANE', payload: id }),
    setActiveEntity: (type: EntityType, id: string | null) =>
      dispatch({ type: 'SET_ACTIVE_ENTITY', payload: { type, id } }),
      
  }), [planes, materials, solutions, experiments, state]);
  
  return (
    <AppContext.Provider value={repository}>
      {children}
    </AppContext.Provider>
  );
}
```

### Loading Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│  1. App Startup                                                      │
│     └── GET /api/v1/planes/ → Lightweight plane list                │
│         Response: [{ id, name, member_count }, ...]                 │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  2. User Selects Plane                                               │
│     └── GET /api/v1/planes/{id} → Plane detail + canvas             │
│         Response: { id, name, canvas: {...}, members: [...] }       │
│                                                                      │
│     └── setVisibleIds() for members in this plane                   │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  3. BufferedComponents Load Visible Entities                         │
│     └── GET /api/v1/materials/?plane_id={id}                        │
│     └── GET /api/v1/solutions/?plane_id={id}                        │
│     └── GET /api/v1/experiments/?plane_id={id}                      │
│         (Parallel fetches)                                           │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  4. User Clicks Entity (e.g., Experiment)                            │
│     └── GET /api/v1/experiments/{id} → Full experiment detail       │
│     └── GET /api/v1/results/?experiment_id={id} → Results           │
│         (On-demand, not preloaded)                                   │
└─────────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────────┐
│  5. User Opens Analysis Tab                                          │
│     └── GET /api/v1/analysis/?results_id={id} → Analysis list       │
│         (Lazy loaded when tab becomes visible)                       │
└─────────────────────────────────────────────────────────────────────┘
```

### Cache Invalidation Strategy

| Action | Invalidates |
|--------|-------------|
| Create Material | `['materials']`, `['materials', { planeId }]` |
| Update Material | `['materials', id]`, `['materials']` |
| Delete Material | `['materials']`, affected plane members |
| Add to Plane | `['planes', planeId, 'members']` |
| Update Canvas | `['planes', planeId]` |
| Create Analysis | `['analysis', { resultsId }]` |

### Optimistic Updates

For immediate UI feedback, use optimistic updates:

```typescript
const updateMutation = useMutation({
  mutationFn: ({ id, data }) => api.updateMaterial(id, data),
  onMutate: async ({ id, data }) => {
    // Cancel outgoing refetches
    await queryClient.cancelQueries({ queryKey: ['materials', id] });
    
    // Snapshot previous value
    const previous = queryClient.getQueryData(['materials', id]);
    
    // Optimistically update
    queryClient.setQueryData(['materials', id], (old) => ({
      ...old,
      ...data,
    }));
    
    return { previous };
  },
  onError: (err, variables, context) => {
    // Rollback on error
    queryClient.setQueryData(
      ['materials', variables.id], 
      context?.previous
    );
  },
  onSettled: (_, __, { id }) => {
    // Always refetch to ensure consistency
    queryClient.invalidateQueries({ queryKey: ['materials', id] });
  },
});
```

---

## Implementation Phases

### Phase 1: Database Schema Update

**Goal**: Add new tables, update existing models, create migration.

#### Tasks

1. **Update models.py**
   - [ ] Add `PlaneCanvas` model (1-to-1 with Plane)
   - [ ] Add `CanvasDecoration` model
   - [ ] Add `PlaneMember` model with `EntityType` enum
   - [ ] Add `Analysis` model
   - [ ] Update `Plane` to remove embedded `CanvasElement`
   - [ ] Update `ExperimentResults` to add `analyses` relationship

2. **Create Alembic migration**
   - [ ] Drop `UserState` table
   - [ ] Drop embedded `CanvasElement` from Plane
   - [ ] Create `planecanvas` table
   - [ ] Create `canvasdecoration` table
   - [ ] Create `planemember` table
   - [ ] Create `analysis` table
   - [ ] Add indices for foreign keys

3. **Update CRUD functions**
   - [ ] Add `create_plane_canvas`, `update_plane_canvas`
   - [ ] Add `create_plane_member`, `delete_plane_member`
   - [ ] Add `create_analysis`, `update_analysis`, `delete_analysis`
   - [ ] Update `create_plane` to auto-create canvas

**Estimated effort**: 4-6 hours

### Phase 2: Backend API Routes

**Goal**: Implement all endpoints with filtering and pagination.

#### Tasks

1. **Planes routes** (`backend/app/api/routes/planes.py`)
   - [ ] GET `/planes/` - List planes
   - [ ] GET `/planes/{id}` - Get plane with canvas
   - [ ] POST `/planes/` - Create plane (auto-creates canvas)
   - [ ] PUT `/planes/{id}` - Update plane
   - [ ] DELETE `/planes/{id}` - Delete plane

2. **Canvas routes** (nested under planes)
   - [ ] GET `/planes/{id}/canvas` - Get canvas with decorations
   - [ ] PUT `/planes/{id}/canvas` - Update canvas
   - [ ] POST `/planes/{id}/canvas/decorations` - Add decoration
   - [ ] DELETE `/planes/{id}/canvas/decorations/{dec_id}` - Remove decoration

3. **Membership routes**
   - [ ] GET `/planes/{id}/members` - List members
   - [ ] POST `/planes/{id}/members` - Add entity to plane
   - [ ] PUT `/planes/{id}/members/{member_id}` - Update position
   - [ ] DELETE `/planes/{id}/members/{member_id}` - Remove from plane

4. **Materials routes** (`backend/app/api/routes/materials.py`)
   - [ ] Implement missing router file
   - [ ] Add `?plane_id=` filter support

5. **Analysis routes** (`backend/app/api/routes/analysis.py`)
   - [ ] CRUD operations
   - [ ] Filter by `?results_id=` and `?experiment_id=`

6. **Update existing routes**
   - [ ] Add `?plane_id=` filter to solutions, experiments

**Estimated effort**: 6-8 hours

### Phase 3: Frontend Caching Infrastructure

**Goal**: Implement BufferedComponents pattern and TanStack Query integration.

#### Tasks

1. **Setup TanStack Query**
   - [ ] Install `@tanstack/react-query`
   - [ ] Create `QueryClientProvider` wrapper
   - [ ] Configure default options (staleTime, cacheTime)

2. **Create buffered hooks**
   - [ ] `useBufferedPlanes` - Plane list and detail
   - [ ] `useBufferedMaterials` - With plane filtering
   - [ ] `useBufferedSolutions` - With plane filtering
   - [ ] `useBufferedExperiments` - With plane filtering
   - [ ] `useBufferedResults` - With experiment filtering
   - [ ] `useBufferedAnalysis` - With results filtering

3. **Update AppContext**
   - [ ] Add visibility state tracking
   - [ ] Integrate TanStack Query hooks
   - [ ] Maintain repository interface compatibility
   - [ ] Update `useApp()` consumers (if interface changes)

4. **Update API client**
   - [ ] Add filter parameters to existing methods
   - [ ] Add new endpoints (planes, canvas, analysis)
   - [ ] Update TypeScript types

**Estimated effort**: 8-10 hours

### Phase 4: UI Integration

**Goal**: Connect components to new data infrastructure.

#### Tasks

1. **Plane selection UI**
   - [ ] Plane list in sidebar
   - [ ] Active plane indicator
   - [ ] Create/rename/delete plane actions

2. **Canvas components**
   - [ ] Update to use PlaneCanvas data
   - [ ] Decoration CRUD
   - [ ] Entity positioning on canvas

3. **Entity lists**
   - [ ] Update to use buffered hooks
   - [ ] Loading states per entity
   - [ ] Optimistic updates

4. **Analysis UI**
   - [ ] Analysis list per experiment
   - [ ] Create/edit analysis form
   - [ ] Computed data display

**Estimated effort**: 6-8 hours

---

## Migration Notes

### Dropping UserState

Since we're starting fresh:

```sql
-- Migration: drop_user_state.sql
DROP TABLE IF EXISTS userstate CASCADE;
```

### Canvas Data Migration (Optional)

If you later decide to migrate existing canvas data:

```python
# scripts/migrate_canvas_data.py

def migrate_planes():
    """Move embedded CanvasElement to separate tables."""
    for plane in session.query(OldPlane).all():
        # Create PlaneCanvas
        canvas = PlaneCanvas(
            plane_id=plane.id,
            owner_id=plane.owner_id,
            zoom_level=1.0,
            pan_x=0.0,
            pan_y=0.0,
        )
        session.add(canvas)
        session.flush()
        
        # Migrate elements to decorations or members
        for elem in plane.elements:
            if elem.element_type == 'collection':
                # Create PlaneMember for each entity ref
                for ref in elem.content.get('refs', []):
                    member = PlaneMember(
                        plane_id=plane.id,
                        entity_type=ref['type'],
                        entity_id=ref['id'],
                        position_x=elem.x,
                        position_y=elem.y,
                        color=elem.color,
                    )
                    session.add(member)
            else:
                # Create CanvasDecoration
                decoration = CanvasDecoration(
                    canvas_id=canvas.id,
                    element_type=elem.element_type,
                    x=elem.x,
                    y=elem.y,
                    width=elem.width,
                    height=elem.height,
                    content=elem.content,
                    color=elem.color,
                )
                session.add(decoration)
    
    session.commit()
```

### Frontend Migration Path

1. Keep `InMemoryBackend` as fallback during transition
2. Implement `HttpBackendV2` using TanStack Query
3. Feature flag to switch between backends
4. Remove `InMemoryBackend` once `HttpBackendV2` is stable

---

## Appendix: Type Definitions

### Backend Pydantic Schemas

```python
# backend/app/schemas/plane.py

class PlaneBase(SQLModel):
    name: str = Field(max_length=255)

class PlaneCreate(PlaneBase):
    pass

class PlaneUpdate(SQLModel):
    name: Optional[str] = Field(default=None, max_length=255)

class PlaneListItem(PlaneBase):
    id: uuid.UUID
    created_at: datetime
    member_count: int

class CanvasDecorationSchema(SQLModel):
    id: uuid.UUID
    element_type: str
    x: float
    y: float
    width: float
    height: float
    content: Optional[str]
    color: Optional[str]

class PlaneCanvasSchema(SQLModel):
    id: uuid.UUID
    zoom_level: float
    pan_x: float
    pan_y: float
    decorations: list[CanvasDecorationSchema]

class PlaneMemberSchema(SQLModel):
    id: uuid.UUID
    entity_type: EntityType
    entity_id: uuid.UUID
    position_x: float
    position_y: float
    width: float
    height: float
    color: Optional[str]
    # Denormalized for convenience
    entity_name: str

class PlaneDetail(PlaneBase):
    id: uuid.UUID
    created_at: datetime
    canvas: PlaneCanvasSchema
    members: list[PlaneMemberSchema]
```

### Frontend TypeScript Types

```typescript
// frontend/src/types/plane.ts

export interface PlaneListItem {
  id: string;
  name: string;
  created_at: string;
  member_count: number;
}

export interface CanvasDecoration {
  id: string;
  element_type: 'text' | 'plaintext' | 'line' | 'shape';
  x: number;
  y: number;
  width: number;
  height: number;
  content?: string;
  color?: string;
}

export interface PlaneCanvas {
  id: string;
  zoom_level: number;
  pan_x: number;
  pan_y: number;
  decorations: CanvasDecoration[];
}

export type EntityType = 'material' | 'solution' | 'experiment';

export interface PlaneMember {
  id: string;
  entity_type: EntityType;
  entity_id: string;
  position_x: number;
  position_y: number;
  width: number;
  height: number;
  color?: string;
  entity_name: string;  // Denormalized
}

export interface PlaneDetail {
  id: string;
  name: string;
  created_at: string;
  canvas: PlaneCanvas;
  members: PlaneMember[];
}

// Analysis
export interface Analysis {
  id: string;
  results_id: string;
  name: string;
  methodology?: string;
  notes?: string;
  material_id?: string;
  computed_data?: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}
```

---

## Summary

This plan establishes a scalable data infrastructure for Plains with:

1. **Normalized schema**: Proper tables for Planes, Canvas, Members, and Analysis
2. **Many-to-many relationships**: Entities can belong to multiple Planes
3. **Lazy loading**: BufferedComponents pattern with visibility gating
4. **Cache efficiency**: TanStack Query with proper key structure
5. **Backward compatibility**: AppContext interface maintained

The implementation is divided into 4 phases totaling approximately 24-32 hours of development work.
