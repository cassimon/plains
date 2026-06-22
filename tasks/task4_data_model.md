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

## Canvas Coordinate System

The canvas is a **discrete grid** (chess-board model).  All positions and sizes are
**non-negative integers**, never floats.  `(i, j)` is the grid cell, `(di, dj)` is the
extent in grid cells.

| Element type | position | size |
|---|---|---|
| `StickyNote` | `(i, j)` | `(di, dj)` — user-defined, ≥ 1 |
| `TextField` | `(i, j)` | `(di, dj)` — user-defined, ≥ 1 |
| `DataCollection` | `(i, j)` | always `(1, 1)` — fixed |

`LineElement` is **deprecated and removed**.  Any existing rows with `element_type =
'line'` are discarded during migration.

---

## Plane Ownership and Copying

**Every domain object carries a `plane_id`** (FK → `plane.id`).  This is the single
authoritative field that places an object on a plane.

- **Deep copy**: to copy an object to another plane, create a new row (new UUID) with
  the target `plane_id`.  All child rows are recursively copied with new UUIDs.
- **Move/shift**: to move an object to another plane without copying, update `plane_id`
  in place.  No new UUIDs are generated.

Objects that have `plane_id`:
`lab_material`, `lab_solution`, `process`, `experiment`, `experiment_results`, `analysis`

---

## Canonical Object Hierarchy

```
User
├── owns: Plane[]                          (plane.owner_id → user.id)
│   ├── has: PlaneShare[]                  (plane_share.plane_id → plane.id)
│   ├── has: StickyNote[]                  (sticky_note.plane_id → plane.id)
│   ├── has: TextField[]                   (text_field.plane_id → plane.id)
│   └── has: DataCollection[]             (data_collection.plane_id → plane.id)
│
├── owns: LabMaterial[]                   (lab_material.owner_id, lab_material.plane_id)
├── owns: LabSolution[]                   (lab_solution.owner_id, lab_solution.plane_id)
│   └── has: SolutionComponent[]          (solution_component.solution_id)
│
├── owns: Process[]                       (process.owner_id, process.plane_id)
│   │   [Process is referenced by a DataCollection via process.collection_id]
│   ├── Step 1 – Chemistry
│   │   └── has: ProcessSolutionRecipe[]  (process_solution_recipe.process_id)
│   │       ├── has: RecipeSolvent[]
│   │       ├── has: RecipeSolute[]
│   │       └── has: RecipeAddedSolution[]
│   ├── Step 2 – Deposition
│   │   └── has: ProcessStep[]            (process_step.process_id; stage_index + step_index)
│   └── Step 3 – Device Stack
│       └── has: GeneratedStack[]         (process_generated_stack.process_id)
│           └── has: GeneratedStackLayer[]
│
├── owns: Experiment[]                    (experiment.owner_id, experiment.plane_id)
│   │   [Experiment is referenced by a DataCollection via experiment.collection_id]
│   ├── FK → Process                      (experiment.process_id → process.id)
│   ├── refs: LabMaterial[]               (experiment_material.experiment_id)
│   ├── refs: LabSolution[]               (experiment_solution.experiment_id)
│   └── has: LabSubstrate[]              (lab_substrate.experiment_id → experiment.id)
│       └── outcome columns              (outcome_status, stopped_at_step, discard_reason)
│
├── owns: ExperimentResults[]             (experiment_results.owner_id, .plane_id)
│   │   [Results are referenced by a DataCollection via experiment_results.collection_id]
│   ├── FK → Experiment                   (experiment_results.experiment_id)
│   ├── has: MeasurementFile[]
│   ├── has: DeviceGroup[]
│   └── NOMAD columns                    (nomad_upload_id, nomad_status, nomad_entries)
│
└── owns: Analysis[]                      (analysis.owner_id, analysis.plane_id)
    │   [Analysis is referenced by a DataCollection via analysis.collection_id]
    ├── refs: AnalysisRef[]              weak FKs to results / experiments / processes
    └── FK → ExperimentResults (nullable) (analysis.primary_result_id)
```

> **DataCollection membership** is expressed by a `collection_id` FK on the entity
> itself (`process.collection_id`, `experiment.collection_id`, etc.), not by a
> separate join table.  A DataCollection is just a named grid cell; the objects
> inside it point back to it.

---

## Tables to Create / Modify

