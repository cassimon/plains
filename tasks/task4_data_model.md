# Task 4 — Backend/Frontend Data Model Alignment

## Goal

Replace the current hybrid approach (normalised tables + large JSONB UserState blob) with
a fully normalised relational schema that mirrors the frontend type system exactly.
Every object the frontend stores in `AppContext` must have a corresponding table or
column in the database.  The `UserState.data` JSONB blob must be reduced to UI-only
ephemeral preferences (active panel, scroll position, etc.) and removed as the
authoritative store for domain objects.

The frontend `BackendAdapter` interface (`store/backend.ts`) must be updated to call
individual REST endpoints per entity rather than doing a bulk PUT/GET of the entire
state blob.

---

## Canonical Object Hierarchy

```
User
├── owns: Plane[]                         (plane.owner_id → user.id)
│   ├── has: PlaneShare[]                 (plane_share.plane_id → plane.id)
│   ├── has: CanvasTextElement[]          (canvas_element.plane_id WHERE type IN …)
│   ├── has: CanvasLineElement[]
│   └── has: DataCollection[]            (canvas_element.plane_id WHERE type='collection')
│       └── refs: CollectionRef[]        (collection_ref.collection_id)
│
├── owns: LabMaterial[]                  (lab_material.owner_id → user.id)
├── owns: LabSolution[]                  (lab_solution.owner_id → user.id)
│   └── has: SolutionComponent[]         (solution_component.solution_id)
│
├── owns: Process[]                      (process.owner_id → user.id)
│   ├── Step 1 – Chemistry
│   │   └── has: ProcessSolutionRecipe[] (process_solution_recipe.process_id)
│   │       ├── has: RecipeSolvent[]
│   │       ├── has: RecipeSolute[]
│   │       └── has: RecipeAddedSolution[]
│   ├── Step 2 – Deposition
│   │   └── has: ProcessStep[]           (process_step.process_id; stage_index + step_index)
│   └── Step 3 – Device Stack
│       └── has: GeneratedStack[]        (process_generated_stack.process_id)
│           └── has: GeneratedStackLayer[]
│
├── owns: Experiment[]                   (experiment.owner_id → user.id)
│   ├── FK → Process                     (experiment.process_id → process.id)
│   └── has: LabSubstrate[]              (lab_substrate.experiment_id → experiment.id)
│       └── has: SubstrateOutcome (cols) (outcome_status, stopped_at_step, discard_reason)
│
├── owns: ExperimentResults[]            (experiment_results.owner_id → user.id)
│   ├── FK → Experiment                  (experiment_results.experiment_id)
│   ├── has: MeasurementFile[]
│   ├── has: DeviceGroup[]
│   └── has: NomadUpload (cols)          (nomad_upload_id, nomad_status, nomad_entries)
│
└── owns: Analysis[]                     (analysis.owner_id → user.id)
    ├── refs: AnalysisRef[]              weak FKs to results / experiments / processes
    └── FK → ExperimentResults (nullable) (analysis.primary_result_id)
```

---

## Tables to Create / Modify

### 1. `user` (modify)
Current schema is complete for auth.  Add NOMAD profile fields if not present.

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| email | text unique | |
| full_name | text nullable | |
| is_active | bool | |
| is_superuser | bool | |
| hashed_password | text nullable | null for NOMAD-only users |
| nomad_sub | text unique nullable | Keycloak UUID |
| nomad_name | text nullable | display name from NOMAD token |
| nomad_email | text nullable | email from NOMAD token (may differ) |
| created_at | timestamptz | |

No migration required for existing columns; add nomad_name, nomad_email.

---

### 2. `plane` (no schema change, add missing fields)
Current schema is correct.  No new columns.

---

### 3. `plane_share` (no change)
Current schema is correct.

---

### 4. `canvas_element` (extend)
Current schema stores all element types in one flat row.  Add columns for the
fields that are type-specific but currently lost in `frontend_data`:

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| plane_id | uuid FK → plane.id CASCADE | |
| element_type | text | 'text' \| 'plaintext' \| 'line' \| 'collection' |
| x | float | top-left x (null for 'line') |
| y | float | top-left y (null for 'line') |
| width | float nullable | |
| height | float nullable | |
| content | text nullable | rich-text or plain-text content |
| color | text nullable | |
| fmt_bold | bool nullable | text/plaintext only |
| fmt_italic | bool nullable | |
| fmt_underline | bool nullable | |
| fmt_font_size | int nullable | |
| stroke_width | float nullable | line only |
| line_kind | text nullable | 'line' \| 'pen' \| 'rectangle' |
| points | jsonb nullable | [{x,y}, …] for line elements |
| frontend_data | jsonb nullable | remaining ephemeral UI state |

