# Plan: populate the NOMAD data schema from CHOSE measurement files

Goal: every number in the instrument files reaches the NOMAD schema; JV/EQE/stability
entries plot inside NOMAD; and `results.properties.optoelectronic.solar_cell`
("Solar Cell Properties") is populated — as in `nomad-hysprint`.

## 0. Diagnosis (measured, not assumed)

Running the *current* `LabJVMeasurement.normalize()` over
`tests/data/0001_2025-11-20_17.32.31_Stability (JV)_AI03-1A.txt`:

```
jv_curve (what JVMeasurement.normalize reads): 0
results  (what nomad-chose writes to)       : 2
active_area: None | intensity: None
datetime   : 2026-07-13  (today — not the file's 2025-11-20 17:32:39)
Solar Cell Properties: EMPTY
```

while the file parses perfectly well:

```
header: {'user': 'FDN', 'device': 'AI03-1A', 'cell area (cm2)': '0.09',
         'date': '2025-11-20', 'time': '17:32:39', 'note': 'SMU 1A'}
curve FW: Voc=0.530612 V  Jsc=15.754854 mA/cm²  FF=0.2538  eff=2.12  (33 pts)
curve RV: Voc=0.539999 V  Jsc=20.841486 mA/cm²  FF=0.3261  eff=3.67  (34 pts)
```

NOMAD prints the root cause itself at import time:

> `SolarCellJV(...) is not derived from its definition ...Measurement.results:SubSection`

### The five defects

1. **JV data is written to the wrong subsection.** `LabJVMeasurement.normalize` does
   `self.results = [SolarCellJV, ...]`. But `JVMeasurement.normalize` (baseclasses)
   iterates **`self.jv_curve`** (`SolarCellJVCurveCustom`, repeating) to find the best
   curve and copy Voc/Jsc/FF/efficiency/illumination into
   `archive.results.properties.optoelectronic.solar_cell`. `jv_curve` is never filled, so
   that block never runs. **This single defect explains "areas not set", "illumination
   not set", "Solar Cell Properties empty" and "JV population in the sample class
   fails"** — the sample plugin's `_populate_from_jv()` also reads `measurement.jv_curve`.
2. **The header is parsed and then thrown away.** `parse_measurement_metadata()` already
   returns `[General info]`, but neither the parser nor any `normalize()` writes it to the
   schema. `active_area`, `intensity`, `integration_time`, `settling_time`, `averaging`,
   `compliance`, `datetime`, `operator` all stay `None`. It also stops reading at
   `[JV Settings]`, so scan settings and `[Cell Settings]` are never even captured.
3. **Stability invents parallel quantities.** `LabStabilityMeasurement` declares
   `time_hours`, `tracking_voltage`, `tracking_power`… instead of filling `MPPTracking`'s
   native `time` (s), `voltage`, `current_density`, `power_density`, `efficiency`.
   `MPPTracking.normalize` uses the native ones to compute `StabilityFiguresOfMerit`
   (T80/T95/Ts80/Ts95) **and to build its PlotlyFigure** — so we get neither.
4. **EQE never runs its own analysis.** `SolarCellEQECustom.normalize()` computes
   `bandgap_eqe`, `integrated_jsc`, `voc_rad`, `urbach_energy` — Hysprint calls it
   explicitly per entry; nomad-chose does not. The `J device` / `J integrated` columns are
   dropped too.
5. **No plots.** Hysprint gets NOMAD-internal plotting declaratively, via `a_plot` on the
   section `m_def`. None of the CHOSE classes has one.

### The one datum that exists nowhere

**Illumination intensity is in no test file and in no app field.** The `.csv` JV variant
has a `light_intensity` header key (`parse_jv_csv` reads it), but the `.txt` instrument
exports do not. `_build_jv_result` hardcodes `light_intensity=100.0` — which is then
discarded with the rest of `results`. See "Decisions" below.

---

## 1. `nomad-chose` — laboratory-specific parsing

### 1a. `parsers/file_reading.py`

* Generalise header parsing: return **all** bracket sections, not just `[General info]`
  (`[JV Settings]`, `[Cell Settings]`, `[Tracking Settings]`, `[Acquisition Settings]`,
  `[Device Settings]`), keyed by section. Keep the existing `## Data ##` table reader.
* Add `build_jv_dict(text, filename)` producing exactly the dict
  `baseclasses.helper.archive_builder.jv_archive.get_jv_archive()` consumes — this is the
  contract Hysprint uses, so we inherit its behaviour for free:

  | jv_dict key | source in the CHOSE file |
  |---|---|
  | `datetime` | `Date` + `Time` |
  | `active_area` | `Cell area (cm2)` |
  | `intensity` | see Decisions (not in file) |
  | `averaging` | `[JV Settings] Averaging` when present |
  | `jv_curve[]` | `{name: 'FW'/'RV', voltage: V_FW/V_RV, current_density: J_FW/J_RV}` |
  | `V_oc`, `J_sc` | summary `Voc`, `Jsc` |
  | `Fill_factor` | summary `FF` (**percent** — `get_jv_archive` applies ×0.01) |
  | `Efficiency` | summary `Eff` |
  | `U_MPP`, `J_MPP` | summary `V_MPP`, `J_MPP` |
  | `R_ser`, `R_par` | summary `Rs`, `R//` (**unit change** — see Decisions) |

  `V_MPP`, `J_MPP`, `Rs`, `R//` are parsed today and then dropped on the floor; this
  recovers them.
