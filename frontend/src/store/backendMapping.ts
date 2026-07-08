/**
 * Pure mapping helpers between the frontend AppContext types and the normalised
 * backend REST schema (Task 4 data model).
 *
 * The backend stores every domain object in its own table with per-entity REST
 * endpoints; the frontend keeps a denormalised in-memory snapshot. These
 * functions translate in both directions:
 *   - `*FromApi` : normalised backend object  → rich frontend object (load)
 *   - `*ToApi`   : rich frontend object        → backend create/update payload (save)
 *
 * Field naming differs (camelCase ⇄ snake_case) and some structures are
 * reshaped (e.g. the frontend's nested `stages[].alternatives[]` maps to a flat
 * list of `process_step` rows keyed by `stage_index`/`step_index`).
 */

import type {
  CanvasCollectionElement,
  CanvasElement,
  CanvasPlainTextElement,
  CanvasTextElement,
  CollectionRef,
  DeviceGroup,
  Experiment,
  ExperimentResults,
  MeasurementFile,
  Plane,
  PlaneFolder,
  Process,
  ProcessGeneratedStack,
  ProcessSolutionRecipe,
  ProcessStage,
  ProcessStep,
  Substrate,
} from "./AppContext"

// Frontend ProcessParam key → backend column prefix (each becomes _value/_mode).
export const STEP_PARAM_COLUMNS = {
  depositionMethod: "deposition_method",
  depositionStartTime: "deposition_start_time",
  substrateTemp: "substrate_temp",
  depositionAtmosphere: "deposition_atmosphere",
  depositionParameters: "deposition_parameters",
  solutionVolume: "solution_volume",
  dryingMethod: "drying_method",
  annealingStartTime: "annealing_start_time",
  annealingTime: "annealing_time",
  annealingTemp: "annealing_temp",
  annealingAtmosphere: "annealing_atmosphere",
} as const

type ApiObj = Record<string, any>

const int = (n: number | undefined | null) => Math.round(Number(n ?? 0))
const atLeast1 = (n: number | undefined | null) =>
  Math.max(1, Math.round(Number(n ?? 1)))

// ── Bulk load response ⇒ frontend snapshot ──────────────────────────────────

export type BulkState = {
  processes?: ApiObj[]
  experiments?: ApiObj[]
  results?: ApiObj[]
  analyses?: ApiObj[]
  planes?: ApiObj[]
  folders?: ApiObj[]
}

export type Snapshot = {
  experiments: Experiment[]
  processes: Process[]
  results: ExperimentResults[]
  planes: Plane[]
  folders: PlaneFolder[]
}

export function bulkToSnapshot(bulk: BulkState): Snapshot {
  const processes = (bulk.processes ?? []).map(processFromApi)
  const experiments = (bulk.experiments ?? []).map(experimentFromApi)
  const results = (bulk.results ?? []).map(resultsFromApi)

  // Reconstruct DataCollection membership: each entity carries a collection_id
  // FK, so a collection's refs are the entities that point back to it.
  const refsByCollection = new Map<string, CollectionRef[]>()
  const addRef = (
    cid: string | null,
    kind: CollectionRef["kind"],
    id: string,
  ) => {
    if (!cid) return
    const list = refsByCollection.get(cid) ?? []
    list.push({ kind, id })
    refsByCollection.set(cid, list)
  }
  for (const p of bulk.processes ?? []) addRef(p.collection_id, "process", p.id)
  for (const e of bulk.experiments ?? [])
    addRef(e.collection_id, "experiment", e.id)
  for (const r of bulk.results ?? []) addRef(r.collection_id, "result", r.id)
  for (const a of bulk.analyses ?? []) addRef(a.collection_id, "analysis", a.id)

  const planes = (bulk.planes ?? []).map((pl) =>
    planeFromApi(pl, refsByCollection),
  )
  const folders = (bulk.folders ?? []).map(folderFromApi)
  return { processes, experiments, results, planes, folders }
}

// ── Process ──────────────────────────────────────────────────────────────────