Migration: add new columns, backfill from existing `frontend_data`, keep
`frontend_data` as a catch-all for anything not yet normalised.

---

### 5. `data_collection` (NEW — replaces canvas_element WHERE type='collection')

Canvas collections need their own table so `CollectionRef` rows can have proper
foreign keys.

| column | type | notes |
|--------|------|-------|
| id | uuid PK | same id as the canvas_element row |
| plane_id | uuid FK → plane.id CASCADE | |
| x | float | |
| y | float | |
| width | float | |
| height | float | |
| name | text | |
| color | text nullable | |

### 5a. `collection_ref` (NEW)

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| collection_id | uuid FK → data_collection.id CASCADE | |
| kind | text | 'experiment' \| 'result' \| 'analysis' \| 'process' |
| entity_id | uuid | weak reference — no FK constraint (entity may be deleted) |

---

### 6. `lab_material` (rename/extend current `material`)

The current `material` table is a good base.  Extend with all frontend fields:

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| owner_id | uuid FK → user.id CASCADE | |
| name | text | |
| category | text | 'chemical_compound' \| 'substrate' \| 'consumable' |
| type | text nullable | 'n-type (ETL)', 'p-type (HTL)', 'solvent', etc. |
| cas_number | text nullable | |
| pubchem_cid | text nullable | |
| molecular_weight | float nullable | g/mol |
| density | float nullable | |
| density_unit | text default 'g/cm3' | |
| supplier | text nullable | |
| supplier_number | text nullable | catalogue number |
| inventory_label | text nullable | lab sticker / barcode |
| purity | text nullable | |
| state_at_rt | text nullable | 'solid' \| 'liquid' \| 'gas' |
| substrate_rigidity | text nullable | 'rigid' \| 'flexible' |
| height_mm | text nullable | substrate thickness |
| notes | text nullable | |
| created_at | timestamptz | |
| frontend_data | jsonb nullable | |

Migration: keep existing rows, backfill new columns from `frontend_data`.

---

### 7. `lab_solution` (rename/extend current `solution`)

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| owner_id | uuid FK → user.id CASCADE | |
| name | text | |
| type | text nullable | layer type hint |
| handling | text nullable | |
| storage | text nullable | NEW |
| creation_time | timestamptz nullable | |
| notes | text nullable | |
| created_at | timestamptz | |
| frontend_data | jsonb nullable | |

### 7a. `solution_component` (extend)

Add `solution_ref_id` for solutions-as-components (currently only supports material
references):

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| solution_id | uuid FK → lab_solution.id CASCADE | parent |
| material_id | uuid FK → lab_material.id nullable SET NULL | |
| solution_ref_id | uuid FK → lab_solution.id nullable SET NULL | NEW: solution-in-solution |
| amount | float | |
| unit | text | 'mg' \| 'ml' \| 'mol' |

Constraint: exactly one of `material_id` / `solution_ref_id` must be non-null.

---

### 8. `process` (NEW — currently stored only in UserState JSONB)

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| owner_id | uuid FK → user.id CASCADE | |
| name | text | |
| description | text nullable | |
| skip_chemistry | bool default false | |
| created_at | timestamptz | |
| frontend_data | jsonb nullable | |

### 8a. `process_inline_substrate` (NEW)

Substrates defined inline on the process (not referencing a LabMaterial):

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| process_id | uuid FK → process.id CASCADE | |
| name | text | |
| rigidity | text nullable | 'rigid' \| 'flexible' |
| length_cm | text nullable | |
| width_cm | text nullable | |
| height_mm | text nullable | |
| surface_roughness_rms_nm | text nullable | |

### 8b. `process_substrate_dimension` (NEW)

Dimensions for LabMaterial-referenced substrates:

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| process_id | uuid FK → process.id CASCADE | |
| material_id | uuid FK → lab_material.id CASCADE | |
| length_cm | text nullable | |
| width_cm | text nullable | |
| height_mm | text nullable | |
| surface_roughness_rms_nm | text nullable | |

Unique constraint on (process_id, material_id).

---

### 9. `process_solution_recipe` (NEW — Step 1: Chemistry)

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| process_id | uuid FK → process.id CASCADE | |
| name | text | |
| type | text nullable | layer type hint |
| is_commercial | bool default false | |
| commercial_name | text nullable | |
| supplier_number | text nullable | |
| handling_preparation | text nullable | |
| handling_before_use | text nullable | |
| total_solvent_volume_ml | text | |