* Keep the scan settings (`Vmin`, `Vmax`, `Voltage Step`, `Scan Rate`, `Scan direction`,
  `Auto-detect Voc`, ranges) and `[Cell Settings]` (`Tipology`, `#Cells`, `W cell area`)
  in a side dict — they belong on the *sample's* `JV` section (§2), not on `JVMeasurement`.
* Stability: return native-unit arrays — `time` in **seconds** (file is hours),
  `power_density` mW/cm², `voltage` V, `current_density` mA/cm², plus `efficiency`
  (derivable, or from the Parameters table).
* IPCE: also read `J device (mA/cm2)` and `J integrated (mA/cm2)`; return the
  `[Acquisition Settings]` / `[Device Settings]` values and `Temperature`.

### 1b. `schema_packages/schema_package.py`

* **`LabJVMeasurement`**
  * Replace `self.results = ...` with `get_jv_archive(jv_dict, self.jv_file, self)`.
    Delete the `results` assignment entirely.
  * Set `datetime`, `operator` (`User`), `description` (`Note`), and the device id
    (`Device` → `lab_id`) from the header.
  * Add the Hysprint plot annotation to `m_def`:
    ```python
    a_plot=[{'x': 'jv_curve/:/voltage', 'y': 'jv_curve/:/current_density',
             'layout': {'showlegend': True,
                        'yaxis': {'fixedrange': False},
                        'xaxis': {'fixedrange': False}}}]
    ```
  * One new `SubSection` — `ChoseJVSettings` (Vmin, Vmax, voltage step, scan rate, scan
    direction, auto-detect Voc, voltage/current range, inverted, auto-range, typology,
    cells, wide-cell area). These have no home in `JVMeasurement`; a single flat section
    keeps the hierarchy addition minimal while losing nothing.
* **`LabStabilityMeasurement`**
  * Fill `time` / `voltage` / `current_density` / `power_density` / `efficiency` (the
    `MPPTracking` natives) and `properties = MPPTrackingProperties(time=<test duration>,
    perturbation_voltage=<dV track>)`; then call `super().normalize()` **last** so
    baseclasses computes `StabilityFiguresOfMerit` (T80/T95) and emits its PlotlyFigure.
  * Drop the redundant `time_hours` / `tracking_*` quantities (keep aliases if any archive
    already uses them).
  * The Parameters table (Voc/Jsc/FF/Eff for FW *and* RV **over time**) has no upstream
    home → one new repeating-array section `StabilityJVParameters` with an `a_plot` of
    efficiency-vs-time. Also add `a_plot` for `power_density` vs `time`.
* **`LabEQEMeasurement`**
  * Call `entry.normalize(archive, logger)` on each `SolarCellEQECustom` → `bandgap_eqe`,
    `integrated_jsc`, `voc_rad`, `urbach_energy`.
  * Map `Bias Voltage (V)` → `light_bias` (exists upstream); add `temperature` and the
    acquisition settings (acquisition time, averaging, delay, LED level, chopper
    frequency, ranges) as a small `ChoseEQESettings` subsection.
  * `a_plot` on `eqe_data/:/photon_energy_array` vs `eqe_data/:/eqe_array`.

### 1c. `parsers/parsers.py`

`ChoseParser` currently sets only `name`, `<x>_file`, `operator`. Pass the parsed header
through so that entries created by *file matching* (not just by our uploaded YAML) get
`datetime`, `active_area`, `lab_id` too. Same code path, one call.

---

## 2. `nomad-perovskite-solar-cell-sample-plains` — the app↔NOMAD schema

`_populate_jv_from_measurements()` is already correct in structure and will start working
the moment §1 lands. Extend it to stop discarding the rest:

* **`_populate_from_jv`** — today only `default_PCE/Voc/Jsc/FF`. Add, from the FW/RV
  curves, which map 1:1 onto the upstream `JV` section:
  `forward_scan_Voc/Jsc/FF/PCE/Vmp/Jmp/series_resistance/shunt_resistance` and the
  `reverse_scan_*` twins; `hysteresis_index` (from FW vs RV PCE); `scan_speed`,
  `scan_voltage_step` (from `ChoseJVSettings`); `light_intensity`; `test_temperature`.
  Also set `default_*_scan_direction`.
* **`_populate_from_eqe`** — currently dead code: it probes `measurement.temperature` and
  `measurement.light_intensity`, **neither of which exists on `EQEMeasurement`**, so both
  `hasattr` checks are always false. Rewrite to populate the sample's own `eqe` subsection
  (`bandgap_eqe`, `integrated_jsc`, `eqe_array`/`photon_energy_array`, `urbach_energy`)
  and feed `jv.test_temperature` from the new EQE `temperature`.
