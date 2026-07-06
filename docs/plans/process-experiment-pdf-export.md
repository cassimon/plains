# Plan: Migrate Process / Experiment export to `pdf-lib` (editable form PDFs)

**Status:** Proposed
**Scope:** Export only. The matching import flow is specified separately in
[`process-experiment-pdf-import.md`](./process-experiment-pdf-import.md) and is **not** part of this plan.

---

## 1. Goals

1. Replace the current **jsPDF** Process protocol export and **delete the DOCX** export entirely
   (`frontend/src/lib/processExport.ts`).
2. Replace the Experiment summary **`.txt` and `.csv`** exports
   (`Experiments.page.tsx` → `buildExportText` / `buildExportCsv` / the two download buttons) with a
   single **PDF** export that mirrors the Process export.
3. The PDF must be **nicely readable** for humans **and** carry **machine-readable app identifiers**
   (`process.id`, `experiment.id`, referenced entity ids) so that a later import can attach uploaded
   measurement data to the correct Process/Experiment automatically. The machine readable parts should be gray and unremarkable, as they are just for the admin.
4. **All important quantities are AcroForm form fields** the user can edit in any PDF viewer.
5. Every exported PDF embeds a **versioned, canonical serialization** of the Process / Experiment
   "class". A `PDF_SCHEMA_VERSION` is bumped whenever the serialized shape changes, enabling
   **downward compatibility** (a newer app can still read an older PDF via migrations).
6. For the **Experiment** PDF, the user may optionally prepend the **full Process protocol** pages
   before the experiment-specific pages.

## 2. Why this is non-trivial

`jsPDF` gave us `doc.text`, `doc.splitTextToSize`, auto page cursor, `doc.save`. `pdf-lib` is
lower-level: you draw glyphs at absolute coordinates on a `PDFPage`, measure with
`font.widthOfTextAtSize`, add pages manually, and create form-field widgets explicitly. So the
migration is mostly **porting the existing layout engine** in `processExport.ts`
(`renderPdfFromModel`, `drawPdfTable`, `writeTitle/…/writeNote`) onto `pdf-lib` primitives, then
adding form fields + the embedded payload. **The data-model layer stays:** `buildProcessExportModel`
and its model types are reused as-is; we only rewrite the rendering half.

---

## 3. Dependency changes

`frontend/package.json`:

- **Add** `pdf-lib` (`^1.17.1`), and `@pdf-lib/fontkit` only if we later embed a custom TTF for
  Unicode (µ, °, ², ×). Start with pdf-lib's built-in `StandardFonts.Helvetica` and map the handful
  of non-Latin-1 glyphs we use (`µ`, `°`, `²`, `×`, `—`, `•`) to safe equivalents — see §7.
- **Remove** `docx` and `jspdf` from `dependencies` once no import references remain.
- `bun install`, verify `bun run lint` and the bundle build.

---

## 4. New module: versioned serialization (`frontend/src/lib/pdfSchema.ts`)

This is the heart of forward/backward compatibility. It owns:

```ts
export const PDF_SCHEMA_VERSION = 1  // BUMP on any change to the serialized shape below

export type SerializedProcess = { schemaVersion: number; kind: "process"; process: Process; refs: EntityRefs }
export type SerializedExperiment = {
  schemaVersion: number; kind: "experiment"
  experiment: Experiment; process: Process; refs: EntityRefs
}
```

- `serializeProcess(process, refs)` / `serializeExperiment(exp, process, refs)` produce the canonical
  JSON. `refs` = the `{id,name}` maps for materials/solutions already passed to the exporter, so an
  importer can resolve names without the whole DB.
- The serialized object stores the **raw `Process` / `Experiment` types** from `AppContext.tsx` (they
  already fully describe the entity). We deliberately serialize the app types verbatim so import is a
  near-inverse; the `schemaVersion` guards against shape drift.
- **Field-name codec** (used by both export and import): stable, unique AcroForm field names that
  encode a path into the data structure, e.g.

  ```
  process.name
  process.description
  chem.<recipeId>.totalSolventVolumeMl
  chem.<recipeId>.solute.<soluteId>.amount
  step.<stepId>.annealingTemp
  substrate.<substrateId>.heightMm
  stack.<stackIdx>.layer.<layerId>.thicknessNm
  experiment.date
  experiment.endDate
  experiment.description
  ```

  Export `encodeFieldName(path)` and import `decodeFieldName(name) → path`. Keep the mapping in ONE
  place so the two directions can never disagree. Field names must be unique per AcroForm — the ids
  guarantee that.