### 9a. `recipe_solvent` (NEW)

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| recipe_id | uuid FK → process_solution_recipe.id CASCADE | |
| name | text | |
| pubchem_cid | text nullable | |
| molar_mass | float nullable | |
| density | float nullable | |
| volume_ratio | float | |
| color | text | |

### 9b. `recipe_solute` (NEW)

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| recipe_id | uuid FK → process_solution_recipe.id CASCADE | |
| name | text | |
| pubchem_cid | text nullable | |
| molar_mass | float nullable | |
| density | float nullable | |
| amount | text | |
| unit | text | 'mg' \| 'ml' \| 'mol' |
| color | text | |

### 9c. `recipe_added_solution` (NEW)

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| recipe_id | uuid FK → process_solution_recipe.id CASCADE | |
| referenced_recipe_id | uuid FK → process_solution_recipe.id SET NULL nullable | |
| volume_ml | text | |

---

### 10. `process_step` (NEW — Step 2: Deposition)

One row per alternative per stage.  `stage_index` + `step_index` give ordering.

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| process_id | uuid FK → process.id CASCADE | |
| stage_index | int | 0-based, 0 = bottom layer |
| step_index | int | 0 = primary; >0 = alternative |
| name | text | |
| step_category | text | 'wet_deposition' \| 'dry_deposition' \| 'surface_treatment' \| 'doping_aging' \| 'substrate_preparation' |
| color | text | |
| material_id | uuid FK → lab_material.id SET NULL nullable | |
| solution_id | uuid FK → lab_solution.id SET NULL nullable | |
| chem_recipe_id | uuid FK → process_solution_recipe.id SET NULL nullable | |
| inline_material | jsonb nullable | `ProcessStepInlineMaterial` for ad-hoc materials |
| — process parameters — | | |
| deposition_method_value | text nullable | |
| deposition_method_mode | text nullable | 'constant' \| 'variation' |
| deposition_start_time_value | text nullable | |
| deposition_start_time_mode | text nullable | |
| substrate_temp_value | text nullable | |
| substrate_temp_mode | text nullable | |
| deposition_atmosphere_value | text nullable | |
| deposition_atmosphere_mode | text nullable | |
| deposition_parameters_value | text nullable | |
| deposition_parameters_mode | text nullable | |
| solution_volume_value | text nullable | |
| solution_volume_mode | text nullable | |
| drying_method_value | text nullable | |
| drying_method_mode | text nullable | |
| annealing_start_time_value | text nullable | |
| annealing_start_time_mode | text nullable | |
| annealing_time_value | text nullable | |
| annealing_time_mode | text nullable | |
| annealing_temp_value | text nullable | |
| annealing_temp_mode | text nullable | |
| annealing_atmosphere_value | text nullable | |
| annealing_atmosphere_mode | text nullable | |
| notes | text nullable | |

Unique constraint on (process_id, stage_index, step_index).

---

### 11. `process_generated_stack` (NEW — Step 3: Device Stack)

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| process_id | uuid FK → process.id CASCADE | |
| combination | int | stack variation number |
| architecture | text nullable | |
| build_device | text nullable | 'Yes' \| 'No' |
| pixel_area_cm2 | text nullable | |
| number_of_pixels | text nullable | |
| is_deleted | bool default false | tracks `deletedStackCombinations` |

### 11a. `process_generated_stack_layer` (NEW)

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| stack_id | uuid FK → process_generated_stack.id CASCADE | |
| layer_index | int | ordering from bottom (0) |
| name | text | |
| color | text | |
| is_substrate | bool | |
| layer_type | text | |
| thickness_nm | text | |
| bandgap_ev | text | |
| perovskite_a | text | |
| perovskite_b | text | |
| perovskite_x | text | |

---

### 12. `experiment` (extend)

Current table has name, description, device_type, active_area_cm2, notes.
Add all frontend fields:

| column | type | notes |
|--------|------|-------|
| … existing … | | |
| process_id | uuid FK → process.id SET NULL nullable | NEW — link to Process |
| architecture | text nullable | 'n-i-p' \| 'p-i-n' \| etc. |
| substrate_material | text nullable | substrate description string |
| substrate_width | float nullable | cm |
| substrate_length | float nullable | cm |
| num_substrates | int nullable | |
| devices_per_substrate | int nullable | |
| device_area | float nullable | cm² (replaces active_area_cm2 eventually) |
| device_layout_image | text nullable | base64 jpg/png |
| date | date nullable | fabrication date |
| end_date | date nullable | |
| has_results | bool default false | denormalised for fast list rendering |
| has_completed_upload | bool default false | |
| chemicals_prep | jsonb nullable | ExperimentChemicalsPrep blob |
| processing_times | jsonb nullable | {stageId: isoString} map |

