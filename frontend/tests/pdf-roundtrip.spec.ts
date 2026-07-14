/**
 * PDF export → import round-trip (real modules, in-browser).
 *
 * Runs in the CHROMIUM project (Vite dev server on :5173), NOT the integration
 * project — because it dynamically imports the app's real source modules
 * (`/src/lib/processExport.ts`, `/src/lib/pdfImport.ts`, `/src/lib/pdfSchema.ts`)
 * via Vite. The integration project serves a production nginx build with no
 * source to import. The flow is pure client logic and needs no backend.
 *
 * It exports a richly-populated Process and Experiment to PDF bytes, imports
 * them back, and asserts:
 *   1. every field of the entity survives the round-trip (canonical payload),
 *   2. an unedited PDF yields zero detected edits (the field snapshot matches
 *      the rendered fields exactly),
 *   3. a valid edit to a form field is detected and applied,
 *   4. an invalid edit (non-numeric into a numeric field) is reported and NOT
 *      applied.
 */

import { expect, test } from "@playwright/test"
import type { Experiment, Process } from "@/store/AppContext"

// ── Fixtures (ids are stable so we can address individual form fields) ────────
const RID = "11111111-1111-4111-8111-111111111111" // lab recipe
const RID2 = "22222222-2222-4222-8222-222222222222" // commercial recipe
const SOLV1 = "aaaaaaaa-0000-4000-8000-000000000001"
const SOLV2 = "aaaaaaaa-0000-4000-8000-000000000002"
const SID = "bbbbbbbb-0000-4000-8000-000000000001" // solute
const STEP1 = "cccccccc-0000-4000-8000-000000000001"
const STEP2 = "cccccccc-0000-4000-8000-000000000002"
const SUBID = "dddddddd-0000-4000-8000-000000000001"
const LID = "eeeeeeee-0000-4000-8000-000000000001"
const PROC_ID = "ffffffff-0000-4000-8000-000000000001"
const EXP_ID = "ffffffff-0000-4000-8000-000000000002"
const SUB_A = "99999999-0000-4000-8000-00000000000a" // experiment substrate A
const SUB_B = "99999999-0000-4000-8000-00000000000b" // experiment substrate B

const processFixture: Process = {
  id: PROC_ID,
  name: "RoundTripProc",
  description: "A process used to test the PDF round-trip.",
  substrateIds: [],
  stages: [
    {
      index: 0,
      alternatives: [
        {
          id: STEP1,
          name: "Perovskite Deposition",
          stepCategory: "wet_deposition",
          color: "#4dabf7",
          chemRecipeId: RID,
          substrateTemp: { value: "25", mode: "constant" },
          annealingTemp: { value: "100", mode: "constant" },
          annealingTime: { value: "10", mode: "constant" },
          // Antisolvent drying/quenching — decoded into editable scalar fields.
          dryingMethod: {
            value:
              "type=Antisolvent|media=Chlorobenzene|volume=0.2 mL|timeUntilStart=5",
            mode: "constant",
          },
          notes: "spin at 3000 rpm",
        },
      ],
    },
    {
      index: 1,
      alternatives: [
        {
          id: STEP2,
          name: "HTL",
          stepCategory: "dry_deposition",
          color: "#f783ac",
          chemRecipeId: RID2,
          notes: "thermal evaporation",
        },
      ],
    },
  ],
  solutionRecipes: [
    {
      id: RID,
      name: "Perovskite Ink",
      type: "n-type (ETL)",
      isCommercial: false,
      totalSolventVolumeMl: "1.5",
      handlingPreparation: "stir overnight",
      handlingBeforeUse: "filter 0.45um",
      solvents: [
        {
          id: SOLV1,
          name: "DMF",
          pubchemCid: "",
          volumeRatio: 3,
          color: "#111",
        },
        {
          id: SOLV2,
          name: "DMSO",
          pubchemCid: "",
          volumeRatio: 1,
          color: "#222",
        },
      ],
      solutes: [
        {
          id: SID,
          name: "PbI2",
          pubchemCid: "",
          amount: "10",
          unit: "mg",
          color: "#333",
          molarMass: 461,
        },
      ],
    },
    {
      id: RID2,
      name: "Spiro (commercial)",
      isCommercial: true,
      commercialName: "Spiro-OMeTAD",
      supplierNumber: "SIG-123",
      totalSolventVolumeMl: "0",
      solvents: [],
      solutes: [],
    },
  ],
  inlineSubstrates: [
    {
      id: SUBID,
      name: "substrate_1",
      rigidity: "rigid",
      lengthCm: "2.5",
      widthCm: "2.5",
      heightMm: "1.1",
      surfaceRoughnessRmsNm: "0.8",
    },
  ],
  generatedStacks: [
    {
      combination: 0,
      architecture: "n-i-p",
      buildDevice: "Yes",
      pixelAreaCm2: "0.16",
      numberOfPixels: "6",
      layers: [
        {
          id: LID,
          name: "TiO2",
          color: "#ffffff",
          isSubstrate: false,
          layerType: "etl",
          thicknessNm: "30",
          bandgapEv: "3.2",
          perovskiteA: "",
          perovskiteB: "",
          perovskiteX: "",
        },
      ],
    },
  ],
}

