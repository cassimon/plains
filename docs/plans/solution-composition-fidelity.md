# Solution composition fidelity: make PlainsSolution archives fully reconstructable

**Goal.** A `PlainsSolution` archive uploaded to NOMAD must carry *everything* the app knew
about that solution, so the solution could be reconstructed from the archive alone.
Prioritize existing `baseclasses`/NOMAD fields; add plugin fields only where no home exists.

**Audience note.** This plan is written to be executed step-by-step. Every edit names its
file, anchor, and exact field names. Read the "Hard rules" section first — several of them
prevent data loss or broken NOMAD normalization.

---

## Hard rules (read before touching anything)

1. **Never run bare `pytest` against the dev stack** — it wipes the dev DB (CLAUDE.md).
   Use the isolated DB. Because this plan changes the schema, **drop and recreate it
   first** (`init_db` only creates missing tables, it never adds columns):
   ```bash
   docker compose exec -T db psql -U postgres -d postgres -c "DROP DATABASE IF EXISTS app_test;"
   docker compose exec -T db psql -U postgres -d postgres -c "CREATE DATABASE app_test;"
   cd backend && POSTGRES_DB=app_test uv run pytest tests/services/ -q
   ```
2. **Hand-write the Alembic migration.** The backend container does **not** bind-mount
   `app/`, so `alembic revision --autogenerate` inside the container sees stale models.
   Follow the pattern of `backend/app/alembic/versions/c7e3b91a45d2_pubchem_enrichment_on_lab_material.py`.
   To apply to the dev DB: `bash scripts/db-backup.sh` first, then
   `docker compose exec -T backend alembic upgrade head`.
3. **Never emit a `pure_substance` section without `molecular_formula`.** NOMAD's
   `CompositeSystem.normalize` calls `Formula(...)` unguarded; `None` kills the whole
   entry. The guard is `_has_molecular_formula()` in `app/services/nomad.py` (~line 3079).
   Keep it in every new emission path.
4. **NOMAD quantity spellings**: SMILES is `smile` / `canonical_smile` (singular);
   `iupac_name`/`monoisotopic_mass` exist only on `PubChemPureSubstanceSectionCustom`,
   not on the entity-level `Substance`. `_material_substance_fields()` already encodes
   this — reuse it, don't re-map.
5. **Service tests must not touch the network.** `backend/tests/services/conftest.py` has
   an autouse `stub_pubchem` fixture. Any new fixture chemicals need their CIDs added to
   `_STUB_COMPOUNDS` there (DMSO / CID 679 is *deliberately* absent — do not add it; it is
   the no-formula regression case).
6. **Do not commit** unless the user explicitly asks.

---

## The loss inventory (what the audit found)

App data flows: frontend recipe → normalized rows (`ProcessSolutionRecipe`,
`RecipeSolvent`, `RecipeSolute`, `RecipeAddedSolution` in `app/models.py:679-776`) →
materializer (`app/services/chemicals_materialization.py`) → `LabSolution` +
`SolutionComponent` → exporter `_build_solution_entity` (`app/services/nomad.py:3379`).

| # | App datum | Today | Status |
|---|---|---|---|
| 1 | `RecipeSolvent.volume_ratio` | Materializer computes absolute mL and drops the ratio. `SolutionComponent` has no column for it, so `_build_solution_entity` emits neither `solvent_ratio` nor per-row `amount_relative` (the recipe *fallback* path does emit both — only the main path loses it) | **LOST** |
| 2 | Component role (solvent / solute / mixed-in stock) | `SolutionComponent` has no role column; exporter *guesses* via `_is_solvent_material()` (`nomad.py:1007`, keys off material `type`/`stateAtRt`). A liquid solute or an untyped solvent gets mis-bucketed; a commercial product mixed in (materializer sets `material_id` for those, see `chemicals_materialization.py:575`) lands as a fake solute instead of an `additive` | **LOSSY GUESS** |
| 3 | Solution `type` (e.g. "perovskite precursor") + `notes` | Joined into `description` with `\n\n` (`nomad.py:3398-3408`) — cannot be split apart again | **MERGED** |
| 4 | `handling_preparation` vs `handling_before_use` | Materializer joins both with bare `\n\n` into `LabSolution.handling` — which text was which is gone | **MERGED** |
| 5 | `mode: "take"` provenance (`takenFromExpId`, `takenFromBatchId`) | Reduced to the fixed sentence "Taken from a batch prepared in another experiment." (`chemicals_materialization.py:412`) | **LOST** |
| 6 | Nested solutions in `CompositeSystem.components` | `_solution_components()` (`nomad.py:3335`) skips components with `solutionId` — a solution mixed from a stock shows no trace of it in the composition overview | **MISSING** |
| 7 | Row ↔ inventory linking for reconstruction | `SolutionChemical.chemical_id` (existing baseclasses quantity, `solution.py:101`) is never filled | unused existing field |
| 8 | `amount_relative` on `other_solution` rows | `OtherSolution.amount_relative` exists (`solution.py:151`); never filled | unused existing field |

