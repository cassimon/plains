# Batch2 substrate grouping + UV-Vis measurement support

## Two independent problems, one investigation

`/home/simon/Downloads/batch` and `/home/simon/Downloads/batch2` are two exports of
the **same** CHOSE instrument suite. `batch` imports cleanly (13 substrates
AI03…AI45, correctly grouped); `batch2` collapses to **one bogus group named
"JV"**. On top of that, `batch2` carries a measurement kind NOMAD has never seen —
**UV-Vis transmittance spectra**.

The two are unrelated in cause and can ship separately. Problem 1 is a
one-file frontend bug; problem 2 is a new measurement type threaded through all
three repos.

---

## Problem 1 — batch2 substrates are never recognized

### Root cause (confirmed by simulation)

Substrate auto-creation during the upload flow runs through
`recognizeGroupName` in `frontend/src/lib/uploadFlow.ts:259`. It tries three
filename patterns, all of which assume the lab's **`AI12`-style** substrate ID
(`[A-Za-z]{2,4}\d{2,3}` — 2–4 letters then 2–3 digits):

```
1. /(?:^|[_\-\s])([A-Za-z]{2,4}\d{2,3})(?=$|[_\-\s])/   → "AI12"
2. /^([A-Za-z]+\d+)/                                     → "Device01"
3. first separator-delimited token with a letter          → fallback
```

batch2's substrate IDs are **compound**: `B37_Ref_100uL_S3`, `B37_Bic_150uL_S12I`,
`B37_Ser_150uL_S31`, etc. The filename is
`0001_2026-04-09_17.54.13_Stability (JV)_B37_Ref_100uL_S3-1C.txt`.

- Pattern 1 finds no `LL DD`-style token (`B37` is 1 letter; `S3` is 1 letter+1 digit).
- Pattern 2 needs the string to *start* with letters, but batch2 names start with
  the `0001` sequence counter.
- Pattern 3 takes only `base.split(/[_\-\s]+/)[0]` = `"0001"`, which is numeric → rejected.

So **`recognizeGroupName` returns `null` for all 1351 real measurement files**.
The only files that yield anything are the stray aggregate exports:

| File | `recognizeGroupName` → |
|---|---|
| `JV Summary.txt` (×6, AEQ/LC × Summary/FW/RV) | `"JV"` |
| `T-PVK 1.68 V_1.6 M_AS 100 uL.txt` (UV-Vis, ×2) | `"T"` |

That single `"JV"` group is exactly the reported symptom. (`extractDeviceFromFilename`
in `Results.page.tsx:147` has the same three-pattern blind spot, but is masked
because `parseTxtContent` reads the authoritative `Device` header field from the file
*content* first — the upload-flow path only has file *names*, so it has no such fallback.)

Simulation artifacts: `recognizeGroupName` over batch → `{AI03…AI45, null:76}`;
over batch2 → `{"JV":6, "T":2, "null":1351}`.

### The reliable signal

Every CHOSE per-pixel export — in **both** batches — is named

```
<seq>_<date>_<time>_<Test>_<Device>-<cell><pixel>.txt
        e.g.  ..._Stability (JV)_AI12-1A.txt
              ..._Stability (JV)_B37_Ref_100uL_S3-1C.txt
```

and `<Device>-<cell><pixel>` is verbatim the file's `Device` header field
(`AI12-1A`, `B37_Ref_100uL_S3-1C`). The substrate is that value with the trailing
`-<cell><pixel>` stripped — which `parseDeviceName` (`Results.page.tsx:176`) already
does correctly for the compound case (`split("-")` → `["B37_Ref_100uL_S3","1C"]`).
The bug is purely that the *filename-only* recognizer never gets that far.

### Fix — `frontend/src/lib/uploadFlow.ts`

Generalize `recognizeGroupName` to parse the standardized CHOSE filename instead of
guessing an ID token:

1. Strip the extension. If the base contains one of the known measurement-type markers
   — `Stability (JV)`, `Stability (Tracking)`, `Stability (Parameters)`, `Dark JV`,
   `IPCE` — take everything **after** the last marker as `<Device>-<cell><pixel>`, then
   strip a trailing `-<digits><letter>` (`-1C`, `-1A`, …) → the substrate name.
   Preserve the raw device casing (do **not** `.toUpperCase()` compound names —
   `B37_Ref_100uL_S3` must stay readable and must match `parseDeviceName`/Results grouping).
2. Keep the current `AI##` fast path (pattern 1) as a fallback for hand-named files.
3. Return `null` for aggregate/summary files so they never seed a substrate:
   name matches `JV Summary` / `Summary_Parameters`, or the tail after the marker is
   empty. (The `JV Summary.txt` files must stop producing a `"JV"` substrate.)

Because the marker set is the same constant used by `parseTxtContent`, factor it into a
shared `const MEASUREMENT_MARKERS` (export from `uploadFlow.ts`, import in
`Results.page.tsx`) so the two recognizers can't drift.

