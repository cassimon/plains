# Scientific data flow

This document traces measurement data from the original instrument file through persistence,
analysis and export. It documents observed behavior only.

## Two experiment shapes

Plains supports two ways an experiment comes into existence, which shape how its data is
represented:

- **Designed experiment** — created from a `Process` (a fabrication recipe with stages, steps,
  substrates and generated stacks). It carries chemistry, substrates and processing times, and
  its start/end dates are derived from the Processing table's step times.
- **Imported experiment** — created directly from dropped measurement files with no process
  (`process_id = NULL`). It has no recipe; the measurements and their original files are the
  primary data.

Both converge on the same `ExperimentResults` → `MeasurementFile` model.

## Designed-experiment workflow

1. Create a **Process**: solution chemistry (optional, can be skipped), substrate preparation,
   and wet-deposition stages with alternative steps; generate stacks.
2. Spawn an **Experiment** from the process; name substrates; fill the Processing table (step
   dates/times); answer the parameter-variation question; confirm the summary.
3. Drop measurement files onto the experiment (or its collection); Plains starts the upload
   flow and links the results to the experiment.

The experiment's `date`/`end_date` are **derived**, not edited directly: they are the first
step's start and the end-of-experiment cell in the Processing table
(`lib/processingTimes.ts` → `computeProcessingTimeRange`). The Summary tab shows them read-only.

## Imported-experiment workflow

1. Drop individual files, a directory, or a ZIP archive onto the Organization canvas or the
   Results drop zone.
2. Plains parses the measurements (forward/reverse JV scans), groups them by device, and shows
   them for review — no process is required.
3. Assign device groups to substrates, move measurements between groups, and exclude files you
   do not want.
4. Confirm the review; measurements are persisted and can be prepared for NOMAD.

## ZIP exploration and parsing

Individual files, directories and ZIP archives all produce identical measurements, because the
backend exposes one scientific parser (`backend/app/services/zip_import.py`) used by every
ingestion path.

- `extract_importable_measurements(bytes)` opens a ZIP, walks its entries, and parses the
  recognized CHOSE instrument files. `parse_jv_file(text)` reads a `## Header ##` /
  `## Data ##` file: `[General info]` key/value pairs, tab-delimited FW/RV summary rows
  (`Voc`, `Jsc`, `Vmpp`, `Jmpp`, `Pmpp`, `Rs`, `Rsh`, `FF`, `Efficiency`), and the raw
  `V_FW (V) / J_FW (mA/cm²) / V_RV (V) / J_RV (mA/cm²)` sweep into `curve_fw`/`curve_rv`.
  Curve points are never synthesized from summary metrics.
- A summary file can carry rows that are already covered by an original JV file; those are
  deduplicated by batch + basename + direction so they are not imported twice.
- Recognized formats include CHOSE `Stability (JV)`, directional `JV Summary_Parameters FW/RV`,
  Dark JV, IPCE, Stability Parameters/Tracking and UV-Vis (see `classify_entry` and the client's
  lightweight scanner in `lib/parseMeasurements.ts` for the formats the structured parser does
  not cover).
- ZIP safety is enforced during import (path traversal and zip-bomb limits in
  `services/zip_import.py`).

## Measurement identity and original-file provenance

Each measurement is identified and traced back to its source:

- **Device/cell/pixel** are parsed from the file and device label (`parse_device_identifier`).
  `substrate_group` is the substrate-level identifier (pixel stripped).
- **`source_file_id`** points to an `ImportedSourceFile` row — the durable original file.
- **`source_record_locator`** identifies the record within that source: the scan direction, plus
  the filename when a summary row's `file` differs from its `source`.

The original bytes are stored once per source under an internal UUID in the
`source_files` volume (`services/source_store.py`). The row records the original relative path,
basename, size and SHA-256; nothing trusts a user-supplied path as a filesystem location. Bytes
are removed by the caller only **after** the deleting database transaction commits, so a
rolled-back delete can never strand a row without its bytes.

## Corrections, exclusions and restoration

- **Corrections** (`POST /results/{id}/corrections`) are `scale` (a metric × factor),
  `edit` (device_name/cell/pixel_label/measurement_date/measurement_user),
  `exclude` and `restore`. Each is appended to the `MeasurementCorrection` history with the
  previous and new value, a reason, the actor and a `request_id` (idempotency — a repeated
  request with the same key is rejected).
