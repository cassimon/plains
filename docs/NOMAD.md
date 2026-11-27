# NOMAD preparation and upload

Plains prepares research data for deposition in [NOMAD](https://nomad-lab.eu/) and, when
configured, uploads it. This document distinguishes **local preparation** (always available),
**mocked verification** (used for isolated testing), and **real deposition** (requires a
reachable NOMAD Oasis and credentials).

## Scope of verification

The acceptance of this application exercised **local archive preparation** and **mock-mode
upload** end to end. Real deposition against a live NOMAD Oasis was **not** performed as part
of that work. Everything below that concerns real deposition describes the implemented
behavior, not an observed real-NOMAD result.

## Preparation (local, no NOMAD needed)

Building the archive and its YAML metadata does not contact NOMAD:

- `services/nomad.py` `create_nomad_metadata_yaml(...)` generates one sample archive per
  substrate/device group plus one measurement archive per measurement file, using two schema
  packages:
  - `nomad_chose.schema_packages.schema_package.*` for measurements —
    `LabJVMeasurement`, `LabEQEMeasurement`, `LabUVvisMeasurement`, `LabStabilityMeasurement`.
  - `nomad_perovskite_solar_cell_sample_plains.schema_packages.*` (a Plains-specific package)
    for `SubstrateSample`, `PerovskiteSolarCellSampleArea`, `DepositionRoutine`, and the
    material/solution entries.
- `POST /nomad/metadata/preview` returns the generated YAML (`yaml_files`) and the raw file list
  (`all_files`) for inspection before upload.
- The measurement archive is named `<raw filename>.archive.yaml`, which is load-bearing:
  `nomad_chose`'s `ChoseParser` skips a raw file that has an adjacent `.archive.yaml`, so the
  app's richer entry is the only one parsed for that measurement.
- Reference schemas live in `backend/app/nomad/data_schemas/` (`working_extend.archive.yaml`,
  `perovskite_solar_cell.json` and the numbered `.archive.yaml` examples).

### Upload flow endpoints

| Endpoint | Purpose |
|---|---|
| `POST /nomad/upload/files` | Stage measurement files; returns an `archive_path`. |
| `POST /nomad/upload/metadata` | Attach process/experiment metadata to the archive. |
| `POST /nomad/metadata/preview` | Preview the generated YAML + raw files. |
| `POST /nomad/upload/nomad` | Upload the archive to NOMAD. |
| `GET /nomad/upload/{id}/status` | Poll NOMAD's processing status. |
| `POST /nomad/imported/prepare` | Server-side preparation of an imported experiment from authoritative DB state (resolves original bytes; no manual re-upload). |

### Prerequisites for preparation

- The experiment must have results with measurements.
- `POST /nomad/imported/prepare` blocks (with a clear explanation) when a deposition cannot be
  represented safely: a partial FW/RV exclusion sharing one source, or a corrected scalar that
  would disagree with the unchanged raw file.

### Prerequisites for upload

- A user authorized for NOMAD uploads: when `NOMAD_OAUTH_ENABLED` is set, an OAuth-linked user
  (`nomad_sub`) or a superuser; otherwise any authenticated user.
- NOMAD credentials from the out-of-repository auth file (`NOMAD_AUTH_FILE`, default
  `../sensitive config/.nomad_auth`), read at startup. See `backend/app/core/config.py`.

## Mock mode

`NOMAD_MOCK_MODE=true` (used by the isolated test stack) makes `upload_to_nomad` return a fake
`MOCK_…` upload id with `PENDING` status instead of contacting NOMAD. It logs what would have
been sent. This exercises the full archive-construction and upload-flow code paths without any
external dependency.

## Real deposition behavior

When mock mode is off, `upload_to_nomad` streams the archive to NOMAD
(`POST /uploads`, or `PUT /uploads/{id}` to add to an existing upload) with a token obtained
from `get_nomad_token`. NOMAD returns `PENDING` first; the verdict is not known at upload time.
The Results page polls `GET /nomad/upload/{id}/status` (every 5 s while open) and updates the
log row. On `SUCCESS` the stash is deleted; on failure it is kept with NOMAD's error notes.

Every upload is recorded in the `nomad_upload_log` table and shown to superusers in
**Admin → NOMAD Uploads**; a failed upload's exact archive is downloadable for one week
(`NOMAD_STASH_MAX_AGE_S`). See [nomad-upload-debugging.md](nomad-upload-debugging.md).

## Genuine compatibility limitations

- **Schema plugin dependency.** The sample/chemical archives reference the custom
  `nomad_perovskite_solar_cell_sample_plains` package, and the measurement archives reference
  `nomad_chose`. The target NOMAD Oasis must have both plugins installed for the deposited
  entries to be recognized. A missing plugin surfaces as a NOMAD processing failure, not a
  client-side error.
- **`PENDING` first.** NOMAD's processing verdict is asynchronous; upload success cannot be
  confirmed at request time and requires polling.
- **Fill-factor unit.** The archive emits FF as a fraction (0–1), per the NOMAD JV schema; see
  [SCIENTIFIC.md](SCIENTIFIC.md).
- **Mock is not real.** Mock mode validates archive construction and flow wiring only; it does
  not exercise NOMAD's parser or schema validation.