Apply the same generalization to `extractDeviceFromFilename` (`Results.page.tsx:147`)
for the content-less fallback path, so drag-and-drop of raw files (no `Device` header)
groups batch2 identically.

### Known naming limitation to surface (not necessarily fix now)

batch2's IPCE lives under `Arkeo/…` with a **different** device convention —
`REF 100 uL S17 CD`, `REF_SAM_MEO_PET_KITO_LAB_2` (spaces, no `-pixel`, no `B37_`
prefix) — so it will **not** auto-group with the `Sun/…` JV/stability device names
(`B37_Ref_100uL_S3`). This is a data-entry mismatch at the instrument, not a code bug;
the recognizer should extract *a* clean group name from these too (strip the `IPCE_`
marker), but reconciling Arkeo-IPCE with Sun-JV needs either a name-normalization rule
the user defines or manual assignment in the Results substrate-matcher UI. Flag it;
don't silently mis-merge.

### Tests (frontend, unit-first)

Add to a `uploadFlow` spec: `recognizeGroupNames` over a representative batch2 filename
list → the ~40 `B37_*` substrates, and **no** `"JV"`/`"T"` groups; batch filenames still
→ `AI03…AI45`. Assert `recognizeGroupName("JV Summary.txt") === null`.

---

## Problem 2 — UV-Vis transmittance is a new measurement type

### The files

`batch2/Batch 37/UVVis/2026-04-09/T-PVK 1.68 V_1.6 M_AS {100,150} uL.txt`:

```
T-PVK 1.68 V_1.6 M_AS 100 uL - RawData      ← line 1: "<name> - RawData"
Wavelength nm. T%                            ← line 2: column header
300.0 0.1
301.0 0.1
…
1100.0 47.6
```

Space-separated, two columns (wavelength nm, transmittance %), **no** `## Header ##`
block, **no** `Device`/`Cell area`/`Test` fields. These are **film-level**
(whole-substrate) optical spectra, not per-pixel — the name encodes the solution/film
(`T-PVK 1.68 V_1.6 M_AS 100 uL`), so association is by film, not by `B37_*-<pixel>`.

baseclasses already ships the base section:
`baseclasses/solar_energy/uvvismeasurement.py` →
`UVvisMeasurement(BaseMeasurement)` with `measurements: SubSection(UVvisData, repeats)`,
where `UVvisData` carries `wavelength (nm)` + `intensity`. Transmittance goes in
`intensity` (document the unit in the section label/description). This mirrors exactly
how `LabEQEMeasurement` extends the EQE baseclass.

### A. `nomad-chose` — parse the raw file

**`src/nomad_chose/parsers/file_reading.py`**
- `detect_measurement_kind`: add a branch returning `'uvvis'` when
  `'Wavelength nm. T%' in text` (and `.txt`). Put it before the generic fallbacks;
  it has no `Test\t…` line so it won't collide with the existing `Test\t…` guards.
- New `build_uvvis_dict(text) -> dict`: take the film name from line 1
  (strip trailing `" - RawData"`), parse the two-column body into
  `wavelength` (nm) and `transmittance` (%, → `intensity`) arrays. Skip the two header
  lines; tolerate blank lines and either space or tab separation.

**`src/nomad_chose/schema_packages/schema_package.py`**
- New `LabUVvisMeasurement(UVvisMeasurement)` (import from
  `baseclasses.solar_energy.uvvismeasurement`), following `LabEQEMeasurement`:
  - `uvvis_file = Quantity(type=str, a_eln=FileEditQuantity, a_browser=RawFileAdaptor)`.
  - `normalize`: read `uvvis_file` through `archive.m_context`, call `build_uvvis_dict`,
    populate one `UVvisData(name=…, wavelength=…, intensity=…)`, set `datetime`/`name`
    from what's available, then `super().normalize`. Guard on missing file / empty data.

**`src/nomad_chose/parsers/parsers.py`**
- `ChoseParser.parse`: add `if kind == 'uvvis': seed(LabUVvisMeasurement()); .uvvis_file = basename`.
  (`is_mainfile`'s companion-archive skip already covers app uploads; the UV-Vis file
  has no stability sibling, so no change to `_stability_sibling`.)

Tests: a `file_reading` unit test on the real batch2 UV-Vis file → correct kind,
array lengths, first/last (wavelength, T%) pairs; a schema test that `normalize`
fills `measurements[0].wavelength/intensity`.

### B. `app` — recognize the file, generate the archive

**`frontend/src/store/AppContext.tsx`** — extend `MeasurementType` with `"UV-Vis"`.

**`frontend/src/routes/Results.page.tsx`**
- `parseTxtContent`: detect UV-Vis by content — line 2 `Wavelength nm. T%` (or line 1
  ending `- RawData`) → `measurementType = "UV-Vis"`. Because these files have no
  `Device` field, set `deviceName` from line 1's film name / filename; and because they
  are film-level, they attach to the **substrate**, not a pixel (no `-<cell><pixel>`
  tail — the substrate matcher should treat them as substrate-scoped).