function processFromApi(p: ApiObj): Process {
  const dims = p.substrate_dimensions ?? []
  const substrateDimensionsById: Record<string, any> = {}
  for (const d of dims) {
    if (
      d.length_cm ||
      d.width_cm ||
      d.height_mm ||
      d.surface_roughness_rms_nm
    ) {
      substrateDimensionsById[d.material_id] = {
        lengthCm: d.length_cm ?? "",
        widthCm: d.width_cm ?? "",
        heightMm: d.height_mm ?? undefined,
        surfaceRoughnessRmsNm: d.surface_roughness_rms_nm ?? undefined,
      }
    }
  }
  const stacks = p.stacks ?? []
  return {
    id: p.id,
    name: p.name,
    description: p.description ?? "",
    skipChemistry: !!p.skip_chemistry,
    substrateIds: dims.map((d: ApiObj) => d.material_id),
    substrateDimensionsById,
    inlineSubstrates: (p.inline_substrates ?? []).map((s: ApiObj) => ({
      id: s.id,
      name: s.name,
      rigidity: s.rigidity ?? undefined,
      lengthCm: s.length_cm ?? undefined,
      widthCm: s.width_cm ?? undefined,
      heightMm: s.height_mm ?? undefined,
      surfaceRoughnessRmsNm: s.surface_roughness_rms_nm ?? undefined,
    })),
    stages: stagesFromSteps(p.steps ?? []),
    generatedStacks: stacks
      .filter((s: ApiObj) => !s.is_deleted)
      .map(stackFromApi),
    deletedStackCombinations: stacks
      .filter((s: ApiObj) => s.is_deleted)
      .map((s: ApiObj) => s.combination),
    solutionRecipes: (p.recipes ?? []).map(recipeFromApi),
  }
}

function stagesFromSteps(steps: ApiObj[]): ProcessStage[] {
  const byStage = new Map<number, ApiObj[]>()
  for (const s of steps) {
    const arr = byStage.get(s.stage_index) ?? []
    arr.push(s)
    byStage.set(s.stage_index, arr)
  }
  return [...byStage.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([index, arr]) => ({
      index,
      alternatives: arr
        .sort((a, b) => a.step_index - b.step_index)
        .map(stepFromApi),
    }))
}

function stepFromApi(s: ApiObj): ProcessStep {
  const step: any = {
    id: s.id,
    name: s.name,
    stepCategory: s.step_category,
    color: s.color ?? "",
    materialId: s.material_id ?? undefined,
    solutionId: s.solution_id ?? undefined,
    chemRecipeId: s.chem_recipe_id ?? undefined,
    inlineMaterial: s.inline_material ?? undefined,
    notes: s.notes ?? undefined,
  }
  for (const [feKey, col] of Object.entries(STEP_PARAM_COLUMNS)) {
    const value = s[`${col}_value`]
    const mode = s[`${col}_mode`]
    if (value != null || mode != null) {
      step[feKey] = { value: value ?? "", mode: mode ?? "constant" }
    }
  }
  return step as ProcessStep
}

function recipeFromApi(r: ApiObj): ProcessSolutionRecipe {
  return {
    id: r.id,
    name: r.name,
    type: r.type ?? undefined,
    isCommercial: r.is_commercial ?? undefined,
    commercialName: r.commercial_name ?? undefined,
    supplierNumber: r.supplier_number ?? undefined,
    handlingPreparation: r.handling_preparation ?? undefined,
    handlingBeforeUse: r.handling_before_use ?? undefined,
    totalSolventVolumeMl: r.total_solvent_volume_ml ?? "",
    solvents: (r.solvents ?? []).map((s: ApiObj) => ({
      id: s.id,
      name: s.name,
      pubchemCid: s.pubchem_cid ?? "",
      componentCids: s.component_cids ?? undefined,
      molarMass: s.molar_mass ?? undefined,
      density: s.density ?? undefined,
      volumeRatio: s.volume_ratio ?? 0,
      color: s.color ?? "",
    })),
    solutes: (r.solutes ?? []).map((s: ApiObj) => ({
      id: s.id,
      name: s.name,
      pubchemCid: s.pubchem_cid ?? "",
      componentCids: s.component_cids ?? undefined,
      molarMass: s.molar_mass ?? undefined,
      density: s.density ?? undefined,
      amount: s.amount ?? "",
      unit: s.unit ?? "mg",
      color: s.color ?? "",
    })),
    addedSolutions: (r.added_solutions ?? []).map((a: ApiObj) => ({
      recipeId: a.referenced_recipe_id ?? "",
      volumeMl: a.volume_ml ?? "",
    })),
  }
}