Out of scope (pre-existing, unrelated gaps — do **not** fix here, just know they exist):
`sol:{id}` batch keys (entity-solution batches with `multiplier`) are not materialized at
all; `ProcessAddedSolution.volumeRatio` / `totalStockSolutionVolumeMl` are frontend-only
(never persisted to the normalized recipe tables — the exporter's recipe *fallback* path
still sees them via the process JSONB snapshot); ingredient `color` is UI cosmetics.

### Where each datum will live (decision table)

| Datum | Destination | Existing field? |
|---|---|---|
| solvent `volume_ratio` | `Solution.solvent_ratio` (string `"4:1"`) + per-row `SolutionChemical.amount_relative` | ✅ both exist in baseclasses |
| component role | new `SolutionComponent.role` DB column; exporter routes rows into `solvent`/`solute`/`additive`/`other_solution` by it | ✅ `additive` SubSection exists, unused |
| solution `type` | new `solution_type` Quantity on plugin `PlainsSolution` | ❌ plugin addition (CompositeSystem has no type; `method` is a preparation enum — wrong home) |
| `notes` | `description` alone (no longer merged with type) | ✅ |
| handling split | labeled join in one string (see Phase 2) — DB stays one column | ✅ plugin `handling` |
| take-provenance | structured sentence carrying both ids in `LabSolution.notes` | ✅ |
| nested solutions in composition | `SystemComponent` entries in `components` | ✅ `nomad.datamodel.metainfo.basesections.v1.SystemComponent` |
| row↔inventory link | `SolutionChemical.chemical_id` ← material `inventory_label` | ✅ |
| stock ratio | `OtherSolution.amount_relative` ← new `SolutionComponent.amount_relative` column | ✅ |

---

## Phase 1 — DB schema (`app/models.py` + one migration)

**1a.** In `app/models.py`, add to the `SolutionComponent` **table class only** (NOT
`SolutionComponentBase` — same reasoning as the PubChem enrichment columns on
`LabMaterial`: these are materializer-owned, keeping them off `Create`/`Update` means a
frontend write can never clobber them, and the API surface / generated client stay
untouched):

```python
    # ── Materializer-owned composition metadata ──────────────────────────
    # Which recipe list this component came from. The exporter routes rows into
    # NOMAD's solvent/solute/additive/other_solution buckets by this instead of
    # guessing from the material's type. Null on rows the GUI created directly;
    # the exporter then falls back to the old inference.
    role: str | None = Field(default=None, max_length=20)
    # The recipe's ratio for this row (solvent volumeRatio / stock share).
    # The absolute `amount` is the scaled batch quantity; this keeps the
    # recipe-level ratio so the recipe is reconstructable from the archive.
    amount_relative: float | None = None
```

Role vocabulary (document in the field comment): `"solvent"`, `"solute"`,
`"stock"` (a `RecipeAddedSolution` → another LabSolution), `"commercial"` (a
`RecipeAddedSolution` whose referenced recipe is commercial → a LabMaterial).

**1b.** Hand-write `backend/app/alembic/versions/<newid>_solution_component_role.py`:
- `down_revision = "c7e3b91a45d2"` (verify with
  `docker compose exec -T backend alembic heads` first; if a different head exists, chain
  from that).