- Add a color for `"UV-Vis"` in the type→color map (line ~664).
- The substrate-name matcher (`findSubstrateNamesInFile`) will not line up the film
  name with `B37_*` device names automatically — same naming-reconciliation caveat as
  Arkeo IPCE. Expect manual assignment; make sure an unmatched UV-Vis file lands in its
  own group rather than corrupting a device group.

**`backend/app/services/nomad.py`** (`create_nomad_archives`)
- Add `UVVIS_TYPES = {"UV-Vis"}`.
- `_measurement_archive`: add a branch emitting
  ```
  m_def: nomad_chose.schema_packages.schema_package.LabUVvisMeasurement
  name, operator, uvvis_file: raw_file, samples: [<ref>]
  ```
  Reference target: since UV-Vis is film-level, point `samples` at the **SubstrateSample**
  archive for the group (not a pixel sample). Confirm the SubstrateSample archive is
  emitted before measurement archives and its filename is resolvable here; if the
  current structure only has pixel-sample refs at this point, reference all pixel
  samples of the substrate, or thread the substrate archive name through.
- `_measurement_runs`: UV-Vis is a single-file run (no Parameters/Tracking pairing) —
  the default per-file path already handles it; just ensure it isn't dropped as
  "Document/Unknown".

### C. `nomad-perovskite-solar-cell-sample-plains` — overview plot

Per the user's instruction, wire UV-Vis at the **SubstrateSample** level and add it to
the overview builders created in the previous task.

**`src/…/utils.py`** — new `create_uvvis_overview_figure(measurements)`:
one line trace per measurement, `x = wavelength (nm)`, `y = intensity (transmittance %)`,
trace name = measurement name/film; `template='plotly_white'`, axis titles
`Wavelength (nm)` / `Transmittance (%)`; return `None` when nothing to plot — matching
the three existing `create_*_overview_figure` builders.

**`src/…/schema_packages/sample.py`**
- Import the UV-Vis section (`from baseclasses.solar_energy.uvvismeasurement import UVvisMeasurement`,
  or the `LabUVvisMeasurement` subtype — match on the base so hand-dropped files also count).
- `SubstrateSample.normalize` currently only mirrors device figures. Add a UV-Vis search
  the same way the device sample finds its measurements: `search(entry_references.target_entry_id == substrate.entry_id)`,
  keep hits `isinstance(entry, UVvisMeasurement)`, build `create_uvvis_overview_figure`,
  append to `self.figures` (labeled e.g. `UV-Vis transmittance (all films)`). This makes
  `SubstrateSample` a measurement-bearing entry, so it needs the same **level-3 parser**
  it already has — no new parser, but confirm the UV-Vis measurement (level ≤2) is
  processed before the substrate (level 3), which it is.
- Optionally also surface UV-Vis on `PerovskiteSolarCellSampleArea` if a device
  references one, via a fourth bucket in `_populate_jv_from_measurements` +
  `_build_figures`. The user asked specifically for the substrate; keep device-level
  optional.

Tests (unit, mirroring `tests/test_overview_figures.py` and
`test_measurement_population.py`): `create_uvvis_overview_figure` draws one trace per
film with % on y and nm on x, `None` when empty; a `SubstrateSample` whose search
returns a stub UV-Vis entry gains the UV-Vis figure; no UV-Vis → no figure.

---

## Verification

- **Unit**: frontend `uploadFlow`/Results recognizer specs; `nomad-chose`
  `file_reading` + schema tests; `sample-plains` overview + substrate tests.
  Run `sample-plains` via `PYTHONPATH=src /home/simon/nomad-chose/.venv/bin/python -m pytest tests/`.
- **Static**: `bun run lint` (frontend), `ruff check` on changed py files in both plugins,
  `bash ./scripts/generate-client.sh` only if backend schemas change (they don't here —
  `create_nomad_archives` emits dicts, not new API models).
- **Heavy / live (ASK FIRST, per standing instruction)**: import batch2 through the app
  → confirm ~40 `B37_*` substrates (no `"JV"` group), UV-Vis files recognized; upload to
  the Oasis → confirm `LabUVvisMeasurement` entries parse, the SubstrateSample shows a
  UV-Vis overview figure alongside the mirrored device plots. This needs the pin bumps +
  Oasis rebuild that are already pending from the overview-plots work and would ship
  together.

## Suggested sequencing

1. **Frontend grouping fix** (Problem 1) — self-contained, highest value, unblocks batch2
   import immediately; ship alone.
2. **UV-Vis** (Problem 2) — `nomad-chose` parse → `sample-plains` overview →
   `app` recognition/archive, in that dependency order, then the live check with the pin bumps.