function stackFromApi(s: ApiObj): ProcessGeneratedStack {
  return {
    combination: s.combination,
    architecture: s.architecture ?? undefined,
    buildDevice: s.build_device ?? undefined,
    pixelAreaCm2: s.pixel_area_cm2 ?? undefined,
    numberOfPixels: s.number_of_pixels ?? undefined,
    layers: (s.layers ?? [])
      .slice()
      .sort((a: ApiObj, b: ApiObj) => a.layer_index - b.layer_index)
      .map((l: ApiObj) => ({
        id: l.step_ref ?? l.id,
        name: l.name ?? "",
        color: l.color ?? "",
        isSubstrate: !!l.is_substrate,
        layerType: l.layer_type ?? "",
        thicknessNm: l.thickness_nm ?? "",
        bandgapEv: l.bandgap_ev ?? "",
        perovskiteA: l.perovskite_a ?? "",
        perovskiteB: l.perovskite_b ?? "",
        perovskiteX: l.perovskite_x ?? "",
        materialType: l.material_type ?? "",
        homoEv: l.homo_ev ?? "",
        lumoEv: l.lumo_ev ?? "",
      })),
  }
}

// ── Experiment ───────────────────────────────────────────────────────────────

function experimentFromApi(e: ApiObj): Experiment {
  return {
    id: e.id,
    name: e.name,
    description: e.description ?? "",
    date: e.date ?? "",
    endDate: e.end_date ?? undefined,
    architecture: e.architecture ?? "n-i-p",
    substrateMaterial: e.substrate_material ?? "",
    substrateWidth: e.substrate_width ?? 0,
    substrateLength: e.substrate_length ?? 0,
    numSubstrates: e.num_substrates ?? 0,
    devicesPerSubstrate: e.devices_per_substrate ?? 0,
    deviceArea: e.device_area ?? 0,
    deviceType: (e.device_type as Experiment["deviceType"]) ?? "film",
    deviceLayoutImage: e.device_layout_image ?? undefined,
    processId: e.process_id ?? "",
    substrates: (e.substrates ?? []).map(substrateFromApi),
    processingTimes: e.processing_times ?? {},
    chemicalsPrep: e.chemicals_prep ?? undefined,
    hasResults: !!e.has_results,
    hasCompletedUpload: !!e.has_completed_upload,
  }
}

function substrateFromApi(s: ApiObj): Substrate {
  return {
    id: s.id,
    name: s.name,
    substrateMaterialId: s.substrate_material_id ?? undefined,
    notes: s.notes ?? undefined,
    outcome: s.outcome_status
      ? {
          status: s.outcome_status,
          stoppedAtStep: s.outcome_stopped_at_step ?? undefined,
          discardReason: s.outcome_discard_reason ?? undefined,
        }
      : undefined,
    parameterValues: s.parameter_values ?? undefined,
  }
}

// ── Results ──────────────────────────────────────────────────────────────────

function resultsFromApi(r: ApiObj): ExperimentResults {
  return {
    id: r.id,
    experimentId: r.experiment_id,
    files: (r.measurement_files ?? []).map(
      (f: ApiObj): MeasurementFile => ({
        id: f.id,
        fileName: f.filename,
        fileType: f.file_type,
        deviceName: f.device_name ?? "",
        cell: f.cell ?? "",
        pixel: f.pixel_label ?? "",
        value: f.value ?? undefined,
        voc: f.voc ?? undefined,
        jsc: f.jsc ?? undefined,
        ff: f.ff ?? undefined,
        measurementDate: f.measurement_date ?? undefined,
        user: f.measurement_user ?? undefined,
      }),
    ),
    deviceGroups: (r.device_groups ?? []).map(
      (g: ApiObj): DeviceGroup => ({
        id: g.id,
        deviceName: g.name,
        files: [],
        assignedSubstrateId: g.assigned_substrate_id ?? null,
        suggestedSubstrateId: g.suggested_substrate_id ?? undefined,
        matchScore: g.match_score ?? undefined,
      }),
    ),
    groupingStrategy: r.grouping_strategy ?? "search",
    matchingStrategy: r.matching_strategy ?? "fuzzy",
    updatedAt: r.created_at ?? new Date().toISOString(),
    nomad: r.nomad_upload_id
      ? {
          upload_id: r.nomad_upload_id,
          upload_time: r.nomad_upload_time ?? undefined,
          status: r.nomad_upload_status ?? undefined,
          entries: r.nomad_entries ?? undefined,
        }
      : undefined,
  }
}

// ── Plane / canvas ───────────────────────────────────────────────────────────

