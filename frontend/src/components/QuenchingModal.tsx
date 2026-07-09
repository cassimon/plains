import type { AutocompleteProps, SelectProps } from "@mantine/core"
import {
  ActionIcon,
  Autocomplete,
  Box,
  Button,
  Group,
  Modal,
  NumberInput,
  SegmentedControl,
  Select,
  SimpleGrid,
  Stack,
  Text,
  TextInput,
} from "@mantine/core"
import { IconSearch, IconX } from "@tabler/icons-react"
import { useEffect, useRef, useState } from "react"

// ─────────────────────────────────────────────────────────────────────────────
// Common antisolvent abbreviations → PubChem search query
// ─────────────────────────────────────────────────────────────────────────────

const ANTISOLVENT_SUGGESTIONS: ReadonlyArray<{
  abbr: string
  name: string
  searchQuery: string
}> = [
  { abbr: "CB", name: "Chlorobenzene", searchQuery: "Chlorobenzene" },
  {
    abbr: "DCB",
    name: "1,2-Dichlorobenzene",
    searchQuery: "1,2-Dichlorobenzene",
  },
  {
    abbr: "oDCB",
    name: "o-Dichlorobenzene",
    searchQuery: "1,2-Dichlorobenzene",
  },
  { abbr: "Toluene", name: "Toluene", searchQuery: "Toluene" },
  { abbr: "Anisole", name: "Anisole", searchQuery: "Anisole" },
  { abbr: "Et2O", name: "Diethyl ether", searchQuery: "Diethyl ether" },
  { abbr: "CHCl3", name: "Chloroform", searchQuery: "Chloroform" },
  { abbr: "EtAc", name: "Ethyl acetate", searchQuery: "Ethyl acetate" },
  { abbr: "MeAc", name: "Methyl acetate", searchQuery: "Methyl acetate" },
  { abbr: "ACN", name: "Acetonitrile", searchQuery: "Acetonitrile" },
  { abbr: "IPA", name: "Isopropanol", searchQuery: "Isopropyl alcohol" },
  { abbr: "Acetone", name: "Acetone", searchQuery: "Acetone" },
  {
    abbr: "DMF",
    name: "N,N-Dimethylformamide",
    searchQuery: "N,N-Dimethylformamide",
  },
  {
    abbr: "DMSO",
    name: "Dimethyl sulfoxide",
    searchQuery: "Dimethyl sulfoxide",
  },
]

type PubChemSearchHit = { cid: string; title: string; formula: string }

async function searchPubChemByName(query: string): Promise<PubChemSearchHit[]> {
  const cidRes = await fetch(
    `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(query)}/cids/JSON`,
  )
  if (!cidRes.ok) return []
  const cidData = (await cidRes.json()) as {
    IdentifierList?: { CID?: number[] }
  }
  const cids = (cidData.IdentifierList?.CID ?? []).slice(0, 10)
  if (cids.length === 0) return []
  const propRes = await fetch(
    `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cids.join(",")}/property/Title,MolecularFormula/JSON`,
  )
  if (!propRes.ok) return []
  const propData = (await propRes.json()) as {
    PropertyTable?: {
      Properties?: Array<{
        CID: number
        Title?: string
        MolecularFormula?: string
      }>
    }
  }
  return (propData.PropertyTable?.Properties ?? []).map((p) => ({
    cid: String(p.CID),
    title: p.Title ?? `CID ${p.CID}`,
    formula: p.MolecularFormula ?? "",
  }))
}

// Wrappers that keep combobox dropdowns inside the Modal portal so they don't
// trigger the modal close via outside-click / focus-trap detection.
function ModalSelect(props: SelectProps) {
  return <Select comboboxProps={{ withinPortal: false }} {...props} />
}
function ModalAutocomplete(props: AutocompleteProps) {
  return <Autocomplete comboboxProps={{ withinPortal: false }} {...props} />
}

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export type QuenchingType = "Gas" | "Antisolvent" | "Vacuum"

type MediaReference = {
  kind: "material" | "solution" | "recipe"
  id: string
}

interface GasState {
  gasType: string
  pressure: string
  pressureUnit: "Pa" | "Psi"
  flowRate: string
  flowRateUnit: "Slm" | "m/s"
  height: string
  heightUnit: "mm" | "cm"
  nozzleWidth: string
  nozzleWidthUnit: "mm" | "cm"
  nozzleForm: string
  timeUntilStart: string
}

interface AntisolventState {
  media: string
  mediaPubChemCid: string
  flowRate: string
  depositionMethod: string
  height: string
  heightUnit: "mm" | "cm"
  volume: string
  timeUntilStart: string
}

interface VacuumState {
  height: string
  heightUnit: "mm" | "cm"
  baseArea: string
  baseAreaUnit: "cm2" | "m2"
  pumpModel: string
  deadVolume: string
  evacuationTime: string
  timeUntilStart: string
}

// ─────────────────────────────────────────────────────────────────────────────
// Defaults
// ─────────────────────────────────────────────────────────────────────────────

function defaultGas(): GasState {
  return {
    gasType: "",
    pressure: "",
    pressureUnit: "Pa",
    flowRate: "",
    flowRateUnit: "Slm",
    height: "",
    heightUnit: "mm",
    nozzleWidth: "",
    nozzleWidthUnit: "mm",
    nozzleForm: "",
    timeUntilStart: "",
  }
}

function defaultAntisolvent(): AntisolventState {
  return {
    media: "",
    mediaPubChemCid: "",
    flowRate: "",
    depositionMethod: "",
    height: "",
    heightUnit: "mm",
    volume: "",
    timeUntilStart: "",
  }
}

function defaultVacuum(): VacuumState {
  return {
    height: "",
    heightUnit: "mm",
    baseArea: "",
    baseAreaUnit: "cm2",
    pumpModel: "",
    deadVolume: "",
    evacuationTime: "",
    timeUntilStart: "",
  }
}