---

### 13. `lab_substrate` (extend current `substrate`)

Current table: name, thickness_nm, experiment_id.  Add full frontend fields:

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| experiment_id | uuid FK → experiment.id CASCADE | |
| name | text | |
| substrate_material_id | uuid FK → lab_material.id SET NULL nullable | NEW |
| notes | text nullable | NEW |
| outcome_status | text nullable | 'complete' \| 'incomplete' \| 'discarded' |
| outcome_stopped_at_step | text nullable | stage index as string |
| outcome_discard_reason | text nullable | |
| parameter_values | jsonb nullable | {paramKey: value} per-substrate variation |

---

### 14. `experiment_results` (extend)

Add NOMAD upload fields as proper columns instead of hiding them in `frontend_data`:

| column | type | notes |
|--------|------|-------|
| … existing … | | |
| grouping_strategy | text nullable | 'exact' \| 'search' \| 'fuzzy' |
| matching_strategy | text nullable | 'fuzzy' \| 'sequential' \| 'manual' |
| nomad_upload_id | text nullable | NOMAD upload UUID |
| nomad_upload_time | timestamptz nullable | |
| nomad_upload_status | text nullable | 'PENDING' \| 'SUCCESS' \| 'FAILURE' |
| nomad_entries | int nullable | number of NOMAD entries |

### 14a. `measurement_file` (extend)

Add all frontend fields currently lost in `frontend_data`:

| column | type | notes |
|--------|------|-------|
| … id, results_id, filename, file_type, file_path, notes … | | |
| device_name | text nullable | |
| cell | text nullable | |
| pixel | text nullable | |
| value | float nullable | e.g. PCE % |
| voc | float nullable | V |
| jsc | float nullable | mA/cm² |
| ff | float nullable | % |
| measurement_date | text nullable | |
| measurement_user | text nullable | |

### 14b. `device_group` (extend)

| column | type | notes |
|--------|------|-------|
| … id, results_id, name, substrate_name … | | |
| assigned_substrate_id | uuid nullable | weak ref to lab_substrate |
| suggested_substrate_id | uuid nullable | |
| match_score | float nullable | 0-1 |

---

### 15. `analysis` (NEW)

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| owner_id | uuid FK → user.id CASCADE | |
| name | text | |
| description | text nullable | |
| is_meta | bool default false | true = meta-analysis across multiple results |
| primary_result_id | uuid FK → experiment_results.id SET NULL nullable | |
| created_at | timestamptz | |
| frontend_data | jsonb nullable | charts, notes, layout |

### 15a. `analysis_ref` (NEW)

Weak multi-references so one Analysis can span Results, Experiments, Processes:

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| analysis_id | uuid FK → analysis.id CASCADE | |
| kind | text | 'result' \| 'experiment' \| 'process' |
| entity_id | uuid | no FK — weak reference |

---

## What Gets Removed / Deprecated

| Current | Action |
|---------|--------|
| `userstate` table `data` blob holding materials/solutions/experiments/processes/results/planes | Emptied after migration; keep table for true UI prefs only |
| `experiment_layer` table | **Delete** — layers are now `process_step` rows |
| `item` table | **Delete** — legacy scaffolding, no frontend usage |
| `frontend_data` JSONB columns | Keep as migration safety net; plan to drop in a later task after all clients migrated |

---

## API Changes

### New endpoints to add

```
# Process
POST   /api/v1/processes/
GET    /api/v1/processes/
GET    /api/v1/processes/{id}
PUT    /api/v1/processes/{id}
DELETE /api/v1/processes/{id}

# Process sub-resources (solution recipes, steps, stacks)
GET/PUT/DELETE /api/v1/processes/{id}/recipes/
GET/PUT/DELETE /api/v1/processes/{id}/steps/
GET/PUT/DELETE /api/v1/processes/{id}/stacks/

# Analysis
POST   /api/v1/analyses/
GET    /api/v1/analyses/
GET    /api/v1/analyses/{id}
PUT    /api/v1/analyses/{id}
DELETE /api/v1/analyses/{id}

# Collection (canvas element sub-type)
POST   /api/v1/planes/{id}/collections/
PUT    /api/v1/planes/{id}/collections/{cid}
DELETE /api/v1/planes/{id}/collections/{cid}
```