- upgrade: `op.add_column("solutioncomponent", sa.Column("role", sa.String(length=20), nullable=True))`
  and `op.add_column("solutioncomponent", sa.Column("amount_relative", sa.Float(), nullable=True))`.
- downgrade drops both. Table name is `"solutioncomponent"` (no underscore — see
  `__tablename__` in models.py).

---

## Phase 2 — Materializer (`app/services/chemicals_materialization.py`)

All in `_sync_solution_components` (~line 520) and the batch-values block (~line 400).

**2a. Roles + ratios.** Where each `SolutionComponent(...)` is constructed:
- solvent rows (~line 539): add `role="solvent", amount_relative=solvent.volume_ratio or None`.
- solute rows (~line 553): add `role="solute"`.
- added-solution rows (~line 570): `role="stock"` when `solution_ref_id` is set,
  `role="commercial"` when it resolved to the commercial material.

**2b. Labeled handling join.** The current join produces an unsplittable blob. Replace with
a labeled format, emitted only for the parts present:

```python
def _joined_handling(preparation: str | None, before_use: str | None) -> str | None:
    parts = []
    if preparation and preparation.strip():
        parts.append(f"Preparation: {preparation.strip()}")
    if before_use and before_use.strip():
        parts.append(f"Before use: {before_use.strip()}")
    return "\n\n".join(parts) or None
```

Put it at module scope in `chemicals_materialization.py` and import it in
`app/services/nomad.py` so the recipe-fallback path (`_build_recipe_solution_entity`,
~line 3455, which does the same bare join) uses the identical function — one format,
two callers.

**2c. Take-provenance.** In the batch-values block (~line 412), replace the fixed note:

```python
if batch.get("mode") == "take":
    source_exp = str(batch.get("takenFromExpId") or "").strip()
    source_batch = str(batch.get("takenFromBatchId") or "").strip()
    values["notes"] = (
        "Taken from a batch prepared in another experiment"
        + (f" (experiment {source_exp}" if source_exp else "")
        + (f", batch {source_batch}" if source_batch and source_exp else "")
        + (")" if source_exp else "")
        + "."
    )
```

(Check first how `batch` dict keys arrive — they are the camelCase
`ExperimentSolutionBatch` fields from `chemicals_prep` JSONB, so `takenFromExpId` /
`takenFromBatchId` are the right spellings; see `frontend/src/store/AppContext.tsx:459`.)

---

## Phase 3 — Exporter (`app/services/nomad.py`)

**3a. Carry the new columns into the export dict.** In `solutions_by_id` (~line 876), the
per-component dict gains:

```python
"role": getattr(c, "role", None),
"amountRelative": getattr(c, "amount_relative", None),
```

(`getattr` because the test harness in `test_nomad_metadata_generation.py` fakes
components — see Phase 5c.)

**3b. Route by role in `_solution_component_rows` (~line 3241).** Rewrite the routing:

```python
role = str(component.get("role") or "").strip().lower()
...
if material_id:
    row = ...  # unchanged construction: name, chemical ref, chemical_2, amount
    relative = _to_float(component.get("amountRelative"))
    if relative is not None and relative > 0:
        row["amount_relative"] = relative
    label = _clean_value((material or {}).get("inventoryLabel"), "")
    if label:
        row["chemical_id"] = label
    if role == "solvent" or (not role and _is_solvent_material(material)):
        solvent.append(row)
    elif role == "commercial":
        additive.append(row)          # NEW bucket, see below
    else:
        _set_row_concentrations(row, material, volume_ml)
        solute.append(row)
elif nested_id:
    entry = ...  # unchanged: name, solution ref, solution_volume
    relative = _to_float(component.get("amountRelative"))
    if relative is not None and relative > 0:
        entry["amount_relative"] = relative
    other.append(entry)
```

Return `{"solvent": ..., "solute": ..., "additive": ..., "other_solution": ...}` — the
caller (`_build_solution_entity` ~line 3414) already iterates the dict generically, so
`additive` flows through with no caller change. `baseclasses.Solution.additive` exists
(`solution.py:516`); no plugin change needed for it.

