# PubChem enrichment for lab materials + fixing `PlainsSolution` normalization

## Context

Two symptoms reported from the Oasis, with **one shared root cause**.

### Symptom 1 — every `PlainsSolution` fails to normalize

PCBM, the perovskite solution and MeO-2PACz all produce the identical traceback:

```
baseclasses/solution.py:550   Solution.normalize -> super().normalize(...)
basesections/v1.py:1082       formula = Formula(component.pure_substance.molecular_formula)
atomutils.py:1108             re.finditer(self.formula_parentheses, formula)
TypeError: expected string or bytes-like object, got 'NoneType'
```

It is not chemistry-specific — the formula being parsed is `None`, so *every* solution we
emit fails the same way regardless of what is in it.

**Cause.** `_solution_components()` (`backend/app/services/nomad.py:3264`) builds each
`PureSubstanceComponent.pure_substance` via `_pubchem_inline()` (:3021), which sets
`load_data: False`. In `baseclasses`, that flag is not a hint — it *bypasses the whole
PubChem fetch*:

```python
# /home/simon/nomad-baseclasses/src/baseclasses/__init__.py:73
def normalize(self, archive, logger):
    if self.load_data:
        super().normalize(archive, logger)          # PubChemPureSubstanceSection: fetches
    else:
        super(PubChemPureSubstanceSection, self).normalize(...)  # skips straight to the base
```

So `molecular_formula` is never populated. Then `CompositeSystem.normalize` calls
`Formula(...)` on it **unguarded**, and the section dies.

Note the irony: `components` was added in the previous phase specifically to stop the
NOMAD composition overview reading as empty. It is now the thing that crashes — the
entry is worse off than before, because a failed `normalize` drops the whole section.

**We chose offline mode and then never supplied the data offline mode obliges us to
supply.** `load_data: False` is still the right call (deterministic, no network during
processing, the app already verified the CID) — but it makes us responsible for
`molecular_formula`, and we carry no such field.

### Symptom 2 — `PlainsMaterial` entries are nearly empty

For Lead(II) bromide only `substance ID`, `material_category`, `datetime`, `density`
and `molecular_mass` come through. Same cause seen from the other side:
`_build_material_entity` (:3052) can only emit what `lab_material` holds — `pubchem_cid`,
`molecular_weight`, `density`, `cas_number`, `purity`, supplier fields. There is **no**
`molecular_formula`, `iupac_name`, `smiles`, `inchi`, `inchi_key`, or canonical PubChem
name anywhere in the schema, and with `load_data: False` NOMAD will not fill them in
from the CID either.

There is also **no PubChem client in this repo at all**. The CIDs come from a hand-curated
table in `frontend/src/routes/-Processes.chemistry.tsx:51` (~60 entries with
`pubchemCid`, molar mass, `componentCids`). Nothing is ever fetched live, so anything
outside that table has a CID only if the user typed one.

**Approach.** Fetch the full PubChem record **once, at the moment a material is set in
the app**, persist it to `lab_material`, and let the exporter read it back. Visible GUI
fields stay exactly as they are — this is a backend-side enrichment. That keeps NOMAD
processing offline and deterministic, fixes both symptoms from one data source, and
makes the enrichment inspectable and re-runnable rather than a hidden step of upload.

---

## Part 1 — Schema: PubChem fields on `lab_material`

Add to `LabMaterialBase` (`backend/app/models.py:355`). All nullable, all optional —
enrichment is best-effort and must never block saving a material.

| column | type | NOMAD target |
|---|---|---|
| `molecular_formula` | `str \| None` (255) | `PureSubstanceSection.molecular_formula` — **the field that fixes symptom 1** |
| `iupac_name` | `str \| None` (text) | `iupac_name` |
| `smiles` | `str \| None` (text) | `smiles` |
| `inchi` | `str \| None` (text) | `inchi` |
| `inchi_key` | `str \| None` (255) | `inchi_key` |
| `pubchem_name` | `str \| None` (255) | canonical name; the lab's own `name` stays authoritative for display |
| `monoisotopic_mass` | `float \| None` | `monoisotopic_mass` |
| `pubchem_synced_at` | `datetime \| None` | — bookkeeping: when we last fetched |