function planeFromApi(
  pl: ApiObj,
  refsByCollection: Map<string, CollectionRef[]>,
): Plane {
  const elements: CanvasElement[] = [
    ...(pl.sticky_notes ?? []).map(
      (n: ApiObj): CanvasTextElement => ({
        id: n.id,
        type: "text",
        position: { x: n.j, y: n.i },
        size: { x: n.dj, y: n.di },
        content: n.content ?? "",
        color: n.color ?? "#000000",
        formatting: {
          bold: n.fmt_bold ?? false,
          italic: n.fmt_italic ?? false,
          underline: n.fmt_underline ?? false,
          fontSize: n.fmt_font_size ?? undefined,
        },
      }),
    ),
    ...(pl.text_fields ?? []).map(
      (t: ApiObj): CanvasPlainTextElement => ({
        id: t.id,
        type: "plaintext",
        position: { x: t.j, y: t.i },
        size: { x: t.dj, y: t.di },
        content: t.content ?? "",
        color: t.color ?? "#000000",
        formatting: {
          bold: t.fmt_bold ?? false,
          italic: t.fmt_italic ?? false,
          underline: t.fmt_underline ?? false,
          fontSize: t.fmt_font_size ?? undefined,
        },
      }),
    ),
    ...(pl.collections ?? []).map(
      (c: ApiObj): CanvasCollectionElement => ({
        id: c.id,
        type: "collection",
        position: { x: c.j, y: c.i },
        size: { x: 200, y: 160 },
        name: c.name,
        refs: refsByCollection.get(c.id) ?? [],
        color: c.color ?? undefined,
      }),
    ),
  ]
  return {
    id: pl.id,
    name: pl.name,
    elements,
    folderId: pl.folder_id ?? null,
    position: pl.position ?? 0,
    ownerId: pl.owner_id,
    owner: pl.owner
      ? {
          id: pl.owner.id,
          email: pl.owner.email,
          full_name: pl.owner.full_name,
        }
      : undefined,
    sharedWith: (pl.shared_with ?? []).map((u: ApiObj) => ({
      id: u.id,
      email: u.email,
      full_name: u.full_name,
    })),
  }
}

// ════════════════════════════════════════════════════════════════════════════
// Save direction: frontend object ⇒ backend payload
// ════════════════════════════════════════════════════════════════════════════

/** Per-entity plane/collection placement derived from collection refs. */
export type Placement = {
  planeByEntity: Map<string, string>
  collectionByEntity: Map<string, string>
}

/** Build entity → (plane, collection) placement from all collection refs. */
export function derivePlacement(planes: Plane[]): Placement {
  const planeByEntity = new Map<string, string>()
  const collectionByEntity = new Map<string, string>()
  for (const pl of planes) {
    for (const el of pl.elements) {
      if (el.type !== "collection") continue
      for (const ref of el.refs) {
        planeByEntity.set(ref.id, pl.id)
        collectionByEntity.set(ref.id, el.id)
      }
    }
  }
  return { planeByEntity, collectionByEntity }
}

export function processToApi(p: Process, place: Placement): ApiObj {
  return {
    id: p.id,
    name: p.name || "Untitled Process",
    description: p.description ?? null,
    skip_chemistry: !!p.skipChemistry,
    plane_id: place.planeByEntity.get(p.id) ?? null,
    collection_id: place.collectionByEntity.get(p.id) ?? null,
  }
}

export function recipesToApi(p: Process): ApiObj[] {
  return (p.solutionRecipes ?? []).map((r) => ({
    id: r.id,
    name: r.name || "Recipe",
    type: r.type ?? null,
    is_commercial: !!r.isCommercial,
    commercial_name: r.commercialName ?? null,
    supplier_number: r.supplierNumber ?? null,
    handling_preparation: r.handlingPreparation ?? null,
    handling_before_use: r.handlingBeforeUse ?? null,
    total_solvent_volume_ml: r.totalSolventVolumeMl ?? "",
    solvents: r.solvents.map((s) => ({
      id: s.id,
      name: s.name || "solvent",
      pubchem_cid: s.pubchemCid || null,
      component_cids: s.componentCids ?? null,
      molar_mass: s.molarMass ?? null,
      density: s.density ?? null,
      volume_ratio: s.volumeRatio ?? 0,
      color: s.color ?? "",
    })),
    solutes: r.solutes.map((s) => ({
      id: s.id,
      name: s.name || "solute",
      pubchem_cid: s.pubchemCid || null,
      component_cids: s.componentCids ?? null,
      molar_mass: s.molarMass ?? null,
      density: s.density ?? null,
      amount: s.amount ?? "",
      unit: s.unit ?? "mg",
      color: s.color ?? "",
    })),
    added_solutions: (r.addedSolutions ?? []).map((a) => ({
      referenced_recipe_id: a.recipeId || null,
      volume_ml: a.volumeMl ?? "",
    })),
  }))
}

