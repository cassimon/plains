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
  date: "2026-07-06",
  endDate: "2026-07-10",
  architecture: "n-i-p",
  substrateMaterial: "glass",
  substrateWidth: 2.5,
  substrateLength: 2.5,
  numSubstrates: 1,
  devicesPerSubstrate: 6,
  deviceArea: 0.16,
  deviceType: "full",
  processId: PROC_ID,
  substrates: [],
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
  expect(result.r1.schemaVersion).toBe(1)
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
})