`molecular_weight`, `cas_number`, `density` already exist and stay — enrichment fills
them **only when empty**, so a user-entered value always wins (see Part 2).

`pubchem_synced_at` is what makes re-enrichment cheap and idempotent: rows already synced
are skipped unless the CID changed or a refresh is forced.

One Alembic migration (`alembic revision --autogenerate` in the backend container).
No index needed — these are payload, never lookup keys.

**Mixtures.** `component_cids` already exists (`models.py:415`). Per-component formulas
would need a second table; not worth it. A mixture gets no top-level formula and is
handled by the omission rule in Part 3 instead.

---

## Part 2 — PubChem client + enrichment service

### `backend/app/services/pubchem.py` (new)

A thin, dependency-free PUG-REST client (`httpx`, already a dependency):

```python
def fetch_compound(cid: int, *, timeout: float = 10.0) -> PubChemCompound | None
def search_cid_by_name(name: str) -> int | None   # used only when no CID is known
```

One request per CID against
`/rest/pug/compound/cid/{cid}/property/MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES,InChI,InChIKey,MonoisotopicMass/JSON`,
plus `/synonyms/JSON` for the CAS number (PubChem exposes CAS only as a synonym — take the
first entry matching `^\d{2,7}-\d{2}-\d$`).

Requirements:
- **Never raises into the caller.** Network error, 404, malformed payload → return `None`
  and log a warning. A dead PubChem must not stop a user saving a material or running an
  upload.
- Respect PubChem's published rate limit (5 req/s): a small sleep between calls in the
  batch path is sufficient at our volumes; no async pool.
- Return a typed `PubChemCompound` dataclass, not raw JSON, so the mapping is testable
  without the network.

### `backend/app/services/pubchem_enrichment.py` (new)

```python
def enrich_material(session: Session, material: LabMaterial, *, force: bool = False) -> bool
def enrich_materials(session: Session, materials: Sequence[LabMaterial], *, force=False) -> int
```

Rules:
- Skip if `pubchem_cid` is empty **and** a name search finds nothing.
- Skip if `pubchem_synced_at` is set and the CID is unchanged, unless `force`.
- **Never overwrite a non-empty user-entered value.** `molecular_weight`, `cas_number`,
  `density` are filled only when `None`. The pure-PubChem columns from Part 1 are always
  refreshed, since nothing else writes them.
- Set `pubchem_synced_at` on success only — a failed fetch leaves the row retryable.

### Invocation points

1. **On write** — in the materials route (`api/routes/materials.py`) on create and on any
   update that changes `pubchem_cid` or `name`. Run it **in a `BackgroundTask`**, not
   inline: a PubChem round-trip must not add latency to, or fail, the user's save. The GUI
   is unchanged; the data simply appears on the next read.
2. **In the materializer** — `chemicals_materialization.py` calls `enrich_material` for
   every row it get-or-creates, so chemicals that only ever exist as `chemicalsPrep` JSONB
   also get enriched.
3. **Backfill endpoint** — `POST /api/v1/materials/enrich-pubchem` (`force` optional) for
   the existing inventory and for retrying failures. Idempotent by `pubchem_synced_at`.

---

## Part 3 — Exporter fixes (`backend/app/services/nomad.py`)

### 3a. The crash — make it structurally impossible

Two independent changes; **both** are needed, because the guard has to hold even for rows
PubChem never resolved.

1. `_pubchem_inline()` (:3021) gains a `molecular_formula` argument and emits it when
   known.
2. **Omission rule in `_solution_components()` (:3264):** if the material has no
   `molecular_formula`, emit the component **without** the `pure_substance` subsection —
   keep `name`/`substance_name`/`mass`. `CompositeSystem.normalize` only dereferences
   `pure_substance` when it is present, so the entry normalizes cleanly, keeps its
   component list, and simply contributes nothing to the elemental composition.

The second rule is the load-bearing one: it means an unresolvable chemical (a lab-made
mixture, a CID typo, PubChem down at enrichment time) degrades to a slightly less rich
entry instead of killing the section. Formalise it as: **never emit a `pure_substance`
without a `molecular_formula`.** Anywhere.

### 3b. Populate the material entity (symptom 2)