export function stepsToApi(p: Process): ApiObj[] {
  const steps: ApiObj[] = []
  p.stages.forEach((stage) => {
    stage.alternatives.forEach((step, stepIdx) => {
      const body: ApiObj = {
        id: step.id,
        stage_index: stage.index,
        step_index: stepIdx,
        name: step.name || "Step",
        step_category: step.stepCategory,
        color: step.color ?? "",
        material_id: step.materialId || null,
        solution_id: step.solutionId || null,
        chem_recipe_id: step.chemRecipeId || null,
        inline_material: step.inlineMaterial ?? null,
        notes: step.notes ?? null,
      }
      for (const [feKey, col] of Object.entries(STEP_PARAM_COLUMNS)) {
        const param = (step as any)[feKey]
        body[`${col}_value`] = param?.value ?? null
        body[`${col}_mode`] = param?.mode ?? null
      }
      steps.push(body)
    })
  })
  return steps
}

export function stacksToApi(p: Process): ApiObj[] {
  const stacks: ApiObj[] = (p.generatedStacks ?? []).map((s) => ({
    combination: s.combination,
    architecture: s.architecture ?? null,
    build_device: s.buildDevice ?? null,
    pixel_area_cm2: s.pixelAreaCm2 ?? null,
    number_of_pixels: s.numberOfPixels ?? null,
    is_deleted: false,
    layers: s.layers.map((l, i) => ({
      // The layer's id references its source ProcessStep and is therefore
      // SHARED across stack combinations — it must not be the DB row PK
      // (unique). Send it as step_ref and let the server mint the row id.
      step_ref: l.id,
      layer_index: i,
      name: l.name ?? "",
      color: l.color ?? "",
      is_substrate: !!l.isSubstrate,
      layer_type: l.layerType ?? "",
      thickness_nm: l.thicknessNm ?? "",
      bandgap_ev: l.bandgapEv ?? "",
      perovskite_a: l.perovskiteA ?? "",
      perovskite_b: l.perovskiteB ?? "",
      perovskite_x: l.perovskiteX ?? "",
      material_type: l.materialType ?? "",
      homo_ev: l.homoEv ?? "",
      lumo_ev: l.lumoEv ?? "",
    })),
  }))
  for (const comb of p.deletedStackCombinations ?? []) {
    stacks.push({ combination: comb, is_deleted: true, layers: [] })
  }
  return stacks
}

export function inlineSubstratesToApi(p: Process): ApiObj[] {
  return (p.inlineSubstrates ?? []).map((s) => ({
    id: s.id,
    name: s.name || "substrate",
    rigidity: s.rigidity ?? null,
    length_cm: s.lengthCm ?? null,
    width_cm: s.widthCm ?? null,
    height_mm: s.heightMm ?? null,
    surface_roughness_rms_nm: s.surfaceRoughnessRmsNm ?? null,
  }))
}

export function substrateDimensionsToApi(p: Process): ApiObj[] {
  const ids = new Set<string>([
    ...(p.substrateIds ?? []),
    ...Object.keys(p.substrateDimensionsById ?? {}),
  ])
  return [...ids].map((mid) => {
    const d = p.substrateDimensionsById?.[mid]
    return {
      material_id: mid,
      length_cm: d?.lengthCm ?? null,
      width_cm: d?.widthCm ?? null,
      height_mm: d?.heightMm ?? null,
      surface_roughness_rms_nm: d?.surfaceRoughnessRmsNm ?? null,
    }
  })
}

export function experimentToApi(
  e: Experiment,
  place: Placement,
  knownProcessIds: Set<string>,
): ApiObj {
  return {
    id: e.id,
    name: e.name || "Untitled Experiment",
    description: e.description ?? null,
    plane_id: place.planeByEntity.get(e.id) ?? null,
    collection_id: place.collectionByEntity.get(e.id) ?? null,
    process_id:
      e.processId && knownProcessIds.has(e.processId) ? e.processId : null,
    architecture: e.architecture ?? null,
    substrate_material: e.substrateMaterial ?? null,
    substrate_width: e.substrateWidth ?? null,
    substrate_length: e.substrateLength ?? null,
    num_substrates: e.numSubstrates ?? null,
    devices_per_substrate: e.devicesPerSubstrate ?? null,
    device_area: e.deviceArea ?? null,
    device_type: e.deviceType ?? null,
    device_layout_image: e.deviceLayoutImage ?? null,
    date: e.date || null,
    end_date: e.endDate || null,
    has_results: !!e.hasResults,
    has_completed_upload: !!e.hasCompletedUpload,
    chemicals_prep: e.chemicalsPrep ?? null,
    processing_times: e.processingTimes ?? null,
  }
}