* **`_populate_from_mppt`** — currently only a fallback `default_PCE`. Populate the
  `stability` subsection (`PCE_T80` and `PCE_end_of_experiment` from
  `StabilityFiguresOfMerit`, `time_total_exposure`) and `stabilised`
  (`performance_PCE`, `performance_measurement_time`).
* Precedence rule to make explicit and test: **measured values (parsed in NOMAD) win over
  the app-supplied seeds**; app values only fill what no measurement provides.

---

## 3. The app (`plains`)

* `backend/app/services/nomad.py`, `_measurement_archive()`: emit `active_area` (from
  `deviceArea`) and `intensity` on each measurement archive, so the schema is populated
  even for file formats whose header lacks them. File-derived values take precedence in
  the plugin.
* `_jv_section()` keeps writing `default_*` as a **seed** (used when NOMAD-side parsing
  yields nothing), unchanged in shape.
* **New GUI field: illumination intensity** (Results page, per measurement or per
  experiment), default `100 mW/cm²`. This is the only quantity that exists in neither the
  files nor the app.

---

## 4. Field-coverage matrix (from `/home/simon/nomad-chose/tests/data`)

| File | Field | Lands in |
|---|---|---|
| Stability (JV) | User / Device / Note / Date+Time | `operator` / `lab_id` / `description` / `datetime` |
| | Cell area 0.09 | `JVMeasurement.active_area`, sample `cell.area_measured` |
| | FW+RV Voc, Jsc, V_MPP, J_MPP, FF, Eff | `jv_curve[].*` → Solar Cell Properties → sample `jv.forward/reverse_scan_*` |
| | Rs, R// | `jv_curve[].series_resistance` / `shunt_resistance` |
| | V_FW/J_FW, V_RV/J_RV arrays | `jv_curve[].voltage` / `.current_density` (+ the NOMAD plot) |
| | Vmin/Vmax/step/scan rate/direction | `ChoseJVSettings` → sample `jv.scan_speed`, `jv.scan_voltage_step` |
| | Tipology / #Cells / W cell area | `ChoseJVSettings`, sample `cell.number_of_cells_per_substrate` |
| Stability (Tracking) | Time/Voltage/Current Density/Power | `MPPTracking.time/voltage/current_density/power_density` → T80/T95 + figure |
| | Algorithm, dV track, delay, JV interval, duration | `MPPTrackingProperties` |
| Stability (Parameters) | Voc/Jsc/FF/Eff FW+RV vs time | `StabilityJVParameters` (+ plot); `stability.PCE_end_of_experiment` |
| IPCE | Wavelength / IPCE | `eqe_data[]` → `bandgap_eqe`, `integrated_jsc`, `urbach_energy` (+ plot) |
| | J device, J integrated | `eqe_data[]` (currently dropped) |
| | Temperature 25.57 | `jv.test_temperature` |
| | Bias Voltage | `SolarCellEQE.light_bias` |
| | Acquisition/Device settings | `ChoseEQESettings` |

---

## 5. Verification

* A harness already exists in scratch: load each file in `tests/data` through the real
  plugin venv, `normalize()`, and assert — `jv_curve == 2`, Solar Cell Properties non-empty
  and equal to the RV curve (best efficiency 3.67 %), `active_area == 0.09 cm²`,
  `datetime == 2025-11-20T17:32:39`, `figures` non-empty, `bandgap_eqe` computed, `T80`
  computed. This is the regression suite for §1.
* Plugin unit tests: extend `nomad-chose/tests/parsers/*` and
  `sample-plains/tests/schema_packages/test_jv_population.py`.
* App: extend `backend/tests/services/test_nomad_metadata_generation.py`.

## 5b. Two data bugs found while implementing

Both were silently corrupting values; both are now covered by tests.

1. **The Stability (Parameters) RV block was shifted by one column.** The data rows
   carry *20* fields but the header names only *19* — the instrument writes a second,
   unnamed `Time (Hours)` column at the start of the RV block. Reading RV columns by
   header position therefore returned R// as the fill factor and the FF as the
   efficiency. Cross-checked against the Stability (JV) export, whose RV summary row
   independently states the same numbers. See `_parameter_indices`.
2. **The tracked efficiency must keep the sign of the power.** A fixed-voltage track
   opens *above* Voc (1.4 V, vs this cell's Voc of 0.54 V), where the cell is driven and
   consumes power (P = −17.57 mW/cm²). Taking `abs()` reported that as a **+17.57 %**
   efficiency — against the cell's actual 3.67 % PCE — and it propagated into the
   sample's stabilised PCE. The sign is now preserved, and the sample only accepts a
   power-*delivering* point as a stabilised PCE.

## 6. Decisions (settled)

1. **Illumination intensity** — default **100 mW/cm² (1 sun, AM 1.5G)**, overridable from a
   new GUI field. Precedence: file header (`.csv` `light_intensity`) → app-supplied value →
   100 mW/cm² default.
2. **Rs / R//** — area-normalise: `R[Ω·cm²] = R[Ω] × active_area[cm²]`, using the cell area
   from the file header (0.09 cm²).