### Endpoints to modify

- `PUT /api/v1/state/` — no longer syncs processes, experiments, solutions, etc.; only accepts `{ ui_prefs: {...} }`.
- `GET /api/v1/state/bulk` — includes `processes`, `analyses`; returns proper normalised objects.
- `GET /api/v1/experiments/{id}` — returns substrates with outcome fields.
- `GET /api/v1/results/{id}` — returns nomad upload fields as top-level columns.

---

## Migration Strategy

This is a breaking schema change.  Execute in phases so the running app never loses data:

### Phase A — Add columns (non-breaking, all nullable)
Add all new columns with `ALTER TABLE … ADD COLUMN … DEFAULT NULL`.
No code changes required yet.  Existing JSONB `frontend_data` remains the truth.

Alembic revision: `"phase_a_add_columns"`

### Phase B — Add new tables (non-breaking)
Create `process`, `process_step`, `process_solution_recipe`, `recipe_*`,
`process_generated_stack`, `process_generated_stack_layer`,
`data_collection`, `collection_ref`, `analysis`, `analysis_ref`,
`process_inline_substrate`, `process_substrate_dimension`.

Alembic revision: `"phase_b_add_tables"`

### Phase C — Backfill (data migration script)
Write a one-shot Python script (`backend/scripts/migrate_state_to_tables.py`) that:
1. Reads every `UserState.data` blob.
2. Upserts materials, solutions, processes, experiments, results, planes into the
   new normalised columns / tables.
3. Marks each migrated row with a `migrated_at` timestamptz so it can be verified.

### Phase D — Flip the backend (breaking)
- Update `models.py` with the full new schema.
- Update `crud.py` with per-entity helpers.
- Update `api/routes/state.py` — `PUT /state/` only accepts `ui_prefs`.
- Add `api/routes/processes.py`, `api/routes/analyses.py`.
- Update `api/routes/experiments.py`, `results.py` to return new fields.
- Re-generate OpenAPI client: `bash ./scripts/generate-client.sh`.

Alembic revision: `"phase_d_activate_normalised_schema"`

### Phase E — Frontend adapter update
- Update `store/backend.ts` `HttpBackend` to call individual endpoints.
- Update `store/AppContext.tsx` to remove fields that are now backend-managed.
- Replace bulk state PUT/GET with per-entity mutations.
- Update `src/client/` (auto-generated, just regenerate).

### Phase F — Drop legacy columns / tables (cleanup)
Only after the frontend is confirmed to work without touching `frontend_data` or
`UserState.data`:
- Drop `experiment_layer`, `item` tables.
- Remove `UserState.data` domain-object keys (keep only `ui_prefs`).
- Optionally drop `frontend_data` columns from each table.

Alembic revision: `"phase_f_drop_legacy"`

---

## Acceptance Criteria

1. Every entity in the frontend `AppContext` type definitions maps 1-to-1 to a
   database table or column — no domain data lives exclusively in a JSONB blob.
2. All existing backend tests pass; coverage stays ≥ 80%.
3. New tests for `Process`, `Analysis`, `DataCollection`, `ProcessStep` CRUD reach ≥ 80%
   line coverage for those modules.
4. `PUT /api/v1/state/` no longer accepts `materials`, `solutions`, `experiments`,
   `results`, `planes`, or `processes` keys.
5. The NOMAD export (`services/nomad.py`) reads from the normalised tables, not
   from `frontend_data`.
6. The frontend loads correctly with the new adapter: materials, solutions,
   processes, experiments, results, planes all appear after login.
7. All 11 Playwright random-walk tests pass (no regressions).

---

## File Checklist

```
backend/
  app/
    models.py                    # Full schema rewrite
    crud.py                      # New helpers for process, analysis, collection
    api/routes/
      processes.py               # NEW
      analyses.py                # NEW
      state.py                   # Slim down PUT /state/
      experiments.py             # Add process_id, substrate outcomes
      results.py                 # Add NOMAD columns, file metadata
      planes.py                  # Collection sub-resource
    services/
      nomad.py                   # Read from normalised tables
  alembic/versions/
    *_phase_a_add_columns.py
    *_phase_b_add_tables.py
    *_phase_d_activate_normalised_schema.py
    *_phase_f_drop_legacy.py
  scripts/
    migrate_state_to_tables.py   # NEW one-shot backfill script

frontend/
  src/
    store/
      backend.ts                 # HttpBackend per-entity calls
      AppContext.tsx              # Remove ephemeral state / align types
    client/                      # Regenerated from openapi.json
```