const experimentFixture: Experiment = {
  id: EXP_ID,
  name: "RoundTripExp",
  description: "Round-trip experiment intent.",
  // Derived from the processing times, and `datetime-local` since v3.
  date: "2026-07-06T09:00",
  endDate: "2026-07-10T17:30",
  architecture: "n-i-p",
  substrateMaterial: "glass",
  substrateWidth: 2.5,
  substrateLength: 2.5,
  numSubstrates: 2,
  devicesPerSubstrate: 6,
  deviceArea: 0.16,
  deviceType: "full",
  processId: PROC_ID,
  substrates: [
    {
      id: SUB_A,
      name: "sub_A",
      parameterValues: {
        "stageSelection:0": STEP1,
        "stageSelection:1": STEP2,
        [`${STEP1}:annealingTemp`]: "110",
      },
    },
    {
      id: SUB_B,
      name: "sub_B",
      parameterValues: {
        "stageSelection:0": STEP1,
        "stageSelection:1": "SKIP",
        [`${STEP1}:annealingTemp`]: "120",
      },
    },
  ],
  hasResults: false,
}

const norm = (o: unknown) => JSON.parse(JSON.stringify(o))

test("Process & Experiment survive a PDF export→import round-trip", async ({
  page,
}) => {
  test.setTimeout(120_000)
  // Load the app so the page origin is the Vite dev server and its module graph
  // is importable. /login is public (no auth needed for this pure-client flow).
  await page.goto("/login", { waitUntil: "domcontentloaded" })

  const result = await page.evaluate(
    async ({ processFixture, experimentFixture }) => {
      // Runtime paths are Vite dev-server URLs (strings so tsc doesn't try to
      // resolve them); the `typeof import("@/…")` casts restore full typing.
      const expPath = "/src/lib/processExport.ts"
      const impPath = "/src/lib/pdfImport.ts"
      const schemaPath = "/src/lib/pdfSchema.ts"
      const exp = (await import(
        /* @vite-ignore */ expPath
      )) as typeof import("@/lib/processExport")
      const imp = (await import(
        /* @vite-ignore */ impPath
      )) as typeof import("@/lib/pdfImport")
      const schema = (await import(
        /* @vite-ignore */ schemaPath
      )) as typeof import("@/lib/pdfSchema")

      // 1. Process round-trip -------------------------------------------------
      const pBytes = await exp.buildProcessPdf({
        process: processFixture,
        materials: [],
        solutions: [],
      })
      const r1 = await imp.importPdf(pBytes)

      // enumerate editable field names actually written to the form
      const fieldNames = await imp.readFieldNames(pBytes)

      // 2/3/4. Edit detection -------------------------------------------------
      const amountField = schema.encodeFieldName({
        kind: "soluteAmount",
        recipeId: "11111111-1111-4111-8111-111111111111",
        soluteId: "bbbbbbbb-0000-4000-8000-000000000001",
      })
      const heightField = schema.encodeFieldName({
        kind: "substrateHeight",
        substrateId: "dddddddd-0000-4000-8000-000000000001",
      })
      const editedBytes = await imp.writeFieldValues(pBytes, {
        [amountField]: "99", // valid numeric edit
        [heightField]: "abc", // invalid numeric edit
      })
      const r2 = await imp.importPdf(editedBytes)

      const editedSolute = r2.edited.process.solutionRecipes
        ?.find((r) => r.id === "11111111-1111-4111-8111-111111111111")
        ?.solutes.find(
          (s) => s.id === "bbbbbbbb-0000-4000-8000-000000000001",
        )?.amount
      const editedHeight = r2.edited.process.inlineSubstrates?.find(
        (s) => s.id === "dddddddd-0000-4000-8000-000000000001",
      )?.heightMm

      // 5. Experiment round-trip (with full process embedded) -----------------
      const eBytes = await exp.buildExperimentPdf({
        experiment: experimentFixture,
        process: processFixture,
        materials: [],
        solutions: [],
        chemicals: [],
        solutionRows: [],
        includeFullProcess: true,
      })
      const r3 = await imp.importPdf(eBytes)
      const expFieldNames = await imp.readFieldNames(eBytes)

      return {
        processFieldNames: fieldNames,
        r1: {
          kind: r1.kind,
          schemaVersion: r1.schemaVersion,
          editsLen: r1.edits.length,
          errorsLen: r1.errors.length,
          roundProcess: r1.original.process,
        },
        r2: {
          edits: r2.edits.map((e) => ({
            name: e.name,
            oldValue: e.oldValue,
            newValue: e.newValue,
          })),
          errors: r2.errors.map((e) => ({ name: e.name, reason: e.reason })),
          editedSolute,
          editedHeight,
          originalSoluteUnchanged: r2.original.process.solutionRecipes
            ?.find((r) => r.id === "11111111-1111-4111-8111-111111111111")
            ?.solutes.find(
              (s) => s.id === "bbbbbbbb-0000-4000-8000-000000000001",
            )?.amount,
          amountField,
          heightField,
        },
        r3: {
          kind: r3.kind,
          editsLen: r3.edits.length,
          errorsLen: r3.errors.length,
          roundProcess: r3.original.process,
          roundExperiment: r3.original.experiment,
          expFieldNames,
        },
      }
    },
    { processFixture, experimentFixture },
  )

  // ── 1. Process payload fully survives ──────────────────────────────────────
  expect(result.r1.kind).toBe("process")
  expect(result.r1.schemaVersion).toBe(4)
  expect(result.r1.roundProcess).toEqual(norm(processFixture))
  // Unedited PDF ⇒ no spurious edits / errors.
  expect(result.r1.editsLen).toBe(0)
  expect(result.r1.errorsLen).toBe(0)

  // ── field coverage: one editable field per stored quantity kind ────────────
  const names = result.processFieldNames
  const has = (frag: string) => names.some((n) => n.includes(frag))
  expect(has(":solute:")).toBeTruthy() // soluteAmount
  expect(has(":unit")).toBeTruthy() // soluteUnit dropdown
  expect(has("totalSolventVolumeMl")).toBeTruthy()
  expect(has("commercialName")).toBeTruthy()
  expect(has("supplierNumber")).toBeTruthy()
  expect(has(":param:")).toBeTruthy() // step params
  expect(has(":quench:")).toBeTruthy() // editable quenching scalars
  expect(has(":solvent:")).toBeTruthy() // editable solvent volume ratio
  expect(has(":ratio")).toBeTruthy()
  expect(has(":notes")).toBeTruthy()
  expect(has("lengthCm")).toBeTruthy()
  expect(has("widthCm")).toBeTruthy()
  expect(has("heightMm")).toBeTruthy()
  expect(has("roughnessNm")).toBeTruthy()
  expect(has("pixelAreaCm2")).toBeTruthy()
  expect(has("numberOfPixels")).toBeTruthy()
  expect(has("thicknessNm")).toBeTruthy()
  expect(has("bandgapEv")).toBeTruthy()

  // ── 3. valid edit detected + applied ───────────────────────────────────────
  const amountEdit = result.r2.edits.find(
    (e) => e.name === result.r2.amountField,
  )
  expect(amountEdit).toBeTruthy()
  expect(amountEdit?.oldValue).toBe("10")
  expect(amountEdit?.newValue).toBe("99")
  expect(result.r2.editedSolute).toBe("99") // applied to the edited clone
  expect(result.r2.originalSoluteUnchanged).toBe("10") // original untouched

  // ── 4. invalid edit reported + NOT applied ─────────────────────────────────
  const heightError = result.r2.errors.find(
    (e) => e.name === result.r2.heightField,
  )
  expect(heightError).toBeTruthy()
  expect(heightError?.reason).toContain("number")
  expect(result.r2.editedHeight).toBe("1.1") // kept original, not "abc"
  // the invalid field is not counted as an applied edit
  expect(
    result.r2.edits.find((e) => e.name === result.r2.heightField),
  ).toBeFalsy()

  // ── 5. Experiment round-trip (process + experiment both survive) ───────────
  expect(result.r3.kind).toBe("experiment")
  expect(result.r3.roundProcess).toEqual(norm(processFixture))
  expect(result.r3.roundExperiment).toEqual(norm(experimentFixture))
  expect(result.r3.editsLen).toBe(0)
  expect(result.r3.errorsLen).toBe(0)
  // includeFullProcess ⇒ experiment PDF carries both process AND experiment fields
  expect(
    result.r3.expFieldNames.some((n) => n.startsWith("experiment:")),
  ).toBeTruthy()
  expect(
    result.r3.expFieldNames.some((n) => n.includes(":solute:")),
  ).toBeTruthy()
  // Per-substrate experiment fields: editable name, step choice, variation.
  expect(
    result.r3.expFieldNames.some((n) => n === `expsub:${SUB_A}:name`),
  ).toBeTruthy()
  expect(
    result.r3.expFieldNames.some((n) => n.startsWith(`expsub:${SUB_A}:stage:`)),
  ).toBeTruthy()
  expect(
    result.r3.expFieldNames.some((n) => n.startsWith(`expsub:${SUB_A}:var:`)),
  ).toBeTruthy()
})