### 1. `user` (modify — add NOMAD profile fields)

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| email | text unique | |
| full_name | text nullable | |
| is_active | bool | |
| is_superuser | bool | |
| hashed_password | text nullable | null for NOMAD-only users |
| nomad_sub | text unique nullable | Keycloak UUID |
| nomad_name | text nullable | NEW: display name from NOMAD token |
| nomad_email | text nullable | NEW: canonical NOMAD email (may differ from login email) |
| created_at | timestamptz | |

---

### 2. `plane` (no schema change)
Current schema is correct.

---

### 3. `plane_share` (no change)
Current schema is correct.

---

### 4. `sticky_note` (NEW — replaces canvas_element WHERE type='text')

Rich-text sticky note placed at a discrete grid cell.

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| plane_id | uuid FK → plane.id CASCADE | |
| i | int | grid row (0-based) |
| j | int | grid column (0-based) |
| di | int default 1 | height in grid cells, ≥ 1 |
| dj | int default 1 | width in grid cells, ≥ 1 |
| content | text nullable | rich-text (e.g. HTML or Markdown) |
| color | text nullable | background colour |
| fmt_bold | bool nullable | |
| fmt_italic | bool nullable | |
| fmt_underline | bool nullable | |
| fmt_font_size | int nullable | |
| hyperlink | text nullable | optional URL attached to the note |
| created_at | timestamptz | |

---

### 5. `text_field` (NEW — replaces canvas_element WHERE type='plaintext')

Plain-text label placed at a discrete grid cell.

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| plane_id | uuid FK → plane.id CASCADE | |
| i | int | grid row |
| j | int | grid column |
| di | int default 1 | height in grid cells |
| dj | int default 1 | width in grid cells |
| content | text nullable | |
| color | text nullable | text colour |
| fmt_bold | bool nullable | |
| fmt_italic | bool nullable | |
| fmt_underline | bool nullable | |
| fmt_font_size | int nullable | |
| hyperlink | text nullable | optional URL |
| created_at | timestamptz | |

---

### 6. `data_collection` (NEW — replaces canvas_element WHERE type='collection')

A named 1×1 grid cell that groups domain objects.  Objects declare membership by
carrying a `collection_id` FK; the collection itself holds no refs.

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| plane_id | uuid FK → plane.id CASCADE | |
| i | int | grid row |
| j | int | grid column |
| name | text | |
| color | text nullable | |
| created_at | timestamptz | |

> Size is always 1×1 (no `di`/`dj` columns needed).

No `collection_ref` table.  Instead, the entities (`process`, `experiment`,
`experiment_results`, `analysis`) each carry a nullable `collection_id` FK:

```sql
collection_id uuid FK → data_collection.id SET NULL nullable
```

Setting `collection_id` on an entity places it in the collection.
Setting it to `NULL` removes it.

---

### 7. `lab_material` (rename/extend current `material`)

Add all frontend fields; add `plane_id`.

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| owner_id | uuid FK → user.id CASCADE | |
| plane_id | uuid FK → plane.id SET NULL nullable | which plane this material lives on |
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
| frontend_data | jsonb nullable | migration safety net |

---

### 8. `lab_solution` (rename/extend current `solution`)

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| owner_id | uuid FK → user.id CASCADE | |
| plane_id | uuid FK → plane.id SET NULL nullable | |
| name | text | |
| type | text nullable | layer type hint |
| handling | text nullable | |
| storage | text nullable | NEW |
| creation_time | timestamptz nullable | |
| notes | text nullable | |
| created_at | timestamptz | |
| frontend_data | jsonb nullable | |

### 8a. `solution_component` (extend)

Add `solution_ref_id` for solutions-as-components:

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| solution_id | uuid FK → lab_solution.id CASCADE | parent solution |
| material_id | uuid FK → lab_material.id SET NULL nullable | |
| solution_ref_id | uuid FK → lab_solution.id SET NULL nullable | NEW: solution-in-solution |
| amount | float | |
| unit | text | 'mg' \| 'ml' \| 'mol' |

CHECK constraint: exactly one of `material_id` / `solution_ref_id` must be non-null.

---

### 9. `process` (NEW — currently in UserState JSONB)

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| owner_id | uuid FK → user.id CASCADE | |
| plane_id | uuid FK → plane.id SET NULL nullable | |
| collection_id | uuid FK → data_collection.id SET NULL nullable | membership |
| name | text | |
| description | text nullable | |
| skip_chemistry | bool default false | |
| created_at | timestamptz | |
| frontend_data | jsonb nullable | |