- **Payload embedding**: attach the canonical JSON as a real PDF file attachment via
  `pdfDoc.attach(bytes, "plains.json", { mimeType: "application/json", ... })`. This survives
  round-tripping through most viewers and is trivial to read back on import. Also mirror the key ids
  (`process.id`, `experiment.id`, `schemaVersion`) into document metadata (`setKeywords` /
  `setSubject`) as a cheap fallback if the attachment is stripped.

> Note: the form-field values are the **human-editable overlay**; the embedded JSON is the
> **original canonical snapshot**. Import diffs one against the other (see import plan §4).

---

## 5. Rewrite `processExport.ts` on pdf-lib

Keep the file's public entry points' names/signatures so call sites barely change, but they become
`pdf-lib`-based and gain form fields.

### 5.1 Layout primitives to port
Build a small `PdfLayout` helper class wrapping a `PDFDocument`:

- `page`, `y` cursor, `margin`, `contentWidth`, `font`/`fontBold` (`StandardFonts.Helvetica[-Bold]`).
- `ensureSpace(h)` → `addPage()` + reset `y` (pdf-lib origin is **bottom-left**, so track `y`
  downward: `y = pageHeight - margin` and decrement).
- `wrap(text, width, size)` using `font.widthOfTextAtSize` (replaces `splitTextToSize`).
- Port `writeTitle / writeSectionHeading / writeSubHeading / writeMiniHeading / writeLabelValue /
  writeBullet / writeNote` from the current file (same visual spec, same colors via `rgb()`).
- Port `drawPdfTable` → `drawTable`, using `page.drawRectangle` for fills/borders and
  `page.drawText` for cells. **Add an `editable` cell mode** (§5.2).
- Port the page-number/footer loop.

### 5.2 Form fields for quantities
`const form = pdfDoc.getForm()`. For every editable quantity, instead of drawing static text in the
value cell, place a text field:

```ts
const f = form.createTextField(encodeFieldName(path))
f.setText(value)
f.addToPage(page, { x, y, width, height, borderWidth: 0, backgroundColor: rgb(0.97,0.98,1) })
```

**Editable set** (all "important quantities"):
- Chemistry: recipe `totalSolventVolumeMl`, each solvent volume, each solute `amount` (+ unit as a
  `createDropdown`), `commercialName`, `supplierNumber`.
- Process steps: every `PROCESS_PARAMETER_DEFINITIONS` value present on a step
  (`substrateTemp`, `annealingTime`, `annealingTemp`, `solutionVolume`, …), plus free-text
  `depositionParameters`, `notes`.
- Substrates: `heightMm`, `surfaceRoughnessRmsNm`, size (length/width).
- Device stacks: per-layer `thicknessNm`, `bandgapEv`; stack `pixelAreaCm2`, `numberOfPixels`.
- Experiment: `date`, `endDate`, `description`, per-substrate outcome fields.

**Identifiers stay read-only text (not fields):** process/experiment ids, recipe ids, step ids,
section headings. They are printed small/greyed in a footer line per section AND live authoritatively
in the embedded JSON — never as an editable field.

Enum-ish quantities (units, `rigidity`, architecture) → `createDropdown` with fixed option lists so
import validation is trivial. Booleans → `createCheckBox`.

### 5.3 Public entry points
```ts
export async function exportProcessProtocolAsPdf(input: ProcessExportInput): Promise<void>
export async function exportExperimentSummaryAsPdf(input: ExperimentExportInput & {
  includeFullProcess: boolean
}): Promise<void>
```
- Drop `exportProcessProtocolAsDocx` and delete `buildDocxChildren` + the whole DOCX half of the file.
- Both call `buildProcessExportModel` (reused). The experiment exporter additionally builds an
  experiment model (name, ids, dates, intent, the chemicals/solutions table currently produced by
  `buildChemicalsExport`, per-substrate outcomes). When `includeFullProcess`, it renders the full
  Process protocol pages first, then a page break, then the experiment section.
- Both attach the serialized payload (§4) and save via a small `savePdf(bytes, filename)` helper
  (`pdfDoc.save()` → `Blob` → the existing `triggerDownload`).

---

## 6. UI changes