test("a slightly altered PDF: several edits across the entity are detected & applied", async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.goto("/login", { waitUntil: "domcontentloaded" })

  const ids = { RID, SID, STEP1, SUBID, LID }

  const result = await page.evaluate(
    async ({ processFixture, experimentFixture, ids }) => {
      const expPath = "/src/lib/processExport.ts"
      const impPath = "/src/lib/pdfImport.ts"
      const schemaPath = "/src/lib/pdfSchema.ts"
      const exp = (await import(
        /* @vite-ignore */ expPath
      )) as typeof import("@/lib/processExport")
      const imp = (await import(
        /* @vite-ignore */ impPath
      )) as typeof import("@/lib/pdfImport")
      const schema = (await import(
        /* @vite-ignore */ schemaPath
      )) as typeof import("@/lib/pdfSchema")

      // Export an experiment PDF that embeds the full process (so a viewer could
      // edit both process- and experiment-level quantities).
      const bytes = await exp.buildExperimentPdf({
        experiment: experimentFixture,
        process: processFixture,
        materials: [],
        solutions: [],
        chemicals: [],
        solutionRows: [],
        includeFullProcess: true,
      })

      // Field names of the quantities a user "edits" in a PDF viewer.
      const f = {
        annealingTemp: schema.encodeFieldName({
          kind: "stepParam",
          stepId: ids.STEP1,
          paramKey: "annealingTemp",
        }),
        soluteAmount: schema.encodeFieldName({
          kind: "soluteAmount",
          recipeId: ids.RID,
          soluteId: ids.SID,
        }),
        soluteUnit: schema.encodeFieldName({
          kind: "soluteUnit",
          recipeId: ids.RID,
          soluteId: ids.SID,
        }),
        substrateHeight: schema.encodeFieldName({
          kind: "substrateHeight",
          substrateId: ids.SUBID,
        }),
        layerThickness: schema.encodeFieldName({
          kind: "stackLayerThickness",
          stackIdx: 0,
          layerId: ids.LID,
        }),
        description: schema.encodeFieldName({ kind: "experimentDescription" }),
        // Start/end are derived from the processing times now, so the export
        // prints them as plain text — there must be no form field to edit.
        endDate: schema.encodeFieldName({ kind: "experimentEndDate" }),
      }

      const altered = await imp.writeFieldValues(bytes, {
        [f.annealingTemp]: "120", // 100 → 120
        [f.soluteAmount]: "12.5", // 10 → 12.5
        [f.soluteUnit]: "mol", // mg → mol (dropdown)
        [f.substrateHeight]: "1.2", // 1.1 → 1.2
        [f.layerThickness]: "45", // 30 → 45
        [f.description]: "Edited intent", // → experiment.description
      })

      const r = await imp.importPdf(altered)

      const rec = r.edited.process.solutionRecipes?.find(
        (x) => x.id === ids.RID,
      )
      const sol = rec?.solutes.find((x) => x.id === ids.SID)
      const step = r.edited.process.stages
        .flatMap((s) => s.alternatives)
        .find((a) => a.id === ids.STEP1)
      const sub = r.edited.process.inlineSubstrates?.find(
        (x) => x.id === ids.SUBID,
      )
      const layer = r.edited.process.generatedStacks?.[0]?.layers.find(
        (l) => l.id === ids.LID,
      )

      const origSol = r.original.process.solutionRecipes
        ?.find((x) => x.id === ids.RID)
        ?.solutes.find((x) => x.id === ids.SID)

      const allFieldNames = await imp.readFieldNames(bytes)

      return {
        editsLen: r.edits.length,
        errorsLen: r.errors.length,
        editsByName: Object.fromEntries(
          r.edits.map((e) => [e.name, { old: e.oldValue, new: e.newValue }]),
        ),
        fieldNames: f,
        allFieldNames,
        applied: {
          annealingTemp: step?.annealingTemp?.value,
          soluteAmount: sol?.amount,
          soluteUnit: sol?.unit,
          substrateHeight: sub?.heightMm,
          layerThickness: layer?.thicknessNm,
          description: r.edited.experiment?.description,
        },
        original: {
          soluteAmount: origSol?.amount,
          soluteUnit: origSol?.unit,
          endDate: r.original.experiment?.endDate,
        },
      }
    },
    { processFixture, experimentFixture, ids },
  )

  // exactly the six edits we made, no validation errors
  expect(result.errorsLen).toBe(0)
  expect(result.editsLen).toBe(6)

  // each edit detected with the right old→new transition
  const e = result.editsByName
  expect(e[result.fieldNames.annealingTemp]).toEqual({ old: "100", new: "120" })
  expect(e[result.fieldNames.soluteAmount]).toEqual({ old: "10", new: "12.5" })
  expect(e[result.fieldNames.soluteUnit]).toEqual({ old: "mg", new: "mol" })
  expect(e[result.fieldNames.substrateHeight]).toEqual({
    old: "1.1",
    new: "1.2",
  })
  expect(e[result.fieldNames.layerThickness]).toEqual({ old: "30", new: "45" })
  expect(e[result.fieldNames.description]).toEqual({
    old: "Round-trip experiment intent.",
    new: "Edited intent",
  })

  // edits applied to the returned entity
  expect(result.applied.annealingTemp).toBe("120")
  expect(result.applied.soluteAmount).toBe("12.5")
  expect(result.applied.soluteUnit).toBe("mol")
  expect(result.applied.substrateHeight).toBe("1.2")
  expect(result.applied.layerThickness).toBe("45")
  expect(result.applied.description).toBe("Edited intent")

  // Start/end are derived from the processing times (first step / end-of-
  // experiment cell) and read-only in the Summary tab — the PDF must not offer
  // them as editable fields either, or an edit would be re-derived away.
  expect(result.allFieldNames).not.toContain(result.fieldNames.endDate)

  // the canonical original is left untouched, and still carries the dates
  expect(result.original.soluteAmount).toBe("10")
  expect(result.original.soluteUnit).toBe("mg")
  expect(result.original.endDate).toBe("2026-07-10T17:30")
})

