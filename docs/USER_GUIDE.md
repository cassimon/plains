# Plains — User Guide

Plains is a lab notebook for perovskite solar cell research. It helps you organize
experiments, record measurement results and prepare data for NOMAD.

This guide is for people who use the app, not for developers.

---

## 1. What Plains is for

- **Organize** your work into planes and collections.
- **Plan** fabrication steps as Processes and generate Experiments from them.
- **Import** existing measurement files (JV Summary) into experiments.
- **Review** results (JV metrics) and prepare them for NOMAD.

## 2. Starting from scratch

The app has a vertical icon bar on the left. The main sections are:

- **Organization** — your canvas of planes and collections.
- **Import** — bring measurement files into Plains.
- **Processes** — define fabrication steps.
- **Experiments** — experiments generated from processes (or imported).
- **Results** — measurement files and their values.
- **Analysis** — plots (coming soon).
- **Export** — export/upload (coming soon).

## 3. Importing existing experimental data

If you already have measurement files (for example a JV Summary export from an
instrument), you can import them directly:

1. Click **Import** in the left bar.
2. Click **Choose ZIP archive** and pick your `.zip` file.
3. Plains shows what it recognized and a preview of the files.
4. Choose **New experiment** (type a name) or **Existing experiment**.
5. Optionally choose a **Plane** and a **Process** to organize the new
   experiment (you can leave them unassigned).
6. Click **Preview import** to see the values, then **Confirm import**.
7. Click **Open Results** to see the imported measurements.

You do **not** need to create a Process first. Imported measurements are saved
under a new experiment with no fabrication process unless you choose one.
Measurements are grouped per device (one group per measurement file).

## 4. What Organization, Process, Experiment and Results mean

- **Organization (plane)**: a canvas where you arrange your work. Planes can be
  shared with collaborators.
- **Process**: a recipe of fabrication steps (materials, solutions, processing).
- **Experiment**: one run of a process, with substrates and dates.
- **Results**: the measurement files (and their JV values) linked to an experiment.

## 5. Inspecting and finding results

Open **Results** and select the experiment you want. You will see the list of
measurement files with their type and, for JV files, their values (Voc, Jsc, FF,
efficiency). Forward (FW) and reverse (RV) scans are shown separately.

## 6. Saving work and recognizing errors

Plains saves your work automatically (with a short delay). If a save fails, the
app keeps your changes and retries — do not close the tab until the work is saved.
Watch for red error messages at the top or next to the fields.

## 7. Current ZIP format limitations

The first importer supports **JV Summary** files:

- `JV Summary_Parameters FW.txt`
- `JV Summary_Parameters RV.txt`

These are tab-delimited files with columns for `File`, `Voc`, `Jsc`, `FF` and
`Eff`. Other formats (Stability JV/Parameters/Tracking, UV-Vis) are currently
recognized but **not** imported.

## 8. Trying the example

There is a small synthetic example archive (fictional data) available inside the
app on the Import page: click **Download example ZIP**, then follow the import
steps above. It contains two fake devices (`SAMPLE-DEVICE-01` and
`SAMPLE-DEVICE-02`) with FW and RV scans.

## 9. Where to find further help

- In-app: the **Help** entry in the user menu (top-right).
- For data mapping and limits, see the technical docs in the repository
  (`docs/`, `workbench/reports/`).