function parseMediaReference(value: string): MediaReference | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const idx = trimmed.indexOf(":")
  if (idx === -1) return null
  const kind = trimmed.slice(0, idx)
  const id = trimmed.slice(idx + 1).trim()
  if (!id || (kind !== "material" && kind !== "solution" && kind !== "recipe"))
    return null
  return { kind, id }
}

function getMediaLabel(
  value: string,
  materials: Array<{ id: string; name: string }>,
  solutions: Array<{ id: string; name: string }>,
  recipes?: Array<{ id: string; name: string }>,
): string {
  const ref = parseMediaReference(value)
  if (!ref) return value
  if (ref.kind === "material") {
    return (
      materials.find((material) => material.id === ref.id)?.name ||
      "Unnamed material"
    )
  }
  if (ref.kind === "recipe") {
    return recipes?.find((r) => r.id === ref.id)?.name || "Unnamed solution"
  }
  return (
    solutions.find((solution) => solution.id === ref.id)?.name ||
    "Unnamed solution"
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// String serialisation / deserialisation
// ─────────────────────────────────────────────────────────────────────────────

/** Compress quenching parameters to a pipe-delimited key=value string. */
function buildQuenchingString(
  type: QuenchingType,
  gas: GasState,
  antisolvent: AntisolventState,
  vacuum: VacuumState,
): string {
  const parts: string[] = [`type=${type}`]

  if (type === "Gas") {
    if (gas.gasType) parts.push(`gasType=${gas.gasType}`)
    if (gas.pressure) parts.push(`pressure=${gas.pressure} ${gas.pressureUnit}`)
    if (gas.flowRate) parts.push(`flowRate=${gas.flowRate} ${gas.flowRateUnit}`)
    if (gas.height) parts.push(`height=${gas.height} ${gas.heightUnit}`)
    if (gas.nozzleWidth)
      parts.push(`nozzleWidth=${gas.nozzleWidth} ${gas.nozzleWidthUnit}`)
    if (gas.nozzleForm) parts.push(`nozzleForm=${gas.nozzleForm}`)
    if (gas.timeUntilStart) parts.push(`timeUntilStart=${gas.timeUntilStart}`)
  } else if (type === "Antisolvent") {
    if (antisolvent.media) parts.push(`media=${antisolvent.media}`)
    if (antisolvent.mediaPubChemCid)
      parts.push(`mediaCid=${antisolvent.mediaPubChemCid}`)
    if (antisolvent.flowRate)
      parts.push(`flowRate=${antisolvent.flowRate} ul/s`)
    if (antisolvent.depositionMethod)
      parts.push(`depositionMethod=${antisolvent.depositionMethod}`)
    if (antisolvent.height)
      parts.push(`height=${antisolvent.height} ${antisolvent.heightUnit}`)
    if (antisolvent.volume) parts.push(`volume=${antisolvent.volume} mL`)
    if (antisolvent.timeUntilStart)
      parts.push(`timeUntilStart=${antisolvent.timeUntilStart}`)
  } else if (type === "Vacuum") {
    if (vacuum.height)
      parts.push(`height=${vacuum.height} ${vacuum.heightUnit}`)
    if (vacuum.baseArea)
      parts.push(`baseArea=${vacuum.baseArea} ${vacuum.baseAreaUnit}`)
    if (vacuum.pumpModel) parts.push(`pumpModel=${vacuum.pumpModel}`)
    if (vacuum.deadVolume) parts.push(`deadVolume=${vacuum.deadVolume} m3`)
    if (vacuum.evacuationTime)
      parts.push(`evacuationTime=${vacuum.evacuationTime} s`)
    if (vacuum.timeUntilStart)
      parts.push(`timeUntilStart=${vacuum.timeUntilStart}`)
  }

  return parts.join("|")
}

/** Parse a quenching string back into form state. */
function parseQuenchingValue(value: string): {
  type: QuenchingType
  gas: GasState
  antisolvent: AntisolventState
  vacuum: VacuumState
} {
  const base = {
    type: "Gas" as QuenchingType,
    gas: defaultGas(),
    antisolvent: defaultAntisolvent(),
    vacuum: defaultVacuum(),
  }

  if (!value) return base

  const pairs: Record<string, string> = {}
  value.split("|").forEach((segment) => {
    const idx = segment.indexOf("=")
    if (idx === -1) return
    pairs[segment.slice(0, idx).trim()] = segment.slice(idx + 1).trim()
  })

  const rawType = pairs.type
  if (!rawType || !["Gas", "Antisolvent", "Vacuum"].includes(rawType))
    return base
  const type = rawType as QuenchingType
  base.type = type

  if (type === "Gas") {
    const gas = defaultGas()
    if (pairs.gasType) gas.gasType = pairs.gasType
    if (pairs.pressure) {
      const parts = pairs.pressure.split(" ")
      gas.pressure = parts[0] ?? ""
      gas.pressureUnit = (
        parts[1] === "Psi" ? "Psi" : "Pa"
      ) as GasState["pressureUnit"]
    }
    if (pairs.flowRate) {
      const parts = pairs.flowRate.split(" ")
      gas.flowRate = parts[0] ?? ""
      gas.flowRateUnit = (
        parts[1] === "m/s" ? "m/s" : "Slm"
      ) as GasState["flowRateUnit"]
    }
    if (pairs.height) {
      const parts = pairs.height.split(" ")
      gas.height = parts[0] ?? ""
      gas.heightUnit = (
        parts[1] === "cm" ? "cm" : "mm"
      ) as GasState["heightUnit"]
    }
    if (pairs.nozzleWidth) {
      const parts = pairs.nozzleWidth.split(" ")
      gas.nozzleWidth = parts[0] ?? ""
      gas.nozzleWidthUnit = (
        parts[1] === "cm" ? "cm" : "mm"
      ) as GasState["nozzleWidthUnit"]
    }
    if (pairs.nozzleForm) gas.nozzleForm = pairs.nozzleForm
    if (pairs.timeUntilStart) gas.timeUntilStart = pairs.timeUntilStart
    base.gas = gas
  } else if (type === "Antisolvent") {
    const anti = defaultAntisolvent()
    if (pairs.media) anti.media = pairs.media
    if (pairs.material) anti.media = pairs.material
    if (pairs.mediaCid) anti.mediaPubChemCid = pairs.mediaCid
    if (pairs.flowRate) {
      const parts = pairs.flowRate.split(" ")
      anti.flowRate = parts[0] ?? ""
    }
    if (pairs.depositionMethod) anti.depositionMethod = pairs.depositionMethod
    if (pairs.height) {
      const parts = pairs.height.split(" ")
      anti.height = parts[0] ?? ""
      anti.heightUnit = (
        parts[1] === "cm" ? "cm" : "mm"
      ) as AntisolventState["heightUnit"]
    }
    if (pairs.volume) {
      const parts = pairs.volume.split(" ")
      anti.volume = parts[0] ?? ""
    }
    // Backward compatibility for older saved values that used pressure.
    if (!anti.volume && pairs.pressure) {
      const parts = pairs.pressure.split(" ")
      anti.volume = parts[0] ?? ""
    }
    if (pairs.timeUntilStart) anti.timeUntilStart = pairs.timeUntilStart
    base.antisolvent = anti
  } else if (type === "Vacuum") {
    const vac = defaultVacuum()
    if (pairs.height) {
      const parts = pairs.height.split(" ")
      vac.height = parts[0] ?? ""
      vac.heightUnit = (
        parts[1] === "cm" ? "cm" : "mm"
      ) as VacuumState["heightUnit"]
    }
    if (pairs.baseArea) {
      const parts = pairs.baseArea.split(" ")
      vac.baseArea = parts[0] ?? ""
      vac.baseAreaUnit = (
        parts[1] === "m2" ? "m2" : "cm2"
      ) as VacuumState["baseAreaUnit"]
    }
    if (pairs.pumpModel) vac.pumpModel = pairs.pumpModel
    if (pairs.deadVolume) {
      const parts = pairs.deadVolume.split(" ")
      vac.deadVolume = parts[0] ?? ""
    }
    if (pairs.evacuationTime) {
      const parts = pairs.evacuationTime.split(" ")
      vac.evacuationTime = parts[0] ?? ""
    }
    if (pairs.timeUntilStart) vac.timeUntilStart = pairs.timeUntilStart
    base.vacuum = vac
  }

  return base
}

// ─────────────────────────────────────────────────────────────────────────────
// PDF-facing helpers — expose the individual quenching parameters as editable
// scalar fields so an exported PDF can round-trip them (see lib/processExport.ts
// and lib/pdfImport.ts). The quenching TYPE stays read-only: switching type
// changes the whole field set, which a flat PDF form cannot express coherently.
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a `type=…|k=v|…` quenching string into a flat key→value map. */
export function parseQuenchingPairs(value: string): Record<string, string> {
  const pairs: Record<string, string> = {}
  if (!value) return pairs
  value.split("|").forEach((segment) => {
    const idx = segment.indexOf("=")
    if (idx === -1) return
    pairs[segment.slice(0, idx).trim()] = segment.slice(idx + 1).trim()
  })
  return pairs
}

type QuenchFieldMeta = {
  key: string
  label: string
  numeric: boolean
  editable: boolean
  /** Stored as `"<scalar> <unit>"` — split the unit off before editing. */
  hasUnit: boolean
}

const QUENCH_FIELD_META: Record<QuenchingType, QuenchFieldMeta[]> = {
  Gas: [
    {
      key: "gasType",
      label: "Gas type",
      numeric: false,
      editable: true,
      hasUnit: false,
    }, // prettier-ignore
    {
      key: "pressure",
      label: "Pressure",
      numeric: true,
      editable: true,
      hasUnit: true,
    },
    {
      key: "flowRate",
      label: "Flow rate",
      numeric: true,
      editable: true,
      hasUnit: true,
    },
    {
      key: "height",
      label: "Nozzle height",
      numeric: true,
      editable: true,
      hasUnit: true,
    }, // prettier-ignore
    {
      key: "nozzleWidth",
      label: "Nozzle width",
      numeric: true,
      editable: true,
      hasUnit: true,
    }, // prettier-ignore
    {
      key: "nozzleForm",
      label: "Nozzle form",
      numeric: false,
      editable: true,
      hasUnit: false,
    }, // prettier-ignore
    {
      key: "timeUntilStart",
      label: "Time until start (s)",
      numeric: true,
      editable: true,
      hasUnit: false,
    }, // prettier-ignore
  ],
  Antisolvent: [
    {
      key: "media",
      label: "Media",
      numeric: false,
      editable: false,
      hasUnit: false,
    },
    {
      key: "depositionMethod",
      label: "Deposition method",
      numeric: false,
      editable: true,
      hasUnit: false,
    }, // prettier-ignore
    {
      key: "flowRate",
      label: "Flow rate",
      numeric: true,
      editable: true,
      hasUnit: true,
    },
    {
      key: "height",
      label: "Height",
      numeric: true,
      editable: true,
      hasUnit: true,
    },
    {
      key: "volume",
      label: "Volume",
      numeric: true,
      editable: true,
      hasUnit: true,
    },
    {
      key: "timeUntilStart",
      label: "Time until start (s)",
      numeric: true,
      editable: true,
      hasUnit: false,
    }, // prettier-ignore
  ],
  Vacuum: [
    {
      key: "height",
      label: "Height",
      numeric: true,
      editable: true,
      hasUnit: true,
    },
    {
      key: "baseArea",
      label: "Base area",
      numeric: true,
      editable: true,
      hasUnit: true,
    },
    {
      key: "pumpModel",
      label: "Pump model",
      numeric: false,
      editable: true,
      hasUnit: false,
    }, // prettier-ignore
    {
      key: "deadVolume",
      label: "Dead volume",
      numeric: true,
      editable: true,
      hasUnit: true,
    }, // prettier-ignore
    {
      key: "evacuationTime",
      label: "Evacuation time",
      numeric: true,
      editable: true,
      hasUnit: true,
    }, // prettier-ignore
    {
      key: "timeUntilStart",
      label: "Time until start (s)",
      numeric: true,
      editable: true,
      hasUnit: false,
    }, // prettier-ignore
  ],
}

/** Numeric-ness of a quenching sub-key is stable across types (import validation). */
export const QUENCH_NUMERIC_KEYS = new Set<string>([
  "pressure",
  "flowRate",
  "height",
  "nozzleWidth",
  "volume",
  "baseArea",
  "deadVolume",
  "evacuationTime",
  "timeUntilStart",
])

export function isNumericQuenchKey(key: string): boolean {
  return QUENCH_NUMERIC_KEYS.has(key)
}

export type QuenchingField = {
  key: string
  label: string
  /** Editable scalar (unit stripped), or a display label for read-only fields. */
  value: string
  unit?: string
  editable: boolean
  numeric: boolean
}

/**
 * Decode a quenching string into the fields that are actually SET, ready to be
 * placed as editable PDF form fields. `resolveMedia` turns a media reference
 * (`material:<id>` etc.) into a human name for the read-only media field.
 */
export function quenchingFields(
  value: string,
  resolveMedia?: (raw: string) => string,
): { type: QuenchingType | null; fields: QuenchingField[] } {
  const pairs = parseQuenchingPairs(value)
  const rawType = pairs.type
  if (!rawType || !(rawType in QUENCH_FIELD_META)) {
    return { type: null, fields: [] }
  }
  const type = rawType as QuenchingType
  const fields: QuenchingField[] = []
  for (const meta of QUENCH_FIELD_META[type]) {
    const raw =
      meta.key === "media" ? (pairs.media ?? pairs.material) : pairs[meta.key] // prettier-ignore
    if (raw === undefined || raw === "") continue
    if (meta.key === "media") {
      fields.push({
        key: meta.key,
        label: meta.label,
        value: resolveMedia ? resolveMedia(raw) : raw,
        editable: false,
        numeric: false,
      })
      continue
    }
    let scalar = raw
    let unit: string | undefined
    if (meta.hasUnit) {
      const i = raw.indexOf(" ")
      if (i >= 0) {
        scalar = raw.slice(0, i)
        unit = raw.slice(i + 1)
      }
    }
    fields.push({
      key: meta.key,
      label: meta.label,
      value: scalar,
      unit,
      editable: meta.editable,
      numeric: meta.numeric,
    })
  }
  return { type, fields }
}

/**
 * Apply a single edited scalar back into a quenching string, preserving the
 * field's original unit and every other (untouched) parameter. An empty scalar
 * clears the parameter. Returns the string unchanged for unknown keys.
 */
export function updateQuenchingField(
  value: string,
  key: string,
  scalar: string,
): string {
  const pairs = parseQuenchingPairs(value)
  const rawType = pairs.type
  if (!rawType || !(rawType in QUENCH_FIELD_META)) return value
  const type = rawType as QuenchingType
  const meta = QUENCH_FIELD_META[type].find((m) => m.key === key)
  if (!meta?.editable) return value

  const trimmed = scalar.trim()
  if (trimmed === "") {
    delete pairs[key]
  } else if (meta.hasUnit) {
    const old = pairs[key] ?? ""
    const i = old.indexOf(" ")
    const unit = i >= 0 ? old.slice(i + 1) : ""
    pairs[key] = unit ? `${trimmed} ${unit}` : trimmed
  } else {
    pairs[key] = trimmed
  }

  return [
    `type=${type}`,
    ...Object.entries(pairs)
      .filter(([k]) => k !== "type")
      .map(([k, v]) => `${k}=${v}`),
  ].join("|")
}

// ─────────────────────────────────────────────────────────────────────────────
// Sub-forms
// ─────────────────────────────────────────────────────────────────────────────

function FieldLabel({ children }: { children: React.ReactNode }) {
  return (
    <Text size="xs" fw={500} mb={2}>
      {children}
    </Text>
  )
}

function GasForm({
  state,
  onChange,
}: {
  state: GasState
  onChange: (s: GasState) => void
}) {
  function set(patch: Partial<GasState>) {
    onChange({ ...state, ...patch })
  }

  return (
    <SimpleGrid cols={2} spacing="sm" verticalSpacing="sm">
      <Box>
        <FieldLabel>Gas Type</FieldLabel>
        <ModalAutocomplete
          size="xs"
          data={["N2", "Air", "O2", "Ar", "He"]}
          value={state.gasType}
          onChange={(v) => set({ gasType: v })}
          placeholder="e.g. N2"
        />
      </Box>

      <Box>
        <FieldLabel>Flow Rate / Pressure Unit</FieldLabel>
        <Group gap="xs" align="flex-end">
          <NumberInput
            size="xs"
            value={state.flowRate !== "" ? Number(state.flowRate) : ""}
            onChange={(v) =>
              set({ flowRate: typeof v === "number" ? String(v) : "" })
            }
            placeholder="Flow rate"
            style={{ flex: 1 }}
            min={0}
          />
          <ModalSelect
            size="xs"
            data={["Slm", "m/s"]}
            value={state.flowRateUnit}
            onChange={(v) =>
              set({ flowRateUnit: (v ?? "Slm") as GasState["flowRateUnit"] })
            }
            style={{ width: 70 }}
          />
        </Group>
      </Box>

      <Box>
        <FieldLabel>Pressure</FieldLabel>
        <Group gap="xs" align="flex-end">
          <NumberInput
            size="xs"
            value={state.pressure !== "" ? Number(state.pressure) : ""}
            onChange={(v) =>
              set({ pressure: typeof v === "number" ? String(v) : "" })
            }
            placeholder="Value"
            style={{ flex: 1 }}
            min={0}
          />
          <ModalSelect
            size="xs"
            data={["Pa", "Psi"]}
            value={state.pressureUnit}
            onChange={(v) =>
              set({ pressureUnit: (v ?? "Pa") as GasState["pressureUnit"] })
            }
            style={{ width: 70 }}
          />
        </Group>
      </Box>

      <Box>
        <FieldLabel>Height</FieldLabel>
        <Group gap="xs" align="flex-end">
          <NumberInput
            size="xs"
            value={state.height !== "" ? Number(state.height) : ""}
            onChange={(v) =>
              set({ height: typeof v === "number" ? String(v) : "" })
            }
            placeholder="Value"
            style={{ flex: 1 }}
            min={0}
          />
          <ModalSelect
            size="xs"
            data={["mm", "cm"]}
            value={state.heightUnit}
            onChange={(v) =>
              set({ heightUnit: (v ?? "mm") as GasState["heightUnit"] })
            }
            style={{ width: 70 }}
          />
        </Group>
      </Box>

      <Box>
        <FieldLabel>Nozzle Width</FieldLabel>
        <Group gap="xs" align="flex-end">
          <NumberInput
            size="xs"
            value={state.nozzleWidth !== "" ? Number(state.nozzleWidth) : ""}
            onChange={(v) =>
              set({ nozzleWidth: typeof v === "number" ? String(v) : "" })
            }
            placeholder="Value"
            style={{ flex: 1 }}
            min={0}
          />
          <ModalSelect
            size="xs"
            data={["mm", "cm"]}
            value={state.nozzleWidthUnit}
            onChange={(v) =>
              set({
                nozzleWidthUnit: (v ?? "mm") as GasState["nozzleWidthUnit"],
              })
            }
            style={{ width: 70 }}
          />
        </Group>
      </Box>

      <Box>
        <FieldLabel>Nozzle Form</FieldLabel>
        <ModalAutocomplete
          size="xs"
          data={["round", "slit", "wide"]}
          value={state.nozzleForm}
          onChange={(v) => set({ nozzleForm: v })}
          placeholder="e.g. round"
        />
      </Box>

      <Box style={{ gridColumn: "span 2" }}>
        <FieldLabel>Time until Start (s)</FieldLabel>
        <NumberInput
          size="xs"
          value={
            state.timeUntilStart !== "" ? Number(state.timeUntilStart) : ""
          }
          onChange={(v) =>
            set({ timeUntilStart: typeof v === "number" ? String(v) : "" })
          }
          placeholder="e.g. 10"
          min={0}
        />
      </Box>
    </SimpleGrid>
  )
}

function AntisolventForm({
  state,
  onChange,
  processSolutionRecipes = [],
}: {
  state: AntisolventState
  onChange: (s: AntisolventState) => void
  processSolutionRecipes?: Array<{ id: string; name: string }>
}) {
  type SearchState =
    | { kind: "idle" }
    | {
        kind: "active"
        query: string
        loading: boolean
        hits: PubChemSearchHit[]
        error: string | null
      }

  const [searchState, setSearchState] = useState<SearchState>({ kind: "idle" })
  const [highlightedIdx, setHighlightedIdx] = useState(-1)
  const searchRef = useRef<HTMLInputElement>(null)

  function set(patch: Partial<AntisolventState>) {
    onChange({ ...state, ...patch })
  }

  const filteredSuggestions =
    searchState.kind === "active" && searchState.query.length > 0
      ? ANTISOLVENT_SUGGESTIONS.filter((s) => {
          const q = searchState.query.toLowerCase()
          return (
            s.abbr.toLowerCase().startsWith(q) ||
            s.name.toLowerCase().startsWith(q) ||
            s.name.toLowerCase().includes(q)
          )
        }).slice(0, 6)
      : []

  const showSuggestions =
    searchState.kind === "active" &&
    filteredSuggestions.length > 0 &&
    searchState.hits.length === 0 &&
    !searchState.loading

  const doSearchWithQuery = async (q: string) => {
    const trimmed = q.trim()
    if (!trimmed) return
    setHighlightedIdx(-1)
    setSearchState((prev) =>
      prev.kind === "active"
        ? { ...prev, query: trimmed, loading: true, error: null, hits: [] }
        : prev,
    )
    try {
      const hits = await searchPubChemByName(trimmed)
      setSearchState((prev) =>
        prev.kind === "active"
          ? {
              ...prev,
              loading: false,
              hits,
              error: hits.length === 0 ? "No compounds found." : null,
            }
          : prev,
      )
    } catch {
      setSearchState((prev) =>
        prev.kind === "active"
          ? { ...prev, loading: false, error: "Search failed." }
          : prev,
      )
    }
  }

  const doSearch = () => {
    if (searchState.kind !== "active") return
    doSearchWithQuery(searchState.query)
  }

  const handleHitSelect = (hit: PubChemSearchHit) => {
    set({ media: hit.title, mediaPubChemCid: hit.cid })
    setSearchState({ kind: "idle" })
    setHighlightedIdx(-1)
  }

  const mediaDisplayName = state.media
    ? getMediaLabel(state.media, [], [], processSolutionRecipes)
    : ""

  return (
    <SimpleGrid cols={2} spacing="sm" verticalSpacing="sm">
      <Box style={{ gridColumn: "span 2" }}>
        <FieldLabel>Antisolvent</FieldLabel>

        {/* Current selection */}
        {state.media && (
          <Group gap="xs" mb={6} wrap="nowrap">
            <Text size="xs" fw={600} style={{ flex: 1 }} truncate>
              {mediaDisplayName}
              {state.mediaPubChemCid && !state.media.startsWith("recipe:") && (
                <Text span size="xs" c="dimmed">
                  {" "}
                  (CID {state.mediaPubChemCid})
                </Text>
              )}
            </Text>
            <ActionIcon
              size="xs"
              variant="subtle"
              color="red"
              onClick={() => set({ media: "", mediaPubChemCid: "" })}
            >
              <IconX size={10} />
            </ActionIcon>
          </Group>
        )}

        {/* Process solution recipe chips */}
        {processSolutionRecipes.length > 0 && (
          <Box mb={8}>
            <Text size="xs" c="dimmed" mb={4}>
              Process solutions:
            </Text>
            <Group gap={4} wrap="wrap">
              {processSolutionRecipes.map((r) => (
                <Button
                  key={r.id}
                  size="xs"
                  variant={
                    state.media === `recipe:${r.id}` ? "filled" : "light"
                  }
                  color="teal"
                  onClick={() => {
                    set({ media: `recipe:${r.id}`, mediaPubChemCid: "" })
                    setSearchState({ kind: "idle" })
                  }}
                >
                  {r.name || "Unnamed"}
                </Button>
              ))}
            </Group>
          </Box>
        )}

        {/* PubChem inline search */}
        {searchState.kind === "idle" ? (
          <Button
            size="xs"
            variant="subtle"
            leftSection={<IconSearch size={12} />}
            onClick={() =>
              setSearchState({
                kind: "active",
                query: "",
                loading: false,
                hits: [],
                error: null,
              })
            }
          >
            Search PubChem
          </Button>
        ) : (
          <Stack gap="xs">
            <Group gap="xs" wrap="nowrap">
              <TextInput
                ref={searchRef}
                size="xs"
                placeholder="e.g. Chlorobenzene, CB, Toluene…"
                value={searchState.query}
                onChange={(e) => {
                  setHighlightedIdx(-1)
                  setSearchState({
                    ...searchState,
                    query: e.currentTarget.value,
                  })
                }}
                onKeyDown={(e) => {
                  if (e.key === "ArrowDown") {
                    e.preventDefault()
                    setHighlightedIdx((prev) =>
                      Math.min(prev + 1, filteredSuggestions.length - 1),
                    )
                  } else if (e.key === "ArrowUp") {
                    e.preventDefault()
                    setHighlightedIdx((prev) => Math.max(prev - 1, -1))
                  } else if (e.key === "Enter") {
                    if (
                      highlightedIdx >= 0 &&
                      filteredSuggestions[highlightedIdx]
                    ) {
                      doSearchWithQuery(
                        filteredSuggestions[highlightedIdx].searchQuery,
                      )
                    } else {
                      doSearch()
                    }
                  } else if (e.key === "Escape") {
                    setSearchState({ kind: "idle" })
                  }
                }}
                style={{ flex: 1 }}
              />
              <ActionIcon
                size="sm"
                variant="filled"
                onClick={doSearch}
                loading={searchState.loading}
              >
                <IconSearch size={13} />
              </ActionIcon>
              <ActionIcon
                size="sm"
                variant="subtle"
                onClick={() => setSearchState({ kind: "idle" })}
              >
                <IconX size={13} />
              </ActionIcon>
            </Group>

            {showSuggestions && (
              <Box
                style={{
                  border:
                    "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
                  borderRadius: 6,
                  overflow: "hidden",
                  boxShadow: "0 2px 8px rgba(0,0,0,0.06)",
                }}
              >
                {filteredSuggestions.map((s, idx) => (
                  <Box
                    key={`${s.abbr}-${idx}`}
                    onClick={() => doSearchWithQuery(s.searchQuery)}
                    onMouseEnter={() => setHighlightedIdx(idx)}
                    style={{
                      padding: "5px 10px",
                      background:
                        idx === highlightedIdx
                          ? "light-dark(var(--mantine-color-blue-0), var(--mantine-color-dark-5))"
                          : "white",
                      cursor: "pointer",
                      display: "flex",
                      alignItems: "center",
                      gap: 8,
                      borderBottom:
                        idx < filteredSuggestions.length - 1
                          ? "1px solid light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-5))"
                          : "none",
                    }}
                  >
                    <Text
                      size="xs"
                      fw={700}
                      style={{ width: 70, flexShrink: 0 }}
                      c="blue.6"
                    >
                      {s.abbr}
                    </Text>
                    <Text size="xs" c="dimmed" style={{ flex: 1 }} truncate>
                      {s.name}
                    </Text>
                  </Box>
                ))}
              </Box>
            )}

            {searchState.error && (
              <Text size="xs" c="red">
                {searchState.error}
              </Text>
            )}

            {searchState.hits.length > 0 && (
              <Stack gap={3} style={{ maxHeight: 160, overflowY: "auto" }}>
                {searchState.hits.map((hit) => (
                  <Box
                    key={hit.cid}
                    onClick={() => handleHitSelect(hit)}
                    style={{
                      padding: "5px 8px",
                      borderRadius: 5,
                      border:
                        "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
                      cursor: "pointer",
                      background:
                        "light-dark(white, var(--mantine-color-dark-6))",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                    }}
                  >
                    <Box>
                      <Text size="xs" fw={600}>
                        {hit.title}
                      </Text>
                      <Text size="xs" c="dimmed">
                        CID {hit.cid}
                        {hit.formula ? ` · ${hit.formula}` : ""}
                      </Text>
                    </Box>
                  </Box>
                ))}
              </Stack>
            )}
          </Stack>
        )}
      </Box>

      <Box>
        <FieldLabel>Deposition Method</FieldLabel>
        <ModalAutocomplete
          size="xs"
          data={["drip", "spray", "bath"]}
          value={state.depositionMethod}
          onChange={(v) => set({ depositionMethod: v })}
          placeholder="e.g. drip"
        />
      </Box>

      <Box>
        <FieldLabel>Flow Rate (µl/s)</FieldLabel>
        <NumberInput
          size="xs"
          value={state.flowRate !== "" ? Number(state.flowRate) : ""}
          onChange={(v) =>
            set({ flowRate: typeof v === "number" ? String(v) : "" })
          }
          placeholder="e.g. 50"
          min={0}
        />
      </Box>

      <Box>
        <FieldLabel>Height</FieldLabel>
        <Group gap="xs" align="flex-end">
          <NumberInput
            size="xs"
            value={state.height !== "" ? Number(state.height) : ""}
            onChange={(v) =>
              set({ height: typeof v === "number" ? String(v) : "" })
            }
            placeholder="Value"
            style={{ flex: 1 }}
            min={0}
          />
          <ModalSelect
            size="xs"
            data={["mm", "cm"]}
            value={state.heightUnit}
            onChange={(v) =>
              set({ heightUnit: (v ?? "mm") as AntisolventState["heightUnit"] })
            }
            style={{ width: 70 }}
          />
        </Group>
      </Box>

      <Box>
        <FieldLabel>Volume (mL)</FieldLabel>
        <NumberInput
          size="xs"
          value={state.volume !== "" ? Number(state.volume) : ""}
          onChange={(v) =>
            set({ volume: typeof v === "number" ? String(v) : "" })
          }
          placeholder="e.g. 0.2"
          min={0}
        />
      </Box>

      <Box style={{ gridColumn: "span 2" }}>
        <FieldLabel>Time until Start (s)</FieldLabel>
        <NumberInput
          size="xs"
          value={
            state.timeUntilStart !== "" ? Number(state.timeUntilStart) : ""
          }
          onChange={(v) =>
            set({ timeUntilStart: typeof v === "number" ? String(v) : "" })
          }
          placeholder="e.g. 10"
          min={0}
        />
      </Box>
    </SimpleGrid>
  )
}

function VacuumForm({
  state,
  onChange,
}: {
  state: VacuumState
  onChange: (s: VacuumState) => void
}) {
  function set(patch: Partial<VacuumState>) {
    onChange({ ...state, ...patch })
  }

  return (
    <SimpleGrid cols={2} spacing="sm" verticalSpacing="sm">
      <Box>
        <FieldLabel>Height</FieldLabel>
        <Group gap="xs" align="flex-end">
          <NumberInput
            size="xs"
            value={state.height !== "" ? Number(state.height) : ""}
            onChange={(v) =>
              set({ height: typeof v === "number" ? String(v) : "" })
            }
            placeholder="Value"
            style={{ flex: 1 }}
            min={0}
          />
          <ModalSelect
            size="xs"
            data={["mm", "cm"]}
            value={state.heightUnit}
            onChange={(v) =>
              set({ heightUnit: (v ?? "mm") as VacuumState["heightUnit"] })
            }
            style={{ width: 70 }}
          />
        </Group>
      </Box>

      <Box>
        <FieldLabel>Base Area</FieldLabel>
        <Group gap="xs" align="flex-end">
          <NumberInput
            size="xs"
            value={state.baseArea !== "" ? Number(state.baseArea) : ""}
            onChange={(v) =>
              set({ baseArea: typeof v === "number" ? String(v) : "" })
            }
            placeholder="Value"
            style={{ flex: 1 }}
            min={0}
          />
          <ModalSelect
            size="xs"
            data={["cm2", "m2"]}
            value={state.baseAreaUnit}
            onChange={(v) =>
              set({ baseAreaUnit: (v ?? "cm2") as VacuumState["baseAreaUnit"] })
            }
            style={{ width: 70 }}
          />
        </Group>
      </Box>

      <Box style={{ gridColumn: "span 2" }}>
        <FieldLabel>Pump Model</FieldLabel>
        <TextInput
          size="xs"
          value={state.pumpModel}
          onChange={(e) => set({ pumpModel: e.currentTarget.value })}
          placeholder="e.g. Edwards RV3"
        />
      </Box>

      <Box>
        <FieldLabel>Dead Volume (m³)</FieldLabel>
        <NumberInput
          size="xs"
          value={state.deadVolume !== "" ? Number(state.deadVolume) : ""}
          onChange={(v) =>
            set({ deadVolume: typeof v === "number" ? String(v) : "" })
          }
          placeholder="e.g. 0.005"
          min={0}
          decimalScale={6}
        />
      </Box>

      <Box>
        <FieldLabel>Evacuation Time (s)</FieldLabel>
        <NumberInput
          size="xs"
          value={
            state.evacuationTime !== "" ? Number(state.evacuationTime) : ""
          }
          onChange={(v) =>
            set({ evacuationTime: typeof v === "number" ? String(v) : "" })
          }
          placeholder="e.g. 60"
          min={0}
        />
      </Box>

      <Box style={{ gridColumn: "span 2" }}>
        <FieldLabel>Time until Start (s)</FieldLabel>
        <NumberInput
          size="xs"
          value={
            state.timeUntilStart !== "" ? Number(state.timeUntilStart) : ""
          }
          onChange={(v) =>
            set({ timeUntilStart: typeof v === "number" ? String(v) : "" })
          }
          placeholder="e.g. 10"
          min={0}
        />
      </Box>
    </SimpleGrid>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Modal component
// ─────────────────────────────────────────────────────────────────────────────

export interface QuenchingModalProps {
  opened: boolean
  initialValue?: string
  onClose: () => void
  onApply: (value: string) => void
  processSolutionRecipes?: Array<{ id: string; name: string }>
}

export function QuenchingModal({
  opened,
  initialValue,
  onClose,
  onApply,
  processSolutionRecipes,
}: QuenchingModalProps) {
  const [type, setType] = useState<QuenchingType>("Gas")
  const [gas, setGas] = useState<GasState>(defaultGas())
  const [antisolvent, setAntisolvent] = useState<AntisolventState>(
    defaultAntisolvent(),
  )
  const [vacuum, setVacuum] = useState<VacuumState>(defaultVacuum())

  // Reset form state whenever the modal opens
  useEffect(() => {
    if (!opened) return
    const parsed = parseQuenchingValue(initialValue ?? "")
    setType(parsed.type)
    setGas(parsed.gas)
    setAntisolvent(parsed.antisolvent)
    setVacuum(parsed.vacuum)
  }, [opened, initialValue])

  function handleApply() {
    const result = buildQuenchingString(type, gas, antisolvent, vacuum)
    onApply(result)
    onClose()
  }

  // DEBUG: onClose is intentionally suppressed to isolate unexpected close behaviour.
  // The modal can only be dismissed via Apply.
  function noOp() {
    /* intentionally empty */
  }

  return (
    <Modal
      opened={opened}
      onClose={noOp}
      title="Quenching / Drying Parameters"
      size="lg"
      centered
      closeOnClickOutside={false}
      closeOnEscape={false}
      withinPortal
    >
      <Stack
        data-quenching-modal="true"
        gap="md"
        onClick={(e) => e.stopPropagation()}
      >
        <SegmentedControl
          data={["Gas", "Antisolvent", "Vacuum"]}
          value={type}
          onChange={(v) => setType(v as QuenchingType)}
          fullWidth
          size="sm"
        />

        {type === "Gas" && <GasForm state={gas} onChange={setGas} />}
        {type === "Antisolvent" && (
          <AntisolventForm
            state={antisolvent}
            onChange={setAntisolvent}
            processSolutionRecipes={processSolutionRecipes}
          />
        )}
        {type === "Vacuum" && (
          <VacuumForm state={vacuum} onChange={setVacuum} />
        )}

        <Group justify="flex-end" mt="xs">
          <Button variant="default" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={handleApply}>Apply</Button>
        </Group>
      </Stack>
    </Modal>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// DryingMethodInput — drop-in replacement for ProcessParamInput when key is
// "dryingMethod". Shows current value with an edit button, and allows clearing.
// ─────────────────────────────────────────────────────────────────────────────

export interface DryingMethodInputProps {
  label: string
  param?: { value: string; mode: "constant" | "variation" }
  onChange: (
    param: { value: string; mode: "constant" | "variation" } | undefined,
  ) => void
  processSolutionRecipes?: Array<{ id: string; name: string }>
}

/** Render a compact human-readable summary of a quenching string. */
export function summariseQuenchingValue(
  value: string,
  materials: Array<{ id: string; name: string }>,
  solutions: Array<{ id: string; name: string }>,
  recipes?: Array<{ id: string; name: string }>,
): string {
  if (!value) return ""
  const pairs: Record<string, string> = {}
  value.split("|").forEach((segment) => {
    const idx = segment.indexOf("=")
    if (idx === -1) return
    pairs[segment.slice(0, idx).trim()] = segment.slice(idx + 1).trim()
  })

  const type = pairs.type
  if (!type) return value

  const parts: string[] = [`D/Q: ${type}`]
  if (type === "Gas") {
    if (pairs.gasType) parts.push(pairs.gasType)
    if (pairs.flowRate) parts.push(`${pairs.flowRate}`)
    if (pairs.pressure) parts.push(`${pairs.pressure}`)
    if (pairs.height) parts.push(`h=${pairs.height}`)
    if (pairs.nozzleForm) parts.push(pairs.nozzleForm)
    if (pairs.timeUntilStart) parts.push(`t_start=${pairs.timeUntilStart} s`)
  } else if (type === "Antisolvent") {
    const media = pairs.media || pairs.material
    if (media) parts.push(getMediaLabel(media, materials, solutions, recipes))
    if (pairs.depositionMethod) parts.push(pairs.depositionMethod)
    if (pairs.flowRate) parts.push(`${pairs.flowRate}`)
    if (pairs.height) parts.push(`h=${pairs.height}`)
    if (pairs.timeUntilStart) parts.push(`t_start=${pairs.timeUntilStart} s`)
  } else if (type === "Vacuum") {
    if (pairs.height) parts.push(`h=${pairs.height}`)
    if (pairs.evacuationTime) parts.push(`t=${pairs.evacuationTime}`)
    if (pairs.pumpModel) parts.push(pairs.pumpModel)
    if (pairs.timeUntilStart) parts.push(`t_start=${pairs.timeUntilStart} s`)
  }

  return parts.join(" | ")
}

export function DryingMethodInput({
  label,
  param,
  onChange,
  processSolutionRecipes,
}: DryingMethodInputProps) {
  const [modalOpen, setModalOpen] = useState(false)
  const hasValue = Boolean(param?.value?.trim())

  function handleApply(value: string) {
    onChange({ value, mode: "constant" })
  }

  function handleClear() {
    onChange(undefined)
  }

  if (!hasValue) {
    return (
      <>
        <Button
          variant="subtle"
          size="xs"
          color="green"
          leftSection={
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width={12}
              height={12}
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              aria-label="Add"
              role="img"
            >
              <title>Add</title>
              <line x1="12" y1="5" x2="12" y2="19" />
              <line x1="5" y1="12" x2="19" y2="12" />
            </svg>
          }
          onClick={(e) => {
            e.stopPropagation()
            setModalOpen(true)
          }}
          style={{ justifyContent: "flex-start" }}
        >
          {`Add ${label}`}
        </Button>

        <QuenchingModal
          opened={modalOpen}
          initialValue=""
          onClose={() => setModalOpen(false)}
          onApply={handleApply}
          processSolutionRecipes={processSolutionRecipes}
        />
      </>
    )
  }

  return (
    <>
      <Box>
        <Group gap={4} mb={4}>
          <Text size="xs" fw={500}>
            {label}
          </Text>
          <ActionIcon
            size="xs"
            variant="subtle"
            color="red"
            onClick={(e) => {
              e.stopPropagation()
              handleClear()
            }}
            title="Clear"
          >
            <IconX size={10} />
          </ActionIcon>
        </Group>

        <Button
          variant="light"
          size="xs"
          fullWidth
          onClick={(e) => {
            e.stopPropagation()
            setModalOpen(true)
          }}
          styles={{ inner: { justifyContent: "flex-start" } }}
        >
          <Text size="xs" truncate style={{ maxWidth: "100%" }}>
            {summariseQuenchingValue(
              param?.value ?? "",
              [],
              [],
              processSolutionRecipes,
            )}
          </Text>
        </Button>
      </Box>

      <QuenchingModal
        opened={modalOpen}
        initialValue={param?.value}
        onClose={() => setModalOpen(false)}
        onApply={handleApply}
        processSolutionRecipes={processSolutionRecipes}
      />
    </>
  )
}