test("migration ladder: a v2 experiment payload still imports, with its dates widened", async ({
  page,
}) => {
  await page.goto("/login", { waitUntil: "domcontentloaded" })

  const result = await page.evaluate(
    async ({ processFixture, experimentFixture }) => {
      const schema = (await import(
        /* @vite-ignore */ "/src/lib/pdfSchema.ts"
      )) as typeof import("@/lib/pdfSchema")

      // What a PDF exported before this change looks like: schemaVersion 2, and
      // date-only start/end (there was no end-of-experiment cell to derive a
      // time from).
      const v2 = {
        schemaVersion: 2,
        kind: "experiment" as const,
        experiment: {
          ...experimentFixture,
          date: "2026-07-06",
          endDate: "2026-07-10",
        },
        process: processFixture,
        refs: { materials: [], solutions: [] },
      }

      const migrated = schema.migratePayload(v2)
      // A payload from a *newer* app must still be rejected rather than guessed at.
      const tooNew = schema.migratePayload({ ...v2, schemaVersion: 99 })

      return {
        version: migrated?.schemaVersion,
        date:
          migrated?.kind === "experiment"
            ? migrated.experiment.date
            : undefined,
        endDate:
          migrated?.kind === "experiment"
            ? migrated.experiment.endDate
            : undefined,
        // everything else must survive the migration untouched
        name:
          migrated?.kind === "experiment"
            ? migrated.experiment.name
            : undefined,
        tooNew,
      }
    },
    { processFixture, experimentFixture },
  )

  // A v2 payload climbs the whole ladder (v2 → v3 → v4).
  expect(result.version).toBe(4)
  expect(result.date).toBe("2026-07-06T00:00")
  expect(result.endDate).toBe("2026-07-10T00:00")
  expect(result.name).toBe("RoundTripExp")
  expect(result.tooNew).toBeNull()
})

