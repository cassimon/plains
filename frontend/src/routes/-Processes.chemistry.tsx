import {
  ActionIcon,
  Badge,
  Box,
  Button,
  ColorPicker,
  Divider,
  Group,
  Loader,
  Menu,
  NativeSelect,
  NumberInput,
  Popover,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core"
import { useElementSize } from "@mantine/hooks"
import {
  IconExternalLink,
  IconFlask2,
  IconPlus,
  IconSearch,
  IconTrash,
  IconX,
} from "@tabler/icons-react"
import { useEffect, useMemo, useRef, useState } from "react"
import type { ConcentrationSummary } from "../lib/solutionConcentration"
import {
  concentrationSummary,
  soluteVolumeMl,
} from "../lib/solutionConcentration"
import type {
  CanvasCollectionElement,
  Plane,
  Process,
  ProcessAddedSolution,
  ProcessSolute,
  ProcessSolutionRecipe,
  ProcessSolvent,
} from "../store/AppContext"

// ── Common perovskite / OPV materials with abbreviation → PubChem search mapping ──

export const PEROVSKITE_MATERIAL_SUGGESTIONS: ReadonlyArray<{
  abbr: string
  name: string
  searchQuery: string
  /** Material type, applied automatically when the suggestion is chosen */
  type: string
  /** Verified PubChem CID — selection uses this directly, no name lookup */
  pubchemCid?: string
  /** For mixtures (e.g. PEDOT:PSS): PubChem CIDs of the components */
  componentCids?: string[]
}> = [
  {
    abbr: "DMF",
    name: "N,N-Dimethylformamide",
    searchQuery: "N,N-Dimethylformamide",
    type: "solvent",
    pubchemCid: "6228",
  },
  {
    abbr: "DMSO",
    name: "Dimethyl sulfoxide",
    searchQuery: "Dimethyl sulfoxide",
    type: "solvent",
    pubchemCid: "679",
  },
  {
    abbr: "GBL",
    name: "γ-Butyrolactone",
    searchQuery: "gamma-butyrolactone",
    type: "solvent",
    pubchemCid: "7302",
  },
  {
    abbr: "NMP",
    name: "N-Methyl-2-pyrrolidone",
    searchQuery: "N-Methyl-2-pyrrolidone",
    type: "solvent",
    pubchemCid: "13387",
  },
  {
    abbr: "CB",
    name: "Chlorobenzene",
    searchQuery: "Chlorobenzene",
    type: "solvent",
    pubchemCid: "7964",
  },
  {
    abbr: "DCB",
    name: "1,2-Dichlorobenzene",
    searchQuery: "1,2-Dichlorobenzene",
    type: "solvent",
    pubchemCid: "7239",
  },
  {
    abbr: "oDCB",
    name: "o-Dichlorobenzene",
    searchQuery: "1,2-Dichlorobenzene",
    type: "solvent",
    pubchemCid: "7239",
  },
  {
    abbr: "IPA",
    name: "Isopropanol",
    searchQuery: "Isopropyl alcohol",
    type: "solvent",
    pubchemCid: "3776",
  },
  {
    abbr: "EtOH",
    name: "Ethanol",
    searchQuery: "Ethanol",
    type: "solvent",
    pubchemCid: "702",
  },
  {
    abbr: "MeOH",
    name: "Methanol",
    searchQuery: "Methanol",
    type: "solvent",
    pubchemCid: "887",
  },
  {
    abbr: "ACN",
    name: "Acetonitrile",
    searchQuery: "Acetonitrile",
    type: "solvent",
    pubchemCid: "6342",
  },
  {
    abbr: "THF",
    name: "Tetrahydrofuran",
    searchQuery: "Tetrahydrofuran",
    type: "solvent",
    pubchemCid: "8028",
  },
  {
    abbr: "CHCl3",
    name: "Chloroform",
    searchQuery: "Chloroform",
    type: "solvent",
    pubchemCid: "6212",
  },
  {
    abbr: "Toluene",
    name: "Toluene",
    searchQuery: "Toluene",
    type: "solvent",
    pubchemCid: "1140",
  },
  {
    abbr: "Anisole",
    name: "Anisole",
    searchQuery: "Anisole",
    type: "solvent",
    pubchemCid: "7519",
  },
  {
    abbr: "Acetone",
    name: "Acetone",
    searchQuery: "Acetone",
    type: "solvent",
    pubchemCid: "180",
  },
  {
    abbr: "Et2O",
    name: "Diethyl ether",
    searchQuery: "Diethyl ether",
    type: "solvent",
    pubchemCid: "3283",
  },
  {
    abbr: "MAI",
    name: "Methylammonium iodide",
    searchQuery: "Methylammonium iodide",
    type: "perovskite precursor",
    pubchemCid: "519034",
  },
  {
    abbr: "MABr",
    name: "Methylammonium bromide",
    searchQuery: "Methylammonium bromide",
    type: "perovskite precursor",
    pubchemCid: "3014526",
  },
  {
    abbr: "MACl",
    name: "Methylammonium chloride",
    searchQuery: "Methylammonium chloride",
    type: "perovskite precursor",
    pubchemCid: "6364545",
  },
  {
    abbr: "FAI",
    name: "Formamidinium iodide",
    searchQuery: "Formamidinium iodide",
    type: "perovskite precursor",
    pubchemCid: "89906651",
  },
  {
    abbr: "FABr",
    name: "Formamidinium bromide",
    searchQuery: "Formamidinium bromide",
    type: "perovskite precursor",
    pubchemCid: "91972093",
  },
  {
    abbr: "FACl",
    name: "Formamidinium chloride",
    searchQuery: "Formamidinium chloride",
    type: "perovskite precursor",
    pubchemCid: "10313058",
  },
  {
    abbr: "PbI2",
    name: "Lead(II) iodide",
    searchQuery: "Lead iodide",
    type: "perovskite precursor",
    pubchemCid: "24931",
  },
  {
    abbr: "PbBr2",
    name: "Lead(II) bromide",
    searchQuery: "Lead bromide",
    type: "perovskite precursor",
    pubchemCid: "139549",
  },
  {
    abbr: "PbCl2",
    name: "Lead(II) chloride",
    searchQuery: "Lead chloride",
    type: "perovskite precursor",
    pubchemCid: "24459",
  },
  {
    abbr: "SnI2",
    name: "Tin(II) iodide",
    searchQuery: "Stannous iodide",
    type: "perovskite precursor",
    pubchemCid: "25138",
  },
  {
    abbr: "SnF2",
    name: "Tin(II) fluoride",
    searchQuery: "Stannous fluoride",
    type: "additive",
    pubchemCid: "24550",
  },
  {
    abbr: "CsI",
    name: "Cesium iodide",
    searchQuery: "Cesium iodide",
    type: "perovskite precursor",
    pubchemCid: "24601",
  },
  {
    abbr: "CsBr",
    name: "Cesium bromide",
    searchQuery: "Cesium bromide",
    type: "perovskite precursor",
    pubchemCid: "24592",
  },
  {
    abbr: "RbI",
    name: "Rubidium iodide",
    searchQuery: "Rubidium iodide",
    type: "perovskite precursor",
    pubchemCid: "3423208",
  },
  {
    abbr: "KI",
    name: "Potassium iodide",
    searchQuery: "Potassium iodide",
    type: "perovskite precursor",
    pubchemCid: "4875",
  },
  {
    abbr: "PCBM",
    name: "PC61BM",
    searchQuery: "[6,6]-Phenyl C61 butyric acid methyl ester",
    type: "n-type (ETL)",
    pubchemCid: "53384373",
  },
  {
    abbr: "PC61BM",
    name: "[6,6]-Phenyl-C61-butyric acid methyl ester",
    searchQuery: "[6,6]-Phenyl C61 butyric acid methyl ester",
    type: "n-type (ETL)",
    pubchemCid: "53384373",
  },
  {
    abbr: "PC71BM",
    // Verified CID; the bare name "PC71BM" resolves to a hydrogenated
    // non-fullerene on PubChem, so the CID is pinned here.
    name: "[6,6]-Phenyl-C71-butyric acid methyl ester",
    searchQuery: "[6,6]-Phenyl-C71-butyric acid methyl ester",
    type: "n-type (ETL)",
    pubchemCid: "71777692",
  },
  {
    abbr: "C60",
    name: "Buckminsterfullerene",
    searchQuery: "Buckminsterfullerene",
    type: "n-type (ETL)",
    pubchemCid: "123591",
  },
  {
    abbr: "C70",
    name: "C70 fullerene",
    searchQuery: "C70 fullerene",
    type: "n-type (ETL)",
    pubchemCid: "16131935",
  },
  {
    abbr: "BCP",
    name: "Bathocuproine",
    searchQuery: "Bathocuproine",
    type: "n-type (ETL)",
    pubchemCid: "65149",
  },
  {
    abbr: "Bphen",
    name: "Bathophenanthroline",
    searchQuery: "Bathophenanthroline",
    type: "n-type (ETL)",
    pubchemCid: "72812",
  },
  {
    abbr: "ITIC",
    name: "ITIC non-fullerene acceptor",
    searchQuery: "ITIC",
    type: "n-type (ETL)",
    pubchemCid: "126843541",
  },
  {
    abbr: "Y6",
    name: "Y6 (BTP-eC9)",
    searchQuery: "BTP-eC9",
    type: "n-type (ETL)",
    pubchemCid: "163203732",
  },
  {
    abbr: "Spiro-OMeTAD",
    name: "Spiro-OMeTAD",
    searchQuery:
      "2,2',7,7'-tetrakis(N,N-di-p-methoxyphenylamine)-9,9'-spirobifluorene",
    type: "p-type (HTL)",
    pubchemCid: "16161850",
  },
  {
    abbr: "Spiro",
    name: "Spiro-OMeTAD",
    searchQuery:
      "2,2',7,7'-tetrakis(N,N-di-p-methoxyphenylamine)-9,9'-spirobifluorene",
    type: "p-type (HTL)",
    pubchemCid: "16161850",
  },
  {
    // Polymer — PubChem has no polymer entry; the search resolves to the
    // repeat-unit monomer, so keep it on the search path (no auto-fill CID).
    abbr: "PTAA",
    name: "Poly[bis(4-phenyl)(2,4,6-trimethylphenyl)amine]",
    searchQuery: "PTAA",
    type: "p-type (HTL)",
  },
  {
    abbr: "P3HT",
    name: "Poly(3-hexylthiophene)",
    searchQuery: "P3HT",
    type: "p-type (HTL)",
  },
  {
    abbr: "PEDOT:PSS",
    name: "PEDOT:PSS",
    searchQuery: "3,4-ethylenedioxythiophene",
    type: "p-type (HTL)",
  },
  {
    abbr: "CuSCN",
    name: "Copper(I) thiocyanate",
    searchQuery: "Copper thiocyanate",
    type: "p-type (HTL)",
    pubchemCid: "61264",
  },
  {
    abbr: "NiO",
    name: "Nickel(II) oxide",
    searchQuery: "Nickel oxide",
    type: "p-type (HTL)",
    pubchemCid: "179931",
  },
  // ── Self-assembled monolayer (SAM) hole-transport materials (Ossila) ──
  // Carbazole/acridine phosphonic- and carboxylic-acid anchored SAMs. CIDs
  // verified against PubChem; entries without a PubChem match omit pubchemCid.
  {
    abbr: "2PACz",
    name: "[2-(9H-carbazol-9-yl)ethyl]phosphonic acid",
    searchQuery: "2PACz",
    type: "p-type (HTL)",
    pubchemCid: "154704302",
  },
  {
    abbr: "MeO-2PACz",
    name: "[2-(3,6-dimethoxy-9H-carbazol-9-yl)ethyl]phosphonic acid",
    searchQuery: "MeO-2PACz",
    type: "p-type (HTL)",
    pubchemCid: "154704514",
  },
  {
    abbr: "Br-2PACz",
    name: "[2-(3,6-dibromo-9H-carbazol-9-yl)ethyl]phosphonic acid",
    searchQuery: "Br-2PACz",
    type: "p-type (HTL)",
    pubchemCid: "170305233",
  },
  {
    abbr: "Cl-2PACz",
    name: "[2-(3,6-dichloro-9H-carbazol-9-yl)ethyl]phosphonic acid",
    searchQuery: "2-(3,6-dichlorocarbazol-9-yl)ethylphosphonic acid",
    type: "p-type (HTL)",
    pubchemCid: "172214721",
  },
  {
    abbr: "4PACz",
    name: "[4-(9H-carbazol-9-yl)butyl]phosphonic acid",
    searchQuery: "4PACz",
    type: "p-type (HTL)",
    pubchemCid: "168435005",
  },
  {
    abbr: "Me-4PACz",
    name: "[4-(3,6-dimethyl-9H-carbazol-9-yl)butyl]phosphonic acid",
    searchQuery: "Me-4PACz",
    type: "p-type (HTL)",
    pubchemCid: "164186534",
  },
  {
    abbr: "MeO-4PACz",
    name: "[4-(3,6-dimethoxy-9H-carbazol-9-yl)butyl]phosphonic acid",
    searchQuery: "MeO-4PACz",
    type: "p-type (HTL)",
    pubchemCid: "166171249",
  },
  {
    abbr: "Ph-4PACz",
    name: "[4-(3,6-diphenyl-9H-carbazol-9-yl)butyl]phosphonic acid",
    searchQuery: "Ph-4PACz",
    type: "p-type (HTL)",
    pubchemCid: "169550445",
  },
  {
    abbr: "4PADCB",
    name: "[4-(7H-dibenzo[c,g]carbazol-7-yl)butyl]phosphonic acid",
    searchQuery: "4PADCB",
    type: "p-type (HTL)",
    pubchemCid: "169408671",
  },
  {
    // No PubChem match by name; falls back to manual entry.
    abbr: "MeO-4PADBC",
    name: "Methoxylated dibenzo[c,g]carbazole butylphosphonic acid",
    searchQuery: "MeO-4PADBC",
    type: "p-type (HTL)",
  },
  {
    abbr: "DMAcPA",
    name: "[4-(2,7-dibromo-9,9-dimethylacridin-10-yl)butyl]phosphonic acid",
    searchQuery: "DMAcPA",
    type: "p-type (HTL)",
    pubchemCid: "172227235",
  },
  {
    abbr: "9CAA",
    name: "2-(9H-carbazol-9-yl)acetic acid",
    searchQuery: "9-Carbazoleacetic acid",
    type: "p-type (HTL)",
    pubchemCid: "2815870",
  },
  {
    abbr: "9CPA",
    name: "3-(9H-carbazol-9-yl)propanoic acid",
    searchQuery: "3-(9H-carbazol-9-yl)propanoic acid",
    type: "p-type (HTL)",
    pubchemCid: "219301",
  },
  {
    abbr: "LiTFSI",
    name: "Lithium bis(trifluoromethanesulfonyl)imide",
    searchQuery: "Lithium bis(trifluoromethanesulfonyl)imide",
    type: "additive",
    pubchemCid: "87103854",
  },
  {
    abbr: "TBP",
    name: "4-tert-Butylpyridine",
    searchQuery: "4-tert-Butylpyridine",
    type: "additive",
    pubchemCid: "19878",
  },
  {
    abbr: "FK102",
    name: "FK102 cobalt(III) TFSI",
    searchQuery: "FK102Co(II) TFSI salt",
    type: "additive",
    pubchemCid: "154728151",
  },
  {
    abbr: "FK209",
    name: "FK209 cobalt(III) TFSI",
    searchQuery: "FK209",
    type: "additive",
    pubchemCid: "146012615",
  },
  {
    abbr: "PEAI",
    name: "Phenylethylammonium iodide",
    searchQuery: "phenethylammonium iodide",
    type: "passivation agent/layer",
    pubchemCid: "91972166",
  },
  {
    abbr: "PEABr",
    name: "Phenylethylammonium bromide",
    searchQuery: "phenethylammonium bromide",
    type: "passivation agent/layer",
    pubchemCid: "70441016",
  },
  {
    abbr: "PEACl",
    name: "Phenylethylammonium chloride",
    searchQuery: "phenethylammonium chloride",
    type: "passivation agent/layer",
    pubchemCid: "9075",
  },
  {
    abbr: "BAI",
    name: "n-Butylammonium iodide",
    searchQuery: "butylammonium iodide",
    type: "passivation agent/layer",
    pubchemCid: "88075134",
  },
  {
    abbr: "OAI",
    name: "Octylammonium iodide",
    searchQuery: "octylammonium iodide",
    type: "passivation agent/layer",
    pubchemCid: "22461615",
  },
  {
    // Polymer — PubChem resolves only the monomer; keep on the search path.
    abbr: "PMMA",
    name: "Poly(methyl methacrylate)",
    searchQuery: "methyl methacrylate",
    type: "passivation agent/layer",
  },
  {
    // No PubChem entry for the free acid by name; falls back to manual entry.
    abbr: "PCBA",
    name: "Phenyl-C61-butyric acid",
    searchQuery: "[6,6]-Phenyl-C61-butyric acid",
    type: "n-type (ETL)",
  },
]

// Solution / material types (shared by the type <select> and the add menus)
const SOLUTION_TYPE_OPTIONS = [
  "n-type (ETL)",
  "p-type (HTL)",
  "perovskite precursor",
  "solvent",
  "additive",
  "passivation agent/layer",
  "conductor (contact)",
  "encapsulant",
  "semiconductor (i)",
  "molecule",
  "polymer",
  "other",
] as const

/**
 * "Add solution" button whose dropdown lists all types on hover, so a solution
 * can be created with its type already set. Mantine v7 lacks `Menu.Sub`, so the
 * type list is a nested `trigger="hover"` menu; the outer menu is controlled to
 * close on selection.
 */
function AddSolutionMenu({
  label,
  color,
  onAdd,
}: {
  label: string
  color?: string
  onAdd: (type?: string) => void
}) {
  const [opened, setOpened] = useState(false)
  return (
    <Menu
      shadow="md"
      width={200}
      opened={opened}
      onChange={setOpened}
      closeOnItemClick={false}
      position="bottom-start"
    >
      <Menu.Target>
        <Button
          size="xs"
          variant="subtle"
          color={color}
          leftSection={<IconPlus size={14} />}
        >
          {label}
        </Button>
      </Menu.Target>
      <Menu.Dropdown>
        <Menu.Label>Choose type</Menu.Label>
        {SOLUTION_TYPE_OPTIONS.map((t) => (
          <Menu.Item
            key={t}
            onClick={() => {
              setOpened(false)
              onAdd(t)
            }}
          >
            {t}
          </Menu.Item>
        ))}
      </Menu.Dropdown>
    </Menu>
  )
}

// ── Color palette (used for auto-assignment only) ─────────────────────────────

const INGREDIENT_COLORS = [
  "#4dabf7",
  "#69db7c",
  "#ffd43b",
  "#ff8787",
  "#cc5de8",
  "#ffa94d",
  "#38d9a9",
  "#a9e34b",
  "#f06595",
  "#74c0fc",
]

function nextColor(existing: string[]): string {
  for (const c of INGREDIENT_COLORS) {
    if (!existing.includes(c)) return c
  }
  return INGREDIENT_COLORS[existing.length % INGREDIENT_COLORS.length]
}

// ── PubChem helpers ───────────────────────────────────────────────────────────

type PubChemHit = {
  cid: string
  title: string
  formula: string
}

async function searchPubChem(query: string): Promise<PubChemHit[]> {
  const cidRes = await fetch(
    `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(query)}/cids/JSON`,
  )
  if (!cidRes.ok) return []
  const cidData = (await cidRes.json()) as {
    IdentifierList?: { CID?: number[] }
  }
  const cids = (cidData.IdentifierList?.CID ?? []).slice(0, 12)
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

async function fetchPubChemProps(
  cid: string,
): Promise<{ molarMass?: number; density?: number }> {
  let molarMass: number | undefined
  let density: number | undefined

  try {
    const propRes = await fetch(
      `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/property/MolecularWeight/JSON`,
    )
    if (propRes.ok) {
      const data = (await propRes.json()) as {
        PropertyTable?: {
          Properties?: Array<{ MolecularWeight?: number | string }>
        }
      }
      const raw = data.PropertyTable?.Properties?.[0]?.MolecularWeight
      if (raw !== undefined) molarMass = Number(raw)
    }
  } catch {
    // best-effort
  }

  try {
    const viewRes = await fetch(
      `https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/${cid}/JSON?heading=Density`,
    )
    if (viewRes.ok) {
      const viewData = (await viewRes.json()) as DensityRecord
      density = parseDensity(viewData)
    }
  } catch {
    // best-effort
  }

  return { molarMass, density }
}

/** Fetch a compound's display title for a known CID (mixture-component names). */
async function fetchPubChemTitle(cid: string): Promise<string> {
  try {
    const res = await fetch(
      `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cid}/property/Title/JSON`,
    )
    if (res.ok) {
      const data = (await res.json()) as {
        PropertyTable?: { Properties?: Array<{ Title?: string }> }
      }
      const title = data.PropertyTable?.Properties?.[0]?.Title
      if (title) return title
    }
  } catch {
    // best-effort
  }
  return `CID ${cid}`
}

// PubChem pug_view JSON shape (density-relevant parts only)
type StringWithMarkup = { String: string }
type InfoValue = { StringWithMarkup?: StringWithMarkup[] }
type Information = { Value?: InfoValue }
type DensitySection = { TOCHeading?: string; Information?: Information[] }
type ExperimentalSection = { TOCHeading?: string; Section?: DensitySection[] }
type TopSection = { TOCHeading?: string; Section?: ExperimentalSection[] }
type DensityRecord = { Record?: { Section?: TopSection[] } }

function parseDensity(data: DensityRecord): number | undefined {
  // Collect all strings from Record.Section[*].Section[*].Section[TOCHeading=="Density"].Information[*].Value.StringWithMarkup[*].String
  const strings: string[] = []
  for (const sec1 of data.Record?.Section ?? []) {
    for (const sec2 of sec1.Section ?? []) {
      for (const sec3 of sec2.Section ?? []) {
        if (sec3.TOCHeading !== "Density") continue
        for (const info of sec3.Information ?? []) {
          for (const swm of info.Value?.StringWithMarkup ?? []) {
            if (swm.String) strings.push(swm.String)
          }
        }
      }
    }
  }
  if (strings.length === 0) return undefined

  // Priority 1: explicit g/cm3 / g/mL / g/cu cm / g/cc
  const explicitRe =
    /(\d+\.?\d*)\s*g\s*[/\\]\s*(?:cu\s*cm|cm\s*3|cm³|cc|mL|ml)/i
  for (const s of strings) {
    const m = s.match(explicitRe)
    if (m) return Number(m[1])
  }

  // Priority 2: "X at Y °C/°F" or "X @Y °C" — specific gravity ≈ density in g/mL
  const tempRe = /^(\d+\.?\d*)\s*(?:at\s+\d|@\s*\d)/i
  for (const s of strings) {
    const m = s.match(tempRe)
    if (m) return Number(m[1])
  }

  // Priority 3: "Relative density (water = 1): X"
  const relRe = /relative\s+density[^:]*:\s*(\d+\.?\d*)/i
  for (const s of strings) {
    const m = s.match(relRe)
    if (m) return Number(m[1])
  }

  // Priority 4: bare number string
  const bareRe = /^(\d+\.?\d*)$/
  for (const s of strings) {
    const m = s.trim().match(bareRe)
    if (m) return Number(m[1])
  }

  return undefined
}

function ColorDot({
  color,
  onChange,
}: {
  color: string
  onChange: (c: string) => void
}) {
  const [open, setOpen] = useState(false)
  const targetRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const handler = (e: MouseEvent) => {
      const target = e.target as Node
      if (targetRef.current?.contains(target)) return
      if ((target as Element).closest?.("[data-color-dot-popover]")) return
      setOpen(false)
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [open])

  return (
    <Popover
      opened={open}
      onClose={() => setOpen(false)}
      position="bottom-start"
      withArrow
      shadow="md"
      withinPortal
    >
      <Popover.Target>
        <Box
          ref={targetRef}
          onClick={(e) => {
            e.stopPropagation()
            setOpen((v) => !v)
          }}
          style={{
            width: 14,
            height: 14,
            borderRadius: "50%",
            background: color,
            flexShrink: 0,
            cursor: "pointer",
            border: "1.5px solid rgba(0,0,0,0.18)",
          }}
        />
      </Popover.Target>
      <Popover.Dropdown
        p={8}
        onClick={(e) => e.stopPropagation()}
        data-color-dot-popover
      >
        <ColorPicker
          format="hex"
          value={color}
          onChange={onChange}
          swatches={INGREDIENT_COLORS}
          swatchesPerRow={5}
          size="sm"
        />
      </Popover.Dropdown>
    </Popover>
  )
}

// ── Vial widget ───────────────────────────────────────────────────────────────

const ADDED_SOLUTION_COLORS = [
  "#f08030",
  "#58c878",
  "#9858d8",
  "#e85858",
  "#30b8c8",
  "#c8a030",
]

function VialWidget({
  solvents,
  solutes,
  addedSegs: externalAddedSegs = [],
  height = 100,
}: {
  solvents: ProcessSolvent[]
  solutes: ProcessSolute[]
  addedSegs?: Array<{ id: string; label: string; volumeMl: number }>
  height?: number
}) {
  const totalSolventRatio = solvents.reduce(
    (s, v) => s + (v.volumeRatio || 0),
    0,
  )

  type Segment = { id: string; label: string; volume: number; color: string }

  const solventSegs: Segment[] = solvents.map((s) => ({
    id: s.id,
    label: `${s.name || "?"}: ratio ${s.volumeRatio}`,
    volume: s.volumeRatio || 0,
    color: s.color,
  }))

  // Solute volumes scaled to the same coordinate space as solvent ratios
  const soluteSegs: Segment[] = solutes
    .map((s) => {
      const vol = soluteVolumeMl(s)
      if (vol === null || vol === 0) return null
      const scaled = totalSolventRatio > 0 ? vol / totalSolventRatio : vol
      return {
        id: s.id,
        label: `${s.name || "?"}: ${s.amount || "—"} ${s.unit}`,
        volume: scaled,
        color: s.color,
      }
    })
    .filter((s): s is Segment => s !== null)

  // Added-solution segments (volume in mL, scaled same as solutes)
  const addedSolSegs: Segment[] = externalAddedSegs.map((s, i) => ({
    id: s.id,
    label: s.label,
    volume: totalSolventRatio > 0 ? s.volumeMl / totalSolventRatio : s.volumeMl,
    color: ADDED_SOLUTION_COLORS[i % ADDED_SOLUTION_COLORS.length],
  }))

  const allSegs = [...solventSegs, ...soluteSegs, ...addedSolSegs]
  const totalVol = allSegs.reduce((s, v) => s + v.volume, 0)

  const width = Math.round(height * 0.38)
  const capHeight = Math.round(height * 0.15)
  const bodyHeight = height - capHeight

  return (
    <Box
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        flexShrink: 0,
      }}
    >
      {/* Vial cap / stopper */}
      <Box
        style={{
          width,
          height: capHeight,
          background: "var(--mantine-color-gray-6)",
          borderRadius: "5px 5px 2px 2px",
          boxShadow: "inset 0 -2px 4px rgba(0,0,0,0.15)",
        }}
      />
      {/* Vial body */}
      <Box
        style={{
          width,
          height: bodyHeight,
          borderRadius: "0 0 6px 6px",
          border: "2px solid var(--mantine-color-gray-4)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column-reverse",
          background:
            "light-dark(var(--mantine-color-gray-1), var(--mantine-color-dark-5))",
        }}
      >
        {totalVol > 0 &&
          allSegs.map((seg) => {
            const pct = (seg.volume / totalVol) * 100
            return (
              <Tooltip
                key={seg.id}
                label={seg.label}
                position="right"
                withArrow
              >
                <Box
                  style={{
                    height: `${pct}%`,
                    minHeight: pct > 0 ? 2 : 0,
                    background: seg.color,
                    opacity: 0.85,
                    flexShrink: 0,
                  }}
                />
              </Tooltip>
            )
          })}
      </Box>
    </Box>
  )
}