Empty-role fallback must keep the old `_is_solvent_material` inference — GUI-created
solutions (Solutions page, not materialized from a recipe) have `role=None`.

**3c. `solvent_ratio` on the solution.** In `_build_solution_entity`, after the rows are
attached: if ≥2 solvent rows all carry `amount_relative > 0`, set
`data["solvent_ratio"] = ":".join(f"{r:g}" ...)` — copy the exact formatting from the
recipe path at line 3469-3470 so both paths produce identical strings. (Bonus, free:
`Solution.normalize` mirrors a top-level `solvent_ratio` into `preparation` when none is
set — `solution.py:540`.)

**3d. Un-merge type from description.** In `_build_solution_entity` (~line 3398):

```python
solution_type = _clean_value(solution.get("type"), "")
if solution_type:
    data["solution_type"] = solution_type      # plugin field, Phase 4
notes = _clean_value(solution.get("notes"), "")
if notes:
    data["description"] = notes
```

Apply the same to `_build_recipe_solution_entity` (~line 3452, currently puts the type in
`description`).

**3e. Nested solutions in `components`.** In `_solution_components` (~line 3335), stop
skipping `solutionId` components:

```python
nested_id = str(component.get("solutionId") or "").strip()
if nested_id:
    nested_ref = entity_ref_by_id.get(nested_id)
    if nested_ref:
        components.append({
            "m_def": "nomad.datamodel.metainfo.basesections.v1.SystemComponent",
            "name": _clean_value(
                (solutions_by_id.get(nested_id) or {}).get("name"), "Solution"
            ),
            "system": nested_ref,
        })
    continue
```

**Verify the m_def path and reference-shape against the live Oasis before trusting it**
(same technique as the pubchem work):

```bash
docker exec nomad_oasis_app python -c "
from nomad.datamodel.metainfo.basesections.v1 import SystemComponent
print(SystemComponent.m_def.qualified_name())
print(sorted(q.name for q in SystemComponent.m_def.all_quantities.values()))"
```

If `SystemComponent.system` normalization chokes on an unresolved archive reference
(possible — references resolve only after all entries process), fall back to emitting the
plain base `Component` (`name` + `mass`) for nested solutions and note it in the code.
Decide by testing on the live Oasis (Phase 6), not by assumption.

---

## Phase 4 — Plugin (`/home/simon/nomad-perovskite-solar-cell-sample-plains`)

File: `src/nomad_perovskite_solar_cell_sample_plains/schema_packages/chemicals.py`.

**4a.** Add to `PlainsSolution` (next to `handling`):

```python
    solution_type = Quantity(
        type=str,
        description=(
            'The app solution category (e.g. "perovskite precursor", "n-type (ETL)").'
        ),
        a_eln=ELNAnnotation(component='StringEditQuantity'),
    )
```

Add `'solution_type'` to the `m_def` ELN `order` list (after `'lab_id'`).

**4b.** Plugin tests: `tests/schema_packages/test_chemicals.py` follows a strict
convention — `parse(...)[0].data`, **no** `normalize_all` (keeps PubChem off the network),
class identity via `type(x).__name__`. Extend `tests/data/solution.archive.yaml` with
`solution_type`, an `additive` row, `chemical_id`, `amount_relative`, `solvent_ratio`, and
a `SystemComponent` entry in `components`; assert each in the test. Run:

```bash
cd /home/simon/nomad-perovskite-solar-cell-sample-plains && uv run pytest tests/schema_packages/ -x
```

**4c.** Reinstall the plugin into the local Oasis before Phase 6 (else the new
`solution_type` quantity is unknown and processing logs a warning / drops it).

---

## Phase 5 — Backend tests

**5a. Materializer** (`backend/tests/services/test_chemicals_materialization.py`):
- every solvent component row has `role == "solvent"` and `amount_relative` equal to the
  recipe's `volume_ratio` (fixture: DMF 4, DMSO 1 — `tests/services/conftest.py:137,145`);