test("new editable fields round-trip: solvent ratio, quenching, substrate name, step choice, variation", async ({
  page,
}) => {
  test.setTimeout(120_000)
  await page.goto("/login", { waitUntil: "domcontentloaded" })

  const ids = { RID, SOLV1, STEP1, STEP2, SUB_A, SUB_B }

  const result = await page.evaluate(
    async ({ processFixture, experimentFixture, ids }) => {
      const exp = (await import(
        /* @vite-ignore */ "/src/lib/processExport.ts"
      )) as typeof import("@/lib/processExport")
      const imp = (await import(
        /* @vite-ignore */ "/src/lib/pdfImport.ts"
      )) as typeof import("@/lib/pdfImport")
      const schema = (await import(
        /* @vite-ignore */ "/src/lib/pdfSchema.ts"
      )) as typeof import("@/lib/pdfSchema")
      const choices = (await import(
        /* @vite-ignore */ "/src/lib/stageStepChoices.ts"
      )) as typeof import("@/lib/stageStepChoices")

      const bytes = await exp.buildExperimentPdf({
        experiment: experimentFixture,
        process: processFixture,
        materials: [],
        solutions: [],
        chemicals: [],
        solutionRows: [],
        includeFullProcess: true,
      })

      // The label a viewer would pick to route SUB_B's stage 1 to STEP2 (it was
      // "Skip step"). Built with the SAME helper import uses to resolve it back.
      const stage1Options = choices.buildStageStepOptions(
        processFixture.stages[1].alternatives,
        processFixture.solutionRecipes ?? [],
      )
      const step2Label =
        stage1Options.find((o) => o.value === ids.STEP2)?.label ?? ""

      const f = {
        solventRatio: schema.encodeFieldName({
          kind: "solventRatio",
          recipeId: ids.RID,
          solventId: ids.SOLV1,
        }),
        quenchVolume: schema.encodeFieldName({
          kind: "stepQuench",
          stepId: ids.STEP1,
          subKey: "volume",
        }),
        subName: schema.encodeFieldName({
          kind: "experimentSubstrateName",
          substrateId: ids.SUB_A,
        }),
        stageChoice: schema.encodeFieldName({
          kind: "experimentStageSelection",
          substrateId: ids.SUB_B,
          stageIndex: 1,
        }),
        variation: schema.encodeFieldName({
          kind: "experimentVariationValue",
          substrateId: ids.SUB_A,
          stepId: ids.STEP1,
          paramKey: "annealingTemp",
        }),
      }

      const altered = await imp.writeFieldValues(bytes, {
        [f.solventRatio]: "5", // 3 → 5
        [f.quenchVolume]: "0.35", // 0.2 → 0.35 (mL preserved)
        [f.subName]: "sub_A_renamed", // sub_A → renamed
        [f.stageChoice]: step2Label, // Skip → STEP2
        [f.variation]: "115", // 110 → 115
      })

      const r = await imp.importPdf(altered)

      const proc = r.edited.process
      const experiment = r.edited.experiment
      const solvent = proc.solutionRecipes
        ?.find((x) => x.id === ids.RID)
        ?.solvents.find((s) => s.id === ids.SOLV1)
      const step1 = proc.stages
        .flatMap((s) => s.alternatives)
        .find((a) => a.id === ids.STEP1)
      const subA = experiment?.substrates.find((s) => s.id === ids.SUB_A)
      const subB = experiment?.substrates.find((s) => s.id === ids.SUB_B)

      return {
        editsLen: r.edits.length,
        errorsLen: r.errors.length,
        step2Label,
        solventRatio: solvent?.volumeRatio,
        quenchValue: step1?.dryingMethod?.value,
        subAName: subA?.name,
        stageChoice: subB?.parameterValues?.["stageSelection:1"],
        variation: subA?.parameterValues?.[`${ids.STEP1}:annealingTemp`],
      }
    },
    { processFixture, experimentFixture, ids },
  )

  expect(result.errorsLen).toBe(0)
  expect(result.editsLen).toBe(5)
  // solvent ratio is numeric on the entity
  expect(result.solventRatio).toBe(5)
  // quenching re-encodes the one scalar, preserving its unit + other params
  expect(result.quenchValue).toContain("volume=0.35 mL")
  expect(result.quenchValue).toContain("timeUntilStart=5")
  expect(result.quenchValue).toContain("type=Antisolvent")
  // substrate name applied
  expect(result.subAName).toBe("sub_A_renamed")
  // step choice: the label mapped back to STEP2's id
  expect(result.stageChoice).toBe(STEP2)
  // variation value applied
  expect(result.variation).toBe("115")
})
