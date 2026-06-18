import {
  ActionIcon,
  Box,
  Button,
  ColorPicker,
  Group,
  Loader,
  NativeSelect,
  NumberInput,
  Popover,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core"
import {
  IconExternalLink,
  IconFlask2,
  IconPlus,
  IconSearch,
  IconTrash,
  IconX,
} from "@tabler/icons-react"
import { useEffect, useMemo, useRef, useState } from "react"
import type {
  Process,
  ProcessSolute,
  ProcessSolutionRecipe,
  ProcessSolvent,
} from "../store/AppContext"

// ── Common perovskite / OPV materials with abbreviation → PubChem search mapping ──

const PEROVSKITE_MATERIAL_SUGGESTIONS: ReadonlyArray<{
  abbr: string
  name: string
  searchQuery: string
}> = [
  // Solvents
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
  { abbr: "GBL", name: "γ-Butyrolactone", searchQuery: "gamma-butyrolactone" },
  {
    abbr: "NMP",
    name: "N-Methyl-2-pyrrolidone",
    searchQuery: "N-Methyl-2-pyrrolidone",
  },
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
  { abbr: "IPA", name: "Isopropanol", searchQuery: "Isopropyl alcohol" },
  { abbr: "EtOH", name: "Ethanol", searchQuery: "Ethanol" },
  { abbr: "MeOH", name: "Methanol", searchQuery: "Methanol" },
  { abbr: "ACN", name: "Acetonitrile", searchQuery: "Acetonitrile" },
  { abbr: "THF", name: "Tetrahydrofuran", searchQuery: "Tetrahydrofuran" },
  { abbr: "CHCl3", name: "Chloroform", searchQuery: "Chloroform" },
  { abbr: "Toluene", name: "Toluene", searchQuery: "Toluene" },
  { abbr: "Anisole", name: "Anisole", searchQuery: "Anisole" },
  { abbr: "Acetone", name: "Acetone", searchQuery: "Acetone" },
  { abbr: "Et2O", name: "Diethyl ether", searchQuery: "Diethyl ether" },
  // Perovskite halide salts
  {
    abbr: "MAI",
    name: "Methylammonium iodide",
    searchQuery: "Methylammonium iodide",
  },
  {
    abbr: "MABr",
    name: "Methylammonium bromide",
    searchQuery: "Methylammonium bromide",
  },
  {
    abbr: "MACl",
    name: "Methylammonium chloride",
    searchQuery: "Methylammonium chloride",
  },
  {
    abbr: "FAI",
    name: "Formamidinium iodide",
    searchQuery: "Formamidinium iodide",
  },
  {
    abbr: "FABr",
    name: "Formamidinium bromide",
    searchQuery: "Formamidinium bromide",
  },
  {
    abbr: "FACl",
    name: "Formamidinium chloride",
    searchQuery: "Formamidinium chloride",
  },
  { abbr: "PbI2", name: "Lead(II) iodide", searchQuery: "Lead iodide" },
  { abbr: "PbBr2", name: "Lead(II) bromide", searchQuery: "Lead bromide" },
  { abbr: "PbCl2", name: "Lead(II) chloride", searchQuery: "Lead chloride" },
  { abbr: "SnI2", name: "Tin(II) iodide", searchQuery: "Stannous iodide" },
  { abbr: "SnF2", name: "Tin(II) fluoride", searchQuery: "Stannous fluoride" },
  { abbr: "CsI", name: "Cesium iodide", searchQuery: "Cesium iodide" },
  { abbr: "CsBr", name: "Cesium bromide", searchQuery: "Cesium bromide" },
  { abbr: "RbI", name: "Rubidium iodide", searchQuery: "Rubidium iodide" },
  { abbr: "KI", name: "Potassium iodide", searchQuery: "Potassium iodide" },
  // ETL / electron acceptors
  {
    abbr: "PCBM",
    name: "PC61BM",
    searchQuery: "Phenyl-C61-butyric acid methyl ester",
  },
  {
    abbr: "PC61BM",
    name: "[6,6]-Phenyl-C61-butyric acid methyl ester",
    searchQuery: "Phenyl-C61-butyric acid methyl ester",
  },
  {
    abbr: "PC71BM",
    name: "[6,6]-Phenyl-C71-butyric acid methyl ester",
    searchQuery: "Phenyl-C71-butyric acid methyl ester",
  },
  {
    abbr: "C60",
    name: "Buckminsterfullerene",
    searchQuery: "Buckminsterfullerene",
  },
  { abbr: "C70", name: "C70 fullerene", searchQuery: "C70 fullerene" },
  { abbr: "BCP", name: "Bathocuproine", searchQuery: "Bathocuproine" },
  {
    abbr: "Bphen",
    name: "Bathophenanthroline",
    searchQuery: "Bathophenanthroline",
  },
  { abbr: "ITIC", name: "ITIC non-fullerene acceptor", searchQuery: "ITIC" },
  { abbr: "Y6", name: "Y6 (BTP-eC9)", searchQuery: "BTP-eC9" },
  // HTL / hole transport
  {
    abbr: "Spiro-OMeTAD",
    name: "Spiro-OMeTAD",
    searchQuery:
      "2,2',7,7'-tetrakis(N,N-di-p-methoxyphenylamine)-9,9'-spirobifluorene",
  },
  {
    abbr: "Spiro",
    name: "Spiro-OMeTAD",
    searchQuery:
      "2,2',7,7'-tetrakis(N,N-di-p-methoxyphenylamine)-9,9'-spirobifluorene",
  },
  {
    abbr: "PTAA",
    name: "Poly[bis(4-phenyl)(2,4,6-trimethylphenyl)amine]",
    searchQuery: "PTAA polymer",
  },
  {
    abbr: "P3HT",
    name: "Poly(3-hexylthiophene)",
    searchQuery: "Poly(3-hexylthiophene)",
  },
  {
    abbr: "PEDOT:PSS",
    name: "PEDOT:PSS",
    searchQuery: "poly(3,4-ethylenedioxythiophene) polystyrene sulfonate",
  },
  {
    abbr: "CuSCN",
    name: "Copper(I) thiocyanate",
    searchQuery: "Copper thiocyanate",
  },
  { abbr: "NiO", name: "Nickel(II) oxide", searchQuery: "Nickel oxide" },
  // Dopants and additives
  {
    abbr: "LiTFSI",
    name: "Lithium bis(trifluoromethanesulfonyl)imide",
    searchQuery: "Lithium bis(trifluoromethanesulfonyl)imide",
  },
  {
    abbr: "TBP",
    name: "4-tert-Butylpyridine",
    searchQuery: "4-tert-Butylpyridine",
  },
  {
    abbr: "FK102",
    name: "FK102 cobalt(III) TFSI",
    searchQuery:
      "tris(2-(1H-pyrazol-1-yl)-4-tert-butylpyridine)cobalt(III) bis(trifluoromethylsulfonyl)imide",
  },
  {
    abbr: "FK209",
    name: "FK209 cobalt(III) TFSI",
    searchQuery: "cobalt tris(bis(trifluoromethanesulfonyl)imide)",
  },
  {
    abbr: "PEAI",
    name: "Phenylethylammonium iodide",
    searchQuery: "phenethylammonium iodide",
  },
  {
    abbr: "PEABr",
    name: "Phenylethylammonium bromide",
    searchQuery: "phenethylammonium bromide",
  },
  {
    abbr: "PEACl",
    name: "Phenylethylammonium chloride",
    searchQuery: "phenethylammonium chloride",
  },
  {
    abbr: "BAI",
    name: "n-Butylammonium iodide",
    searchQuery: "butylammonium iodide",
  },
  {
    abbr: "OAI",
    name: "Octylammonium iodide",
    searchQuery: "octylammonium iodide",
  },
  {
    abbr: "PMMA",
    name: "Poly(methyl methacrylate)",
    searchQuery: "Poly(methyl methacrylate)",
  },
  {
    abbr: "PCBA",
    name: "Phenyl-C61-butyric acid",
    searchQuery: "phenyl C61 butyric acid",
  },
]

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

// ── Volume / mole helpers ─────────────────────────────────────────────────────

function soluteVolumeMl(s: ProcessSolute): number | null {
  const amt = Number(s.amount)
  if (!amt) return null
  if (s.unit === "ml") return amt
  if (s.unit === "mg" && s.density) return amt / (s.density * 1000)
  if (s.unit === "mol" && s.molarMass && s.density)
    return (amt * s.molarMass) / (s.density * 1000)
  return null
}

function soluteMoles(s: ProcessSolute): number | null {
  const amt = Number(s.amount)
  if (!amt) return null
  if (s.unit === "mol") return amt
  if (s.unit === "mg" && s.molarMass) return amt / 1000 / s.molarMass
  if (s.unit === "ml" && s.density && s.molarMass)
    return (amt * s.density) / s.molarMass
  return null
}

// ── Free color picker dot ─────────────────────────────────────────────────────

function ColorDot({
  color,
  onChange,
}: {
  color: string
  onChange: (c: string) => void
}) {
  const [open, setOpen] = useState(false)

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
      <Popover.Dropdown p={8} onClick={(e) => e.stopPropagation()}>
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

function VialWidget({
  solvents,
  solutes,
  height = 100,
}: {
  solvents: ProcessSolvent[]
  solutes: ProcessSolute[]
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

  const allSegs = [...solventSegs, ...soluteSegs]
  const totalVol = allSegs.reduce((s, v) => s + v.volume, 0)

  const width = Math.round(height * 0.38)

  return (
    <Box
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        gap: 2,
        flexShrink: 0,
      }}
    >
      <Box
        style={{
          width: Math.round(width * 0.45),
          height: Math.round(height * 0.1),
          background: "var(--mantine-color-gray-3)",
          borderRadius: "3px 3px 0 0",
        }}
      />
      <Box
        style={{
          width,
          height: Math.round(height * 0.85),
          borderRadius: "0 0 6px 6px",
          border: "2px solid var(--mantine-color-gray-4)",
          overflow: "hidden",
          display: "flex",
          flexDirection: "column-reverse",
          background: "var(--mantine-color-gray-1)",
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

type InlineSearchProps = {
  ingredientRole: "solvent" | "solute"
  onSelect: (
    hit: { cid: string; title: string } | null,
    props: { name?: string; molarMass?: number; density?: number },
  ) => void
  onCancel: () => void
}

function InlineSearch({
  ingredientRole: role,
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

  const handleHitClick = async (hit: PubChemHit) => {
    if (mode.kind !== "searching" || mode.fetchingCid) return
    setMode({ ...mode, fetchingCid: hit.cid })
    try {
      const props = await fetchPubChemProps(hit.cid)
      onSelect({ cid: hit.cid, title: hit.title }, props)
    } catch {
      setMode({
        kind: "manual",
        hit,
        name: hit.title,
        molarMass: "",
        density: "",
      })
    }
  }

  const goManual = () =>
    setMode({ kind: "manual", hit: null, name: "", molarMass: "", density: "" })

  if (mode.kind === "manual") {
    return (
      <Box
        style={{
          background: "var(--mantine-color-gray-0)",
          border: "1px solid var(--mantine-color-gray-3)",
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

  const { query, loading, hits, error, fetchingCid } = mode

  return (
    <Box
      style={{
        background: "var(--mantine-color-gray-0)",
        border: "1px solid var(--mantine-color-gray-3)",
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
                  doSearchWithQuery(
                    filteredSuggestions[highlightedIdx].searchQuery,
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
              border: "1px solid var(--mantine-color-gray-3)",
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
                      ? "var(--mantine-color-blue-0)"
                      : "white",
                  cursor: "pointer",
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  borderBottom:
                    idx < filteredSuggestions.length - 1
                      ? "1px solid var(--mantine-color-gray-1)"
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
                  border: "1px solid var(--mantine-color-gray-3)",
                  cursor: fetchingCid ? "not-allowed" : "pointer",
                  background:
                    fetchingCid === hit.cid
                      ? "var(--mantine-color-blue-0)"
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

// ── Concentration summary ─────────────────────────────────────────────────────

function concentrationSummary(
  recipe: ProcessSolutionRecipe,
): { name: string; molPerMl: number }[] {
  const volMl = Number(recipe.totalSolventVolumeMl)
  if (!volMl) return []
  return recipe.solutes
    .map((s) => {
      const mol = soluteMoles(s)
      if (mol === null) return null
      return { name: s.name || "?", molPerMl: mol / volMl }
    })
    .filter((x): x is { name: string; molPerMl: number } => x !== null)
}

// ── Solution card ─────────────────────────────────────────────────────────────

const SOLUTE_UNITS = ["mg", "ml", "mol"] as const

function SolutionCard({
  recipe,
  expanded,
  onToggle,
  onUpdate,
  onDelete,
}: {
  recipe: ProcessSolutionRecipe
  expanded: boolean
  onToggle: () => void
  onUpdate: (updated: ProcessSolutionRecipe) => void
  onDelete: () => void
}) {
  const [search, setSearch] = useState<{
    role: "solvent" | "solute"
    ingredientId: string | null
  } | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const update = (patch: Partial<ProcessSolutionRecipe>) =>
    onUpdate({ ...recipe, ...patch })

  const allColors = [
    ...recipe.solvents.map((s) => s.color),
    ...recipe.solutes.map((s) => s.color),
  ]

  const handleSearchSelect = (
    hit: { cid: string; title: string } | null,
    props: { name?: string; molarMass?: number; density?: number },
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
          amount: "",
          unit: "mg",
          color,
          molarMass: props.molarMass,
          density: props.density,
        }
        update({ solutes: [...recipe.solutes, newSolute] })
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

  const concentrations = concentrationSummary(recipe)

  const solventSummary = recipe.solvents.map((s) => s.name || "?").join(":")
  const ratioSummary = recipe.solvents.map((s) => s.volumeRatio).join(":")
  const solventLine = solventSummary
    ? `${solventSummary}${ratioSummary ? ` (${ratioSummary})` : ""}`
    : "No solvents"
  const solutesSummary = recipe.solutes
    .map((s) => `${s.amount || "—"} ${s.unit} ${s.name || "?"}`)
    .join(", ")

  return (
    <Box
      style={{
        border: expanded
          ? "1.5px solid var(--mantine-color-blue-4)"
          : "1px solid var(--mantine-color-gray-3)",
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
          background: expanded
            ? "var(--mantine-color-blue-0)"
            : "var(--mantine-color-gray-0)",
        }}
        onClick={onToggle}
      >
        <VialWidget
          solvents={recipe.solvents}
          solutes={recipe.solutes}
          height={56}
        />
        <Box style={{ flex: 1, minWidth: 0 }}>
          <Text fw={700} size="sm" truncate>
            {recipe.name || "Unnamed Solution"}
          </Text>
          <Text size="xs" c="dimmed" truncate>
            {solventLine}
            {solutesSummary ? ` · ${solutesSummary}` : ""}
          </Text>
          {concentrations.length > 0 && (
            <Text size="xs" c="teal" fw={500} truncate>
              {concentrations
                .map(
                  (c) =>
                    `${c.name}: ${c.molPerMl < 0.001 ? c.molPerMl.toExponential(2) : c.molPerMl.toFixed(4)} mol/mL`,
                )
                .join(" · ")}
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
          style={{ borderTop: "1px solid var(--mantine-color-gray-3)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <Group align="flex-start" gap="md" wrap="nowrap">
            <VialWidget
              solvents={recipe.solvents}
              solutes={recipe.solutes}
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
                      { label: "—", value: "" },
                      { label: "n-type (ETL)", value: "n-type (ETL)" },
                      { label: "p-type (HTL)", value: "p-type (HTL)" },
                      {
                        label: "perovskite precursor",
                        value: "perovskite precursor",
                      },
                      { label: "solvent", value: "solvent" },
                      { label: "additive", value: "additive" },
                      {
                        label: "passivation agent/layer",
                        value: "passivation agent/layer",
                      },
                      {
                        label: "conductor (contact)",
                        value: "conductor (contact)",
                      },
                      { label: "encapsulant", value: "encapsulant" },
                      {
                        label: "semiconductor (i)",
                        value: "semiconductor (i)",
                      },
                      { label: "other", value: "other" },
                    ]}
                    style={{ flex: 1 }}
                  />
                  <NumberInput
                    label="Total solvent volume (mL)"
                    placeholder="e.g. 5"
                    value={
                      recipe.totalSolventVolumeMl !== ""
                        ? Number(recipe.totalSolventVolumeMl)
                        : ""
                    }
                    onChange={(v) =>
                      update({
                        totalSolventVolumeMl: v !== "" ? String(v) : "",
                      })
                    }
                    min={0}
                    style={{ flex: 1 }}
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

                {/* Concentration box */}
                {concentrations.length > 0 && (
                  <Box
                    p="xs"
                    style={{
                      background: "var(--mantine-color-teal-0)",
                      border: "1px solid var(--mantine-color-teal-2)",
                      borderRadius: 6,
                    }}
                  >
                    <Text size="xs" fw={700} c="teal" mb={4}>
                      Concentration
                    </Text>
                    <Group gap="lg" wrap="wrap">
                      {concentrations.map((c) => (
                        <Box key={c.name}>
                          <Text size="xs" fw={600}>
                            {c.name}
                          </Text>
                          <Text size="xs" c="dimmed">
                            {c.molPerMl < 0.001
                              ? c.molPerMl.toExponential(3)
                              : c.molPerMl.toFixed(4)}{" "}
                            mol/mL
                          </Text>
                        </Box>
                      ))}
                    </Group>
                  </Box>
                )}

                {/* Solvents */}
                <Box>
                  <Group justify="space-between" mb={6}>
                    <Text size="sm" fw={600}>
                      Solvents
                    </Text>
                    <Button
                      size="xs"
                      variant="subtle"
                      leftSection={<IconPlus size={12} />}
                      onClick={() =>
                        setSearch({ role: "solvent", ingredientId: null })
                      }
                    >
                      Add Solvent
                    </Button>
                  </Group>

                  {recipe.solvents.length > 0 && (
                    <Stack gap={4}>
                      <Group gap="xs" style={{ paddingLeft: 20 }}>
                        <Text size="xs" c="dimmed" style={{ flex: 2 }}>
                          Name
                        </Text>
                        <Text size="xs" c="dimmed" style={{ width: 110 }}>
                          PubChem CID
                        </Text>
                        <Text
                          size="xs"
                          c="blue.6"
                          fw={600}
                          style={{ width: 80 }}
                        >
                          Vol. ratio ★
                        </Text>
                        <Text size="xs" c="dimmed" style={{ width: 80 }}>
                          ρ (g/mL)
                        </Text>
                        <Text size="xs" c="dimmed" style={{ width: 80 }}>
                          M (g/mol)
                        </Text>
                        <Box style={{ width: 24 }} />
                      </Group>
                      {recipe.solvents.map((s) => (
                        <Group key={s.id} gap="xs" align="center" wrap="nowrap">
                          <ColorDot
                            color={s.color}
                            onChange={(c) => updateSolvent(s.id, { color: c })}
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
                          <Group gap={2} style={{ width: 110 }} wrap="nowrap">
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
                            value={s.volumeRatio}
                            min={0}
                            step={0.5}
                            onChange={(v) =>
                              updateSolvent(s.id, {
                                volumeRatio: Number(v) || 0,
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
                          <NumberInput
                            size="xs"
                            value={s.density ?? ""}
                            placeholder="—"
                            min={0}
                            decimalScale={3}
                            onChange={(v) =>
                              updateSolvent(s.id, {
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
                              updateSolvent(s.id, {
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
                                solvents: recipe.solvents.filter(
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

                  {search?.role === "solvent" && (
                    <Box mt={6}>
                      <InlineSearch
                        ingredientRole="solvent"
                        onSelect={handleSearchSelect}
                        onCancel={() => setSearch(null)}
                      />
                    </Box>
                  )}
                </Box>

                {/* Solutes */}
                <Box>
                  <Group justify="space-between" mb={6}>
                    <Text size="sm" fw={600}>
                      Solutes
                    </Text>
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
                          <NumberInput
                            size="xs"
                            value={s.amount !== "" ? Number(s.amount) : ""}
                            placeholder="0"
                            min={0}
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
                        onSelect={handleSearchSelect}
                        onCancel={() => setSearch(null)}
                      />
                    </Box>
                  )}
                </Box>
              </Stack>
            </Box>
          </Group>
        </Box>
      )}
    </Box>
  )
}

// ── Chemistry tab ─────────────────────────────────────────────────────────────

export function ChemistryTab({
  process,
  onUpdateProcess,
}: {
  process: Process
  onUpdateProcess: (updated: Process) => void
}) {
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const containerRef = useRef<HTMLDivElement>(null)

  const recipes = process.solutionRecipes ?? []

  const updateRecipes = (updated: ProcessSolutionRecipe[]) =>
    onUpdateProcess({ ...process, solutionRecipes: updated })

  const addRecipe = () => {
    const r: ProcessSolutionRecipe = {
      id: crypto.randomUUID(),
      name: "",
      totalSolventVolumeMl: "1",
      solvents: [],
      solutes: [],
    }
    updateRecipes([...recipes, r])
    setExpandedId(r.id)
  }

  const updateRecipe = (updated: ProcessSolutionRecipe) =>
    updateRecipes(recipes.map((r) => (r.id === updated.id ? updated : r)))

  const deleteRecipe = (id: string) => {
    updateRecipes(recipes.filter((r) => r.id !== id))
    if (expandedId === id) setExpandedId(null)
  }

  useEffect(() => {
    const handler = (e: MouseEvent) => {
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
          <Button leftSection={<IconPlus size={16} />} onClick={addRecipe}>
            Define Solution
          </Button>
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
          expanded={expandedId === r.id}
          onToggle={() =>
            setExpandedId((prev) => (prev === r.id ? null : r.id))
          }
          onUpdate={updateRecipe}
          onDelete={() => deleteRecipe(r.id)}
        />
      ))}
      <Group>
        <Button
          size="xs"
          variant="subtle"
          leftSection={<IconPlus size={14} />}
          onClick={addRecipe}
        >
          Define Solution
        </Button>
      </Group>
    </Stack>
  )
}