// ── Inline PubChem search ─────────────────────────────────────────────────────

type SelectedProps = {
  name?: string
  molarMass?: number
  density?: number
  /** Material type carried from a standard suggestion */
  type?: string
  /** Component CIDs for a mixture suggestion (e.g. PEDOT:PSS) */
  componentCids?: string[]
  /** Solute amount / unit (collected in the confirm step for solutes) */
  amount?: string
  unit?: "mg" | "ml" | "mol"
}

type SearchMode =
  | {
      kind: "searching"
      query: string
      loading: boolean
      hits: PubChemHit[]
      error: string | null
      fetchingCid: string | null
    }
  | {
      kind: "manual"
      hit: PubChemHit | null
      name: string
      molarMass: string
      density: string
    }
  | {
      // Solute-only step: amount is required, and molar mass is required when
      // PubChem could not provide it. Density stays optional.
      kind: "confirm"
      cid: string | null
      name: string
      type?: string
      componentCids?: string[]
      componentNames?: string[]
      molarMass: string
      density: string
      molarMassFromPubChem: boolean
      amount: string
      unit: "mg" | "ml" | "mol"
    }

type InlineSearchProps = {
  ingredientRole: "solvent" | "solute"
  /** When true (non-commercial solute), collect a required amount + molar mass */
  collectSoluteDetails?: boolean
  onSelect: (
    hit: { cid: string; title: string } | null,
    props: SelectedProps,
  ) => void
  onCancel: () => void
}