- solute rows: `role == "solute"`, `amount_relative is None`;
- the PVK-into-PCBM added solution: `role == "stock"`;
- handling: for the PVK recipe (fixture has both handling fields) assert the joined value
  is `"Preparation: Stir at 60 C\n\nBefore use: Filter with 0.45 um PTFE"`;
- idempotency still holds (re-run creates no new rows) — the existing test should already
  cover this; just confirm it still passes with the new columns.

**5b. Exporter** (`backend/tests/services/test_nomad_entities.py`, real-DB harness via the
`experiment` fixture + `_export`):
- PVK solution archive: `solvent_ratio == "4:1"`; DMF solvent row `amount_relative == 4`;
  rows carry `chemical_id` equal to the material's inventory label (`INV-DMF` etc.);
- `solution_type == "perovskite precursor"` and `description` does **not** contain it;
- PCBM solution archive: the mixed-in PVK batch appears in `other_solution` (existing
  behaviour) **and** as a `SystemComponent` in `components` whose `system` reference is
  the PVK archive's filename (reuse the reference-resolution assertion style of
  `test_every_entity_reference_resolves_to_an_emitted_archive`);
- **the marquee round-trip test** `test_solution_is_reconstructable_from_its_archive`:
  from the PVK archive alone, rebuild `(name, type, handling-prep, handling-before-use,
  vial label, prepared-at, final volume, [(solvent name, CID, ratio, volume)],
  [(solute name, CID, mass)])` and assert equality with the fixture's recipe + batch
  values. Parse handling by splitting on the `"Preparation: "` / `"Before use: "` labels —
  this test is what pins the labeled format as a contract.
- keep `test_no_substance_section_anywhere_lacks_a_molecular_formula` green — the new
  `additive`/`SystemComponent` paths must not violate it (SystemComponent has no
  `pure_substance`, so it passes vacuously; verify, don't assume).

**5c. Fake-session harness** (`backend/tests/services/test_nomad_metadata_generation.py`):
the `_orm_solution` / component fakes need the two new attributes (`role`,
`amount_relative`) added, read via `d.get(...)` like the pubchem fields were, or the
`getattr` defaults in Phase 3a silently return `None` and the new assertions can't be
exercised there.

Run everything (after the DROP/CREATE from Hard rule 1):

```bash
cd backend && POSTGRES_DB=app_test uv run pytest tests/services/ -q
bash ./scripts/lint.sh
```

Expected pre-existing noise: `tests/api/routes/test_nomad.py` has 8 unrelated 403
failures and `tests/integration/` errors without a live server — do not chase them here.

---

## Phase 6 — Live verification against the Oasis

1. `bash scripts/db-backup.sh`, then `docker compose exec -T backend alembic upgrade head`.
2. Restart backend, re-run a real upload (or the in-container generation script from
   `docs/plans/pubchem-enrichment-and-solution-normalization.md`'s verification section)
   for an experiment with a multi-solvent solution and a stock mix-in.
3. In the Oasis, open the PlainsSolution entry and check: solvent ratio visible,
   additive/other_solution buckets correct, `solution_type` rendered, composition overview
   (elemental composition) now includes the nested solution's contribution, and — most
   importantly — **zero normalization errors** in `docker logs nomad_oasis_worker`.
4. Reproduce the reconstruction manually once: download the archive yaml, check every app
   field is findable.

---

## Risks / notes

- **`role=None` legacy rows.** Solutions materialized before this change keep null roles
  until the next upload re-materializes them (the materializer deletes and rewrites
  components each run — `chemicals_materialization.py:579` — so one re-upload heals them).
  The inference fallback covers the interim.
- **`SystemComponent` normalization** is the one genuinely uncertain piece (reference
  resolution order during processing). It is isolated in Phase 3e with a designed
  fallback; everything else in this plan is independent of its outcome.
- **The labeled handling format is now API.** The round-trip test (5b) pins it; if the
  labels ever change, that test fails loudly. Acceptable — it is exactly the contract the
  user asked for.
- `additive` rows deliberately get no `concentration_*`: a commercial product has no
  molar mass in the app, and mass-per-volume of a mixed-in dispersion is not a solute
  concentration.