`_build_material_entity` (:3052) — add to the `substance` section, each when present:
`molecular_formula`, `iupac_name`, `smiles`, `inchi`, `inchi_key`, `monoisotopic_mass`.
`molar_mass` and `cas_number` are already there. Same for `component_substances`
(:3091), which today emit a bare CID and nothing else.

### 3c. Mapping layer

`component_cids` and the new columns must be carried through the DB→dict mapping the
builders read (`materials_by_id`, :774) and through `frontend/src/store/backendMapping.ts`
+ `apiTypes.ts` so the round-trip does not drop them. Regenerate the API client
(`bash ./scripts/generate-client.sh`) after the model change.

---

## Part 4 — Tests

All DB-level/unit, no Playwright, no live network — mirroring the previous phase.

### `backend/tests/services/test_pubchem.py` (new)
Parse a captured PUG-REST payload for Lead(II) bromide (CID 24831) into
`PubChemCompound` — pin formula `Br2Pb`, the CAS synonym pick, and the numeric fields.
Assert the failure modes return `None` and log rather than raise: HTTP 404, HTTP 503,
truncated JSON, empty `PropertyTable`. Use a stubbed transport; **no test may touch the
network.**

### `backend/tests/services/test_pubchem_enrichment.py` (new)
Against the real `db` fixture, with a stubbed client:
1. a material with a CID gains every new column and a `pubchem_synced_at`;
2. **user-entered `molecular_weight`/`cas_number`/`density` are not overwritten**, while
   empty ones are filled;
3. a failed fetch leaves the row untouched with `pubchem_synced_at` still `None` (retryable)
   and does not raise;
4. idempotency — a second run makes no further calls unless `force=True`;
5. a material with no CID and no name match is skipped silently.

### `backend/tests/services/test_nomad_entities.py` (extend)
6. **The regression test for the crash:** a solution whose material has **no**
   `molecular_formula` emits components with **no `pure_substance` key at all** — assert
   the key's absence directly, since that absence is exactly what upstream needs;
7. a solution whose materials *are* enriched emits `pure_substance.molecular_formula` on
   every component;
8. `PlainsMaterial` for an enriched Lead(II) bromide carries formula, IUPAC name, SMILES,
   InChI, InChIKey — the direct assertion for symptom 2;
9. **repo-wide invariant:** walk every generated archive and assert no `pure_substance`
   dict anywhere lacks `molecular_formula`. This is what stops the bug returning through a
   builder nobody thought to update.

---

## Verification

```bash
docker compose exec backend alembic upgrade head
cd backend && bash ./scripts/test.sh      # backs up + restores the dev DB itself
cd backend && bash ./scripts/lint.sh
bash ./scripts/generate-client.sh
```

Then, in the container, backfill and regenerate against the real dev DB:

```bash
docker compose exec backend python -c "
from sqlmodel import Session, select; from app.core.db import engine
from app.models import LabMaterial
from app.services.pubchem_enrichment import enrich_materials
with Session(engine) as s:
    n = enrich_materials(s, s.exec(select(LabMaterial)).all()); s.commit(); print(n)
"
```

Confirm with `psql` that `molecular_formula` is populated, regenerate an upload, and grep
the emitted solution archives for `pure_substance` blocks lacking `molecular_formula`
(there must be none). Finally re-upload to the Oasis and confirm `PlainsSolution` reaches
`normalize` without the `Formula(None)` error, and that the composition overview is
populated rather than empty.

**Never run `docker compose down -v` by hand** (CLAUDE.md). Never run bare `pytest`
against the dev stack — use `POSTGRES_DB=app_test`.

## Risks

- **PubChem is an external dependency at write time.** Mitigated by the background task,
  the never-raise contract, and `pubchem_synced_at` making retries cheap. Enrichment
  failing must be invisible to the user beyond a less rich NOMAD entry.
- **Stale enrichment.** Data is fetched once and cached indefinitely. Acceptable —
  formulas do not change — and `force=True` exists for corrections.
- **CAS-from-synonyms is heuristic.** The regex can pick a wrong synonym on odd
  compounds; that is why it never overwrites a user-entered `cas_number`.
- **Upstream stays fragile.** `CompositeSystem.normalize`'s unguarded `Formula(...)` will
  break anyone else who emits a formula-less `pure_substance`. Our omission rule works
  around it; worth reporting upstream, but do not block on that.