### 9a. `process_inline_substrate` (NEW)

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

### 9b. `process_substrate_dimension` (NEW)

Dimension overrides for LabMaterial-referenced substrates:

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| process_id | uuid FK → process.id CASCADE | |
| material_id | uuid FK → lab_material.id CASCADE | |
| length_cm | text nullable | |
| width_cm | text nullable | |
| height_mm | text nullable | |
| surface_roughness_rms_nm | text nullable | |

UNIQUE on (process_id, material_id).

---

### 10. `process_solution_recipe` (NEW — Step 1: Chemistry)

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

### 10a. `recipe_solvent` (NEW)

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

### 10b. `recipe_solute` (NEW)

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

### 10c. `recipe_added_solution` (NEW)

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| recipe_id | uuid FK → process_solution_recipe.id CASCADE | |
| referenced_recipe_id | uuid FK → process_solution_recipe.id SET NULL nullable | |
| volume_ml | text | |

---

### 11. `process_step` (NEW — Step 2: Deposition)

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
| inline_material | jsonb nullable | ad-hoc material (no entity) |
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

UNIQUE on (process_id, stage_index, step_index).

---

### 12. `process_generated_stack` (NEW — Step 3: Device Stack)

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| process_id | uuid FK → process.id CASCADE | |
| combination | int | stack variation number |
| architecture | text nullable | |
| build_device | text nullable | 'Yes' \| 'No' |
| pixel_area_cm2 | text nullable | |
| number_of_pixels | text nullable | |
| is_deleted | bool default false | soft-delete for `deletedStackCombinations` |

### 12a. `process_generated_stack_layer` (NEW)

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

### 13. `experiment` (extend)

| column | type | notes |
|--------|------|-------|
| … existing … | | |
| plane_id | uuid FK → plane.id SET NULL nullable | NEW |
| collection_id | uuid FK → data_collection.id SET NULL nullable | NEW membership |
| process_id | uuid FK → process.id SET NULL nullable | NEW link to Process |
| architecture | text nullable | 'n-i-p' \| 'p-i-n' \| etc. |
| substrate_material | text nullable | substrate description string |
| substrate_width | float nullable | cm |
| substrate_length | float nullable | cm |
| num_substrates | int nullable | |
| devices_per_substrate | int nullable | |
| device_area | float nullable | cm² |
| device_layout_image | text nullable | base64 jpg/png |
| date | date nullable | fabrication date |
| end_date | date nullable | |
| has_results | bool default false | denormalised for list rendering |
| has_completed_upload | bool default false | |
| chemicals_prep | jsonb nullable | ExperimentChemicalsPrep blob |
| processing_times | jsonb nullable | {stageId: isoString} map |

### 13a. `experiment_material` (NEW — junction)

Records every LabMaterial consumed in this experiment (independent of the Process
link, because the same material can be used differently each run).

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| experiment_id | uuid FK → experiment.id CASCADE | |
| material_id | uuid FK → lab_material.id CASCADE | |
| role | text nullable | 'substrate' \| 'additive' \| etc. (optional label) |

UNIQUE on (experiment_id, material_id).

### 13b. `experiment_solution` (NEW — junction)

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| experiment_id | uuid FK → experiment.id CASCADE | |
| solution_id | uuid FK → lab_solution.id CASCADE | |
| role | text nullable | optional label |

UNIQUE on (experiment_id, solution_id).

---

### 14. `lab_substrate` (extend current `substrate`)

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| experiment_id | uuid FK → experiment.id CASCADE | |
| name | text | |
| substrate_material_id | uuid FK → lab_material.id SET NULL nullable | |
| notes | text nullable | |
| outcome_status | text nullable | 'complete' \| 'incomplete' \| 'discarded' |
| outcome_stopped_at_step | text nullable | stage index as string |
| outcome_discard_reason | text nullable | |
| parameter_values | jsonb nullable | {paramKey: value} per-substrate variation |

---

### 15. `experiment_results` (extend)