### 6.1 Processes page (`frontend/src/routes/Processes.page.tsx`)
- Remove `exportProcessProtocolAsDocx` import (line 56) and `handleExportProcessDocx`
  (lines 3945-3960) + its button + `isExportingDocx` state.
- Keep the single "Export PDF" button wired to `handleExportProcessPdf` (already exists,
  lines 3928-3943) — unchanged signature.

### 6.2 Experiments page (`frontend/src/routes/Experiments.page.tsx`)
- Delete `buildExportText` (1941-1994), `buildExportCsv` (1996-2041), and the `.txt` / `.csv`
  buttons (2226-2253). Keep `buildChemicalsExport` (it feeds both the on-screen list and the PDF).
- Keep `downloadFile` only if still used elsewhere; otherwise remove.
- Replace the two download buttons with **one "Export PDF"** button plus a **checkbox
  "Include full process protocol"** (default off) that drives `includeFullProcess`.
- The "Copy" button (plain-text clipboard) may stay as a convenience — confirm with product; it is
  independent of the file exports being removed.

---

## 7. Glyph / encoding caveats
Helvetica (WinAnsi) can encode `°`, `²`, `×`, `µ`, `–`. It **cannot** encode `—` (em dash, used as the
"—" empty marker) or `•` reliably, and non-Latin script names will throw. Mitigations:
- Replace the "—" empty marker with "-" (or "n/a") and `•` with "-" in bullets.
- Run all user-supplied strings through a `sanitizeForHelvetica()` that strips/replaces
  un-encodable code points, OR embed a Unicode TTF via `@pdf-lib/fontkit` (bundle a subset). Decide
  during implementation; start with sanitize, escalate to fontkit if lab names need it.

---

## 8. Versioning rule + CLAUDE.md remark
- `PDF_SCHEMA_VERSION` lives in `pdfSchema.ts`. **Any change** to `SerializedProcess` /
  `SerializedExperiment` (including changes to `Process` / `Experiment` in `AppContext.tsx` that alter
  what gets serialized, or to the field-name codec) **must bump it** and add a migration entry for the
  importer.
- Add a remark to `CLAUDE.md` (a new short "## PDF Export/Import Schema Versioning" section) stating
  this rule. **Done as part of this plan's delivery** (see the accompanying CLAUDE.md edit).

---

## 9. Testing
- Unit: `encodeFieldName`/`decodeFieldName` round-trip; `serializeProcess` snapshot; payload embed +
  read-back (`PDFDocument.load` → find `plains.json` attachment → parse → deep-equal original).
- Manual/visual: export a rich process (multi-stage, alternatives, chemistry, stacks, substrates) and
  eyeball layout parity with the old jsPDF output; open in Acrobat + Chrome PDF viewer + macOS Preview
  and confirm form fields are editable and re-saved values persist.
- Regression: `bun run lint`, typecheck, and confirm no remaining `jspdf` / `docx` imports
  (`grep -rn "jspdf\|docx" frontend/src`).

---

## 10. File-by-file change list
| File | Change |
|---|---|
| `frontend/package.json` | +`pdf-lib` (+maybe `@pdf-lib/fontkit`), −`jspdf`, −`docx` |
| `frontend/src/lib/pdfSchema.ts` | **new** — `PDF_SCHEMA_VERSION`, serialize fns, field-name codec, payload embed/read |
| `frontend/src/lib/processExport.ts` | rewrite render layer on pdf-lib; add form fields; add experiment exporter; **delete all DOCX code** |
| `frontend/src/routes/Processes.page.tsx` | remove DOCX button/handler/import |
| `frontend/src/routes/Experiments.page.tsx` | remove txt/csv builders+buttons; add "Export PDF" + "Include full process protocol" checkbox |
| `CLAUDE.md` | add schema-versioning remark |
| `frontend/tests/…` | codec round-trip + payload read-back unit tests |

---

## 11. Open questions
1. Keep the plain-text **Copy** button on the Experiment summary, or remove it with txt/csv? 
-> Remove it
2. Attachment vs. embedded hidden form field for the canonical payload if a target viewer strips
   attachments — attachment is preferred; metadata mirror is the fallback.
-> Chose options which are less likely to be viewed as a piggyback virus. Prerfer the option that is less suspicious.
3. Do we need a bundled Unicode font now (non-Latin chemical/lab names), or is sanitize enough for v1?
-> Use unicode!

## PROGRESS ## Mark progress here for future continuation (if token budget is used up)