function InlineSearch({
  ingredientRole: role,
  collectSoluteDetails = false,
  onSelect,
  onCancel,
}: InlineSearchProps) {
  const [mode, setMode] = useState<SearchMode>({
    kind: "searching",
    query: "",
    loading: false,
    hits: [],
    error: null,
    fetchingCid: null,
  })
  const [highlightedIdx, setHighlightedIdx] = useState(-1)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    inputRef.current?.focus()
  }, [])

  const searchQuery = mode.kind === "searching" ? mode.query : ""

  const filteredSuggestions = useMemo(() => {
    const q = searchQuery.toLowerCase().trim()
    if (q.length === 0) return []
    return PEROVSKITE_MATERIAL_SUGGESTIONS.filter(
      (s) =>
        s.abbr.toLowerCase().startsWith(q) ||
        s.name.toLowerCase().startsWith(q) ||
        s.name.toLowerCase().includes(q),
    ).slice(0, 8)
  }, [searchQuery])

  const showSuggestions =
    mode.kind === "searching" &&
    filteredSuggestions.length > 0 &&
    mode.hits.length === 0 &&
    !mode.loading

  const doSearchWithQuery = async (q: string) => {
    const trimmed = q.trim()
    if (!trimmed) return
    setHighlightedIdx(-1)
    setMode((prev) =>
      prev.kind === "searching"
        ? { ...prev, query: trimmed, loading: true, error: null, hits: [] }
        : prev,
    )
    try {
      const results = await searchPubChem(trimmed)
      setMode((prev) =>
        prev.kind === "searching"
          ? {
              ...prev,
              loading: false,
              hits: results,
              error: results.length === 0 ? "No compounds found." : null,
            }
          : prev,
      )
    } catch {
      setMode((prev) =>
        prev.kind === "searching"
          ? {
              ...prev,
              loading: false,
              error: "Search failed. Check your connection.",
            }
          : prev,
      )
    }
  }

  const doSearch = () => {
    if (mode.kind !== "searching") return
    doSearchWithQuery(mode.query)
  }

  // For a solute, route into the confirm step (amount + molar mass) instead of
  // committing immediately. Prefill molar mass/density from PubChem when known.
  const goConfirm = (init: {
    cid: string | null
    name: string
    type?: string
    componentCids?: string[]
    componentNames?: string[]
    molarMass?: number
    density?: number
  }) => {
    setMode({
      kind: "confirm",
      cid: init.cid,
      name: init.name,
      type: init.type,
      componentCids: init.componentCids,
      componentNames: init.componentNames,
      molarMass: init.molarMass != null ? String(init.molarMass) : "",
      density: init.density != null ? String(init.density) : "",
      molarMassFromPubChem: init.molarMass != null,
      amount: "",
      unit: "mg",
    })
  }

  const commitSelection = (
    hit: { cid: string; title: string } | null,
    props: SelectedProps,
  ) => {
    if (collectSoluteDetails) {
      goConfirm({
        cid: hit?.cid ?? null,
        name: props.name ?? hit?.title ?? "",
        type: props.type,
        componentCids: props.componentCids,
        molarMass: props.molarMass,
        density: props.density,
      })
    } else {
      onSelect(hit, props)
    }
  }

  const handleSuggestionClick = async (
    s: (typeof PEROVSKITE_MATERIAL_SUGGESTIONS)[number],
  ) => {
    if (!s.pubchemCid) return doSearchWithQuery(s.searchQuery)
    setMode((prev) =>
      prev.kind === "searching"
        ? { ...prev, loading: true, error: null, hits: [] }
        : prev,
    )
    try {
      const props = await fetchPubChemProps(s.pubchemCid)
      commitSelection(
        { cid: s.pubchemCid, title: s.name },
        { ...props, type: s.type, componentCids: s.componentCids },
      )
    } catch {
      doSearchWithQuery(s.searchQuery)
    }
  }

  const handleHitClick = async (hit: PubChemHit) => {
    if (mode.kind !== "searching" || mode.fetchingCid) return
    setMode({ ...mode, fetchingCid: hit.cid })
    try {
      const props = await fetchPubChemProps(hit.cid)
      commitSelection({ cid: hit.cid, title: hit.title }, props)
    } catch {
      if (collectSoluteDetails) {
        goConfirm({ cid: hit.cid, name: hit.title })
      } else {
        setMode({
          kind: "manual",
          hit,
          name: hit.title,
          molarMass: "",
          density: "",
        })
      }
    }
  }

  const goManual = () => {
    if (collectSoluteDetails) {
      goConfirm({ cid: null, name: "" })
    } else {
      setMode({
        kind: "manual",
        hit: null,
        name: "",
        molarMass: "",
        density: "",
      })
    }
  }

  if (mode.kind === "manual") {
    return (
      <Box
        style={{
          background:
            "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))",
          border:
            "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
          borderRadius: 8,
          padding: "10px 12px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <Text size="xs" c="dimmed" mb="xs">
          {mode.hit ? (
            <>
              PubChem couldn't retrieve properties for <b>{mode.hit.title}</b>.
              Fill in manually:
            </>
          ) : (
            <>Add custom {role} without PubChem:</>
          )}
        </Text>
        <Stack gap="xs">
          <TextInput
            size="xs"
            label="Name"
            value={mode.name}
            onChange={(e) => setMode({ ...mode, name: e.currentTarget.value })}
          />
          <Group gap="xs" wrap="nowrap">
            <NumberInput
              size="xs"
              label="Molar mass (g/mol)"
              placeholder="e.g. 461.0"
              value={mode.molarMass !== "" ? Number(mode.molarMass) : ""}
              onChange={(v) =>
                setMode({ ...mode, molarMass: v !== "" ? String(v) : "" })
              }
              min={0}
              style={{ flex: 1 }}
            />
            <NumberInput
              size="xs"
              label="Density (g/mL)"
              placeholder="e.g. 6.16"
              value={mode.density !== "" ? Number(mode.density) : ""}
              onChange={(v) =>
                setMode({ ...mode, density: v !== "" ? String(v) : "" })
              }
              min={0}
              style={{ flex: 1 }}
            />
          </Group>
          <Group gap="xs" justify="flex-end">
            <Button size="xs" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              size="xs"
              disabled={!mode.name.trim()}
              onClick={() =>
                onSelect(
                  mode.hit ? { cid: mode.hit.cid, title: mode.name } : null,
                  {
                    name: mode.name.trim() || undefined,
                    molarMass: mode.molarMass
                      ? Number(mode.molarMass)
                      : undefined,
                    density: mode.density ? Number(mode.density) : undefined,
                  },
                )
              }
            >
              Add
            </Button>
          </Group>
        </Stack>
      </Box>
    )
  }

  if (mode.kind === "confirm") {
    const molarMassRequired = !mode.molarMassFromPubChem
    const molarMassMissing = molarMassRequired && !mode.molarMass.trim()
    const amountMissing = !mode.amount.trim()
    const canAdd =
      mode.name.trim() !== "" && !amountMissing && !molarMassMissing
    return (
      <Box
        style={{
          background:
            "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))",
          border:
            "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
          borderRadius: 8,
          padding: "10px 12px",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        <Text size="xs" c="dimmed" mb="xs">
          {mode.cid ? (
            <>
              Add <b>{mode.name}</b>
              {mode.type ? ` (${mode.type})` : ""} — set the amount to use.
            </>
          ) : (
            <>Add custom solute — provide amount and molar mass.</>
          )}
        </Text>
        <Stack gap="xs">
          <TextInput
            size="xs"
            label="Name"
            withAsterisk
            value={mode.name}
            onChange={(e) => setMode({ ...mode, name: e.currentTarget.value })}
          />
          <TextInput
            size="xs"
            label="Mixture component CIDs (optional)"
            description="Comma-separated PubChem CIDs for a mixture, e.g. PEDOT:PSS"
            placeholder="e.g. 61109, 74722"
            value={(mode.componentCids ?? []).join(", ")}
            onChange={(e) =>
              setMode({
                ...mode,
                componentCids: e.currentTarget.value
                  .split(",")
                  .map((c) => c.trim())
                  .filter((c) => c !== ""),
              })
            }
          />
          <Group justify="flex-end">
            <Button
              size="xs"
              variant="subtle"
              disabled={(mode.componentCids ?? []).length === 0}
              onClick={async () => {
                const cids = mode.componentCids ?? []
                const names = await Promise.all(
                  cids.map((c) => fetchPubChemTitle(c)),
                )
                setMode((prev) =>
                  prev.kind === "confirm"
                    ? { ...prev, componentNames: names }
                    : prev,
                )
              }}
            >
              Pull component names
            </Button>
          </Group>
          {mode.componentNames && mode.componentNames.length > 0 && (
            <Text size="xs" c="dimmed">
              Components: {mode.componentNames.join(", ")}
            </Text>
          )}
          <Group gap="xs" wrap="nowrap" align="flex-end">
            <NumberInput
              size="xs"
              label="Amount"
              withAsterisk
              placeholder="0"
              value={mode.amount !== "" ? Number(mode.amount) : ""}
              onChange={(v) =>
                setMode({ ...mode, amount: v !== "" ? String(v) : "" })
              }
              min={0}
              error={amountMissing ? "Required" : undefined}
              style={{ flex: 1 }}
            />
            <NativeSelect
              size="xs"
              label="Unit"
              value={mode.unit}
              onChange={(e) =>
                setMode({
                  ...mode,
                  unit: e.currentTarget.value as "mg" | "ml" | "mol",
                })
              }
              data={SOLUTE_UNITS as unknown as string[]}
              style={{ width: 72 }}
            />
          </Group>
          <Group gap="xs" wrap="nowrap">
            <NumberInput
              size="xs"
              label="Molar mass (g/mol)"
              withAsterisk={molarMassRequired}
              placeholder={mode.molarMassFromPubChem ? "" : "e.g. 461.0"}
              value={mode.molarMass !== "" ? Number(mode.molarMass) : ""}
              onChange={(v) =>
                setMode({ ...mode, molarMass: v !== "" ? String(v) : "" })
              }
              min={0}
              error={molarMassMissing ? "Required (not on PubChem)" : undefined}
              style={{ flex: 1 }}
            />
            <NumberInput
              size="xs"
              label="Density (g/mL)"
              placeholder="optional"
              value={mode.density !== "" ? Number(mode.density) : ""}
              onChange={(v) =>
                setMode({ ...mode, density: v !== "" ? String(v) : "" })
              }
              min={0}
              style={{ flex: 1 }}
            />
          </Group>
          <Group gap="xs" justify="flex-end">
            <Button size="xs" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              size="xs"
              disabled={!canAdd}
              onClick={() =>
                onSelect(
                  mode.cid ? { cid: mode.cid, title: mode.name } : null,
                  {
                    name: mode.name.trim() || undefined,
                    molarMass: mode.molarMass
                      ? Number(mode.molarMass)
                      : undefined,
                    density: mode.density ? Number(mode.density) : undefined,
                    type: mode.type,
                    componentCids: mode.componentCids,
                    amount: mode.amount,
                    unit: mode.unit,
                  },
                )
              }
            >
              Add
            </Button>
          </Group>
        </Stack>
      </Box>
    )
  }

  const { query, loading, hits, error, fetchingCid } = mode

  return (
    <Box
      style={{
        background:
          "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))",
        border:
          "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
        borderRadius: 8,
        padding: "10px 12px",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <Stack gap="xs">
        <Group gap="xs" wrap="nowrap">
          <TextInput
            ref={inputRef}
            size="xs"
            placeholder="Name or abbreviation (e.g. DMF, MAI, PbI2)…"
            value={query}
            onChange={(e) => {
              setHighlightedIdx(-1)
              setMode({ ...mode, query: e.currentTarget.value })
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
                  void handleSuggestionClick(
                    filteredSuggestions[highlightedIdx],
                  )
                } else {
                  doSearch()
                }
              } else if (e.key === "Escape") {
                onCancel()
              }
            }}
            style={{ flex: 1 }}
          />
          <ActionIcon
            size="sm"
            variant="filled"
            onClick={doSearch}
            loading={loading}
          >
            <IconSearch size={13} />
          </ActionIcon>
          <ActionIcon size="sm" variant="subtle" onClick={onCancel}>
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
                onClick={() => handleSuggestionClick(s)}
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
                  style={{ width: 80, flexShrink: 0 }}
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

        {error && (
          <Text size="xs" c="red">
            {error}
          </Text>
        )}

        {hits.length > 0 && (
          <Stack gap={3} style={{ maxHeight: 220, overflowY: "auto" }}>
            {hits.map((hit) => (
              <Box
                key={hit.cid}
                onClick={() => handleHitClick(hit)}
                style={{
                  padding: "6px 8px",
                  borderRadius: 5,
                  border:
                    "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
                  cursor: fetchingCid ? "not-allowed" : "pointer",
                  background:
                    fetchingCid === hit.cid
                      ? "light-dark(var(--mantine-color-blue-0), var(--mantine-color-dark-5))"
                      : "white",
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
                {fetchingCid === hit.cid && <Loader size="xs" />}
              </Box>
            ))}
          </Stack>
        )}

        <Button
          size="xs"
          variant="subtle"
          color="gray"
          leftSection={<IconPlus size={12} />}
          onClick={goManual}
        >
          Add custom {role} without PubChem
        </Button>
      </Stack>
    </Box>
  )
}

// ── Concentration bar ─────────────────────────────────────────────────────────

/** mol/mL → molarity (mol/L ≡ mmol/mL ≡ M). */
function fmtM(molPerMl: number | null): string | null {
  if (molPerMl === null) return null
  const m = molPerMl * 1000
  if (m === 0) return "0 M"
  if (Math.abs(m) < 0.001) return `${m.toExponential(2)} M`
  if (Math.abs(m) >= 100) return `${m.toFixed(1)} M`
  return `${m.toFixed(4)} M`
}

function fmtPct(p: number | null): string | null {
  return p === null ? null : `${p.toFixed(2)} %w/w`
}

/** Horizontal room (px) one solute needs at each level of detail. */
const CONC_FULL_W = 230
const CONC_SHORT_W = 110
const CONC_TOTAL_W = 160

/**
 * Concentration of the solution as a whole on the right, the solutes it is made
 * of on the left. The per-solute figures are the first thing to go when the card
 * gets narrow — they shorten to a bare molarity, then drop out entirely, so the
 * total always survives.
 */
function ConcentrationBar({ summary }: { summary: ConcentrationSummary }) {
  const { ref, width } = useElementSize()
  const { entries, total, dilution, incomplete } = summary

  // A single solute *is* the total, so print one figure rather than the same
  // number twice.
  const single = entries.length === 1
  const headline = single ? entries[0] : total

  // Before the first measurement, assume there is room: showing everything for
  // one frame beats blanking the bar out.
  const avail =
    (width > 0 ? width : Number.POSITIVE_INFINITY) -
    (headline && !single ? CONC_TOTAL_W : 0)
  const detail: "full" | "short" | "none" = single
    ? avail >= CONC_FULL_W
      ? "full"
      : "short"
    : avail >= entries.length * CONC_FULL_W
      ? "full"
      : avail >= entries.length * CONC_SHORT_W
        ? "short"
        : "none"

  const headlineSub = [
    fmtM(headline?.molPerMlSolvent ?? null)?.concat(" solvent"),
    fmtPct(headline?.wPercent ?? null),
  ]
    .filter(Boolean)
    .join(" · ")

  return (
    <Box
      ref={ref}
      p="xs"
      style={{
        background:
          "light-dark(var(--mantine-color-teal-0), var(--mantine-color-teal-9))",
        borderTop: "1px solid var(--mantine-color-teal-2)",
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <Group justify="space-between" align="flex-start" wrap="nowrap" gap="md">
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group gap={6} align="center" wrap="nowrap" mb={4}>
            <Text size="xs" fw={700} c="teal">
              Concentration
            </Text>
            {dilution && (
              <Badge size="xs" color="violet" variant="light">
                Diluted 1:{dilution.factor.toFixed(1)} ·{" "}
                {dilution.percentVv.toFixed(1)}% v/v
              </Badge>
            )}
            {incomplete && !dilution && (
              <Tooltip
                label="Some content could not be quantified — the figures are a lower bound."
                withArrow
              >
                <Badge size="xs" color="gray" variant="light">
                  partial
                </Badge>
              </Tooltip>
            )}
          </Group>

          {!single && detail !== "none" && (
            <Group gap="lg" wrap="wrap">
              {entries.map((c) => (
                <Box key={c.name} style={{ minWidth: 0 }}>
                  <Text size="xs" fw={600} truncate>
                    {c.name}
                  </Text>
                  <Text size="xs" c="dimmed">
                    {detail === "full"
                      ? [
                          fmtM(c.molPerMlTotal),
                          fmtM(c.molPerMlSolvent)?.concat(" solvent"),
                          fmtPct(c.wPercent),
                        ]
                          .filter(Boolean)
                          .join(" · ")
                      : (fmtM(c.molPerMlTotal) ?? fmtPct(c.wPercent) ?? "—")}
                  </Text>
                </Box>
              ))}
            </Group>
          )}
          {!single && detail === "none" && entries.length > 0 && (
            <Text size="xs" c="dimmed">
              {entries.length} solutes
            </Text>
          )}
        </Box>

        {headline && (
          <Box style={{ flexShrink: 0, textAlign: "right" }}>
            <Text size="xs" fw={600} c="dimmed" truncate>
              {single ? entries[0].name : "Total"}
            </Text>
            <Text size="sm" fw={700} c="teal">
              {fmtM(headline.molPerMlTotal) ?? fmtPct(headline.wPercent) ?? "—"}
            </Text>
            {detail === "full" && headlineSub && (
              <Text size="10px" c="dimmed">
                {headlineSub}
              </Text>
            )}
          </Box>
        )}
      </Group>
    </Box>
  )
}

// ── Solution card ─────────────────────────────────────────────────────────────

const SOLUTE_UNITS = ["mg", "ml", "mol"] as const

function SolutionCard({
  recipe,
  allRecipes,
  expanded,
  onToggle,
  onUpdate,
  onDelete,
  onCreateDilution,
  highlightSolvents = false,
}: {
  recipe: ProcessSolutionRecipe
  allRecipes: ProcessSolutionRecipe[]
  expanded: boolean
  onToggle: () => void
  onUpdate: (updated: ProcessSolutionRecipe) => void
  onDelete: () => void
  onCreateDilution: () => void
  /** Draw attention to the solvent section (freshly created dilution). */
  highlightSolvents?: boolean
}) {
  const [search, setSearch] = useState<{
    role: "solvent" | "solute"
    ingredientId: string | null
  } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [addingSolution, setAddingSolution] = useState(false)
  const [newSolutionId, setNewSolutionId] = useState("")
  const [newSolutionVolumeMl, setNewSolutionVolumeMl] = useState("")
  const [newSoluteId, setNewSoluteId] = useState<string | null>(null)

  const update = (patch: Partial<ProcessSolutionRecipe>) =>
    onUpdate({ ...recipe, ...patch })

  const allColors = [
    ...recipe.solvents.map((s) => s.color),
    ...recipe.solutes.map((s) => s.color),
  ]

  const handleSearchSelect = (
    hit: { cid: string; title: string } | null,
    props: SelectedProps,
  ) => {
    if (!search) return
    const { role, ingredientId } = search
    setSearch(null)

    const resolvedName = props.name ?? hit?.title ?? ""
    const resolvedCid = hit?.cid ?? ""

    if (role === "solvent") {
      if (ingredientId) {
        update({
          solvents: recipe.solvents.map((s) =>
            s.id === ingredientId
              ? {
                  ...s,
                  name: resolvedName || s.name,
                  pubchemCid: resolvedCid || s.pubchemCid,
                  componentCids: props.componentCids ?? s.componentCids,
                  molarMass: props.molarMass ?? s.molarMass,
                  density: props.density ?? s.density,
                }
              : s,
          ),
        })
      } else {
        const color = nextColor(allColors)
        const newSolvent: ProcessSolvent = {
          id: crypto.randomUUID(),
          name: resolvedName,
          pubchemCid: resolvedCid,
          componentCids: props.componentCids,
          volumeRatio: 1,
          color,
          molarMass: props.molarMass,
          density: props.density,
        }
        update({ solvents: [...recipe.solvents, newSolvent] })
      }
    } else {
      if (ingredientId) {
        update({
          solutes: recipe.solutes.map((s) =>
            s.id === ingredientId
              ? {
                  ...s,
                  name: resolvedName || s.name,
                  pubchemCid: resolvedCid || s.pubchemCid,
                  componentCids: props.componentCids ?? s.componentCids,
                  molarMass: props.molarMass ?? s.molarMass,
                  density: props.density ?? s.density,
                }
              : s,
          ),
        })
      } else {
        const color = nextColor(allColors)
        const newSolute: ProcessSolute = {
          id: crypto.randomUUID(),
          name: resolvedName,
          pubchemCid: resolvedCid,
          componentCids: props.componentCids,
          amount: props.amount ?? "",
          unit: props.unit ?? "mg",
          color,
          molarMass: props.molarMass,
          density: props.density,
        }
        // Adopt the suggestion's type as the solution's type when unset
        // (skip pure solvents — they don't define the solution's type).
        const patch: Partial<ProcessSolutionRecipe> = {
          solutes: [...recipe.solutes, newSolute],
        }
        if (props.type && !recipe.type && props.type !== "solvent") {
          patch.type = props.type
        }
        update(patch)
        setNewSoluteId(newSolute.id)
      }
    }
  }

  const updateSolvent = (id: string, patch: Partial<ProcessSolvent>) =>
    update({
      solvents: recipe.solvents.map((s) =>
        s.id === id ? { ...s, ...patch } : s,
      ),
    })

  const updateSolute = (id: string, patch: Partial<ProcessSolute>) =>
    update({
      solutes: recipe.solutes.map((s) =>
        s.id === id ? { ...s, ...patch } : s,
      ),
    })

  const addedSolutions = recipe.addedSolutions ?? []

  const updateAddedSolutionVolume = (recipeId: string, volumeMl: string) =>
    update({
      addedSolutions: addedSolutions.map((e) =>
        e.recipeId === recipeId ? { ...e, volumeMl } : e,
      ),
    })

  const removeAddedSolution = (recipeId: string) =>
    update({
      addedSolutions: addedSolutions.filter((e) => e.recipeId !== recipeId),
    })

  const confirmAddSolution = () => {
    if (!newSolutionId) return
    if (addedSolutions.some((e) => e.recipeId === newSolutionId)) return
    const entry: ProcessAddedSolution = {
      recipeId: newSolutionId,
      volumeMl: newSolutionVolumeMl,
    }
    update({ addedSolutions: [...addedSolutions, entry] })
    setAddingSolution(false)
    setNewSolutionId("")
    setNewSolutionVolumeMl("")
  }

  // Recipes that can be added (other recipes in this process, not self)
  const availableToAdd = allRecipes.filter(
    (r) =>
      r.id !== recipe.id && !addedSolutions.some((e) => e.recipeId === r.id),
  )

  const addedSolutionsTotalMl = addedSolutions.reduce(
    (sum, e) => sum + (Number(e.volumeMl) || 0),
    0,
  )

  const concentrations = concentrationSummary(recipe, allRecipes)

  const solventSummary = recipe.solvents.map((s) => s.name || "?").join(":")
  const ratioSummary = recipe.solvents.map((s) => s.volumeRatio).join(":")
  const solventLine = solventSummary
    ? `${solventSummary}${ratioSummary ? ` (${ratioSummary})` : ""}`
    : "No solvents"
  const solutesSummary = recipe.solutes
    .map((s) => `${s.amount || "—"} ${s.unit} ${s.name || "?"}`)
    .join(", ")

  const missingSoluteNames = recipe.isCommercial
    ? []
    : recipe.solutes
        .filter((s) => !s.amount)
        .map((s) => s.name || "unnamed solute")
  const hasComponent =
    recipe.solvents.length > 0 ||
    recipe.solutes.length > 0 ||
    (recipe.addedSolutions ?? []).length > 0
  const missingItems: string[] = []
  if (!recipe.type) missingItems.push("set a type")
  if (!hasComponent)
    missingItems.push("add at least one solvent, solute, or stock solution")
  if (missingSoluteNames.length > 0)
    missingItems.push(`set amount for: ${missingSoluteNames.join(", ")}`)
  const isComplete = missingItems.length === 0

  return (
    <Box
      style={{
        border: isComplete
          ? "1.5px solid var(--mantine-color-green-5)"
          : expanded
            ? "1.5px solid var(--mantine-color-blue-4)"
            : "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
        borderRadius: 10,
        overflow: "hidden",
        transition: "border-color 150ms",
      }}
    >
      {/* Header / retracted view */}
      <Box
        style={{
          display: "flex",
          alignItems: "center",
          gap: 12,
          padding: "10px 14px",
          cursor: "pointer",
          background: isComplete
            ? "light-dark(var(--mantine-color-green-0), var(--mantine-color-green-9))"
            : expanded
              ? "light-dark(var(--mantine-color-blue-0), var(--mantine-color-dark-5))"
              : "light-dark(var(--mantine-color-gray-0), var(--mantine-color-dark-6))",
        }}
        onClick={onToggle}
      >
        <VialWidget
          solvents={recipe.solvents}
          solutes={recipe.solutes}
          addedSegs={addedSolutions.map((e) => {
            const ref = allRecipes.find((r) => r.id === e.recipeId)
            return {
              id: e.recipeId,
              label: `${ref?.name || "Solution"} (added): ${e.volumeMl} mL`,
              volumeMl: Number(e.volumeMl) || 0,
            }
          })}
          height={56}
        />
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Group gap={6} wrap="nowrap">
            <Text fw={700} size="sm" truncate>
              {recipe.name || "Unnamed Solution"}
            </Text>
            {recipe.isCommercial && (
              <Badge
                size="xs"
                color="violet"
                variant="light"
                style={{ flexShrink: 0 }}
              >
                Commercial
              </Badge>
            )}
          </Group>
          <Text size="xs" c="dimmed" truncate>
            {solventLine}
            {solutesSummary ? ` · ${solutesSummary}` : ""}
          </Text>
          {!isComplete && (
            <Text size="xs" c="orange.7" fw={500} truncate>
              {missingItems.join(" · ")}
            </Text>
          )}
        </Box>

        {/* Inline delete confirmation */}
        {confirmDelete ? (
          <Group gap={4} wrap="nowrap" onClick={(e) => e.stopPropagation()}>
            <Text size="xs" c="red" fw={500}>
              Delete?
            </Text>
            <Button size="xs" color="red" onClick={onDelete}>
              Yes
            </Button>
            <Button
              size="xs"
              variant="subtle"
              onClick={() => setConfirmDelete(false)}
            >
              No
            </Button>
          </Group>
        ) : (
          <ActionIcon
            variant="subtle"
            color="red"
            size="sm"
            onClick={(e) => {
              e.stopPropagation()
              setConfirmDelete(true)
            }}
          >
            <IconTrash size={14} />
          </ActionIcon>
        )}
      </Box>

      {/* Expanded editor */}
      {expanded && (
        <Box
          p="md"
          style={{
            borderTop:
              "1px solid light-dark(var(--mantine-color-gray-3), var(--mantine-color-dark-4))",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <Group align="flex-start" gap="md" wrap="nowrap">
            <VialWidget
              solvents={recipe.solvents}
              solutes={recipe.solutes}
              addedSegs={addedSolutions.map((e) => {
                const ref = allRecipes.find((r) => r.id === e.recipeId)
                return {
                  id: e.recipeId,
                  label: `${ref?.name || "Solution"} (added): ${e.volumeMl} mL`,
                  volumeMl: Number(e.volumeMl) || 0,
                }
              })}
              height={180}
            />

            <Box style={{ flex: 1, minWidth: 0 }}>
              <Stack gap="md">
                {/* Name + type + volume */}
                <Group gap="sm" wrap="nowrap">
                  <TextInput
                    label="Solution name"
                    placeholder="e.g. Perovskite precursor"
                    value={recipe.name}
                    onChange={(e) => update({ name: e.currentTarget.value })}
                    style={{ flex: 2 }}
                  />
                  <NativeSelect
                    label="Type"
                    withAsterisk
                    value={recipe.type ?? ""}
                    onChange={(e) => update({ type: e.currentTarget.value })}
                    data={[
                      {
                        label: "Select type…",
                        value: "",
                        disabled: true,
                      },
                      ...SOLUTION_TYPE_OPTIONS.map((t) => ({
                        label: t,
                        value: t,
                      })),
                    ]}
                    style={{ flex: 1 }}
                    styles={{
                      input: {
                        borderColor: "var(--mantine-color-blue-4)",
                        borderWidth: "1.5px",
                      },
                    }}
                  />
                </Group>

                {/* Handling notes */}
                <Group gap="sm" wrap="nowrap" align="flex-start">
                  <Textarea
                    label="Handling (Preparation)"
                    placeholder="e.g. prepare in N₂ glovebox, keep away from moisture"
                    value={recipe.handlingPreparation ?? ""}
                    onChange={(e) =>
                      update({ handlingPreparation: e.currentTarget.value })
                    }
                    autosize
                    minRows={2}
                    style={{ flex: 1 }}
                  />
                  <Textarea
                    label="Handling (Before use)"
                    placeholder="e.g. stir at 60 °C for 1 h, filter before use"
                    value={recipe.handlingBeforeUse ?? ""}
                    onChange={(e) =>
                      update({ handlingBeforeUse: e.currentTarget.value })
                    }
                    autosize
                    minRows={2}
                    style={{ flex: 1 }}
                  />
                </Group>

                {/* Commercial-only fields */}
                {recipe.isCommercial && (
                  <Group gap="sm" wrap="nowrap">
                    <TextInput
                      label="Commercial name"
                      placeholder="e.g. Clevios PH1000"
                      value={recipe.commercialName ?? ""}
                      onChange={(e) =>
                        update({ commercialName: e.currentTarget.value })
                      }
                      style={{ flex: 2 }}
                    />
                    <TextInput
                      label="Supplier number"
                      placeholder="e.g. 768650-100ML"
                      value={recipe.supplierNumber ?? ""}
                      onChange={(e) =>
                        update({ supplierNumber: e.currentTarget.value })
                      }
                      style={{ flex: 1 }}
                    />
                  </Group>
                )}

                {/* Create a lab-solution dilution seeded with this commercial
                    solution (1 mL), then switch to it. */}
                {recipe.isCommercial && (
                  <Button
                    fullWidth
                    color="violet"
                    variant="light"
                    leftSection={<IconPlus size={18} />}
                    onClick={onCreateDilution}
                  >
                    Create dilution
                  </Button>
                )}

                {/* Solvents */}
                <Box
                  style={
                    highlightSolvents
                      ? {
                          border: "1.5px solid var(--mantine-color-blue-5)",
                          borderRadius: 8,
                          padding: 8,
                          background:
                            "light-dark(var(--mantine-color-blue-0), var(--mantine-color-dark-5))",
                        }
                      : undefined
                  }
                >
                  <Group justify="space-between" align="center" mb={6}>
                    <Text size="sm" fw={600}>
                      Solvents
                      {highlightSolvents && (
                        <Text component="span" c="blue.6" fw={700}>
                          {" ★"}
                        </Text>
                      )}
                    </Text>
                    {highlightSolvents && (
                      <Text size="xs" c="blue.6" fw={500}>
                        Add the solvent this dilution is made with
                      </Text>
                    )}
                  </Group>

                  {/* Table: solvent fields on the left, and a single boxed
                      column on the right whose SOLO top cell is the total
                      volume, with each solvent's volume ratio written directly
                      underneath — kept on the same flex row as its solvent so
                      ratio and solvent always line up regardless of row height. */}
                  {(() => {
                    const showRatioColumn =
                      !recipe.isCommercial && recipe.solvents.length > 0
                    const ratioCellBoxStyle = {
                      width: 100,
                      flexShrink: 0,
                      borderLeft: "1px solid var(--mantine-color-blue-3)",
                      borderRight: "1px solid var(--mantine-color-blue-3)",
                      background:
                        "light-dark(var(--mantine-color-blue-0), var(--mantine-color-dark-5))",
                      paddingLeft: 6,
                      paddingRight: 6,
                    } as const
                    return (
                      <Box>
                        {/* Header row: field labels (left) + solo Total volume
                            cell that caps the ratio column (right). */}
                        <Group gap="xs" wrap="nowrap" align="flex-end" mb={4}>
                          <Box style={{ flex: 1, minWidth: 0 }}>
                            {recipe.solvents.length > 0 && (
                              <Group
                                gap="xs"
                                style={{ paddingLeft: 20 }}
                                wrap="nowrap"
                              >
                                <Text size="xs" c="dimmed" style={{ flex: 2 }}>
                                  Name
                                </Text>
                                <Text
                                  size="xs"
                                  c="dimmed"
                                  style={{ width: 110 }}
                                >
                                  PubChem CID
                                </Text>
                                <Text
                                  size="xs"
                                  c="dimmed"
                                  style={{ width: 80 }}
                                >
                                  ρ (g/mL)
                                </Text>
                                <Text
                                  size="xs"
                                  c="dimmed"
                                  style={{ width: 80 }}
                                >
                                  M (g/mol)
                                </Text>
                                <Box style={{ width: 24 }} />
                              </Group>
                            )}
                          </Box>
                          {!recipe.isCommercial && (
                            <Box
                              style={{
                                width: 100,
                                flexShrink: 0,
                                border: "1px solid var(--mantine-color-blue-3)",
                                borderTopLeftRadius: 8,
                                borderTopRightRadius: 8,
                                borderBottom: showRatioColumn
                                  ? "none"
                                  : "1px solid var(--mantine-color-blue-3)",
                                borderBottomLeftRadius: showRatioColumn ? 0 : 8,
                                borderBottomRightRadius: showRatioColumn
                                  ? 0
                                  : 8,
                                background:
                                  "light-dark(var(--mantine-color-blue-0), var(--mantine-color-dark-5))",
                                padding: 6,
                              }}
                            >
                              <NumberInput
                                label={
                                  <Text size="xs" c="blue.6" fw={700}>
                                    Total vol. (mL) ★
                                  </Text>
                                }
                                placeholder="e.g. 5"
                                value={
                                  recipe.totalSolventVolumeMl !== ""
                                    ? Number(recipe.totalSolventVolumeMl)
                                    : ""
                                }
                                onChange={(v) =>
                                  update({
                                    totalSolventVolumeMl:
                                      v !== "" ? String(v) : "",
                                  })
                                }
                                min={0}
                                size="xs"
                                styles={{
                                  input: {
                                    borderColor: "var(--mantine-color-blue-4)",
                                    borderWidth: "1.5px",
                                  },
                                }}
                              />
                              {showRatioColumn && (
                                <Text size="xs" c="blue.6" fw={600} mt={8}>
                                  Vol. ratio ★
                                </Text>
                              )}
                            </Box>
                          )}
                        </Group>

                        {/* One flex row per solvent: fields on the left, its
                            volume ratio in the boxed column on the right. */}
                        {recipe.solvents.length > 0 && (
                          <Stack gap={4}>
                            {recipe.solvents.map((s, idx) => (
                              <Group
                                key={s.id}
                                gap="xs"
                                align="center"
                                wrap="nowrap"
                              >
                                <Box style={{ flex: 1, minWidth: 0 }}>
                                  <Group gap="xs" align="center" wrap="nowrap">
                                    <ColorDot
                                      color={s.color}
                                      onChange={(c) =>
                                        updateSolvent(s.id, { color: c })
                                      }
                                    />
                                    <TextInput
                                      size="xs"
                                      value={s.name}
                                      placeholder="Name"
                                      onChange={(e) =>
                                        updateSolvent(s.id, {
                                          name: e.currentTarget.value,
                                        })
                                      }
                                      style={{ flex: 2 }}
                                    />
                                    <Group
                                      gap={2}
                                      style={{ width: 110 }}
                                      wrap="nowrap"
                                    >
                                      <TextInput
                                        size="xs"
                                        value={s.pubchemCid}
                                        placeholder="CID"
                                        onChange={(e) =>
                                          updateSolvent(s.id, {
                                            pubchemCid: e.currentTarget.value,
                                          })
                                        }
                                        style={{ flex: 1 }}
                                      />
                                      <Tooltip label="Search PubChem">
                                        <ActionIcon
                                          size="xs"
                                          variant="subtle"
                                          onClick={() =>
                                            setSearch({
                                              role: "solvent",
                                              ingredientId: s.id,
                                            })
                                          }
                                        >
                                          <IconSearch size={10} />
                                        </ActionIcon>
                                      </Tooltip>
                                      {s.pubchemCid && (
                                        <Tooltip label="Open in PubChem">
                                          <ActionIcon
                                            size="xs"
                                            variant="subtle"
                                            component="a"
                                            href={`https://pubchem.ncbi.nlm.nih.gov/compound/${s.pubchemCid}`}
                                            target="_blank"
                                            rel="noreferrer"
                                            onClick={(e) => e.stopPropagation()}
                                          >
                                            <IconExternalLink size={10} />
                                          </ActionIcon>
                                        </Tooltip>
                                      )}
                                    </Group>
                                    <NumberInput
                                      size="xs"
                                      value={s.density ?? ""}
                                      placeholder="—"
                                      min={0}
                                      decimalScale={3}
                                      onChange={(v) =>
                                        updateSolvent(s.id, {
                                          density:
                                            v !== "" ? Number(v) : undefined,
                                        })
                                      }
                                      style={{ width: 80 }}
                                    />
                                    <NumberInput
                                      size="xs"
                                      value={s.molarMass ?? ""}
                                      placeholder="—"
                                      min={0}
                                      decimalScale={2}
                                      onChange={(v) =>
                                        updateSolvent(s.id, {
                                          molarMass:
                                            v !== "" ? Number(v) : undefined,
                                        })
                                      }
                                      style={{ width: 80 }}
                                    />
                                    <ActionIcon
                                      size="xs"
                                      variant="subtle"
                                      color="red"
                                      onClick={() =>
                                        update({
                                          solvents: recipe.solvents.filter(
                                            (x) => x.id !== s.id,
                                          ),
                                        })
                                      }
                                    >
                                      <IconX size={12} />
                                    </ActionIcon>
                                  </Group>
                                </Box>
                                {/* Ratio cell — aligned to this solvent's row,
                                    stacked under the total-volume cell. */}
                                <Box
                                  style={{
                                    ...ratioCellBoxStyle,
                                    paddingTop: 2,
                                    paddingBottom:
                                      idx === recipe.solvents.length - 1
                                        ? 6
                                        : 2,
                                    borderBottom:
                                      idx === recipe.solvents.length - 1
                                        ? "1px solid var(--mantine-color-blue-3)"
                                        : "none",
                                    borderBottomLeftRadius:
                                      idx === recipe.solvents.length - 1
                                        ? 8
                                        : 0,
                                    borderBottomRightRadius:
                                      idx === recipe.solvents.length - 1
                                        ? 8
                                        : 0,
                                  }}
                                >
                                  {showRatioColumn && (
                                    <NumberInput
                                      size="xs"
                                      value={s.volumeRatio}
                                      min={0}
                                      step={0.5}
                                      onChange={(v) =>
                                        updateSolvent(s.id, {
                                          volumeRatio: Number(v) || 0,
                                        })
                                      }
                                      styles={{
                                        input: {
                                          borderColor:
                                            "var(--mantine-color-blue-4)",
                                          borderWidth: "1.5px",
                                        },
                                      }}
                                    />
                                  )}
                                </Box>
                              </Group>
                            ))}
                          </Stack>
                        )}
                      </Box>
                    )
                  })()}

                  {search?.role === "solvent" && (
                    <Box mt={6}>
                      <InlineSearch
                        ingredientRole="solvent"
                        onSelect={handleSearchSelect}
                        onCancel={() => setSearch(null)}
                      />
                    </Box>
                  )}

                  <Group justify="flex-start" mt={6}>
                    <Button
                      size="xs"
                      variant={highlightSolvents ? "light" : "subtle"}
                      leftSection={<IconPlus size={12} />}
                      onClick={() =>
                        setSearch({ role: "solvent", ingredientId: null })
                      }
                    >
                      Add Solvent
                    </Button>
                  </Group>
                </Box>

                {/* Solutes */}
                <Box>
                  <Group justify="space-between" mb={6}>
                    <Text size="sm" fw={600}>
                      Solutes
                    </Text>
                  </Group>

                  {recipe.solutes.length === 0 && !search ? (
                    <Text size="xs" c="dimmed">
                      No solutes added.
                    </Text>
                  ) : (
                    <Stack gap={4}>
                      {recipe.solutes.length > 0 && (
                        <Group gap="xs" style={{ paddingLeft: 20 }}>
                          <Text size="xs" c="dimmed" style={{ flex: 2 }}>
                            Name
                          </Text>
                          <Text size="xs" c="dimmed" style={{ width: 110 }}>
                            PubChem CID
                          </Text>
                          {!recipe.isCommercial && (
                            <>
                              <Text
                                size="xs"
                                c="blue.6"
                                fw={600}
                                style={{ width: 80 }}
                              >
                                Amount ★
                              </Text>
                              <Text
                                size="xs"
                                c="blue.6"
                                fw={600}
                                style={{ width: 60 }}
                              >
                                Unit ★
                              </Text>
                            </>
                          )}
                          <Text size="xs" c="dimmed" style={{ width: 80 }}>
                            ρ (g/mL)
                          </Text>
                          <Text size="xs" c="dimmed" style={{ width: 80 }}>
                            M (g/mol)
                          </Text>
                          <Box style={{ width: 24 }} />
                        </Group>
                      )}
                      {recipe.solutes.map((s) => (
                        <Group key={s.id} gap="xs" align="center" wrap="nowrap">
                          <ColorDot
                            color={s.color}
                            onChange={(c) => updateSolute(s.id, { color: c })}
                          />
                          <TextInput
                            size="xs"
                            value={s.name}
                            placeholder="Name"
                            onChange={(e) =>
                              updateSolute(s.id, {
                                name: e.currentTarget.value,
                              })
                            }
                            style={{ flex: 2 }}
                          />
                          <Group gap={2} style={{ width: 110 }} wrap="nowrap">
                            <TextInput
                              size="xs"
                              value={s.pubchemCid}
                              placeholder="CID"
                              onChange={(e) =>
                                updateSolute(s.id, {
                                  pubchemCid: e.currentTarget.value,
                                })
                              }
                              style={{ flex: 1 }}
                            />
                            <Tooltip label="Search PubChem">
                              <ActionIcon
                                size="xs"
                                variant="subtle"
                                onClick={() =>
                                  setSearch({
                                    role: "solute",
                                    ingredientId: s.id,
                                  })
                                }
                              >
                                <IconSearch size={10} />
                              </ActionIcon>
                            </Tooltip>
                            {s.pubchemCid && (
                              <Tooltip label="Open in PubChem">
                                <ActionIcon
                                  size="xs"
                                  variant="subtle"
                                  component="a"
                                  href={`https://pubchem.ncbi.nlm.nih.gov/compound/${s.pubchemCid}`}
                                  target="_blank"
                                  rel="noreferrer"
                                  onClick={(e) => e.stopPropagation()}
                                >
                                  <IconExternalLink size={10} />
                                </ActionIcon>
                              </Tooltip>
                            )}
                          </Group>
                          {!recipe.isCommercial && (
                            <>
                              <NumberInput
                                size="xs"
                                value={s.amount !== "" ? Number(s.amount) : ""}
                                placeholder="0"
                                min={0}
                                autoFocus={s.id === newSoluteId}
                                onChange={(v) =>
                                  updateSolute(s.id, {
                                    amount: v !== "" ? String(v) : "",
                                  })
                                }
                                style={{ width: 80 }}
                                styles={{
                                  input: {
                                    borderColor: "var(--mantine-color-blue-4)",
                                    borderWidth: "1.5px",
                                  },
                                }}
                              />
                              <NativeSelect
                                size="xs"
                                value={s.unit}
                                onChange={(e) =>
                                  updateSolute(s.id, {
                                    unit: e.currentTarget
                                      .value as ProcessSolute["unit"],
                                  })
                                }
                                data={SOLUTE_UNITS as unknown as string[]}
                                style={{ width: 60 }}
                                styles={{
                                  input: {
                                    borderColor: "var(--mantine-color-blue-4)",
                                    borderWidth: "1.5px",
                                  },
                                }}
                              />
                            </>
                          )}
                          <NumberInput
                            size="xs"
                            value={s.density ?? ""}
                            placeholder="—"
                            min={0}
                            decimalScale={3}
                            onChange={(v) =>
                              updateSolute(s.id, {
                                density: v !== "" ? Number(v) : undefined,
                              })
                            }
                            style={{ width: 80 }}
                          />
                          <NumberInput
                            size="xs"
                            value={s.molarMass ?? ""}
                            placeholder="—"
                            min={0}
                            decimalScale={2}
                            onChange={(v) =>
                              updateSolute(s.id, {
                                molarMass: v !== "" ? Number(v) : undefined,
                              })
                            }
                            style={{ width: 80 }}
                          />
                          <ActionIcon
                            size="xs"
                            variant="subtle"
                            color="red"
                            onClick={() =>
                              update({
                                solutes: recipe.solutes.filter(
                                  (x) => x.id !== s.id,
                                ),
                              })
                            }
                          >
                            <IconX size={12} />
                          </ActionIcon>
                        </Group>
                      ))}
                    </Stack>
                  )}

                  {search?.role === "solute" && (
                    <Box mt={6}>
                      <InlineSearch
                        ingredientRole="solute"
                        collectSoluteDetails={
                          !recipe.isCommercial && !search.ingredientId
                        }
                        onSelect={handleSearchSelect}
                        onCancel={() => setSearch(null)}
                      />
                    </Box>
                  )}

                  <Group justify="flex-start" mt={6}>
                    <Button
                      size="xs"
                      variant="subtle"
                      leftSection={<IconPlus size={12} />}
                      onClick={() =>
                        setSearch({ role: "solute", ingredientId: null })
                      }
                    >
                      Add Solute
                    </Button>
                  </Group>
                </Box>

                {/* Solutions — mix in other process solutions (non-commercial only) */}
                {!recipe.isCommercial && (
                  <Box>
                    <Group justify="space-between" mb={4} align="flex-start">
                      <Box>
                        <Text size="sm" fw={600}>
                          Add Stock Solutions
                        </Text>
                        <Text size="xs" c="dimmed" maw={420} lh={1.4}>
                          Add volumes of other solutions to this solution.
                          {addedSolutionsTotalMl > 0 && (
                            <Text span size="xs" c="blue.6" fw={600}>
                              {" "}
                              (Added: {addedSolutionsTotalMl.toFixed(2)} mL →
                              effective total:{" "}
                              {(
                                (Number(recipe.totalSolventVolumeMl) || 0) +
                                addedSolutionsTotalMl
                              ).toFixed(2)}{" "}
                              mL)
                            </Text>
                          )}
                        </Text>
                      </Box>
                    </Group>

                    {addedSolutions.length > 0 && (
                      <Stack gap={4} mb={addingSolution ? 6 : 0}>
                        {addedSolutions.map((entry) => {
                          const ref = allRecipes.find(
                            (r) => r.id === entry.recipeId,
                          )
                          return (
                            <Group
                              key={entry.recipeId}
                              gap="xs"
                              align="center"
                              wrap="nowrap"
                            >
                              <Text size="xs" style={{ flex: 1 }} truncate>
                                {ref?.name || "Unknown solution"}
                              </Text>
                              {ref?.isCommercial && (
                                <Badge
                                  size="xs"
                                  color="violet"
                                  variant="light"
                                  style={{ flexShrink: 0 }}
                                >
                                  Commercial
                                </Badge>
                              )}
                              <NumberInput
                                size="xs"
                                value={
                                  entry.volumeMl !== ""
                                    ? Number(entry.volumeMl)
                                    : ""
                                }
                                placeholder="0"
                                min={0}
                                decimalScale={3}
                                rightSection={
                                  <Text size="10px" c="dimmed" pr={2}>
                                    mL
                                  </Text>
                                }
                                rightSectionWidth={28}
                                onChange={(v) =>
                                  updateAddedSolutionVolume(
                                    entry.recipeId,
                                    v !== "" ? String(v) : "",
                                  )
                                }
                                style={{ width: 100 }}
                              />
                              <ActionIcon
                                size="xs"
                                variant="subtle"
                                color="red"
                                onClick={() =>
                                  removeAddedSolution(entry.recipeId)
                                }
                              >
                                <IconX size={12} />
                              </ActionIcon>
                            </Group>
                          )
                        })}
                      </Stack>
                    )}

                    {addingSolution && (
                      <Group gap="xs" align="center" wrap="nowrap" mt={4}>
                        <NativeSelect
                          size="xs"
                          value={newSolutionId}
                          onChange={(e) =>
                            setNewSolutionId(e.currentTarget.value)
                          }
                          data={availableToAdd.map((r) => ({
                            label: r.name || "Unnamed",
                            value: r.id,
                          }))}
                          style={{ flex: 1 }}
                        />
                        <NumberInput
                          size="xs"
                          value={
                            newSolutionVolumeMl !== ""
                              ? Number(newSolutionVolumeMl)
                              : ""
                          }
                          placeholder="mL"
                          min={0}
                          decimalScale={3}
                          onChange={(v) =>
                            setNewSolutionVolumeMl(v !== "" ? String(v) : "")
                          }
                          style={{ width: 90 }}
                        />
                        <Button size="xs" onClick={confirmAddSolution}>
                          Add
                        </Button>
                        <ActionIcon
                          size="xs"
                          variant="subtle"
                          onClick={() => {
                            setAddingSolution(false)
                            setNewSolutionId("")
                            setNewSolutionVolumeMl("")
                          }}
                        >
                          <IconX size={12} />
                        </ActionIcon>
                      </Group>
                    )}

                    {availableToAdd.length === 0 &&
                      !addingSolution &&
                      addedSolutions.length === 0 && (
                        <Text size="xs" c="dimmed">
                          No other solutions defined in this process yet.
                        </Text>
                      )}

                    {availableToAdd.length > 0 && !addingSolution && (
                      <Group justify="flex-start" mt={4}>
                        <Button
                          size="xs"
                          variant="subtle"
                          leftSection={<IconPlus size={12} />}
                          onClick={() => {
                            setNewSolutionId(availableToAdd[0]?.id ?? "")
                            setAddingSolution(true)
                          }}
                        >
                          Add Solution
                        </Button>
                      </Group>
                    )}
                  </Box>
                )}
                {/* end !isCommercial Solutions */}
              </Stack>
            </Box>
          </Group>
        </Box>
      )}
      {(concentrations.entries.length > 0 || concentrations.dilution) && (
        <ConcentrationBar summary={concentrations} />
      )}
    </Box>
  )
}

// ── Chemistry tab ─────────────────────────────────────────────────────────────

export function ChemistryTab({
  process,
  onUpdateProcess,
  planes = [],
  allProcesses = [],
}: {
  process: Process
  onUpdateProcess: (updated: Process) => void
  planes?: Plane[]
  allProcesses?: Process[]
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  // Dilution just created here: its solvent section stays highlighted until the
  // user picks the diluting solvent (the one field it can't inherit).
  const [dilutionSeedId, setDilutionSeedId] = useState<string | null>(null)
  const [importOpen, setImportOpen] = useState(false)
  const [importCollKey, setImportCollKey] = useState("")
  const [importProcessId, setImportProcessId] = useState("")
  const [importSolutionId, setImportSolutionId] = useState("")
  const containerRef = useRef<HTMLDivElement>(null)

  const recipes = process.solutionRecipes ?? []

  const updateRecipes = (updated: ProcessSolutionRecipe[]) =>
    onUpdateProcess({ ...process, solutionRecipes: updated })

  const addRecipe = (type?: string) => {
    const r: ProcessSolutionRecipe = {
      id: crypto.randomUUID(),
      name: "",
      type: type || undefined,
      totalSolventVolumeMl: "1",
      solvents: [],
      solutes: [],
    }
    updateRecipes([...recipes, r])
    setExpandedId(r.id)
  }

  const addCommercialRecipe = (type?: string) => {
    const r: ProcessSolutionRecipe = {
      id: crypto.randomUUID(),
      name: "",
      type: type || undefined,
      isCommercial: true,
      totalSolventVolumeMl: "1",
      solvents: [],
      solutes: [],
    }
    updateRecipes([...recipes, r])
    setExpandedId(r.id)
  }

  // Build collection options: one entry per CanvasCollectionElement that has process refs
  // (pointing to a process other than the current one)
  const collectionOptions = useMemo(() => {
    const opts: Array<{ value: string; label: string; processIds: string[] }> =
      []
    for (const plane of planes) {
      for (const el of plane.elements) {
        if (el.type !== "collection") continue
        const coll = el as CanvasCollectionElement
        const processIds = coll.refs
          .filter((r) => r.kind === "process" && r.id !== process.id)
          .map((r) => r.id)
          .filter((id) => allProcesses.some((p) => p.id === id))
        if (processIds.length === 0) continue
        opts.push({
          value: `${plane.id}:${coll.id}`,
          label: `${plane.name} / ${coll.name}`,
          processIds,
        })
      }
    }
    return opts
  }, [planes, allProcesses, process.id])

  const selectedColl = collectionOptions.find((o) => o.value === importCollKey)

  const processOptions = useMemo(() => {
    if (!selectedColl) return []
    return selectedColl.processIds
      .map((id) => allProcesses.find((p) => p.id === id))
      .filter((p): p is Process => p !== undefined)
      .map((p) => ({ value: p.id, label: p.name || "Unnamed process" }))
  }, [selectedColl, allProcesses])

  const selectedImportProcess = allProcesses.find(
    (p) => p.id === importProcessId,
  )

  const solutionOptions = useMemo(() => {
    if (!selectedImportProcess) return []
    return (selectedImportProcess.solutionRecipes ?? []).map((r) => ({
      value: r.id,
      label: r.name || "Unnamed solution",
    }))
  }, [selectedImportProcess])

  const doImport = () => {
    const srcRecipe = (selectedImportProcess?.solutionRecipes ?? []).find(
      (r) => r.id === importSolutionId,
    )
    if (!srcRecipe) return
    const copied: ProcessSolutionRecipe = {
      ...srcRecipe,
      id: crypto.randomUUID(),
      solvents: srcRecipe.solvents.map((s) => ({
        ...s,
        id: crypto.randomUUID(),
      })),
      solutes: srcRecipe.solutes.map((s) => ({
        ...s,
        id: crypto.randomUUID(),
      })),
      addedSolutions: srcRecipe.addedSolutions
        ? [...srcRecipe.addedSolutions]
        : undefined,
    }
    updateRecipes([...recipes, copied])
    setExpandedId(copied.id)
    setImportOpen(false)
    setImportCollKey("")
    setImportProcessId("")
    setImportSolutionId("")
  }

  const openImport = () => {
    setImportOpen(true)
    setImportCollKey(collectionOptions[0]?.value ?? "")
    setImportProcessId("")
    setImportSolutionId("")
  }

  const updateRecipe = (updated: ProcessSolutionRecipe) =>
    updateRecipes(recipes.map((r) => (r.id === updated.id ? updated : r)))

  const createDilution = (commercial: ProcessSolutionRecipe) => {
    const dilution: ProcessSolutionRecipe = {
      id: crypto.randomUUID(),
      name: `Dilution of ${commercial.name || commercial.commercialName || "Commercial Solution"}`,
      // A dilution is the same substance at a lower concentration: it keeps the
      // parent's functional type and handling constraints. The diluting solvent
      // is the one thing it cannot inherit — hence the highlight below.
      type: commercial.type,
      handlingPreparation: commercial.handlingPreparation,
      handlingBeforeUse: commercial.handlingBeforeUse,
      totalSolventVolumeMl: "1",
      solvents: [],
      solutes: [],
      addedSolutions: [{ recipeId: commercial.id, volumeMl: "1" }],
    }
    updateRecipes([...recipes, dilution])
    setExpandedId(dilution.id)
    setDilutionSeedId(dilution.id)
  }

  const deleteRecipe = (id: string) => {
    updateRecipes(recipes.filter((r) => r.id !== id))
    if (expandedId === id) setExpandedId(null)
  }

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if ((e.target as Element)?.closest?.("[data-color-dot-popover]")) return
      if (
        containerRef.current &&
        !containerRef.current.contains(e.target as Node)
      ) {
        setExpandedId(null)
      }
    }
    document.addEventListener("mousedown", handler)
    return () => document.removeEventListener("mousedown", handler)
  }, [])

  // Reset downstream selects when parent changes
  useEffect(() => {
    setImportProcessId(processOptions[0]?.value ?? "")
  }, [processOptions])

  useEffect(() => {
    setImportSolutionId(solutionOptions[0]?.value ?? "")
  }, [solutionOptions])

  const importPanel = importOpen && (
    <Box
      style={{
        border: "1px solid var(--mantine-color-blue-3)",
        borderRadius: 8,
        padding: "12px 14px",
        background:
          "light-dark(var(--mantine-color-blue-0), var(--mantine-color-dark-5))",
      }}
    >
      <Text size="sm" fw={600} mb="xs">
        Import solution from another process
      </Text>
      {collectionOptions.length === 0 ? (
        <Text size="xs" c="dimmed">
          No collections with other processes found. Add processes to a
          collection on a Plane to enable importing.
        </Text>
      ) : (
        <Stack gap="xs">
          <Group gap="sm" wrap="wrap">
            <NativeSelect
              label="Collection"
              size="xs"
              value={importCollKey}
              onChange={(e) => setImportCollKey(e.currentTarget.value)}
              data={collectionOptions.map((o) => ({
                label: o.label,
                value: o.value,
              }))}
              style={{ flex: 1, minWidth: 160 }}
            />
            <NativeSelect
              label="Process"
              size="xs"
              value={importProcessId}
              onChange={(e) => setImportProcessId(e.currentTarget.value)}
              data={processOptions}
              disabled={processOptions.length === 0}
              style={{ flex: 1, minWidth: 140 }}
            />
            <NativeSelect
              label="Solution"
              size="xs"
              value={importSolutionId}
              onChange={(e) => setImportSolutionId(e.currentTarget.value)}
              data={solutionOptions}
              disabled={solutionOptions.length === 0}
              style={{ flex: 1, minWidth: 140 }}
            />
          </Group>
          <Group gap="xs">
            <Button size="xs" disabled={!importSolutionId} onClick={doImport}>
              Import (copy)
            </Button>
            <Button
              size="xs"
              variant="subtle"
              onClick={() => setImportOpen(false)}
            >
              Cancel
            </Button>
          </Group>
        </Stack>
      )}
    </Box>
  )

  if (recipes.length === 0) {
    return (
      <Box
        style={{
          display: "grid",
          placeItems: "center",
          height: "100%",
          minHeight: 300,
        }}
      >
        <Stack align="center" gap="md">
          <IconFlask2
            size={56}
            style={{ color: "var(--mantine-color-gray-4)" }}
          />
          <Text size="lg" fw={600} c="dimmed">
            No solution recipes yet
          </Text>
          <Text size="sm" c="dimmed" ta="center" maw={340}>
            Define the solutions you'll prepare for this process — solvents,
            solutes, and volumes.
          </Text>
          <Group gap="sm" justify="center" wrap="wrap">
            <AddSolutionMenu label="Custom Solution" onAdd={addRecipe} />
            <AddSolutionMenu
              label="Commercial Solution"
              color="violet"
              onAdd={addCommercialRecipe}
            />
            {collectionOptions.length > 0 && (
              <Button
                leftSection={<IconPlus size={16} />}
                variant="light"
                color="teal"
                onClick={openImport}
              >
                Import Solution
              </Button>
            )}
          </Group>
          {importPanel}
        </Stack>
      </Box>
    )
  }

  return (
    <Stack p="md" gap="sm" ref={containerRef}>
      {recipes.map((r) => (
        <SolutionCard
          key={r.id}
          recipe={r}
          allRecipes={recipes}
          expanded={expandedId === r.id}
          onToggle={() =>
            setExpandedId((prev) => (prev === r.id ? null : r.id))
          }
          onUpdate={updateRecipe}
          onDelete={() => deleteRecipe(r.id)}
          onCreateDilution={() => createDilution(r)}
          highlightSolvents={dilutionSeedId === r.id && r.solvents.length === 0}
        />
      ))}
      <Divider />
      <Group wrap="wrap">
        <AddSolutionMenu label="Custom Solution" onAdd={addRecipe} />
        <AddSolutionMenu
          label="Commercial Solution / Dispersion"
          color="violet"
          onAdd={addCommercialRecipe}
        />
        <Button
          size="xs"
          variant="subtle"
          color="teal"
          leftSection={<IconPlus size={14} />}
          onClick={openImport}
          disabled={collectionOptions.length === 0}
        >
          Import Solution
        </Button>
      </Group>
      {importPanel}
    </Stack>
  )
}