| column | type | notes |
|--------|------|-------|
| … existing … | | |
| plane_id | uuid FK → plane.id SET NULL nullable | NEW |
| collection_id | uuid FK → data_collection.id SET NULL nullable | NEW |
| grouping_strategy | text nullable | 'exact' \| 'search' \| 'fuzzy' |
| matching_strategy | text nullable | 'fuzzy' \| 'sequential' \| 'manual' |
| nomad_upload_id | text nullable | NOMAD upload UUID |
| nomad_upload_time | timestamptz nullable | |
| nomad_upload_status | text nullable | 'PENDING' \| 'SUCCESS' \| 'FAILURE' |
| nomad_entries | int nullable | number of NOMAD entries |

### 15a. `measurement_file` (extend)

| column | type | notes |
|--------|------|-------|
| … id, results_id, filename, file_type, file_path, notes … | | |
| device_name | text nullable | |
| cell | text nullable | |
| pixel_label | text nullable | renamed from 'pixel' to avoid SQL keyword |
| value | float nullable | e.g. PCE % |
| voc | float nullable | V |
| jsc | float nullable | mA/cm² |
| ff | float nullable | % |
| measurement_date | text nullable | |
| measurement_user | text nullable | |

### 15b. `device_group` (extend)

| column | type | notes |
|--------|------|-------|
| … id, results_id, name, substrate_name … | | |
| assigned_substrate_id | uuid nullable | weak ref to lab_substrate |
| suggested_substrate_id | uuid nullable | |
| match_score | float nullable | 0–1 |

---

### 16. `analysis` (NEW)

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| owner_id | uuid FK → user.id CASCADE | |
| plane_id | uuid FK → plane.id SET NULL nullable | |
| collection_id | uuid FK → data_collection.id SET NULL nullable | |
| name | text | |
| description | text nullable | |
| is_meta | bool default false | true = spans multiple results |
| primary_result_id | uuid FK → experiment_results.id SET NULL nullable | |
| created_at | timestamptz | |
| frontend_data | jsonb nullable | charts, layout |

### 16a. `analysis_ref` (NEW)

Weak multi-references so one Analysis can span Results, Experiments, Processes:

| column | type | notes |
|--------|------|-------|
| id | uuid PK | |
| analysis_id | uuid FK → analysis.id CASCADE | |
| kind | text | 'result' \| 'experiment' \| 'process' |
| entity_id | uuid | no FK constraint — entity may be independently deleted |

---

## What Gets Removed / Deprecated

| Current | Action |
|---------|--------|
| `canvas_element` table (all rows) | **Replaced** by `sticky_note`, `text_field`, `data_collection` |
| `canvas_element` rows where type='line' | **Discarded** — LineElement deprecated |
| `userstate.data` domain keys | Emptied after Phase C backfill; keep only `ui_prefs` |
| `experiment_layer` table | **Deleted** — layers are now `process_step` rows |
| `item` table | **Deleted** — legacy scaffolding, no frontend usage |
| `frontend_data` JSONB columns | Keep as migration safety net; drop in a later pass |
| `collection_ref` table (was proposed) | **Never created** — membership via FK on entities |

---

## API Changes

### New endpoints

```
# Canvas elements
POST/GET/PUT/DELETE  /api/v1/planes/{id}/sticky-notes/{nid}
POST/GET/PUT/DELETE  /api/v1/planes/{id}/text-fields/{tid}
POST/GET/PUT/DELETE  /api/v1/planes/{id}/collections/{cid}

# Process
POST/GET/PUT/DELETE  /api/v1/processes/{id}
GET/PUT/DELETE       /api/v1/processes/{id}/recipes/
GET/PUT/DELETE       /api/v1/processes/{id}/steps/
GET/PUT/DELETE       /api/v1/processes/{id}/stacks/

# Analysis
POST/GET/PUT/DELETE  /api/v1/analyses/{id}

# Experiment material/solution references
PUT  /api/v1/experiments/{id}/materials      body: [material_id, …]
PUT  /api/v1/experiments/{id}/solutions      body: [solution_id, …]
```

### Endpoints to modify

- `PUT /api/v1/state/` — accepts only `{ ui_prefs: {...} }` going forward.
- `GET /api/v1/state/bulk` — adds `processes`, `analyses`; returns normalised objects.
- `GET /api/v1/experiments/{id}` — includes `material_ids`, `solution_ids`, substrate outcomes.
- `GET /api/v1/results/{id}` — returns NOMAD columns as top-level fields.
- `GET /api/v1/planes/{id}` — returns `sticky_notes`, `text_fields`, `collections` instead of `elements`.