- A corrected field is recorded in the measurement's `corrected_fields`, so snapshot saves never
  overwrite an authoritative corrected value with a stale pre-correction one.
- **Exclusion** marks a measurement `excluded`; it is kept (never silently dropped) but does not
  contribute to analysis or export. Excluded observations are listed in the export manifest.
- **Partial FW/RV exclusion is blocked** when both scan directions share one source: the raw
  file re-derives both, so one direction cannot be excluded while the other is accepted.
- Corrected scalar metrics are also blocked from NOMAD preparation when the corrected value
  would disagree with the unchanged raw file.

## JV metrics, units and validity

JV measurements carry these scalar metrics (units as used in the UI and the export manifest):

| Metric | Field | Unit |
|---|---|---|
| Power conversion efficiency | `value` (PCE) | % |
| Open-circuit voltage | `voc` | V |
| Short-circuit current density | `jsc` | mA/cm² |
| Fill factor | `ff` | % (0–100 internally) |
| Max-power voltage | `vmpp` | V |
| Max-power current density | `jmpp` | mA/cm² |
| Max-power density | `pmpp` | mW/cm² |
| Series resistance | `rs` | Ω |
| Shunt resistance | `rsh` | Ω |

`illumination_intensity` is recorded in mW/cm² (defaults to 1 sun when the instrument file does
not state it).

Metric validity (`lib/analysis.ts` `isMetricValid`, mirroring `lib/quality.ts`): non-finite
values are invalid for every metric; PCE must be ≥ 0; FF must be in 0–100 %. Contextual warnings
never invalidate a value; physically impossible values do. Legitimate zeros are preserved.

> **Fill factor unit:** internally Plains stores FF as a percentage (0–100). For NOMAD it emits
> the fraction (0–1) that the `nomad-perovskite-solar-cells-database` JV schema expects —
> `services/nomad.py` `_fill_factor_fraction` always divides by 100 (the schema's
> `reverse_scan_FF`/`forward_scan_FF` are defined as "a value between 0 and 1").

## Descriptive statistics and analysis

`frontend/src/lib/analysis.ts` provides the deterministic, pure analysis functions used by the
Analysis page. They operate on **effective (corrected)**, non-excluded JV values.

- **Descriptive statistics** (`descriptiveStats`): n, min, Q1, median, mean, Q3, max, sample
  standard deviation (n − 1, only when n ≥ 2) and IQR. Quartiles use linear interpolation
  (`percentile`). Box plots draw box = Q1..Q3, line = median, whiskers = min..max — outliers are
  kept and individually inspectable, never hidden by fences.
- **Hysteresis** (`hysteresisPct`): HI (%) = 100 × (PCE_RV − PCE_FW) / PCE_RV, requiring a
  valid pair and a strictly positive RV denominator.
- **Pearson correlation** (`pearson`): requires at least three complete pairs and non-zero
  variance in both variables.
- **FW/RV pairing** (`pairFwRv`): pairs by durable source identity; a source must carry exactly
  one FW and one RV candidate (regardless of exclusion) to be unambiguous — excluding one of
  several candidates does not resolve the ambiguity.
- **Paired differences** (`pairedDifferences`): RV − FW for a metric over unambiguous valid
  pairs.
- **Histogram** (`histogram`): fixed-width bins over finite values.

## Local scientific export

`GET /export/experiments/{experiment_id}` returns a self-contained ZIP of the *accepted*
scientific dataset plus durable provenance. The archive contains:

| Member | Contents |
|---|---|
| `measurements.csv` | Effective (corrected) scalar metrics for accepted measurements; `value` is populated only for JV records. |
| `curves.csv` | Original raw curve points (`voltage_v`, `current_density_ma_cm2`) for accepted observations, in order. |
| `corrections.csv` | Traceable correction history (field, operation, previous/new value, reason, created_at) without personal information. |
| `originals/` | The unchanged original source files (SHA-256-verified at export time). |
| `manifest.json` | Units, measurement/excluded counts, excluded measurements, source-file metadata, correction count. |

Excluded observations are documented in the manifest but never appear in the accepted
measurement/curve tables. A missing or corrupted (SHA-256-mismatched) source aborts the export
with a 409 rather than producing an incomplete archive.
