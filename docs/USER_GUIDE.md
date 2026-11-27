# Plains — User Guide

Plains is a lab notebook for perovskite solar cell research. It helps you organize
experiments, record measurement results and prepare data for NOMAD.

This guide is for people who use the app, not for developers.

---

## 1. What Plains is for

- **Organize** your work into planes and collections.
- **Plan** fabrication steps as Processes and generate Experiments from them.
- **Ingest** measurement files (individual files, folders or ZIP archives) into experiments.
- **Review** results (JV metrics) and prepare them for NOMAD.

## 2. Starting from scratch

The app has a vertical icon bar on the left. The main sections are:

- **Organization** — your canvas of planes and collections.
- **Processes** — define fabrication steps.
- **Experiments** — experiments generated from processes (or imported).
- **Results** — measurement files and their values.
- **Analysis** — descriptive statistics, group comparisons, correlation and hysteresis plots.
- **Export** — download an experiment's data locally, or prepare/upload it to NOMAD.

## 3. Importing existing experimental data

If you already have measurement files (individual files, an extracted directory,
or a ZIP archive from the instrument), bring them into the native Results
workflow:

1. Open **Results** and select (or create) the experiment.
2. Drop the files, folder or `.zip` archive onto the Results drop zone.
3. Plains parses the measurements (including forward/reverse JV scans), groups
   them by device and shows them for review.
4. Assign device groups to substrates, move measurements between groups, and
   exclude any files you don't want.
5. Confirm the review; the measurements are saved and can be prepared for NOMAD.

ZIP archives are expanded automatically; their original files are kept available
for NOMAD preparation. You do **not** need to create a Process first.

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

## 7. Supported measurement formats

CHOSE ``Stability (JV)`` files (structured header + FW/RV data) and directional
``JV Summary_Parameters FW/RV.txt`` files are parsed with full device, cell and
pixel identifiers. Other formats (Dark JV, IPCE, Stability Parameters/Tracking,
UV-Vis) are also recognized.

## 8. Where to find further help

- In-app: the **Help** entry in the user menu (top-right).
- For data mapping, scientific conventions and limits, see the technical docs in the repository
  (`docs/ARCHITECTURE.md`, `docs/SCIENTIFIC.md`, `docs/NOMAD.md`).