---

## Migration Strategy

### Phase A — Add columns (non-breaking, all nullable)
Add `plane_id`, `collection_id`, and all new scalar columns to existing tables.
No code changes; `frontend_data` remains the truth source.

Alembic revision: `phase_a_add_columns`

### Phase B — Add new tables (non-breaking)
Create `sticky_note`, `text_field`, `data_collection`,
`process`, `process_step`, `process_solution_recipe`, `recipe_*`,
`process_generated_stack`, `process_generated_stack_layer`,
`process_inline_substrate`, `process_substrate_dimension`,
`experiment_material`, `experiment_solution`,
`analysis`, `analysis_ref`.

Alembic revision: `phase_b_add_tables`

### Phase C — Backfill (data migration script)
`backend/scripts/migrate_state_to_tables.py`:
1. Read every `UserState.data` blob.
2. Upsert `lab_material`, `lab_solution`, `process`, `experiment`, `experiment_results`,
   `analysis` into normalised rows.
3. For canvas elements: create `sticky_note` / `text_field` / `data_collection` rows
   from `canvas_element`; skip any with type='line'.
4. Set `plane_id`, `collection_id` on all entities.
5. Populate `experiment_material` and `experiment_solution` junction rows.
6. Mark each migrated row with `migrated_at` for auditability.

### Phase D — Flip the backend (breaking)
- Rewrite `models.py` with the full new schema.
- Update `crud.py`.
- Slim down `state.py` (`PUT` accepts only `ui_prefs`).
- Add `processes.py`, `analyses.py`, extend `planes.py`.
- Extend `experiments.py`, `results.py`.
- Regenerate OpenAPI client: `bash ./scripts/generate-client.sh`.

Alembic revision: `phase_d_activate_normalised_schema`

### Phase E — Frontend adapter update
- Update `store/backend.ts` `HttpBackend` to per-entity endpoints.
- Update `store/AppContext.tsx`: canvas uses integer grid coords; no LineElement; plane_id on every entity.
- Regenerate `src/client/`.

### Phase F — Drop legacy (cleanup)
- Drop `canvas_element`, `experiment_layer`, `item` tables.
- Remove domain keys from `UserState.data`.
- Optionally drop `frontend_data` columns.

Alembic revision: `phase_f_drop_legacy`

---

## Acceptance Criteria

1. Every entity in `AppContext` types maps 1-to-1 to a table column — no domain data
   in JSONB blobs.
2. Canvas positions are integer grid coordinates `(i, j)` everywhere; no float x/y.
3. LineElement rows are absent from the database after Phase C.
4. Every domain object (`lab_material`, `lab_solution`, `process`, `experiment`,
   `experiment_results`, `analysis`) has a non-null `plane_id`.
5. DataCollection contains no ref table; membership is expressed via `collection_id`
   FKs on entities.
6. `experiment_material` and `experiment_solution` junction tables exist and are
   populated by the experiment save endpoint.
7. Process, Experiment, Results, and Analysis all carry a `collection_id` FK.
8. All existing backend tests pass; coverage stays ≥ 80%.
9. New tests for `Process`, `Analysis`, `DataCollection`, canvas element CRUD reach ≥ 80%.
10. `PUT /api/v1/state/` rejects any key other than `ui_prefs` with 422.
11. NOMAD export reads from normalised tables only.
12. All 11 Playwright random-walk tests pass.

---

## File Checklist

```
backend/
  app/
    models.py                        # Full schema rewrite
    crud.py                          # Helpers for process, analysis, collections
    api/routes/
      processes.py                   # NEW
      analyses.py                    # NEW
      state.py                       # Slim to ui_prefs only
      experiments.py                 # plane_id, collection_id, material/solution refs
      results.py                     # NOMAD cols, plane_id, collection_id
      planes.py                      # sticky_note, text_field, collection sub-routes
    services/
      nomad.py                       # Read normalised tables
  alembic/versions/
    *_phase_a_add_columns.py
    *_phase_b_add_tables.py
    *_phase_d_activate_normalised_schema.py
    *_phase_f_drop_legacy.py
  scripts/
    migrate_state_to_tables.py       # NEW one-shot backfill

frontend/
  src/
    store/
      backend.ts                     # HttpBackend per-entity calls
      AppContext.tsx                  # Integer grid coords, plane_id on entities
    client/                          # Regenerated from openapi.json
```