export function substratesToApi(e: Experiment): ApiObj[] {
  return e.substrates.map((s) => ({
    id: s.id,
    name: s.name || "substrate",
    substrate_material_id: s.substrateMaterialId || null,
    notes: s.notes ?? null,
    outcome_status: s.outcome?.status ?? null,
    outcome_stopped_at_step: s.outcome?.stoppedAtStep ?? null,
    outcome_discard_reason: s.outcome?.discardReason ?? null,
    parameter_values: s.parameterValues ?? null,
  }))
}

export function resultsToApi(r: ExperimentResults, place: Placement): ApiObj {
  return {
    id: r.id,
    plane_id: place.planeByEntity.get(r.id) ?? null,
    collection_id: place.collectionByEntity.get(r.id) ?? null,
    grouping_strategy: r.groupingStrategy ?? null,
    matching_strategy: r.matchingStrategy ?? null,
    nomad_upload_id: r.nomad?.upload_id ?? null,
    nomad_upload_time: r.nomad?.upload_time ?? null,
    nomad_upload_status: r.nomad?.status ?? null,
    nomad_entries: r.nomad?.entries ?? null,
  }
}

export function measurementFilesToApi(r: ExperimentResults): ApiObj[] {
  return r.files.map((f) => ({
    id: f.id,
    filename: f.fileName || "file",
    file_type: f.fileType || "Unknown",
    device_name: f.deviceName ?? null,
    cell: f.cell ?? null,
    pixel_label: f.pixel ?? null,
    value: f.value ?? null,
    voc: f.voc ?? null,
    jsc: f.jsc ?? null,
    ff: f.ff ?? null,
    measurement_date: f.measurementDate ?? null,
    measurement_user: f.user ?? null,
  }))
}

export function deviceGroupsToApi(r: ExperimentResults): ApiObj[] {
  return r.deviceGroups.map((g) => ({
    id: g.id,
    name: g.deviceName || "group",
    assigned_substrate_id: g.assignedSubstrateId ?? null,
    suggested_substrate_id: g.suggestedSubstrateId ?? null,
    match_score: g.matchScore ?? null,
  }))
}

export function planeToApi(pl: Plane): ApiObj {
  return {
    id: pl.id,
    name: pl.name || "Plane",
    folder_id: pl.folderId ?? null,
    position: pl.position ?? 0,
  }
}

function folderFromApi(f: ApiObj): PlaneFolder {
  return {
    id: f.id,
    name: f.name,
    position: f.position ?? 0,
    ownerId: f.owner_id,
  }
}

export function folderToApi(f: PlaneFolder): ApiObj {
  return { id: f.id, name: f.name || "Folder", position: f.position ?? 0 }
}

export function stickyNotesToApi(pl: Plane): ApiObj[] {
  return pl.elements
    .filter((e): e is CanvasTextElement => e.type === "text")
    .map(canvasNoteToApi)
}

export function textFieldsToApi(pl: Plane): ApiObj[] {
  return pl.elements
    .filter((e): e is CanvasPlainTextElement => e.type === "plaintext")
    .map(canvasNoteToApi)
}

function canvasNoteToApi(
  el: CanvasTextElement | CanvasPlainTextElement,
): ApiObj {
  return {
    id: el.id,
    i: int(el.position.y),
    j: int(el.position.x),
    di: atLeast1(el.size.y),
    dj: atLeast1(el.size.x),
    content: el.content ?? null,
    color: el.color ?? null,
    fmt_bold: el.formatting?.bold ?? null,
    fmt_italic: el.formatting?.italic ?? null,
    fmt_underline: el.formatting?.underline ?? null,
    fmt_font_size: el.formatting?.fontSize ?? null,
    hyperlink: null,
  }
}

export function collectionsToApi(pl: Plane): ApiObj[] {
  return pl.elements
    .filter((e): e is CanvasCollectionElement => e.type === "collection")
    .map((el) => ({
      id: el.id,
      i: int(el.position.y),
      j: int(el.position.x),
      name: el.name || "Collection",
      color: el.color ?? null,
    }))
}

// Line elements are deprecated (Task 4) and have no backend representation; they
// are intentionally dropped on persist.
