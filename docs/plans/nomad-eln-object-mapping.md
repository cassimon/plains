# Plan: first-class ELN objects for Materials, Solutions and Processes in NOMAD

Improve how the Plains app maps its objects into the NOMAD ELN via the
`nomad-perovskite-solar-cell-sample-plains` plugin. The `DepositionRoutine` /
`DepositionStep` assignment stays as it is; this plan adds proper ELN entities for
**Materials** and **Solutions**, links them from the process steps, and closes the
information-loss gaps in the process representation.

Two repos are touched:

- **sample-plains plugin** — new schema classes (`schema_packages/`), new parser entry
  points, tests.
- **plains backend** (`backend/app/services/nomad.py`) — new archive builders that emit
  the corresponding `.archive.yaml` entries and wire the references.

---

## 1. Current state (what gets lost today)

| App object | Today in NOMAD | Loss |
|---|---|---|
| `LabMaterial` (name, CAS, PubChem CID, MW, density, supplier, supplier #, inventory label, purity, state@RT, notes) | No entry. Name/supplier/purity appear only as `;`-joined strings inside the perovskite-database layer sections, and as `DepositedMaterial{name, supplier}` on a step. | CAS, PubChem CID, MW, density, inventory label, state, notes all dropped. Not searchable, not navigable. |
| `LabSolution` (name, type, handling, storage, creation_time, notes, components → materials **and stock solutions**) | No entry. Flattened to strings (`solvents`, `compounds`, `concentrations`) and to one `DepositedMaterial{name, concentration, supplier}` per step. | Structure (which component, how much, which stock solution) fully flattened; creation date, handling, storage, notes dropped. |
| Process chem recipe (`chemRecipe`: solvents+ratios, solutes, addedSolutions, totalSolventVolumeMl, isCommercial/commercialName/supplierNumber) | Same flattening as `LabSolution`. | Same; recipe-mixed-into-recipe volumes reduced to strings. |
| Process → substrate (`DepositionRoutine` + `DepositionStep`) | Good coverage of times/annealing/atmosphere/temps. | Quenching is **only** on the device sample's `perovskite_deposition`, not on the step that did it; the step's chemistry is a dead-end flat section; the layer a step produces (name, thickness) is not recorded on the step. |

The flattened strings in the perovskite-database sections (`solvents`, `compounds`, …)
**stay** — they feed the perovskite database schema. The new entities are additive.

---

## 2. New classes (sample-plains, `schema_packages/`)

Create a new module `schema_packages/chemicals.py` (keeps `sample.py` from
growing), imported into the same `SchemaPackage`.

### 2.1 `PlainsMaterial` — the material/chemical entity  *(request c)*

**Inheritance:** `PlainsMaterial(Chemical)` where `Chemical` is
`baseclasses.chemical.Chemical` → `nomad.datamodel.metainfo.eln.Substance` →
`System`/`Entity`.

Why this base and not `basesections.PureSubstance`:
- `baseclasses.solution.SolutionChemical.chemical` is `Reference(Chemical.m_def)` —
  inheriting `Chemical` makes every material entry **natively referenceable from
  solution components** with zero subclassing of the solution machinery.
- `Substance` already carries the identifier block: `cas_number`, `cas_uri`,
  `cas_name`, `inchi`, `inchi_key`, `smile`, `canonical_smile`, `molecular_formula`,
  `molecular_mass`, plus `lab_id` and CAS-API auto-fill on normalize.
- `Chemical` adds `state_of_matter` (`Liquid|Solid|Gas`) — direct fit for the app's
  `state_at_rt`.

```python
class PlainsMaterial(Chemical):
    """A chemical from the Plains inventory."""

    material_category = Quantity(type=str, a_eln=...)   # app `category` / `type`
    purity = Quantity(type=str, a_eln=...)              # app free-text purity
    density = Quantity(type=float, unit='g/cm**3', a_eln=...)

    substance = SubSection(section_def=PubChemPureSubstanceSectionCustom)
    product_info = SubSection(section_def=ProductInfo)
```

- `substance` (`baseclasses.PubChemPureSubstanceSectionCustom`) carries the **PubChem
  identity**: the app has *verified* CIDs, so set `pub_chem_cid` and pre-fill
  name/formula/molar mass/CAS from app data with **`load_data=False`** — deterministic
  and offline-safe during processing; a user can flip `load_data` in the GUI to
  re-fetch from PubChem.
- `product_info` (`baseclasses.product_info.ProductInfo`) carries **supplier
  metadata**: `supplier`, `product_number`, `lot_number`, etc.

**Attribute mapping `LabMaterial` → `PlainsMaterial`:**

| App field | NOMAD quantity |
|---|---|
| `name` | `name` |
| `inventory_label` | `lab_id` (Entity semantics: “unique within the lab” — exactly an inventory label; searchable) |
| `cas_number` | `cas_number` (Substance) + `substance.cas_number` |
| `pubchem_cid` | `substance.pub_chem_cid` |
| `molecular_weight` | `molecular_mass` + `substance.molecular_mass` |
| `density`, `density_unit` | `density` (converted to g/cm³) |
| `supplier` | `product_info.supplier` |
| `supplier_number` | `product_info.product_number` |
| `purity` | `purity` |
| `state_at_rt` | `state_of_matter` (map to `Liquid`/`Solid`/`Gas`; unknown → unset) |
| `category` / `type` | `material_category` |
| `notes` | `description` |
| `substrate_rigidity`, `height_mm` | `description` suffix (substrate geometry already lives in `SubstrateSample`/`SubstrateInfo`; don't duplicate a schema for it) |

A **commercial recipe** (`isCommercial=True`) is bought, not mixed — it maps to a
`PlainsMaterial` too (`name=commercialName`, `product_info.product_number=supplierNumber`),
not to a solution.

### 2.2 `PlainsSolution` — the solution actually made in the lab  *(request a)*

**Inheritance:** `PlainsSolution(Solution)` where `Solution` is
`baseclasses.solution.Solution` → `basesections.CompositeSystem`. This base already
models everything the app knows, including **solutions containing stock solutions**:

- `solvent` / `solute` / `additive`: repeating `SolutionChemical` — each with
  `chemical` (**Reference to a `Chemical` entry** → our `PlainsMaterial`),
  `chemical_2` (inline `PubChemPureSubstanceSectionCustom`), `chemical_volume` (ml),
  `chemical_mass` (mg), `amount_mol`, `concentration_mol`, `concentration_mass`,
  `amount_relative`.
- `other_solution`: repeating `OtherSolution` with `solution` (**Reference to another
  `Solution` entry**) + `solution_volume` — the stock-solution case, first class, no
  flattening.
- `preparation` (`SolutionPreparationStandard`: method/temperature/time/speed),
  `storage` (repeating `SolutionStorage`: dates, condition, temperature, atmosphere,
  comments), `properties`, `solution_id` (`ReadableIdentifiersCustom`).

```python
class PlainsSolution(Solution):
    """A solution mixed in the Plains lab (LabSolution or a process recipe)."""

    handling = Quantity(type=str, a_eln=...)  # app free-text handling instructions
```

**Attribute mapping `LabSolution` → `PlainsSolution`:**

| App field | NOMAD quantity |
|---|---|
| `name` | `name` |
| `id` (app UUID) | `lab_id` (stable cross-upload identity → dedup/search) |
| `creation_time` | `datetime` (Entity creation timestamp) |
| `handling` | `handling` |
| `storage` | `storage[0].storage_condition` |
| `notes` | `description` |
| `type` | `description` prefix (or reuse `method` when it matches the enum) |
| component with `material_id`, unit `ml` | solvent-typed material → `solvent[]`, else `additive[]`/`solute[]`; `SolutionChemical.chemical` = ref to the `PlainsMaterial` entry, `chemical_2` pre-filled inline (CID, formula, `load_data=False`), `chemical_volume = amount` |
| component with `material_id`, unit `mg` | `solute[]` (or `additive[]`), `chemical_mass = amount` |
| component with `material_id`, unit `mol` | `solute[]`, `amount_mol = amount` |
| component with `solution_ref_id` | `other_solution[]`: `OtherSolution.solution` = ref to that solution's entry, `solution_volume` when the amount is a volume |

Solvent vs. solute/additive classification reuses the backend's existing
`_is_solvent_material` (material `type` contains “solvent”).

**Attribute mapping process recipe (`chemRecipe`, non-commercial) → `PlainsSolution`:**

| Recipe field | NOMAD quantity |
|---|---|
| `name` | `name` |
| recipe id | `lab_id` |
| `solvents[i].name` + ratio-split of `totalSolventVolumeMl` (existing `_recipe_solvent_volumes_ml`) | `solvent[i].chemical_volume`; ratio also into `amount_relative`; `solvent_ratio` string on the solution |
| `solutes[i]` (`amount`, `unit`) | `solute[i].chemical_mass` / `chemical_volume`; molar concentration via existing `_recipe_molar_concentration` → `concentration_mol` |
| `addedSolutions[i]` (`recipeId`, `volumeMl`) | `other_solution[i]`: `solution` = ref to that recipe's solution entry, `solution_volume = volumeMl` |

### 2.3 Process-step linkage  *(requests a + b; DepositionStep/Routine kept)*

`DepositedMaterial` stays (cheap summary, backward compatible) and gains navigable
references; `DepositionStep` gains the sections that currently vanish:

```python
class DepositedMaterial(ArchiveSection):
    ...existing name/concentration/supplier...
    solution_reference = Quantity(
        type=Reference(Solution.m_def),          # → PlainsSolution entry
        a_eln=ELNAnnotation(component='ReferenceEditQuantity'),
    )
    material_reference = Quantity(
        type=Reference(Chemical.m_def),          # → PlainsMaterial entry
        a_eln=ELNAnnotation(component='ReferenceEditQuantity'),
    )

class DepositionStep(ProcessStep):
    ...existing quantities...
    quenching = SubSection(section_def=QuenchingParameters)   # was sample-only
    layer_name = Quantity(type=str, a_eln=...)                # layer this step builds
    layer_thickness = Quantity(type=float, unit='nm', a_eln=...)
```

- **Quenching on the step** (b): the backend already parses per-step quenching
  (`_parse_quenching_string`) but only writes it into the device sample's
  `perovskite_deposition`. Emit the same `QuenchingParameters` payload on the step so
  the process entry is self-contained. Bonus: `AntisolventQuenchingParameters` gains
  `media_reference = Quantity(type=Reference(Solution.m_def))` so the antisolvent
  solution is a link, not just a name string.
- **Layer produced** (b): the app knows the layer name and thickness
  (`_layer_thickness`); record them on the step.
- Everything else in `_build_deposition_routine_data` (start/duration boundaries,
  annealing block, atmosphere, temps, solution volume) is already faithful — no change.

### 2.4 Class-inheritance overview

```
nomad.basesections.System ── eln.Substance ── baseclasses.Chemical ── PlainsMaterial   (new)
nomad.basesections.CompositeSystem ── baseclasses.Solution ── PlainsSolution           (new)
nomad.basesections.Process      ── DepositionRoutine        (kept)
nomad.basesections.ProcessStep  ── DepositionStep           (kept, + quenching/layer)
sections referenced/embedded:
  baseclasses.SolutionChemical            (solvent/solute/additive rows; `chemical` → Chemical)
  baseclasses.OtherSolution               (stock-solution rows; `solution` → Solution)
  baseclasses.SolutionStorage / SolutionPreparationStandard
  baseclasses.PubChemPureSubstanceSectionCustom  (identifiers; load_data=False, pre-filled)
  baseclasses.ProductInfo                 (supplier / product number / lot)
```

---

## 3. Upload layout and reference wiring (plains backend)

New files inside the upload zip, built by `create_nomad_metadata_yaml`:

```
materials/<slug>.material.archive.yaml    # one per LabMaterial actually used
                                          # (+ commercial recipes)
solutions/<slug>.solution.archive.yaml    # one per LabSolution / non-commercial recipe
                                          # actually used (incl. transitively via
                                          # stock solutions, addedSolutions,
                                          # antisolvent media)
```

- Collect the used-id sets by walking the selected steps of every substrate
  (`materialId`, `solutionId`, `chemRecipeId`, `inlineMaterial`, quenching media), then
  closing over `SolutionComponent.solution_ref_id` and `addedSolutions.recipeId`
  (cycle-guarded, as `_flatten_*` already do).
- References use the existing `_upload_raw_reference(path, '/data')` pattern
  (`../upload/raw/...#/data`), same as sample ↔ substrate today.
- Inline materials (typed on the step, no entity) keep today's behavior — flat
  `DepositedMaterial` only, no entry.
- Filenames deduped via the existing `_reserve_archive_filename`.

**Parser entry points** (sample-plains `parsers/__init__.py` + `pyproject.toml`):
reuse the config-driven `PlainsSampleParser` with two new entry points matching the new
`m_def`s — materials at **level 1**, solutions at **level 2** (materials normalize
first so `SolutionChemical.normalize` can render names; device samples stay at 2,
substrates at 3). Cross-solution references resolve lazily, so ordering within level 2
is not load-bearing.

**Backend builders** (`services/nomad.py`): `_build_material_entity_data`,
`_build_solution_entity_data` (LabSolution), `_build_recipe_solution_data` (recipe),
plus extending `_step_material_payload` to attach `solution_reference` /
`material_reference`. Unit mapping is closed: app units are exactly `mg | ml | mol`
(solutions) and `mg | ml` (recipe solutes).

---

## 4. Compatibility & rollout

- Purely additive: no class renamed/removed, old archives keep processing.
- `load_data=False` + pre-filled PubChem fields keeps Oasis processing offline-safe and
  deterministic (no PubChem API calls at normalize time).
- `lab_id` = app UUID (solutions) / inventory label (materials) gives a stable,
  searchable identity across uploads; true cross-upload dedup (referencing an entry in
  a previous upload) is out of scope here — each upload stays self-contained.
- Ship order: (1) plugin classes + tests → (2) backend builders + tests → (3) pin bump,
  Oasis rebuild, live re-upload check (gated on user go-ahead, per standing rule).

## 5. Tests

- **sample-plains:** instantiate `PlainsMaterial`/`PlainsSolution` from dicts shaped
  like the generated YAML; normalize with a mock archive; assert identifier propagation
  (`lab_id`, CID pre-fill without network), component typing (solvent/solute/other_solution),
  and that new parser entry points claim `materials/…`/`solutions/…` and nothing else.
- **plains backend:** extend the `create_nomad_metadata_yaml` tests: a fixture
  experiment with a material, a solution containing a stock solution, and a recipe with
  an added solution → assert the four archive files exist, references point at each
  other, unit routing (`mg`→`chemical_mass`, `ml`→`chemical_volume`, `mol`→`amount_mol`),
  commercial recipe → material entry, and step payloads carry
  `solution_reference`/`quenching`/`layer_*`.
- **Live (ask first):** re-upload a real experiment; check the Solutions/Materials
  entries render in the NOMAD GUI, references navigate both ways, and the ELN overview
  shows the solution composition tables.
