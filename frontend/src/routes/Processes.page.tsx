import {
  ActionIcon,
  Badge,
  Box,
  Button,
  Divider,
  Group,
  Menu,
  NumberInput,
  Paper,
  ScrollArea,
  Select,
  SimpleGrid,
  Stack,
  Text,
  Textarea,
  TextInput,
  Tooltip,
} from "@mantine/core"
import { modals } from "@mantine/modals"
import {
  IconArrowBackUp,
  IconAtom,
  IconCheck,
  IconChevronDown,
  IconCopy,
  IconDownload,
  IconDroplet,
  IconLayersIntersect,
  IconPlayerPlay,
  IconPlus,
  IconRefresh,
  IconRowInsertTop,
  IconSparkles,
  IconSquare,
  IconTrash,
  IconX,
} from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { DryingMethodInput, summariseQuenchingValue } from "@/components/QuenchingModal"
import {
  type CollectionConfirmParams,
  SelectCollectionModal,
} from "@/components/SelectCollectionModal"
import {
  exportProcessProtocolAsDocx,
  exportProcessProtocolAsPdf,
} from "@/lib/processExport"
import {
  type CanvasCollectionElement,
  getDependentLocations,
  type Material,
  newProcess,
  newProcessStep,
  PROCESS_PARAMETER_DEFINITIONS,
  type Process,
  type ProcessGeneratedStack,
  type ProcessParam,
  type ProcessParameterKey,
  type ProcessStep,
  type ProcessStepCategory,
  type Solution,
  useAppContext,
  useEntityCollection,
} from "@/store/AppContext"
import { DependencyBlockModal } from "../components/DependencyBlockModal"

const STEP_CATEGORIES: Array<{
  value: ProcessStepCategory
  label: string
  icon: React.ReactNode
}> = [
  {
    value: "wet_deposition",
    label: "Wet Deposition",
    icon: <IconDroplet size={14} />,
  },
  {
    value: "dry_deposition",
    label: "Dry Deposition",
    icon: <IconLayersIntersect size={14} />,
  },
  {
    value: "surface_treatment",
    label: "Surface Treatment",
    icon: <IconSparkles size={14} />,
  },
  {
    value: "doping_aging",
    label: "Doping/Aging",
    icon: <IconAtom size={14} />,
  },
  {
    value: "substrate_preparation",
    label: "Substrate Preparation",
    icon: <IconSquare size={14} />,
  },
]

const STEP_CATEGORY_ICON_MAP: Record<ProcessStepCategory, React.ReactNode> = {
  wet_deposition: <IconDroplet size={14} />,
  dry_deposition: <IconLayersIntersect size={14} />,
  surface_treatment: <IconSparkles size={14} />,
  doping_aging: <IconAtom size={14} />,
  substrate_preparation: <IconSquare size={14} />,
}

const SUBSTRATE_COLOR = "#6e8c9e"
const ROW_ACTION_SLOT_WIDTH = 220
const DEFAULT_SUBSTRATE_DIMENSIONS = {
  lengthCm: "2",
  widthCm: "2",
  surfaceRoughnessRmsNm: "",
}
const NEW_CHEMICAL_OPTION = "action:new-material:chemical_compound"
const NEW_COMMERCIAL_MIXTURE_OPTION = "action:new-material:commercial_mixture"
const NEW_SOLUTION_OPTION = "action:new-solution"

const STEP_COLOR_PALETTE = [
  "#d96c4f",
  "#5b8c85",
  "#6f7cc3",
  "#b5895a",
  "#7a9e4b",
  "#b06c8d",
  "#4d8fb3",
  "#9a6bb0",
]

const PROCESS_DETAIL_DEFINITIONS = new Map(
  PROCESS_PARAMETER_DEFINITIONS.map((definition) => [
    definition.key,
    definition,
  ]),
)

const DEFAULT_DEPOSITION_KEYS: ProcessParameterKey[] = [
  "depositionMethod",
  "substrateTemp",
  "depositionAtmosphere",
  "depositionParameters",
  "solutionVolume",
  "dryingMethod",
]

const DEFAULT_ANNEALING_KEYS: ProcessParameterKey[] = [
  "annealingTime",
  "annealingTemp",
  "annealingAtmosphere",
]

function getParameterSections(stepCategory: ProcessStepCategory): {
  deposition: ProcessParameterKey[]
  annealing: ProcessParameterKey[]
  labelOverrides: Partial<Record<ProcessParameterKey, string>>
  placeholderOverrides: Partial<Record<ProcessParameterKey, string>>
} {
  if (stepCategory === "substrate_preparation") {
    return {
      deposition: ["depositionMethod", "annealingTime", "depositionParameters"],
      annealing: [],
      labelOverrides: {
        depositionMethod: "Cleaning Method",
        annealingTime: "Cleaning Time",
        depositionParameters: "Cleaning Parameters",
      },
      placeholderOverrides: {},
    }
  }

  if (stepCategory === "dry_deposition") {
    return {
      deposition: [
        "depositionMethod",
        "substrateTemp",
        "depositionParameters",
        "depositionAtmosphere",
      ],
      annealing: DEFAULT_ANNEALING_KEYS,
      labelOverrides: {},
      placeholderOverrides: {
        depositionParameters: "Rate / Temperature",
      },
    }
  }

  if (stepCategory === "wet_deposition") {
    return {
      // Two-column SimpleGrid is row-major. This ordering yields:
      // Left: Deposition Method, Deposition Parameters, Deposition Atmosphere
      // Right: Solution Volume, Substrate Temperature, Drying/Quenching
      deposition: [
        "depositionMethod",
        "solutionVolume",
        "depositionParameters",
        "substrateTemp",
        "depositionAtmosphere",
        "dryingMethod",
      ],
      annealing: DEFAULT_ANNEALING_KEYS,
      labelOverrides: {},
      placeholderOverrides: {},
    }
  }

  if (stepCategory === "surface_treatment") {
    return {
      // Surface treatment reuses the same layout pattern as wet deposition.
      deposition: [
        "depositionMethod",
        "solutionVolume",
        "depositionParameters",
        "substrateTemp",
        "depositionAtmosphere",
        "dryingMethod",
      ],
      annealing: DEFAULT_ANNEALING_KEYS,
      labelOverrides: {},
      placeholderOverrides: {},
    }
  }

  if (stepCategory === "doping_aging") {
    return {
      deposition: ["annealingAtmosphere", "annealingTemp", "annealingTime"],
      annealing: [],
      labelOverrides: {
        annealingAtmosphere: "Doping Atmosphere",
        annealingTemp: "Atmosphere Temperature",
        annealingTime: "Doping Time",
      },
      placeholderOverrides: {},
    }
  }

  return {
    deposition: DEFAULT_DEPOSITION_KEYS,
    annealing: DEFAULT_ANNEALING_KEYS,
    labelOverrides: {},
    placeholderOverrides: {},
  }
}

function randomStepColor() {
  return STEP_COLOR_PALETTE[
    Math.floor(Math.random() * STEP_COLOR_PALETTE.length)
  ]
}

function ProcessParamInput({
  label,
  param,
  onChange,
  placeholder,
  unit,
  initialParam,
  sourceSuggestions = [],
  type = "text",
}: {
  label: string
  param?: ProcessParam
  onChange: (param: ProcessParam | undefined) => void
  placeholder?: string
  unit?: string
  initialParam?: ProcessParam
  sourceSuggestions?: Array<{
    name: string
    origin: string
    param: ProcessParam
  }>
  type?: "text" | "number" | "datetime-local"
}) {
  const [expanded, setExpanded] = useState(Boolean(param))

  useEffect(() => {
    setExpanded(Boolean(param))
  }, [param])

  if (!expanded) {
    return (
      <Group gap={4} align="flex-start" wrap="wrap">
        <Button
          variant="subtle"
          size="xs"
          color="green"
          leftSection={<IconPlus size={12} />}
          onClick={() => {
            setExpanded(true)
            onChange(initialParam ?? { value: "", mode: "constant" })
          }}
          style={{ justifyContent: "flex-start" }}
        >
          {`Add ${label}`.replace(/\s*\([^)]*\)/g, "")}
        </Button>

        {sourceSuggestions.map((source) => (
          <Button
            key={`${source.name}:${source.origin}:${source.param.mode}:${source.param.value}`}
            variant="subtle"
            size="xs"
            color="teal"
            leftSection={<IconPlus size={12} />}
            onClick={() => {
              setExpanded(true)
              onChange({ ...source.param })
            }}
            style={{ justifyContent: "flex-start" }}
          >
            {`${source.param.value}${unit ? ` ${unit}` : ""}`}
          </Button>
        ))}
      </Group>
    )
  }

  return (
    <Box>
      <Group gap="xs" mb={4}>
        <Text size="xs" fw={500}>
          {label}
        </Text>
        {unit && (
          <Text size="xs" c="dimmed">
            ({unit})
          </Text>
        )}
        <ActionIcon
          size="xs"
          variant="subtle"
          color="red"
          onClick={() => {
            setExpanded(false)
            onChange(undefined)
          }}
        >
          <IconX size={10} />
        </ActionIcon>
      </Group>

      <Group gap="xs" align="flex-end" wrap="nowrap">
        {type === "number" ? (
          <NumberInput
            size="xs"
            value={param?.value ? Number(param.value) : ""}
            onChange={(val) =>
              onChange({
                ...(param ?? { mode: "constant", value: "" }),
                value:
                  typeof val === "number" ? String(val) : String(val ?? ""),
              })
            }
            placeholder={placeholder}
            style={{ flex: 1 }}
          />
        ) : (
          <TextInput
            size="xs"
            type={type}
            value={param?.value ?? ""}
            onChange={(e) =>
              onChange({
                ...(param ?? { mode: "constant", value: "" }),
                value: e.currentTarget.value,
              })
            }
            placeholder={placeholder}
            style={{ flex: 1 }}
          />
        )}
      </Group>
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Device Stack Generation & Rendering
// ─────────────────────────────────────────────────────────────────────────────

type StackLayer = {
  id: string
  name: string
  color: string
  isSubstrate: boolean
  layerType: string // "ETL" | "HTL" | "absorber" | "contact" | "interlayer" | ""
  thicknessNm: string
  bandgapEv: string
  perovskiteA: string
  perovskiteB: string
  perovskiteX: string
}

const LAYER_TYPE_OPTIONS = ["ETL", "HTL", "absorber", "contact", "interlayer"]

// Based on NOMAD perovskite schema ion lists (ion_vars.py).
const NOMAD_PEROVSKITE_A_IONS = new Set([
  "MA",
  "FA",
  "Cs",
  "Rb",
  "K",
  "Na",
  "GU",
  "NH4",
  "BA",
  "PEA",
  "EA",
  "DMA",
  "TMA",
  "PMA",
  "AVA",
  "5-AVA",
  "HA",
  "CHMA",
  "Ada",
  "Anyl",
  "A43",
  "BI",
])

const NOMAD_PEROVSKITE_B_IONS = new Set([
  "Fe",
  "Nb",
  "Ag",
  "Te",
  "Ni",
  "Hg",
  "Pt",
  "Ba",
  "Al",
  "Eu",
  "Ca",
  "Co",
  "Y",
  "Ti",
  "Zn",
  "Au",
  "In",
  "Sr",
  "Sn",
  "Sb",
  "Ge",
  "Bi",
  "Mg",
  "Cu",
  "Cr",
  "Pb",
  "Mn",
  "Sm",
  "La",
  "Tb",
])

const NOMAD_PEROVSKITE_X_IONS = new Set([
  "Cl",
  "BF4",
  "S",
  "O",
  "Br",
  "F",
  "I",
  "SCN",
  "PF6",
])

const PEROVSKITE_A_FORMULA_SUGGESTIONS = [
  "FA1",
  "MA1",
  "Cs1",
  "FA0.9MA0.1",
  "Cs0.05FA0.79MA0.16",
  "Cs0.1FA0.9",
]

const PEROVSKITE_B_FORMULA_SUGGESTIONS = [
  "Pb1",
  "Sn1",
  "Pb0.8Sn0.2",
  "Pb0.5Sn0.5",
  "Pb0.9Ge0.1",
]

const PEROVSKITE_X_FORMULA_SUGGESTIONS = [
  "I1",
  "Br1",
  "Cl1",
  "I0.75Br0.25",
  "I0.5Br0.5",
  "Br0.2I0.8",
]

type PerovskiteSite = "A" | "B" | "X"

type PerovskiteLayerValidation = {
  aErrors: string[]
  bErrors: string[]
  xErrors: string[]
  errors: string[]
}

function normalizePerovskiteIonToken(token: string): string {
  if (token.startsWith("(") && token.endsWith(")")) {
    return token.slice(1, -1)
  }
  return token
}

function parsePerovskiteSiteFormula(rawValue: string): {
  components: Array<{ ion: string; coefficient: number }>
  parseError?: string
} {
  const compact = rawValue.replace(/\s+/g, "")
  if (!compact) {
    return { components: [] }
  }

  const componentRegex = /(\([^)]+\)|[A-Za-z][A-Za-z0-9+-]*)(\d+(?:\.\d+)?|\.\d+)/g
  const components: Array<{ ion: string; coefficient: number }> = []
  let consumedUntil = 0

  let match = componentRegex.exec(compact)
  while (match) {
    if (match.index !== consumedUntil) {
      return {
        components: [],
        parseError:
          "Invalid formula syntax. Use Ion+coefficient blocks, e.g. Cs0.1FA0.9",
      }
    }
    const coefficient = Number(match[2])
    if (!Number.isFinite(coefficient)) {
      return {
        components: [],
        parseError: `Invalid coefficient \"${match[2]}\"`,
      }
    }
    components.push({
      ion: normalizePerovskiteIonToken(match[1]),
      coefficient,
    })
    consumedUntil = componentRegex.lastIndex
    match = componentRegex.exec(compact)
  }

  if (consumedUntil !== compact.length) {
    return {
      components: [],
      parseError:
        "Invalid formula syntax. Use Ion+coefficient blocks, e.g. I0.75Br0.25",
    }
  }

  return { components }
}

function validatePerovskiteSiteFormula(
  site: PerovskiteSite,
  rawValue: string,
  allowedIons: Set<string>,
): string[] {
  const value = rawValue.trim()
  if (!value) return []

  const { components, parseError } = parsePerovskiteSiteFormula(value)
  if (parseError) {
    return [`${site}: ${parseError}`]
  }

  const errors: string[] = []
  let sum = 0

  for (const component of components) {
    if (component.coefficient <= 0) {
      errors.push(
        `${site}: coefficient for ${component.ion} must be > 0 (got ${component.coefficient}).`,
      )
    }

    if (!allowedIons.has(component.ion)) {
      const caseInsensitiveMatch = Array.from(allowedIons).find(
        (candidate) => candidate.toLowerCase() === component.ion.toLowerCase(),
      )
      if (caseInsensitiveMatch) {
        errors.push(
          `${site}: ${component.ion} is not valid in NOMAD. Did you mean ${caseInsensitiveMatch}?`,
        )
      } else {
        errors.push(
          `${site}: ${component.ion} is not in the NOMAD ${site}-site ion list.`,
        )
      }
    }

    sum += component.coefficient
  }

  if (Math.abs(sum - 1) > 1e-3) {
    errors.push(`${site}: coefficients must sum to 1 (got ${sum.toFixed(3)}).`)
  }

  return errors
}

function validatePerovskiteLayerComposition(
  layer: Pick<StackLayer, "perovskiteA" | "perovskiteB" | "perovskiteX">,
): PerovskiteLayerValidation {
  const aErrors = validatePerovskiteSiteFormula(
    "A",
    layer.perovskiteA,
    NOMAD_PEROVSKITE_A_IONS,
  )
  const bErrors = validatePerovskiteSiteFormula(
    "B",
    layer.perovskiteB,
    NOMAD_PEROVSKITE_B_IONS,
  )
  const xErrors = validatePerovskiteSiteFormula(
    "X",
    layer.perovskiteX,
    NOMAD_PEROVSKITE_X_IONS,
  )
  return {
    aErrors,
    bErrors,
    xErrors,
    errors: [...aErrors, ...bErrors, ...xErrors],
  }
}

function getMaterialTypeStr(step: ProcessStep, materials: Material[]): string {
  if (step.materialId) {
    const mat = materials.find((m) => m.id === step.materialId)
    return mat?.type?.toLowerCase() ?? ""
  }
  return ""
}

function getSolidComponents(
  solutionId: string,
  materials: Material[],
  solutions: Solution[],
): Material[] {
  const sol = solutions.find((s) => s.id === solutionId)
  if (!sol?.components?.length) return []
  return sol.components
    .map((comp) => materials.find((m) => m.id === comp.materialId))
    .filter((mat): mat is Material => Boolean(mat))
    .filter(
      (mat) =>
        mat.type?.toLowerCase() !== "solvent" && mat.stateAtRt === "solid",
    )
}

function isPerovskitePrecursor(
  step: ProcessStep,
  materials: Material[],
  solutions: Solution[],
): boolean {
  if (step.materialId) {
    return getMaterialTypeStr(step, materials).includes("perovskite")
  }
  if (step.solutionId) {
    return getSolidComponents(step.solutionId, materials, solutions).some(
      (mat) => mat.type?.toLowerCase().includes("perovskite"),
    )
  }
  return false
}

function getDefaultLayerType(
  step: ProcessStep,
  materials: Material[],
  solutions: Solution[],
): string {
  if (step.materialId) {
    const t = getMaterialTypeStr(step, materials)
    if (t.includes("n-type") || t.includes("etl")) return "ETL"
    if (t.includes("p-type") || t.includes("htl")) return "HTL"
    if (t.includes("perovskite")) return "absorber"
    if (t.includes("conductor") || t.includes("contact")) return "contact"
    if (t.includes("semiconductor")) return "absorber"
    return "interlayer"
  }
  if (step.solutionId) {
    const solids = getSolidComponents(step.solutionId, materials, solutions)
    // Perovskite precursor takes highest priority
    if (solids.some((mat) => mat.type?.toLowerCase().includes("perovskite")))
      return "absorber"
    for (const mat of solids) {
      const t = mat.type?.toLowerCase() ?? ""
      if (t.includes("n-type") || t.includes("etl")) return "ETL"
      if (t.includes("p-type") || t.includes("htl")) return "HTL"
      if (t.includes("conductor") || t.includes("contact")) return "contact"
      if (t.includes("semiconductor")) return "absorber"
    }
  }
  return "interlayer"
}

type GeneratedStack = {
  layers: StackLayer[]
  combination: number // for identifying which alternative combo this represents
  architecture?: string
  buildDevice?: "Yes" | "No"
  pixelAreaCm2?: string
  numberOfPixels?: string
}

function getStackInvalidationKey(process: Process | null): string {
  if (!process) return ""

  const substrateKey = (process.substrateIds ?? []).join("|")
  const stageKey = process.stages
    .map(
      (stage, stagePos) =>
        `${stagePos}:${stage.alternatives
          .map(
            (step, altPos) =>
              `${altPos}:${step.id}:${step.materialId ?? ""}:${step.solutionId ?? ""}`,
          )
          .join(",")}`,
    )
    .join(";")

  return `${process.id}::${substrateKey}::${stageKey}`
}

function getLayerName(
  step: ProcessStep,
  materials: Material[],
  solutions: Solution[],
): string {
  // Try to get material/solution name
  if (step.materialId) {
    const mat = materials.find((m) => m.id === step.materialId)
    return mat?.name || "Unnamed Material"
  }
  if (step.solutionId) {
    const sol = solutions.find((s) => s.id === step.solutionId)
    if (sol?.components?.length) {
      const solidNames = Array.from(
        new Set(
          sol.components
            .map((comp) => materials.find((m) => m.id === comp.materialId))
            .filter((mat): mat is Material => Boolean(mat))
            .filter((mat) => mat.type !== "solvent")
            .filter(
              (mat) =>
                mat.stateAtRt === "solid" ||
                (mat.category ?? "chemical_compound") === "substrate_material",
            )
            .map(
              (mat) =>
                mat.name || mat.inventoryLabel || mat.casNumber || mat.id,
            ),
        ),
      )
      if (solidNames.length > 0) {
        return solidNames.join(", ")
      }
    }
    return step.depositionMethod?.value?.trim() || step.name || "Unnamed"
  }
  // Fallback to deposition method
  return step.depositionMethod?.value?.trim() || step.name || "Unnamed"
}

function shouldIncludeLayer(
  step: ProcessStep,
  materials: Material[],
  solutions: Solution[],
): boolean {
  // Exclude solvents, surface modifiers, etc.
  if (step.stepCategory === "surface_treatment") {
    return false
  }

  // Check material type
  if (step.materialId) {
    const mat = materials.find((m) => m.id === step.materialId)
    if (!mat) return true // include if not found

    // Exclude solvents in materials (type field)
    const materialType = mat.type?.toLowerCase() || ""
    if (
      materialType.includes("solvent") ||
      materialType.includes("surface modifier")
    ) {
      return false
    }
    return true
  }

  // For solutions, only include solid materials (not solvents)
  if (step.solutionId) {
    const sol = solutions.find((s) => s.id === step.solutionId)
    if (!sol || !sol.components) return true

    // Check if solution has any solid components
    for (const comp of sol.components) {
      const mat = materials.find((m) => m.id === comp.materialId)
      if (
        mat &&
        (mat.stateAtRt === "solid" || mat.category === "substrate_material")
      ) {
        return true
      }
    }
    return false
  }

  return true
}

/**
 * Generate all possible device stack combinations from a process.
 * Returns one stack per unique combination of alternative steps.
 */
function generateStackCombinations(
  process: Process,
  materials: Material[],
  solutions: Solution[],
  substrateMap: Map<string, Material>,
): GeneratedStack[] {
  if (process.substrateIds.length === 0 || process.stages.length === 0) {
    return []
  }

  // Build cartesian product of stage alternatives
  const combinations: ProcessStep[][] = [[]]

  for (const stage of process.stages) {
    const newCombinations: ProcessStep[][] = []
    for (const combo of combinations) {
      for (const step of stage.alternatives) {
        newCombinations.push([...combo, step])
      }
    }
    combinations.splice(0, combinations.length, ...newCombinations)
  }

  // Convert each substrate + step combination to a stack
  const stacks: GeneratedStack[] = []
  let combinationCounter = 0

  for (const substrateId of process.substrateIds) {
    const substrate = substrateMap.get(substrateId)
    if (!substrate) continue

    for (const combo of combinations) {
      const layers: StackLayer[] = []

      // Add substrate at bottom
      layers.push({
        id: substrate.id,
        name: `substrate: ${substrate.name || "Unnamed"}`,
        color: SUBSTRATE_COLOR,
        isSubstrate: true,
        layerType: "",
        thicknessNm: "",
        bandgapEv: "",
        perovskiteA: "",
        perovskiteB: "",
        perovskiteX: "",
      })

      // Filter to includable steps
      const includedSteps = combo.filter((step) =>
        shouldIncludeLayer(step, materials, solutions),
      )

      // Merge consecutive perovskite precursor steps into one "Perovskite" layer
      type MergedEntry = {
        step: ProcessStep
        name: string
        isPerovskite: boolean
      }
      const merged: MergedEntry[] = []
      for (const step of includedSteps) {
        const isPero = isPerovskitePrecursor(step, materials, solutions)
        if (
          isPero &&
          merged.length > 0 &&
          merged[merged.length - 1].isPerovskite
        ) {
          // absorb into previous perovskite group (keep first step's color)
        } else {
          merged.push({
            step,
            name: isPero
              ? "Perovskite"
              : getLayerName(step, materials, solutions),
            isPerovskite: isPero,
          })
        }
      }

      for (const entry of merged) {
        layers.push({
          id: entry.step.id,
          name: entry.name,
          color: entry.step.color,
          isSubstrate: false,
          layerType: getDefaultLayerType(entry.step, materials, solutions),
          thicknessNm: "",
          bandgapEv: "",
          perovskiteA: "",
          perovskiteB: "",
          perovskiteX: "",
        })
      }

      stacks.push({
        layers,
        combination: combinationCounter,
        architecture: "Unknown",
        buildDevice: "Yes",
        pixelAreaCm2: "",
        numberOfPixels: "4",
      })
      combinationCounter += 1
    }
  }

  return stacks
}

type ResultingStacksProps = {
  stacks: GeneratedStack[]
  deletedCombinations: Set<number>
  onLayerChange: (
    stackIdx: number,
    layerIdx: number,
    field: keyof StackLayer,
    value: string,
  ) => void
  onStackFieldChange: (
    stackIdx: number,
    field: "architecture" | "buildDevice" | "pixelAreaCm2" | "numberOfPixels",
    value: string,
  ) => void
  onDelete: (combination: number) => void
  onRecover: (combination: number) => void
  onRefresh: () => void
}

function ResultingStacks({
  stacks,
  deletedCombinations,
  onLayerChange,
  onStackFieldChange,
  onDelete,
  onRecover,
  onRefresh,
}: ResultingStacksProps) {
  const LAYER_HEIGHT = 42
  const PEROVSKITE_LAYER_HEIGHT = 92
  const PEROVSKITE_EDIT_LAYER_HEIGHT = 144
  const SUBSTRATE_HEIGHT = 50
  const [editingLayerKey, setEditingLayerKey] = useState<string | null>(null)
  const [expandedFields, setExpandedFields] = useState<
    Record<string, { thickness: boolean; bandgap: boolean }>
  >({})

  const toggleExpandedField = (
    layerKey: string,
    field: "thickness" | "bandgap",
  ) => {
    setExpandedFields((prev) => ({
      ...prev,
      [layerKey]: {
        ...(prev[layerKey] ?? { thickness: false, bandgap: false }),
        [field]: true,
      },
    }))
  }

  const addParamButtonStyle: React.CSSProperties = {
    background: "none",
    border: "1px dashed #ced4da",
    borderRadius: 4,
    color: "#868e96",
    fontSize: 9,
    padding: "2px 4px",
    cursor: "pointer",
    width: "100%",
    textAlign: "center" as const,
    lineHeight: "1.4",
  }

  const sideInputStyle: React.CSSProperties = {
    fontSize: 11,
    border: "1px solid #dee2e6",
    borderRadius: 4,
    padding: "2px 4px",
    background: "white",
    color: "#333",
    width: "100%",
    outline: "none",
  }

  const inLayerFieldInputStyle: React.CSSProperties = {
    width: "100%",
    background: "rgba(255,255,255,0.16)",
    border: "1px solid rgba(255,255,255,0.3)",
    borderRadius: 4,
    color: "white",
    fontSize: 11,
    padding: "2px 4px",
    outline: "none",
  }

  const activeStacks = stacks.filter(
    (s) => !deletedCombinations.has(s.combination),
  )
  const deletedStacks = stacks.filter((s) =>
    deletedCombinations.has(s.combination),
  )
  const getLayerKey = (combination: number, layerIdx: number) =>
    `${combination}-${layerIdx}`

  return (
    <Box onClick={() => setEditingLayerKey(null)}>
      <Group justify="space-between" align="center" mb="md">
        <Text size="sm" fw={600}>
          Generated Device Stacks ({activeStacks.length} combination
          {activeStacks.length !== 1 ? "s" : ""})
        </Text>
        <Tooltip label="Refresh generated stacks" withArrow>
          <ActionIcon
            size="sm"
            variant="subtle"
            color="blue"
            onClick={onRefresh}
          >
            <IconRefresh size={14} />
          </ActionIcon>
        </Tooltip>
      </Group>
      <Group gap="xl" wrap="wrap" align="flex-start" justify="center">
        {activeStacks.map((stack) => {
          const stackIdx = stacks.indexOf(stack)
          return (
            <Paper
              key={`stack-${stack.combination}`}
              withBorder
              p="md"
              radius="md"
              style={{ minWidth: 440, position: "relative" }}
            >
              {/* Delete (X) button — top right corner */}
              <Tooltip label="Remove combination" withArrow>
                <ActionIcon
                  size="xs"
                  variant="subtle"
                  color="gray"
                  style={{ position: "absolute", top: 6, right: 6, zIndex: 1 }}
                  onClick={() => onDelete(stack.combination)}
                >
                  <IconX size={12} />
                </ActionIcon>
              </Tooltip>

              {/* Stack-level metadata fields */}
              <Box
                mb="md"
                p="xs"
                style={{
                  background: "var(--mantine-color-gray-0)",
                  borderRadius: 6,
                }}
              >
                <Group gap="xs" wrap="nowrap" align="flex-start">
                  {/* Architecture dropdown */}
                  <Box style={{ flex: 1 }}>
                    <Text size="10px" c="dimmed" mb={2}>
                      Architecture
                    </Text>
                    <select
                      value={stack.architecture || "Unknown"}
                      onChange={(e) =>
                        onStackFieldChange(
                          stackIdx,
                          "architecture",
                          e.currentTarget.value,
                        )
                      }
                      style={{
                        width: "100%",
                        fontSize: 11,
                        border: "1px solid #dee2e6",
                        borderRadius: 4,
                        padding: "4px 6px",
                        background: "white",
                        color: "#333",
                        outline: "none",
                      }}
                    >
                      <option value="Unknown">Unknown</option>
                      <option value="Pn-Heterojunction">
                        Pn-Heterojunction
                      </option>
                      <option value="Front contacted">Front contacted</option>
                      <option value="Back contacted">Back contacted</option>
                      <option value="pin">pin</option>
                      <option value="nip">nip</option>
                      <option value="Schottky">Schottky</option>
                    </select>
                  </Box>

                  {/* Build Device selector */}
                  <Box style={{ width: 100 }}>
                    <Text size="10px" c="dimmed" mb={2}>
                      Build Device
                    </Text>
                    <select
                      value={stack.buildDevice || "Yes"}
                      onChange={(e) =>
                        onStackFieldChange(
                          stackIdx,
                          "buildDevice",
                          e.currentTarget.value as "Yes" | "No",
                        )
                      }
                      style={{
                        width: "100%",
                        fontSize: 11,
                        border: "1px solid #dee2e6",
                        borderRadius: 4,
                        padding: "4px 6px",
                        background: "white",
                        color: "#333",
                        outline: "none",
                      }}
                    >
                      <option value="Yes">Yes</option>
                      <option value="No">No</option>
                    </select>
                  </Box>

                  {/* Pixel area - only show if buildDevice is Yes */}
                  {stack.buildDevice !== "No" && (
                    <Box style={{ width: 100 }}>
                      <Text size="10px" c="dimmed" mb={2}>
                        Area (cm²)
                      </Text>
                      <input
                        type="number"
                        min={0}
                        step={0.01}
                        value={stack.pixelAreaCm2 || ""}
                        onChange={(e) =>
                          onStackFieldChange(
                            stackIdx,
                            "pixelAreaCm2",
                            e.currentTarget.value,
                          )
                        }
                        placeholder="—"
                        style={{
                          width: "100%",
                          fontSize: 11,
                          border: "1px solid #dee2e6",
                          borderRadius: 4,
                          padding: "4px 6px",
                          background: "white",
                          color: "#333",
                          outline: "none",
                          textAlign: "right",
                        }}
                      />
                    </Box>
                  )}

                  {/* Number of pixels - only show if buildDevice is Yes */}
                  {stack.buildDevice !== "No" && (
                    <Box style={{ width: 80 }}>
                      <Text size="10px" c="dimmed" mb={2}>
                        # Pixels
                      </Text>
                      <input
                        type="number"
                        min={1}
                        step={1}
                        value={stack.numberOfPixels || "4"}
                        onChange={(e) =>
                          onStackFieldChange(
                            stackIdx,
                            "numberOfPixels",
                            e.currentTarget.value,
                          )
                        }
                        style={{
                          width: "100%",
                          fontSize: 11,
                          border: "1px solid #dee2e6",
                          borderRadius: 4,
                          padding: "4px 6px",
                          background: "white",
                          color: "#333",
                          outline: "none",
                          textAlign: "right",
                        }}
                      />
                    </Box>
                  )}
                </Group>
              </Box>

              {/* Column headers */}
              <Box
                style={{
                  display: "flex",
                  gap: 4,
                  marginBottom: 4,
                  paddingRight: 20,
                }}
              >
                <Box style={{ width: 96 }}>
                  <Text size="10px" c="dimmed" ta="center">
                    Type
                  </Text>
                </Box>
                <Box style={{ flex: 1 }}>
                  <Text size="10px" c="dimmed" ta="center">
                    Layer
                  </Text>
                </Box>
                <Box style={{ width: 92 }}>
                  <Text size="10px" c="dimmed" ta="center">
                    nm
                  </Text>
                </Box>
              </Box>

              <Box
                style={{
                  display: "flex",
                  flexDirection: "column-reverse",
                  gap: 2,
                }}
              >
                {stack.layers.map((layer, layerIdx) => {
                  const depositIndex = layerIdx
                  const layerKey = getLayerKey(stack.combination, layerIdx)
                  const isEditing = editingLayerKey === layerKey

                  if (layer.isSubstrate) {
                    return (
                      <Box
                        key={`layer-${layer.id}`}
                        style={{
                          display: "flex",
                          alignItems: "stretch",
                          gap: 4,
                        }}
                      >
                        <Box style={{ width: 96, flexShrink: 0 }} />
                        <Box
                          style={{
                            flex: 1,
                            background: layer.color,
                            height: SUBSTRATE_HEIGHT,
                            borderRadius: 4,
                            display: "flex",
                            alignItems: "center",
                            border: "1px solid rgba(0,0,0,0.1)",
                            padding: "0 8px",
                          }}
                          onClick={(e) => {
                            e.stopPropagation()
                            setEditingLayerKey(layerKey)
                          }}
                        >
                          {isEditing ? (
                            <Box
                              style={{ width: "100%", position: "relative" }}
                            >
                              <ActionIcon
                                size="xs"
                                variant="subtle"
                                color="gray"
                                style={{
                                  position: "absolute",
                                  top: 2,
                                  right: 2,
                                }}
                                onClick={(e) => {
                                  e.stopPropagation()
                                  setEditingLayerKey(null)
                                }}
                              >
                                <IconCheck size={12} />
                              </ActionIcon>
                              <input
                                type="text"
                                value={layer.name}
                                onChange={(e) =>
                                  onLayerChange(
                                    stackIdx,
                                    layerIdx,
                                    "name",
                                    e.currentTarget.value,
                                  )
                                }
                                onClick={(e) => e.stopPropagation()}
                                style={inLayerFieldInputStyle}
                              />
                            </Box>
                          ) : (
                            <Text
                              size="sm"
                              c="white"
                              fw={600}
                              ta="center"
                              style={{
                                width: "100%",
                                textShadow: "0 1px 2px rgba(0,0,0,0.3)",
                              }}
                            >
                              {layer.name || "Unnamed"}
                            </Text>
                          )}
                        </Box>
                        <Box style={{ width: 92, flexShrink: 0 }} />
                      </Box>
                    )
                  }

                  return (
                    <Box
                      key={`layer-${layer.id}`}
                      style={{ display: "flex", alignItems: "center", gap: 4 }}
                    >
                      {(() => {
                        const isPerovskiteLayer = layer.name
                          .toLowerCase()
                          .includes("perovskite")
                        const perovskiteValidation = isPerovskiteLayer
                          ? validatePerovskiteLayerComposition(layer)
                          : null
                        const hasPerovskiteErrors =
                          (perovskiteValidation?.errors.length ?? 0) > 0
                        const layerHeight = isPerovskiteLayer
                          ? isEditing
                            ? PEROVSKITE_EDIT_LAYER_HEIGHT
                            : PEROVSKITE_LAYER_HEIGHT +
                              (hasPerovskiteErrors ? 16 : 0)
                          : LAYER_HEIGHT

                        return (
                          <>
                            {/* Left: index + type dropdown */}
                            <Box
                              style={{
                                width: 96,
                                flexShrink: 0,
                                display: "flex",
                                flexDirection: "column",
                                gap: 4,
                              }}
                            >
                              <Box
                                style={{
                                  display: "flex",
                                  alignItems: "center",
                                  gap: 4,
                                }}
                              >
                                <Text
                                  size="10px"
                                  c="dimmed"
                                  fw={700}
                                  style={{
                                    width: 14,
                                    flexShrink: 0,
                                    textAlign: "right",
                                  }}
                                >
                                  {depositIndex}
                                </Text>
                                <select
                                  value={layer.layerType}
                                  onChange={(e) =>
                                    onLayerChange(
                                      stackIdx,
                                      layerIdx,
                                      "layerType",
                                      e.currentTarget.value,
                                    )
                                  }
                                  style={{ ...sideInputStyle, flex: 1 }}
                                >
                                  {LAYER_TYPE_OPTIONS.map((opt) => (
                                    <option key={opt} value={opt}>
                                      {opt}
                                    </option>
                                  ))}
                                </select>
                              </Box>
                              {isPerovskiteLayer &&
                                (!!layer.bandgapEv ||
                                expandedFields[layerKey]?.bandgap ? (
                                  <>
                                    <Text size="9px" c="dimmed" ta="left">
                                      Eg (eV)
                                    </Text>
                                    <input
                                      type="number"
                                      min={0}
                                      step="0.01"
                                      value={layer.bandgapEv ?? ""}
                                      onChange={(e) =>
                                        onLayerChange(
                                          stackIdx,
                                          layerIdx,
                                          "bandgapEv",
                                          e.currentTarget.value,
                                        )
                                      }
                                      onClick={(e) => e.stopPropagation()}
                                      placeholder="—"
                                      style={{
                                        ...sideInputStyle,
                                        textAlign: "right",
                                      }}
                                    />
                                  </>
                                ) : (
                                  <button
                                    style={addParamButtonStyle}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      toggleExpandedField(layerKey, "bandgap")
                                    }}
                                  >
                                    + Eg
                                  </button>
                                ))}
                            </Box>

                            {/* Center: colored bar with editable name */}
                            <Box
                              style={{
                                flex: 1,
                                background: layer.color,
                                height: layerHeight,
                                borderRadius: 4,
                                display: "flex",
                                alignItems: "center",
                                border: "1px solid rgba(0,0,0,0.1)",
                                padding: "0 8px",
                              }}
                              onClick={(e) => {
                                e.stopPropagation()
                                setEditingLayerKey(layerKey)
                              }}
                            >
                              {isPerovskiteLayer && isEditing ? (
                                <Box
                                  style={{
                                    width: "100%",
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: 4,
                                  }}
                                >
                                  <Box
                                    style={{
                                      display: "flex",
                                      justifyContent: "flex-end",
                                    }}
                                  >
                                    <ActionIcon
                                      size="xs"
                                      variant="subtle"
                                      color="gray"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setEditingLayerKey(null)
                                      }}
                                    >
                                      <IconCheck size={12} />
                                    </ActionIcon>
                                  </Box>
                                  <Text
                                    size="10px"
                                    c="white"
                                    fw={700}
                                    ta="center"
                                    style={{ opacity: 0.9, marginTop: -4 }}
                                  >
                                    Perovskite ABX3
                                  </Text>
                                  <Box style={{ display: "flex", gap: 4 }}>
                                    <Box style={{ flex: 1 }}>
                                      <Text
                                        size="9px"
                                        c="white"
                                        fw={600}
                                        style={{
                                          opacity: 0.85,
                                          marginBottom: 2,
                                        }}
                                      >
                                        A
                                      </Text>
                                      <input
                                        type="text"
                                        list={`pvk-a-${stack.combination}-${layerIdx}`}
                                        value={layer.perovskiteA}
                                        onChange={(e) =>
                                          onLayerChange(
                                            stackIdx,
                                            layerIdx,
                                            "perovskiteA",
                                            e.currentTarget.value,
                                          )
                                        }
                                        onClick={(e) => e.stopPropagation()}
                                        aria-invalid={
                                          (perovskiteValidation?.aErrors.length ??
                                            0) > 0
                                        }
                                        style={{
                                          ...inLayerFieldInputStyle,
                                          border:
                                            (perovskiteValidation?.aErrors
                                              .length ?? 0) > 0
                                              ? "1px solid #ff8787"
                                              : inLayerFieldInputStyle.border,
                                        }}
                                      />
                                      <datalist
                                        id={`pvk-a-${stack.combination}-${layerIdx}`}
                                      >
                                        {PEROVSKITE_A_FORMULA_SUGGESTIONS.map(
                                          (option) => (
                                            <option key={option} value={option} />
                                          ),
                                        )}
                                      </datalist>
                                    </Box>
                                    <Box style={{ flex: 1 }}>
                                      <Text
                                        size="9px"
                                        c="white"
                                        fw={600}
                                        style={{
                                          opacity: 0.85,
                                          marginBottom: 2,
                                        }}
                                      >
                                        B
                                      </Text>
                                      <input
                                        type="text"
                                        list={`pvk-b-${stack.combination}-${layerIdx}`}
                                        value={layer.perovskiteB}
                                        onChange={(e) =>
                                          onLayerChange(
                                            stackIdx,
                                            layerIdx,
                                            "perovskiteB",
                                            e.currentTarget.value,
                                          )
                                        }
                                        onClick={(e) => e.stopPropagation()}
                                        aria-invalid={
                                          (perovskiteValidation?.bErrors.length ??
                                            0) > 0
                                        }
                                        style={{
                                          ...inLayerFieldInputStyle,
                                          border:
                                            (perovskiteValidation?.bErrors
                                              .length ?? 0) > 0
                                              ? "1px solid #ff8787"
                                              : inLayerFieldInputStyle.border,
                                        }}
                                      />
                                      <datalist
                                        id={`pvk-b-${stack.combination}-${layerIdx}`}
                                      >
                                        {PEROVSKITE_B_FORMULA_SUGGESTIONS.map(
                                          (option) => (
                                            <option key={option} value={option} />
                                          ),
                                        )}
                                      </datalist>
                                    </Box>
                                    <Box style={{ flex: 1 }}>
                                      <Text
                                        size="9px"
                                        c="white"
                                        fw={600}
                                        style={{
                                          opacity: 0.85,
                                          marginBottom: 2,
                                        }}
                                      >
                                        X
                                      </Text>
                                      <input
                                        type="text"
                                        list={`pvk-x-${stack.combination}-${layerIdx}`}
                                        value={layer.perovskiteX}
                                        onChange={(e) =>
                                          onLayerChange(
                                            stackIdx,
                                            layerIdx,
                                            "perovskiteX",
                                            e.currentTarget.value,
                                          )
                                        }
                                        onClick={(e) => e.stopPropagation()}
                                        aria-invalid={
                                          (perovskiteValidation?.xErrors.length ??
                                            0) > 0
                                        }
                                        style={{
                                          ...inLayerFieldInputStyle,
                                          border:
                                            (perovskiteValidation?.xErrors
                                              .length ?? 0) > 0
                                              ? "1px solid #ff8787"
                                              : inLayerFieldInputStyle.border,
                                        }}
                                      />
                                      <datalist
                                        id={`pvk-x-${stack.combination}-${layerIdx}`}
                                      >
                                        {PEROVSKITE_X_FORMULA_SUGGESTIONS.map(
                                          (option) => (
                                            <option key={option} value={option} />
                                          ),
                                        )}
                                      </datalist>
                                    </Box>
                                  </Box>
                                  {hasPerovskiteErrors && (
                                    <Text
                                      size="9px"
                                      c="#ffd8d8"
                                      ta="left"
                                      style={{ lineHeight: 1.2 }}
                                    >
                                      {perovskiteValidation?.errors
                                        .slice(0, 2)
                                        .join(" ")}
                                    </Text>
                                  )}
                                </Box>
                              ) : isPerovskiteLayer ? (
                                <Box
                                  style={{
                                    width: "100%",
                                    display: "flex",
                                    flexDirection: "column",
                                    gap: 2,
                                  }}
                                >
                                  <Text
                                    size="sm"
                                    c="white"
                                    fw={700}
                                    ta="center"
                                    style={{
                                      textShadow: "0 1px 2px rgba(0,0,0,0.3)",
                                    }}
                                  >
                                    Perovskite ABX3
                                  </Text>
                                  <Text
                                    size="xs"
                                    c={
                                      hasPerovskiteErrors ? "#ffd8d8" : "white"
                                    }
                                    ta="center"
                                    style={{
                                      opacity: 0.9,
                                      textShadow: "0 1px 2px rgba(0,0,0,0.3)",
                                    }}
                                  >
                                    A: {layer.perovskiteA || "-"} B:{" "}
                                    {layer.perovskiteB || "-"} X:{" "}
                                    {layer.perovskiteX || "-"}
                                  </Text>
                                  {hasPerovskiteErrors && (
                                    <Text
                                      size="9px"
                                      c="#ffd8d8"
                                      ta="center"
                                      style={{ lineHeight: 1.2 }}
                                    >
                                      {perovskiteValidation?.errors[0]}
                                    </Text>
                                  )}
                                </Box>
                              ) : isEditing ? (
                                <Box style={{ width: "100%" }}>
                                  <Box
                                    style={{
                                      display: "flex",
                                      justifyContent: "flex-end",
                                    }}
                                  >
                                    <ActionIcon
                                      size="xs"
                                      variant="subtle"
                                      color="gray"
                                      onClick={(e) => {
                                        e.stopPropagation()
                                        setEditingLayerKey(null)
                                      }}
                                    >
                                      <IconCheck size={12} />
                                    </ActionIcon>
                                  </Box>
                                  <input
                                    type="text"
                                    value={layer.name}
                                    onChange={(e) =>
                                      onLayerChange(
                                        stackIdx,
                                        layerIdx,
                                        "name",
                                        e.currentTarget.value,
                                      )
                                    }
                                    onClick={(e) => e.stopPropagation()}
                                    style={inLayerFieldInputStyle}
                                  />
                                </Box>
                              ) : (
                                <Text
                                  size="sm"
                                  c="white"
                                  fw={600}
                                  ta="center"
                                  style={{
                                    width: "100%",
                                    textShadow: "0 1px 2px rgba(0,0,0,0.3)",
                                  }}
                                >
                                  {layer.name || "Unnamed"}
                                </Text>
                              )}
                            </Box>

                            {/* Right: thickness (nm) */}
                            <Box style={{ width: 92, flexShrink: 0 }}>
                              {!!layer.thicknessNm ||
                              expandedFields[layerKey]?.thickness ? (
                                <input
                                  type="number"
                                  min={0}
                                  value={layer.thicknessNm}
                                  onChange={(e) =>
                                    onLayerChange(
                                      stackIdx,
                                      layerIdx,
                                      "thicknessNm",
                                      e.currentTarget.value,
                                    )
                                  }
                                  onClick={(e) => e.stopPropagation()}
                                  placeholder="—"
                                  style={{
                                    ...sideInputStyle,
                                    textAlign: "right",
                                  }}
                                />
                              ) : (
                                <button
                                  style={addParamButtonStyle}
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    toggleExpandedField(layerKey, "thickness")
                                  }}
                                >
                                  + nm
                                </button>
                              )}
                            </Box>
                          </>
                        )
                      })()}
                    </Box>
                  )
                })}
              </Box>

              {/* Param count badge */}
              {(() => {
                let paramCount = stack.layers
                  .filter((l) => !l.isSubstrate)
                  .reduce((acc, l) => {
                    if (l.thicknessNm) acc++
                    if (l.bandgapEv) acc++
                    if (l.perovskiteA) acc++
                    if (l.perovskiteB) acc++
                    if (l.perovskiteX) acc++
                    return acc
                  }, 0)
                // Add stack-level parameters
                if (stack.architecture && stack.architecture !== "Unknown")
                  paramCount++
                // Only count device parameters if buildDevice is Yes
                if (stack.buildDevice !== "No") {
                  if (stack.pixelAreaCm2) paramCount++
                  if (stack.numberOfPixels) paramCount++
                }

                return paramCount > 0 ? (
                  <Box
                    mt="xs"
                    style={{ display: "flex", justifyContent: "flex-end" }}
                  >
                    <Badge size="xs" variant="light" color="teal">
                      + {paramCount} param{paramCount !== 1 ? "s" : ""}
                    </Badge>
                  </Box>
                ) : null
              })()}
            </Paper>
          )
        })}
      </Group>

      {/* Deleted stack thumbnails */}
      {deletedStacks.length > 0 && (
        <Box
          mt="lg"
          pt="sm"
          style={{ borderTop: "1px dashed var(--mantine-color-gray-3)" }}
        >
          <Text size="xs" c="dimmed" mb="xs">
            Deleted combinations — click to restore
          </Text>
          <Group gap="sm" wrap="wrap" align="flex-end">
            {deletedStacks.map((stack) => (
              <Tooltip
                key={`deleted-${stack.combination}`}
                label={`Restore combination ${stack.combination + 1}`}
                withArrow
              >
                <Box
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: 4,
                    cursor: "pointer",
                    opacity: 0.7,
                  }}
                  onClick={() => onRecover(stack.combination)}
                >
                  {/* Mini stack visualization */}
                  <Box
                    style={{
                      width: 60,
                      display: "flex",
                      flexDirection: "column-reverse",
                      gap: 1,
                    }}
                  >
                    {stack.layers.map((layer) => (
                      <Box
                        key={layer.id}
                        style={{
                          height: layer.isSubstrate ? 10 : 6,
                          background: layer.color,
                          borderRadius: 2,
                          border: "1px solid rgba(0,0,0,0.08)",
                        }}
                      />
                    ))}
                  </Box>
                  <ActionIcon
                    size="xs"
                    variant="subtle"
                    color="blue"
                    tabIndex={-1}
                  >
                    <IconArrowBackUp size={12} />
                  </ActionIcon>
                  <Text size="10px" c="dimmed">
                    #{stack.combination + 1}
                  </Text>
                </Box>
              </Tooltip>
            ))}
          </Group>
        </Box>
      )}
    </Box>
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Main Page
// ─────────────────────────────────────────────────────────────────────────────

export function ProcessesPage() {
  const navigate = useNavigate()

  const {
    materials,
    experiments,
    processes,
    setProcesses,
    planes,
    updateElement,
    removeCollectionRefs,
    solutions,
    pendingCollectionLink,
    setPendingCollectionLink,
    activeCollectionId,
    activePlaneId,
    activeEntity,
    setActiveEntity,
    lastSelectedByKind,
    updateLastSelected,
  } = useAppContext()
  const {
    isEntityVisible,
    getEntityColor,
    getEntityPlane,
    getEntityCollection,
  } = useEntityCollection()

  const [searchQuery, setSearchQuery] = useState("")
  const [draggedStep, setDraggedStep] = useState<{
    stepId: string
    fromStagePos: number
  } | null>(null)
  const [pendingFocusStepId, setPendingFocusStepId] = useState<string | null>(
    null,
  )
  const [noteEditorStepId, setNoteEditorStepId] = useState<string | null>(null)
  const [dropStagePos, setDropStagePos] = useState<number | null>(null)
  const [dropInsertIndex, setDropInsertIndex] = useState<number | null>(null)
  const [isExportingPdf, setIsExportingPdf] = useState(false)
  const [isExportingDocx, setIsExportingDocx] = useState(false)
  const [substrateSelectingIdx, setSubstrateSelectingIdx] = useState<
    number | null
  >(null)
  const processNameInputRef = useRef<HTMLInputElement | null>(null)
  const [pendingSelectProcessNameId, setPendingSelectProcessNameId] = useState<
    string | null
  >(null)
  const processedPendingRequestIdsRef = useRef<Set<string>>(new Set())
  const stackInvalidationByProcessRef = useRef<Map<string, string>>(new Map())
  const [collectionModalOpen, setCollectionModalOpen] = useState(false)

  const selectProcess = useCallback(
    (id: string | null) => {
      setActiveEntity(id ? { kind: "process", id } : null)
      if (id) updateLastSelected("process", id)
    },
    [setActiveEntity, updateLastSelected],
  )

  // Restore last selected process on mount if no active entity
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  useEffect(() => {
    if (activeEntity?.kind === "process") return
    const lastId = lastSelectedByKind.process
    if (lastId && processes.some((p) => p.id === lastId)) {
      selectProcess(lastId)
    }
  }, [])

  // Auto-create process + link to collection when navigated from action bubble
  useEffect(() => {
    if (!pendingCollectionLink || pendingCollectionLink.kind !== "process") {
      return
    }
    if (
      processedPendingRequestIdsRef.current.has(pendingCollectionLink.requestId)
    ) {
      return
    }
    processedPendingRequestIdsRef.current.add(pendingCollectionLink.requestId)

    const { collectionId, planeId } = pendingCollectionLink
    setPendingCollectionLink(null)

    const proc = newProcess()
    setProcesses((prev) => [...prev, proc])

    // Link back to collection
    const plane = planes.find((p) => p.id === planeId)
    if (plane) {
      const col = plane.elements.find((e) => e.id === collectionId)
      if (col && col.type === "collection") {
        const updated = {
          ...col,
          refs: [...col.refs, { kind: "process" as const, id: proc.id }],
        }
        updateElement(planeId, updated)
      }
    }
  }, [
    pendingCollectionLink,
    setPendingCollectionLink,
    setProcesses,
    planes,
    updateElement,
  ])

  // Filtered list of visible processes
  const visibleProcesses = useMemo(
    () =>
      processes.filter(
        (p) =>
          isEntityVisible("process", p.id) &&
          (p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
            p.description?.toLowerCase().includes(searchQuery.toLowerCase())),
      ),
    [processes, isEntityVisible, searchQuery],
  )

  const selectedProcess = useMemo(
    () =>
      activeEntity?.kind === "process"
        ? (processes.find((p) => p.id === activeEntity.id) ?? null)
        : null,
    [activeEntity, processes],
  )

  const stackInvalidationKey = useMemo(
    () => getStackInvalidationKey(selectedProcess),
    [selectedProcess],
  )

  const generatedStacks = useMemo<GeneratedStack[]>(
    () => (selectedProcess?.generatedStacks ?? []) as GeneratedStack[],
    [selectedProcess],
  )

  const deletedCombinations = useMemo(
    () => new Set<number>(selectedProcess?.deletedStackCombinations ?? []),
    [selectedProcess],
  )

  // Clear persisted stacks only when stack-defining structure/source changes.
  // Parameter edits should not invalidate generated stacks.
  useEffect(() => {
    if (!selectedProcess) return

    const previousKey = stackInvalidationByProcessRef.current.get(
      selectedProcess.id,
    )
    // First observation for this process in this session: record key, do not clear.
    if (previousKey === undefined) {
      stackInvalidationByProcessRef.current.set(
        selectedProcess.id,
        stackInvalidationKey,
      )
      return
    }
    if (previousKey === stackInvalidationKey) {
      return
    }

    stackInvalidationByProcessRef.current.set(
      selectedProcess.id,
      stackInvalidationKey,
    )

    // Structure/source changed: clear now-stale generated stacks.
    if (
      (selectedProcess.generatedStacks?.length ?? 0) > 0 ||
      (selectedProcess.deletedStackCombinations?.length ?? 0) > 0
    ) {
      const updated: Process = {
        ...selectedProcess,
        generatedStacks: [],
        deletedStackCombinations: [],
      }
      setProcesses((prev) =>
        prev.map((p) => (p.id === selectedProcess.id ? updated : p)),
      )
    }
  }, [selectedProcess, setProcesses, stackInvalidationKey])

  const launchLinkedCreation = useCallback(
    (config: {
      kind: "material" | "solution"
      route: "/materials" | "/solutions"
      materialCategory?:
        | "chemical_compound"
        | "commercial_mixture"
        | "substrate_material"
      processAttachment: {
        target: "substrate" | "step-material" | "step-solution"
        stepId?: string
      }
    }) => {
      if (!selectedProcess) {
        return
      }

      const owner = getEntityCollection("process", selectedProcess.id)
      setPendingCollectionLink({
        collectionId: owner?.collection.id ?? activeCollectionId ?? "",
        planeId: owner?.plane.id ?? activePlaneId ?? "",
        kind: config.kind,
        materialCategory: config.materialCategory,
        processAttachment: {
          processId: selectedProcess.id,
          target: config.processAttachment.target,
          stepId: config.processAttachment.stepId,
        },
        returnTo: "/processes",
        requestId: crypto.randomUUID(),
      })
      void navigate({ to: config.route })
    },
    [
      activeCollectionId,
      activePlaneId,
      getEntityCollection,
      navigate,
      selectedProcess,
      setPendingCollectionLink,
    ],
  )

  const [selectedStepId, setSelectedStepId] = useState<string | null>(null)

  const selectedStep: ProcessStep | null = useMemo(() => {
    if (!selectedProcess || !selectedStepId) return null
    for (const stage of selectedProcess.stages) {
      for (const alt of stage.alternatives) {
        if (alt.id === selectedStepId) return alt
      }
    }
    return null
  }, [selectedProcess, selectedStepId])

  useEffect(() => {
    if (!selectedProcess || pendingSelectProcessNameId !== selectedProcess.id)
      return
    const raf = window.requestAnimationFrame(() => {
      const input = processNameInputRef.current
      if (!input) return
      input.focus()
      input.select()
    })
    setPendingSelectProcessNameId(null)
    return () => window.cancelAnimationFrame(raf)
  }, [pendingSelectProcessNameId, selectedProcess])

  const selectedStepStagePos = useMemo(() => {
    if (!selectedProcess || !selectedStepId) return null
    const stagePos = selectedProcess.stages.findIndex((stage) =>
      stage.alternatives.some((alt) => alt.id === selectedStepId),
    )
    return stagePos >= 0 ? stagePos : null
  }, [selectedProcess, selectedStepId])

  const doCreateProcess = ({
    planeId,
    collection,
  }: CollectionConfirmParams) => {
    const newProc = newProcess()
    setProcesses((prev) => [...prev, newProc])
    selectProcess(newProc.id)
    setSelectedStepId(null)
    setPendingSelectProcessNameId(newProc.id)
    updateElement(planeId, {
      ...collection,
      refs: [...collection.refs, { kind: "process" as const, id: newProc.id }],
    })
  }

  const handleCreateProcess = () => {
    if (activeCollectionId && activePlaneId) {
      const plane = planes.find((p) => p.id === activePlaneId)
      const col = plane?.elements.find((e) => e.id === activeCollectionId)
      if (col && col.type === "collection") {
        doCreateProcess({
          planeId: activePlaneId,
          collectionId: activeCollectionId,
          collection: col as CanvasCollectionElement,
        })
        return
      }
    }
    setCollectionModalOpen(true)
  }

  const handleSpawnExperiment = (process: Process) => {
    const owner = getEntityCollection("process", process.id)
    setPendingCollectionLink({
      collectionId: owner?.collection.id ?? activeCollectionId ?? "",
      planeId: owner?.plane.id ?? activePlaneId ?? "",
      kind: "experiment",
      selectedProcessId: process.id,
      requestId: crypto.randomUUID(),
    })
    void navigate({ to: "/experiments" })
  }

  const handleGenerateStacks = () => {
    if (!selectedProcess) return
    const substrateMap = new Map(materials.map((m) => [m.id, m]))
    const newStacks = generateStackCombinations(
      selectedProcess,
      materials,
      solutions,
      substrateMap,
    )

    // Preserve user edits by layer id across regenerations
    const existingLayerData = new Map<
      string,
      {
        name: string
        layerType: string
        thicknessNm: string
        bandgapEv: string
        perovskiteA: string
        perovskiteB: string
        perovskiteX: string
      }
    >()
    for (const stack of generatedStacks) {
      for (const layer of stack.layers) {
        existingLayerData.set(layer.id, {
          name: layer.name,
          layerType: layer.layerType,
          thicknessNm: layer.thicknessNm,
          bandgapEv: layer.bandgapEv ?? "",
          perovskiteA: layer.perovskiteA,
          perovskiteB: layer.perovskiteB,
          perovskiteX: layer.perovskiteX,
        })
      }
    }

    // Preserve stack-level fields by combination number
    const existingStackData = new Map<
      number,
      {
        architecture?: string
        pixelAreaCm2?: string
        numberOfPixels?: string
      }
    >()
    for (const stack of generatedStacks) {
      existingStackData.set(stack.combination, {
        architecture: stack.architecture,
        pixelAreaCm2: stack.pixelAreaCm2,
        numberOfPixels: stack.numberOfPixels,
      })
    }

    const preservedStacks = newStacks.map((stack) => {
      const existingStack = existingStackData.get(stack.combination)
      return {
        ...stack,
        ...(existingStack || {}),
        layers: stack.layers.map((layer) => {
          const existing = existingLayerData.get(layer.id)
          return existing ? { ...layer, ...existing } : layer
        }),
      }
    })

    const updated: Process = {
      ...selectedProcess,
      generatedStacks: preservedStacks as ProcessGeneratedStack[],
      // intentionally NOT cleared — persists across regenerations
      deletedStackCombinations: selectedProcess.deletedStackCombinations ?? [],
    }
    setProcesses((prev) =>
      prev.map((p) => (p.id === selectedProcess.id ? updated : p)),
    )
  }

  const handleDeleteStack = (combination: number) => {
    if (!selectedProcess) return
    const next = new Set<number>(selectedProcess.deletedStackCombinations ?? [])
    next.add(combination)
    const updated: Process = {
      ...selectedProcess,
      deletedStackCombinations: [...next],
    }
    setProcesses((prev) =>
      prev.map((p) => (p.id === selectedProcess.id ? updated : p)),
    )
  }

  const handleRecoverStack = (combination: number) => {
    if (!selectedProcess) return
    const next = new Set<number>(selectedProcess.deletedStackCombinations ?? [])
    next.delete(combination)
    const updated: Process = {
      ...selectedProcess,
      deletedStackCombinations: [...next],
    }
    setProcesses((prev) =>
      prev.map((p) => (p.id === selectedProcess.id ? updated : p)),
    )
  }

  const handleUpdateStackLayer = (
    stackIdx: number,
    layerIdx: number,
    field: keyof StackLayer,
    value: string,
  ) => {
    if (!selectedProcess) return
    const stack = generatedStacks[stackIdx]
    if (!stack) return
    const layer = stack.layers[layerIdx]
    if (!layer) return
    // Sync selected fields across ALL stacks that share the same layer (same process step)
    const syncAcrossStacks =
      field === "thicknessNm" ||
      field === "bandgapEv" ||
      field === "perovskiteA" ||
      field === "perovskiteB" ||
      field === "perovskiteX"
    const updatedStacks = generatedStacks.map((s, si) => ({
      ...s,
      layers: s.layers.map((l, li) => {
        if (si === stackIdx && li === layerIdx) return { ...l, [field]: value }
        if (syncAcrossStacks && !l.isSubstrate && l.id === layer.id)
          return { ...l, [field]: value }
        return l
      }),
    }))
    const updated: Process = {
      ...selectedProcess,
      generatedStacks: updatedStacks as ProcessGeneratedStack[],
    }
    setProcesses((prev) =>
      prev.map((p) => (p.id === selectedProcess.id ? updated : p)),
    )
  }

  const handleUpdateStackField = (
    stackIdx: number,
    field: "architecture" | "buildDevice" | "pixelAreaCm2" | "numberOfPixels",
    value: string,
  ) => {
    if (!selectedProcess) return
    const updatedStacks = generatedStacks.map((s, si) =>
      si === stackIdx ? { ...s, [field]: value } : s,
    )
    const updated: Process = {
      ...selectedProcess,
      generatedStacks: updatedStacks as ProcessGeneratedStack[],
    }
    setProcesses((prev) =>
      prev.map((p) => (p.id === selectedProcess.id ? updated : p)),
    )
  }

  const handleExportProcessPdf = async () => {
    if (!selectedProcess) return
    try {
      setIsExportingPdf(true)
      await exportProcessProtocolAsPdf({
        process: selectedProcess,
        materials: materials.map((m) => ({ id: m.id, name: m.name })),
        solutions: solutions.map((s) => ({ id: s.id, name: s.name })),
      })
    } catch (error) {
      console.error("Failed to export process PDF", error)
      window.alert("Failed to export process PDF. Please try again.")
    } finally {
      setIsExportingPdf(false)
    }
  }

  const handleExportProcessDocx = async () => {
    if (!selectedProcess) return
    try {
      setIsExportingDocx(true)
      await exportProcessProtocolAsDocx({
        process: selectedProcess,
        materials: materials.map((m) => ({ id: m.id, name: m.name })),
        solutions: solutions.map((s) => ({ id: s.id, name: s.name })),
      })
    } catch (error) {
      console.error("Failed to export process DOCX", error)
      window.alert("Failed to export process DOCX. Please try again.")
    } finally {
      setIsExportingDocx(false)
    }
  }

  const handleDeleteProcess = (id: string) => {
    const proc = processes.find((p) => p.id === id)
    const dependents = getDependentLocations("process", id, {
      solutions,
      experiments,
      processes,
      planes,
    })

    if (dependents.length > 0) {
      modals.open({
        title: "Cannot delete process",
        children: (
          <DependencyBlockModal
            itemName={proc?.name ?? id}
            dependents={dependents}
          />
        ),
      })
      return
    }

    setProcesses((prev) => prev.filter((p) => p.id !== id))
    removeCollectionRefs("process", [id])
    if (selectedProcess?.id === id) {
      selectProcess(null)
      setSelectedStepId(null)
    }
  }

  const handleCopyProcess = (process: Process) => {
    const copy: Process = {
      ...process,
      id: crypto.randomUUID(),
      name: `${process.name} (copy)`,
      stages: process.stages.map((stage) => ({
        ...stage,
        alternatives: stage.alternatives.map((step) => ({
          ...step,
          id: crypto.randomUUID(),
        })),
      })),
    }
    setProcesses((prev) => [...prev, copy])
    const owner = getEntityCollection("process", process.id)
    if (owner) {
      updateElement(owner.plane.id, {
        ...owner.collection,
        refs: [
          ...owner.collection.refs,
          { kind: "process" as const, id: copy.id },
        ],
      })
    }
    selectProcess(copy.id)
    setSelectedStepId(null)
  }

  const commitProcessUpdate = useCallback(
    (updated: Process, nextSelectedStepId: string | null) => {
      setProcesses((prev) =>
        prev.map((p) => (p.id === updated.id ? updated : p)),
      )
      selectProcess(updated.id)
      setSelectedStepId(nextSelectedStepId)
    },
    [selectProcess, setProcesses],
  )

  const addCopiedProcessToCollection = useCallback(
    (sourceProcessId: string, copy: Process) => {
      const owner = getEntityCollection("process", sourceProcessId)
      if (owner) {
        updateElement(owner.plane.id, {
          ...owner.collection,
          refs: [
            ...owner.collection.refs,
            { kind: "process" as const, id: copy.id },
          ],
        })
      }
    },
    [getEntityCollection, updateElement],
  )

  const runGuardedStepStructureEdit = useCallback(
    (
      buildUpdatedProcess: (process: Process) => {
        updated: Process
        nextSelectedStepId: string | null
      } | null,
    ) => {
      if (!selectedProcess) {
        return
      }

      const dependentExperiments = experiments.filter(
        (experiment) => experiment.processId === selectedProcess.id,
      )

      const applyToCurrentProcess = () => {
        const result = buildUpdatedProcess(selectedProcess)
        if (!result) {
          return
        }
        commitProcessUpdate(result.updated, result.nextSelectedStepId)
      }

      if (dependentExperiments.length === 0) {
        applyToCurrentProcess()
        return
      }

      const modalId = `guard-process-edit-${crypto.randomUUID()}`
      const applyToCopiedProcess = () => {
        const copyBase: Process = {
          ...selectedProcess,
          id: crypto.randomUUID(),
          name: `${selectedProcess.name} (copy)`,
          stages: selectedProcess.stages.map((stage) => ({
            ...stage,
            alternatives: stage.alternatives.map((step) => ({ ...step })),
          })),
        }
        const result = buildUpdatedProcess(copyBase)
        if (!result) {
          return
        }
        setProcesses((prev) => [...prev, result.updated])
        addCopiedProcessToCollection(selectedProcess.id, result.updated)
        selectProcess(result.updated.id)
        setSelectedStepId(result.nextSelectedStepId)
      }

      modals.open({
        modalId,
        title: "Edit process with dependent experiments?",
        children: (
          <Stack gap="md">
            <Text size="sm">
              Are you sure you want to edit this process because the following
              experiments depend on it?
            </Text>
            <Text size="sm" c="dimmed">
              Altering the process could change or delete information in these
              experiments. It is highly recommended to edit a copy of the
              process instead.
            </Text>
            <Stack gap={4}>
              {dependentExperiments.map((experiment) => (
                <Text key={experiment.id} size="sm">
                  {experiment.name || "Unnamed experiment"}
                </Text>
              ))}
            </Stack>
            <Group justify="flex-end" gap="sm">
              <Button variant="default" onClick={() => modals.close(modalId)}>
                Cancel
              </Button>
              <Button
                variant="filled"
                onClick={() => {
                  modals.close(modalId)
                  applyToCopiedProcess()
                }}
              >
                Edit a copy (recommended)
              </Button>
              <Button
                color="red"
                onClick={() => {
                  modals.close(modalId)
                  applyToCurrentProcess()
                }}
              >
                Edit process (not recommended)
              </Button>
            </Group>
          </Stack>
        ),
      })
    },
    [
      addCopiedProcessToCollection,
      commitProcessUpdate,
      experiments,
      selectedProcess,
      selectProcess,
      setProcesses,
    ],
  )

  const handleAddProcessStep = (category: ProcessStepCategory) => {
    if (!selectedProcess) return
    const nextIndex = selectedProcess.stages.length
    const step = {
      ...newProcessStep(nextIndex, category),
      color: randomStepColor(),
    }
    const newStage = { index: nextIndex, alternatives: [step] }
    const updated: Process = {
      ...selectedProcess,
      stages: [...selectedProcess.stages, newStage],
    }
    setProcesses((prev) =>
      prev.map((p) => (p.id === selectedProcess.id ? updated : p)),
    )
    setActiveEntity({ kind: "process", id: updated.id })
    setSelectedStepId(step.id)
    setPendingFocusStepId(step.id)
  }

  const handleAddAlternativeStep = (
    stageIndex: number,
    category: ProcessStepCategory,
  ) => {
    if (!selectedProcess) return
    const step = {
      ...newProcessStep(stageIndex, category),
      color: randomStepColor(),
    }
    const updated: Process = {
      ...selectedProcess,
      stages: selectedProcess.stages.map((stage) =>
        stage.index === stageIndex
          ? { ...stage, alternatives: [...stage.alternatives, step] }
          : stage,
      ),
    }
    setProcesses((prev) =>
      prev.map((p) => (p.id === selectedProcess.id ? updated : p)),
    )
    selectProcess(updated.id)
    setSelectedStepId(step.id)
    setPendingFocusStepId(step.id)
  }

  const handleUpdateProcessName = (name: string) => {
    if (!selectedProcess) return
    const updated: Process = { ...selectedProcess, name }
    setProcesses((prev) =>
      prev.map((p) => (p.id === selectedProcess.id ? updated : p)),
    )
  }

  const handleUpdateStepParam = (
    stepId: string,
    key: ProcessParameterKey,
    param: ProcessParam | undefined,
  ) => {
    if (!selectedProcess) return
    const updated: Process = {
      ...selectedProcess,
      stages: selectedProcess.stages.map((stage) => ({
        ...stage,
        alternatives: stage.alternatives.map((step) =>
          step.id === stepId
            ? {
                ...step,
                [key]: param ? { ...param, mode: "constant" } : undefined,
                ...(key === "depositionMethod"
                  ? { name: param?.value?.trim() || step.name }
                  : {}),
              }
            : step,
        ),
      })),
    }
    setProcesses((prev) =>
      prev.map((p) => (p.id === selectedProcess.id ? updated : p)),
    )
  }

  const handleUpdateStepNotes = (stepId: string, notes: string) => {
    if (!selectedProcess) return
    const updated: Process = {
      ...selectedProcess,
      stages: selectedProcess.stages.map((stage) => ({
        ...stage,
        alternatives: stage.alternatives.map((step) =>
          step.id === stepId ? { ...step, notes } : step,
        ),
      })),
    }
    setProcesses((prev) =>
      prev.map((p) => (p.id === selectedProcess.id ? updated : p)),
    )
  }

  const handleUpdateStepColor = (stepId: string, color: string) => {
    if (!selectedProcess) return
    const updated: Process = {
      ...selectedProcess,
      stages: selectedProcess.stages.map((stage) => ({
        ...stage,
        alternatives: stage.alternatives.map((step) =>
          step.id === stepId ? { ...step, color } : step,
        ),
      })),
    }
    setProcesses((prev) =>
      prev.map((p) => (p.id === selectedProcess.id ? updated : p)),
    )
  }

  const handleRemoveStep = (stepId: string) => {
    runGuardedStepStructureEdit((process) => ({
      updated: {
        ...process,
        stages: process.stages
          .map((stage) => ({
            ...stage,
            alternatives: stage.alternatives.filter((s) => s.id !== stepId),
          }))
          .filter((stage) => stage.alternatives.length > 0)
          .map((stage, idx) => ({ ...stage, index: idx })),
      },
      nextSelectedStepId: selectedStepId === stepId ? null : selectedStepId,
    }))
  }

  const moveStepToAlternativeStage = (
    stepId: string,
    fromStagePos: number,
    targetStagePos: number,
  ) => {
    if (!selectedProcess || fromStagePos === targetStagePos) {
      return
    }
    runGuardedStepStructureEdit((process) => {
      const stages = process.stages.map((stage) => ({
        ...stage,
        alternatives: [...stage.alternatives],
      }))

      const source = stages[fromStagePos]
      if (!source) {
        return null
      }

      const movingIdx = source.alternatives.findIndex(
        (step) => step.id === stepId,
      )
      if (movingIdx < 0) {
        return null
      }

      const [movingStep] = source.alternatives.splice(movingIdx, 1)
      const sourceEmptied = source.alternatives.length === 0
      if (sourceEmptied) {
        stages.splice(fromStagePos, 1)
      }

      let adjustedTarget = targetStagePos
      if (sourceEmptied && fromStagePos < targetStagePos) {
        adjustedTarget -= 1
      }
      if (adjustedTarget < 0 || adjustedTarget >= stages.length) {
        return null
      }

      stages[adjustedTarget].alternatives.push(movingStep)

      return {
        updated: {
          ...process,
          stages: stages.map((stage, index) => ({ ...stage, index })),
        },
        nextSelectedStepId: stepId,
      }
    })
  }

  const moveStepToNewStageAt = (
    stepId: string,
    fromStagePos: number,
    insertIndex: number,
  ) => {
    if (!selectedProcess) {
      return
    }

    runGuardedStepStructureEdit((process) => {
      const stages = process.stages.map((stage) => ({
        ...stage,
        alternatives: [...stage.alternatives],
      }))
      const source = stages[fromStagePos]
      if (!source) {
        return null
      }
      const movingIdx = source.alternatives.findIndex(
        (step) => step.id === stepId,
      )
      if (movingIdx < 0) {
        return null
      }
      const [movingStep] = source.alternatives.splice(movingIdx, 1)
      const sourceEmptied = source.alternatives.length === 0
      if (sourceEmptied) {
        stages.splice(fromStagePos, 1)
      }

      let adjustedInsert = insertIndex
      if (sourceEmptied && fromStagePos < insertIndex) {
        adjustedInsert -= 1
      }
      adjustedInsert = Math.max(0, Math.min(stages.length, adjustedInsert))

      stages.splice(adjustedInsert, 0, {
        index: adjustedInsert,
        alternatives: [movingStep],
      })

      return {
        updated: {
          ...process,
          stages: stages.map((stage, index) => ({ ...stage, index })),
        },
        nextSelectedStepId: stepId,
      }
    })
  }

  useEffect(() => {
    if (selectedProcess && !isEntityVisible("process", selectedProcess.id)) {
      selectProcess(null)
      setSelectedStepId(null)
    }
  }, [selectedProcess, isEntityVisible, selectProcess])

  const hasBothSubstrateAndStep = useMemo(() => {
    if (!selectedProcess) return false
    const hasSubstrate = (selectedProcess.substrateIds ?? []).length > 0
    const hasStep = selectedProcess.stages.some(
      (stage) => stage.alternatives.length > 0,
    )
    return hasSubstrate && hasStep
  }, [selectedProcess])

  useEffect(() => {
    if (!selectedProcess) return
    const substrateIds = selectedProcess.substrateIds ?? []
    if (substrateIds.length === 0) return

    const existing = selectedProcess.substrateDimensionsById ?? {}
    let hasMissing = false
    for (const substrateId of substrateIds) {
      if (!existing[substrateId]) {
        hasMissing = true
        break
      }
    }
    if (!hasMissing) return

    const nextDimensions = { ...existing }
    for (const substrateId of substrateIds) {
      if (!nextDimensions[substrateId]) {
        nextDimensions[substrateId] = { ...DEFAULT_SUBSTRATE_DIMENSIONS }
      }
    }

    const updated: Process = {
      ...selectedProcess,
      substrateDimensionsById: nextDimensions,
    }
    setProcesses((prev) =>
      prev.map((p) => (p.id === selectedProcess.id ? updated : p)),
    )
  }, [selectedProcess, setProcesses])

  const handleAddSubstrate = (substrateId: string) => {
    if (!selectedProcess) return
    const updated: Process = {
      ...selectedProcess,
      substrateIds: [...(selectedProcess.substrateIds ?? []), substrateId],
      substrateDimensionsById: {
        ...(selectedProcess.substrateDimensionsById ?? {}),
        [substrateId]: {
          ...(selectedProcess.substrateDimensionsById?.[substrateId] ??
            DEFAULT_SUBSTRATE_DIMENSIONS),
        },
      },
    }
    setProcesses((prev) =>
      prev.map((p) => (p.id === selectedProcess.id ? updated : p)),
    )
  }

  const handleRemoveSubstrate = (substrateId: string) => {
    if (!selectedProcess) return
    const currentIds = selectedProcess.substrateIds ?? []
    // Block: cannot remove the last substrate while steps exist
    if (currentIds.length === 1 && selectedProcess.stages.length > 0) return
    const updated: Process = {
      ...selectedProcess,
      substrateIds: currentIds.filter((id) => id !== substrateId),
      substrateDimensionsById: Object.fromEntries(
        Object.entries(selectedProcess.substrateDimensionsById ?? {}).filter(
          ([id]) => id !== substrateId,
        ),
      ),
    }
    setProcesses((prev) =>
      prev.map((p) => (p.id === selectedProcess.id ? updated : p)),
    )
    setSubstrateSelectingIdx(null)
  }

  const handleReplaceSubstrate = (index: number, substrateId: string) => {
    if (!selectedProcess) return
    const ids = [...(selectedProcess.substrateIds ?? [])]
    const previousSubstrateId = ids[index]
    ids[index] = substrateId
    const nextDimensions = {
      ...(selectedProcess.substrateDimensionsById ?? {}),
    }
    if (previousSubstrateId && previousSubstrateId !== substrateId) {
      delete nextDimensions[previousSubstrateId]
    }
    nextDimensions[substrateId] = {
      ...(nextDimensions[substrateId] ?? DEFAULT_SUBSTRATE_DIMENSIONS),
    }
    const updated: Process = {
      ...selectedProcess,
      substrateIds: ids,
      substrateDimensionsById: nextDimensions,
    }
    setProcesses((prev) =>
      prev.map((p) => (p.id === selectedProcess.id ? updated : p)),
    )
  }

  const handleUpdateSubstrateDimensions = (
    substrateId: string,
    patch: Partial<{
      lengthCm: string
      widthCm: string
      surfaceRoughnessRmsNm: string
    }>,
  ) => {
    if (!selectedProcess) return
    const current =
      selectedProcess.substrateDimensionsById?.[substrateId] ??
      DEFAULT_SUBSTRATE_DIMENSIONS
    const updated: Process = {
      ...selectedProcess,
      substrateDimensionsById: {
        ...(selectedProcess.substrateDimensionsById ?? {}),
        [substrateId]: {
          ...current,
          ...patch,
        },
      },
    }
    setProcesses((prev) =>
      prev.map((p) => (p.id === selectedProcess.id ? updated : p)),
    )
  }

  const handleCreateSubstrateMaterial = useCallback(() => {
    launchLinkedCreation({
      kind: "material",
      route: "/materials",
      materialCategory: "substrate_material",
      processAttachment: { target: "substrate" },
    })
  }, [launchLinkedCreation])

  const getSubstrateLabel = useCallback(
    (substrateId: string | undefined) => {
      if (!substrateId) return null
      const substrate = materials.find((m) => m.id === substrateId)
      if (!substrate) return null
      return {
        name: substrate.name || "Unnamed substrate",
        rigidity: substrate.substrateRigidity || "—",
      }
    },
    [materials],
  )

  const getSourceSuggestions = useCallback(
    (
      key: ProcessParameterKey,
    ): Array<{ name: string; origin: string; param: ProcessParam }> => {
      if (!selectedProcess || !selectedStep) {
        return []
      }
      const seen = new Set<string>()
      const suggestions: Array<{
        name: string
        origin: string
        param: ProcessParam
      }> = []

      for (let i = 0; i < selectedProcess.stages.length; i++) {
        const stage = selectedProcess.stages[i]
        for (const step of stage.alternatives) {
          if (step.id === selectedStep.id) {
            continue
          }
          const stepParam = step[key]
          if (!stepParam || !stepParam.value) {
            continue
          }
          const signature = `${stepParam.mode}::${stepParam.value}`
          if (seen.has(signature)) {
            continue
          }
          seen.add(signature)
          const origin = step.materialId
            ? materials.find((material) => material.id === step.materialId)
                ?.name || "Unnamed material"
            : step.solutionId
              ? solutions.find((solution) => solution.id === step.solutionId)
                  ?.name || "Unnamed solution"
              : "No material"
          suggestions.push({
            name:
              step.depositionMethod?.value?.trim() ||
              step.name ||
              `Step ${i + 1}`,
            origin,
            param: { ...stepParam },
          })
          if (suggestions.length >= 4) {
            return suggestions
          }
        }
      }

      return suggestions
    },
    [materials, selectedProcess, selectedStep, solutions],
  )

  const displayedStages = useMemo(() => {
    if (!selectedProcess) {
      return [] as Array<{ stage: Process["stages"][number]; stagePos: number }>
    }
    return selectedProcess.stages.map((stage, stagePos) => ({
      stage,
      stagePos,
    }))
  }, [selectedProcess])

  const visibleMaterialOptions = useMemo(
    () =>
      materials
        .filter((material) => isEntityVisible("material", material.id))
        .filter(
          (material) =>
            (material.category ?? "chemical_compound") !== "substrate_material",
        )
        .map((material) => ({
          value: `material:${material.id}`,
          label: material.name || "Unnamed material",
        })),
    [isEntityVisible, materials],
  )

  const visibleSubstrateOptions = useMemo(
    () =>
      materials
        .filter(
          (material) =>
            material.category === "substrate_material" &&
            isEntityVisible("material", material.id),
        )
        .map((material) => ({
          value: material.id,
          label: material.name || "Unnamed substrate",
          rigidity: material.substrateRigidity,
        })),
    [isEntityVisible, materials],
  )

  const visibleSolutionOptions = useMemo(
    () =>
      solutions
        .filter((solution) => isEntityVisible("solution", solution.id))
        .map((solution) => ({
          value: `solution:${solution.id}`,
          label: solution.name || "Unnamed solution",
        })),
    [isEntityVisible, solutions],
  )

  const sourceOptions = useMemo(
    () => [
      ...visibleMaterialOptions.map((option) => ({
        ...option,
        label: `Material: ${option.label}`,
      })),
      ...visibleSolutionOptions.map((option) => ({
        ...option,
        label: `Solution: ${option.label}`,
      })),
      { value: NEW_CHEMICAL_OPTION, label: "Add New Chemical" },
      { value: NEW_COMMERCIAL_MIXTURE_OPTION, label: "Add New Com. Mixture" },
      { value: NEW_SOLUTION_OPTION, label: "Add New Solution" },
    ],
    [visibleMaterialOptions, visibleSolutionOptions],
  )

  const wetDepositionSourceOptions = useMemo(
    () => [
      ...visibleSolutionOptions.map((option) => ({
        ...option,
        label: `Solution: ${option.label}`,
      })),
      ...materials
        .filter((material) => isEntityVisible("material", material.id))
        .filter(
          (material) =>
            (material.category ?? "chemical_compound") !== "substrate_material",
        )
        .filter((material) => material.stateAtRt === "liquid")
        .map((material) => ({
          value: `material:${material.id}`,
          label: `Material: ${material.name || "Unnamed material"}`,
        })),
      { value: NEW_CHEMICAL_OPTION, label: "Add New Chemical" },
      { value: NEW_COMMERCIAL_MIXTURE_OPTION, label: "Add New Com. Mixture" },
      { value: NEW_SOLUTION_OPTION, label: "Add New Solution" },
    ],
    [isEntityVisible, materials, visibleSolutionOptions],
  )

  const getStepSourceValue = useCallback((step: ProcessStep) => {
    if (step.materialId) {
      return `material:${step.materialId}`
    }
    if (step.solutionId) {
      return `solution:${step.solutionId}`
    }
    return null
  }, [])

  const getStepSourceLabel = useCallback(
    (step: ProcessStep) => {
      if (step.materialId) {
        return (
          materials.find((material) => material.id === step.materialId)?.name ||
          "Unnamed material"
        )
      }
      if (step.solutionId) {
        return (
          solutions.find((solution) => solution.id === step.solutionId)?.name ||
          "Unnamed solution"
        )
      }
      return "No material"
    },
    [materials, solutions],
  )

  const handleUpdateStepSource = (
    stepId: string,
    sourceValue: string | null,
  ) => {
    if (!selectedProcess) return

    if (sourceValue === NEW_CHEMICAL_OPTION) {
      launchLinkedCreation({
        kind: "material",
        route: "/materials",
        materialCategory: "chemical_compound",
        processAttachment: { target: "step-material", stepId },
      })
      return
    }

    if (sourceValue === NEW_COMMERCIAL_MIXTURE_OPTION) {
      launchLinkedCreation({
        kind: "material",
        route: "/materials",
        materialCategory: "commercial_mixture",
        processAttachment: { target: "step-material", stepId },
      })
      return
    }

    if (sourceValue === NEW_SOLUTION_OPTION) {
      launchLinkedCreation({
        kind: "solution",
        route: "/solutions",
        processAttachment: { target: "step-solution", stepId },
      })
      return
    }

    const [kind, id] = sourceValue?.split(":") ?? []
    const updated: Process = {
      ...selectedProcess,
      stages: selectedProcess.stages.map((stage) => ({
        ...stage,
        alternatives: stage.alternatives.map((step) =>
          step.id === stepId
            ? {
                ...step,
                materialId: kind === "material" ? id : undefined,
                solutionId: kind === "solution" ? id : undefined,
              }
            : step,
        ),
      })),
    }
    setProcesses((prev) =>
      prev.map((process) =>
        process.id === selectedProcess.id ? updated : process,
      ),
    )
  }

  const getParameterFlowLines = useCallback((step: ProcessStep) => {
    const lines = PROCESS_PARAMETER_DEFINITIONS.flatMap(
      ({ key, label, unit }) => {
        if (
          key === "depositionMethod" ||
          key === "depositionStartTime" ||
          key === "annealingStartTime"
        ) {
          return []
        }
        const value = step[key]?.value?.trim()
        if (!value) {
          return []
        }
        if (key === "dryingMethod") {
          // Use full human-readable quenching summary
          const summary = summariseQuenchingValue(value, materials, solutions)
          return [summary || `${label}: Set`]
        }
        return [`${label}: ${value}${unit ? ` ${unit}` : ""}`]
      },
    )

    if (lines.length === 0) {
      return ["No parameters set"]
    }
    return lines
  }, [materials, solutions])

  const selectedStepParameterSections = useMemo(() => {
    if (!selectedStep) {
      return null
    }
    return getParameterSections(selectedStep.stepCategory)
  }, [selectedStep])

  const inlineStepDetailsPanel = selectedStep ? (
    <Paper
      data-step-details="true"
      p="md"
      radius="md"
      withBorder
      style={{
        backgroundColor: "var(--mantine-color-gray-0)",
      }}
    >
      <Stack gap="md">
        {selectedStepParameterSections && (
          <>
            {selectedStepParameterSections.deposition.length > 0 && (
              <Stack gap="xs">
                <Text size="xs" fw={700} c="dimmed" tt="uppercase">
                  Deposition Parameters
                </Text>
                <SimpleGrid cols={2} spacing="md" verticalSpacing="sm">
                  {selectedStepParameterSections.deposition.map((key) => {
                    const definition = PROCESS_DETAIL_DEFINITIONS.get(key)
                    if (!definition) return null
                    return (
                      <Box
                        key={key}
                        p="xs"
                        style={{
                          borderRadius: 8,
                          border: `1px solid ${selectedStep.color}66`,
                          background: `linear-gradient(90deg, ${selectedStep.color}18 0%, transparent 100%)`,
                        }}
                      >
                        {key === "dryingMethod" ? (
                          <DryingMethodInput
                            label={
                              selectedStepParameterSections.labelOverrides[
                                key
                              ] ?? definition.label
                            }
                            param={selectedStep[key]}
                            onChange={(param) =>
                              handleUpdateStepParam(selectedStep.id, key, param)
                            }
                          />
                        ) : (
                          <ProcessParamInput
                            label={
                              selectedStepParameterSections.labelOverrides[
                                key
                              ] ?? definition.label
                            }
                            param={selectedStep[key]}
                            onChange={(param) =>
                              handleUpdateStepParam(selectedStep.id, key, param)
                            }
                            placeholder={
                              selectedStepParameterSections
                                .placeholderOverrides[key] ??
                              definition.placeholder
                            }
                            unit={definition.unit}
                            sourceSuggestions={getSourceSuggestions(key)}
                            type={definition.type ?? "text"}
                          />
                        )}
                      </Box>
                    )
                  })}
                </SimpleGrid>
              </Stack>
            )}

            {selectedStepParameterSections.annealing.length > 0 && (
              <Stack gap="xs">
                <Text size="xs" fw={700} c="dimmed" tt="uppercase">
                  Annealing Parameters
                </Text>
                <SimpleGrid cols={2} spacing="md" verticalSpacing="sm">
                  {selectedStepParameterSections.annealing.map((key) => {
                    const definition = PROCESS_DETAIL_DEFINITIONS.get(key)
                    if (!definition) return null
                    return (
                      <Box
                        key={key}
                        p="xs"
                        style={{
                          borderRadius: 8,
                          border: `1px solid ${selectedStep.color}66`,
                          background: `linear-gradient(90deg, ${selectedStep.color}18 0%, transparent 100%)`,
                        }}
                      >
                        <ProcessParamInput
                          label={
                            selectedStepParameterSections.labelOverrides[key] ??
                            definition.label
                          }
                          param={selectedStep[key]}
                          onChange={(param) =>
                            handleUpdateStepParam(selectedStep.id, key, param)
                          }
                          placeholder={
                            selectedStepParameterSections.placeholderOverrides[
                              key
                            ] ?? definition.placeholder
                          }
                          unit={definition.unit}
                          sourceSuggestions={getSourceSuggestions(key)}
                          type={definition.type ?? "text"}
                        />
                      </Box>
                    )
                  })}
                </SimpleGrid>
              </Stack>
            )}
          </>
        )}

        {noteEditorStepId === selectedStep.id ||
        Boolean(selectedStep.notes?.trim()) ? (
          <Textarea
            label="Notes"
            minRows={2}
            maxRows={4}
            value={selectedStep.notes ?? ""}
            onChange={(e) =>
              handleUpdateStepNotes(selectedStep.id, e.currentTarget.value)
            }
          />
        ) : (
          <Button
            size="xs"
            variant="subtle"
            leftSection={<IconPlus size={12} />}
            onClick={() => setNoteEditorStepId(selectedStep.id)}
            style={{ justifyContent: "flex-start", width: "fit-content" }}
          >
            Add Note
          </Button>
        )}
      </Stack>
    </Paper>
  ) : null

  return (
    <>
      <Box
        style={{
          display: "grid",
          gridTemplateColumns: "250px 1fr",
          height: "100%",
        }}
      >
        {/* Left Sidebar: Process List */}
        <Paper
          p="md"
          radius={0}
          style={{ borderRight: "1px solid var(--mantine-color-gray-3)" }}
        >
          <Stack gap="md" style={{ height: "100%" }}>
            <TextInput
              placeholder="Search processes..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.currentTarget.value)}
              styles={{ input: { fontSize: "0.875rem" } }}
            />
            <Button
              onClick={handleCreateProcess}
              fullWidth
              leftSection={<IconPlus size={16} />}
            >
              New Process
            </Button>

            <Divider />
            <ScrollArea style={{ flex: 1 }}>
              <Stack gap="xs">
                {visibleProcesses.length === 0 ? (
                  <Paper
                    p="lg"
                    ta="center"
                    style={{ background: "var(--mantine-color-gray-0)" }}
                  >
                    <Text size="sm" c="dimmed">
                      No processes yet
                    </Text>
                  </Paper>
                ) : !activePlaneId ? (
                  (() => {
                    const groups = new Map<
                      string,
                      { planeName: string; items: typeof visibleProcesses }
                    >()
                    const orphans: typeof visibleProcesses = []
                    for (const process of visibleProcesses) {
                      const plane = getEntityPlane("process", process.id)
                      if (plane) {
                        const group = groups.get(plane.id)
                        if (group) {
                          group.items.push(process)
                        } else {
                          groups.set(plane.id, {
                            planeName: plane.name,
                            items: [process],
                          })
                        }
                      } else {
                        orphans.push(process)
                      }
                    }
                    const sections: React.ReactNode[] = []
                    for (const [planeId, { planeName, items }] of groups) {
                      sections.push(
                        <Text
                          key={`plane-header-${planeId}`}
                          size="xs"
                          fw={700}
                          c="dimmed"
                          tt="uppercase"
                          mt="xs"
                        >
                          {planeName}
                        </Text>,
                      )
                      sections.push(
                        ...items.map((process) => {
                          const isSelected = selectedProcess?.id === process.id
                          const collectionColor = getEntityColor(
                            "process",
                            process.id,
                          )
                          return (
                            <Paper
                              key={process.id}
                              p="xs"
                              radius="sm"
                              style={{
                                cursor: "pointer",
                                backgroundColor: isSelected
                                  ? "var(--mantine-color-blue-0)"
                                  : "transparent",
                                borderLeft: collectionColor
                                  ? `3px solid ${collectionColor}`
                                  : undefined,
                              }}
                              onClick={() => {
                                selectProcess(process.id)
                                setSelectedStepId(null)
                              }}
                            >
                              <Group justify="space-between">
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <Text
                                    size="sm"
                                    fw={isSelected ? 600 : 400}
                                    truncate
                                  >
                                    {process.name || "Untitled"}
                                  </Text>
                                  <Text size="xs" c="dimmed">
                                    {process.stages.length} step
                                    {process.stages.length !== 1 ? "s" : ""}
                                  </Text>
                                </div>
                                <Menu shadow="md" width={160}>
                                  <Menu.Target>
                                    <ActionIcon
                                      size="sm"
                                      variant="subtle"
                                      color="gray"
                                    >
                                      <IconChevronDown size={14} />
                                    </ActionIcon>
                                  </Menu.Target>
                                  <Menu.Dropdown>
                                    <Menu.Item
                                      leftSection={<IconCopy size={14} />}
                                      onClick={() => handleCopyProcess(process)}
                                    >
                                      Copy
                                    </Menu.Item>
                                    <Menu.Item
                                      leftSection={<IconTrash size={14} />}
                                      color="red"
                                      onClick={() =>
                                        handleDeleteProcess(process.id)
                                      }
                                    >
                                      Delete
                                    </Menu.Item>
                                  </Menu.Dropdown>
                                </Menu>
                              </Group>
                            </Paper>
                          )
                        }),
                      )
                    }
                    if (orphans.length > 0) {
                      sections.push(
                        <Text
                          key="plane-header-orphan"
                          size="xs"
                          fw={700}
                          c="dimmed"
                          tt="uppercase"
                          mt="xs"
                        >
                          Unassigned
                        </Text>,
                      )
                      sections.push(
                        ...orphans.map((process) => {
                          const isSelected = selectedProcess?.id === process.id
                          const collectionColor = getEntityColor(
                            "process",
                            process.id,
                          )
                          return (
                            <Paper
                              key={process.id}
                              p="xs"
                              radius="sm"
                              style={{
                                cursor: "pointer",
                                backgroundColor: isSelected
                                  ? "var(--mantine-color-blue-0)"
                                  : "transparent",
                                borderLeft: collectionColor
                                  ? `3px solid ${collectionColor}`
                                  : undefined,
                              }}
                              onClick={() => {
                                selectProcess(process.id)
                                setSelectedStepId(null)
                              }}
                            >
                              <Group justify="space-between">
                                <div style={{ flex: 1, minWidth: 0 }}>
                                  <Text
                                    size="sm"
                                    fw={isSelected ? 600 : 400}
                                    truncate
                                  >
                                    {process.name || "Untitled"}
                                  </Text>
                                  <Text size="xs" c="dimmed">
                                    {process.stages.length} step
                                    {process.stages.length !== 1 ? "s" : ""}
                                  </Text>
                                </div>
                                <Menu shadow="md" width={160}>
                                  <Menu.Target>
                                    <ActionIcon
                                      size="sm"
                                      variant="subtle"
                                      color="gray"
                                    >
                                      <IconChevronDown size={14} />
                                    </ActionIcon>
                                  </Menu.Target>
                                  <Menu.Dropdown>
                                    <Menu.Item
                                      leftSection={<IconCopy size={14} />}
                                      onClick={() => handleCopyProcess(process)}
                                    >
                                      Copy
                                    </Menu.Item>
                                    <Menu.Item
                                      leftSection={<IconTrash size={14} />}
                                      color="red"
                                      onClick={() =>
                                        handleDeleteProcess(process.id)
                                      }
                                    >
                                      Delete
                                    </Menu.Item>
                                  </Menu.Dropdown>
                                </Menu>
                              </Group>
                            </Paper>
                          )
                        }),
                      )
                    }
                    return sections
                  })()
                ) : (
                  visibleProcesses.map((process) => {
                    const isSelected = selectedProcess?.id === process.id
                    const canSpawnFromList =
                      (process.generatedStacks?.length ?? 0) > 0 &&
                      process.substrateIds.length > 0 &&
                      process.stages.length > 0
                    const collectionColor = getEntityColor(
                      "process",
                      process.id,
                    )
                    return (
                      <Paper
                        key={process.id}
                        withBorder
                        p="sm"
                        radius="md"
                        style={{
                          cursor: "pointer",
                          background: isSelected
                            ? "var(--mantine-color-blue-0)"
                            : undefined,
                          borderLeft: isSelected
                            ? "4px solid var(--mantine-color-blue-4)"
                            : collectionColor
                              ? `4px solid ${collectionColor}`
                              : undefined,
                        }}
                        onClick={() => {
                          selectProcess(process.id)
                          setSelectedStepId(null)
                        }}
                      >
                        <Group justify="space-between" wrap="nowrap">
                          <Box style={{ flex: 1, minWidth: 0 }}>
                            <Text size="sm" fw={600} truncate mb={2}>
                              {process.name || "Untitled"}
                            </Text>
                            <Text size="xs" c="dimmed">
                              {process.stages.length} step
                              {process.stages.length !== 1 ? "s" : ""}
                            </Text>
                          </Box>
                          <Group gap={2} wrap="nowrap">
                            {process.substrateIds.length > 0 &&
                              process.stages.length > 0 && (
                                <Tooltip label="New experiment" withArrow>
                                  <ActionIcon
                                    size="sm"
                                    variant="subtle"
                                    color={canSpawnFromList ? "green" : "gray"}
                                    disabled={!canSpawnFromList}
                                    onClick={(e) => {
                                      e.stopPropagation()
                                      handleSpawnExperiment(process)
                                    }}
                                  >
                                    <IconPlayerPlay size={14} />
                                  </ActionIcon>
                                </Tooltip>
                              )}
                            <ActionIcon
                              size="sm"
                              variant="subtle"
                              color="teal"
                              onClick={(e) => {
                                e.stopPropagation()
                                handleCopyProcess(process)
                              }}
                            >
                              <IconCopy size={14} />
                            </ActionIcon>
                            <ActionIcon
                              size="sm"
                              variant="subtle"
                              color="red"
                              onClick={(e) => {
                                e.stopPropagation()
                                handleDeleteProcess(process.id)
                              }}
                            >
                              <IconTrash size={14} />
                            </ActionIcon>
                          </Group>
                        </Group>
                      </Paper>
                    )
                  })
                )}
              </Stack>
            </ScrollArea>
          </Stack>
        </Paper>

        {/* Center: Process Editor */}
        <Box style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
          {selectedProcess ? (
            <>
              {/* Header */}
              <Group justify="space-between" p="md" pb={0}>
                <TextInput
                  ref={processNameInputRef}
                  placeholder="Process name"
                  value={selectedProcess.name}
                  onChange={(e) =>
                    handleUpdateProcessName(e.currentTarget.value)
                  }
                  style={{ flex: 1 }}
                />
                <Group gap="xs">
                  <Button
                    size="md"
                    color="blue"
                    variant="light"
                    leftSection={<IconSparkles size={18} />}
                    onClick={handleGenerateStacks}
                    disabled={!hasBothSubstrateAndStep}
                    title={
                      !hasBothSubstrateAndStep
                        ? "Select both a substrate and add at least one step to generate stacks"
                        : ""
                    }
                  >
                    Generate Resulting Stacks
                  </Button>
                  <Button
                    size="md"
                    color="green"
                    variant="light"
                    leftSection={<IconPlayerPlay size={18} />}
                    onClick={() => handleSpawnExperiment(selectedProcess)}
                    disabled={
                      !hasBothSubstrateAndStep || generatedStacks.length === 0
                    }
                    title={
                      !hasBothSubstrateAndStep
                        ? "Select both a substrate and add at least one step to create an experiment"
                        : generatedStacks.length === 0
                          ? "Generate resulting stacks first"
                          : ""
                    }
                  >
                    Create Experiment from Process
                  </Button>
                  <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconDownload size={14} />}
                    onClick={handleExportProcessPdf}
                    loading={isExportingPdf}
                  >
                    Export PDF
                  </Button>
                  <Button
                    size="xs"
                    variant="light"
                    leftSection={<IconDownload size={14} />}
                    onClick={handleExportProcessDocx}
                    loading={isExportingDocx}
                  >
                    Export DOCX
                  </Button>
                </Group>
              </Group>

              <Box style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
                <Stack p="md" gap="sm">
                  {/* Process Board */}
                  <Box>
                    <Stack gap="sm">
                      <Box
                        style={{
                          padding: "6px 8px",
                          borderRadius: 8,
                          background: "transparent",
                        }}
                        onMouseDown={(e) => {
                          const target = e.target as HTMLElement
                          if (
                            target.closest('[data-quenching-modal="true"]') ||
                            target.closest('[role="dialog"]') ||
                            target.closest('[data-step-box="true"]') ||
                            target.closest('[data-step-details="true"]') ||
                            target.closest('[role="listbox"]') ||
                            target.closest('[role="option"]') ||
                            target.closest(".mantine-Select-dropdown")
                          ) {
                            return
                          }
                          if (!target.closest('[data-step-box="true"]')) {
                            setSelectedStepId(null)
                            setSubstrateSelectingIdx(null)
                          }
                        }}
                      >
                        {/* Substrate Row – same visual structure as a steps row */}
                        {(() => {
                          const subIds = selectedProcess.substrateIds ?? []
                          const isLastSubstrate = subIds.length === 1
                          const hasSteps = selectedProcess.stages.length > 0
                          const availableForNew =
                            visibleSubstrateOptions.filter(
                              (opt) => !subIds.includes(opt.value),
                            )
                          return (
                            <Box
                              style={{
                                minHeight: 96,
                                borderRadius: 10,
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                padding: "8px 12px",
                              }}
                            >
                              <Text
                                size="xl"
                                fw={700}
                                w={84}
                                ta="left"
                                style={{
                                  color: "var(--mantine-color-gray-5)",
                                  flexShrink: 0,
                                }}
                              >
                                Substrate
                              </Text>

                              <Box
                                style={{
                                  flex: 1,
                                  minWidth: 0,
                                  overflowX: "auto",
                                }}
                              >
                                {subIds.length === 0 &&
                                substrateSelectingIdx !== -1 ? (
                                  <Group justify="center">
                                    {visibleSubstrateOptions.length > 0 ? (
                                      <Button
                                        size="xs"
                                        variant="subtle"
                                        leftSection={<IconPlus size={14} />}
                                        onClick={() =>
                                          setSubstrateSelectingIdx(-1)
                                        }
                                      >
                                        Choose Substrate
                                      </Button>
                                    ) : (
                                      <Button
                                        size="xs"
                                        variant="subtle"
                                        leftSection={
                                          <IconRowInsertTop size={14} />
                                        }
                                        onClick={handleCreateSubstrateMaterial}
                                      >
                                        New Substrate Material
                                      </Button>
                                    )}
                                  </Group>
                                ) : (
                                  <Group
                                    justify="center"
                                    gap="sm"
                                    wrap="nowrap"
                                    style={{
                                      width: "fit-content",
                                      minWidth: "100%",
                                      margin: "0 auto",
                                    }}
                                  >
                                    {subIds.map((subId, idx) => {
                                      const label = getSubstrateLabel(subId)
                                      const substrateDimensions =
                                        selectedProcess
                                          .substrateDimensionsById?.[subId] ??
                                        DEFAULT_SUBSTRATE_DIMENSIONS
                                      const isActive =
                                        substrateSelectingIdx === idx
                                      const cannotRemove =
                                        isLastSubstrate && hasSteps
                                      const replacementOptions =
                                        visibleSubstrateOptions.filter(
                                          (opt) =>
                                            !subIds.includes(opt.value) ||
                                            opt.value === subId,
                                        )
                                      return (
                                        <Box
                                          key={subId}
                                          data-step-box="true"
                                          onClick={() =>
                                            setSubstrateSelectingIdx(idx)
                                          }
                                          style={{
                                            width: 260,
                                            minHeight: 92,
                                            borderRadius: 8,
                                            padding: "10px 12px",
                                            display: "flex",
                                            flexDirection: "column",
                                            justifyContent: "space-between",
                                            cursor: "default",
                                            userSelect: "none",
                                            background: `linear-gradient(90deg, ${SUBSTRATE_COLOR}2E 0%, transparent 100%)`,
                                            border: isActive
                                              ? `2px solid ${SUBSTRATE_COLOR}`
                                              : "1px solid var(--mantine-color-gray-3)",
                                          }}
                                        >
                                          <Stack gap={6}>
                                            <Group
                                              justify="space-between"
                                              wrap="nowrap"
                                              gap="xs"
                                            >
                                              <Group
                                                gap={6}
                                                wrap="nowrap"
                                                style={{ flex: 1, minWidth: 0 }}
                                              >
                                                <IconSquare size={14} />
                                                <Text
                                                  size="sm"
                                                  fw={700}
                                                  truncate
                                                >
                                                  {label?.name ?? "Unnamed"}
                                                </Text>
                                              </Group>
                                              <Tooltip
                                                label="Remove all steps first before removing the last substrate"
                                                disabled={!cannotRemove}
                                                withArrow
                                              >
                                                <ActionIcon
                                                  size="xs"
                                                  variant="subtle"
                                                  color={
                                                    cannotRemove
                                                      ? "gray"
                                                      : "red"
                                                  }
                                                  onClick={(e) => {
                                                    e.stopPropagation()
                                                    if (!cannotRemove)
                                                      handleRemoveSubstrate(
                                                        subId,
                                                      )
                                                  }}
                                                >
                                                  <IconX size={12} />
                                                </ActionIcon>
                                              </Tooltip>
                                            </Group>

                                            <Box>
                                              {isActive ? (
                                                <Stack gap={6}>
                                                  <Select
                                                    size="xs"
                                                    placeholder="Select substrate"
                                                    value={subId}
                                                    data={replacementOptions.map(
                                                      (opt) => ({
                                                        value: opt.value,
                                                        label: opt.label,
                                                      }),
                                                    )}
                                                    searchable
                                                    clearable
                                                    comboboxProps={{
                                                      withinPortal: false,
                                                    }}
                                                    onClick={(e) =>
                                                      e.stopPropagation()
                                                    }
                                                    onChange={(value) => {
                                                      if (value) {
                                                        handleReplaceSubstrate(
                                                          idx,
                                                          value,
                                                        )
                                                      } else {
                                                        handleRemoveSubstrate(
                                                          subId,
                                                        )
                                                      }
                                                      setSubstrateSelectingIdx(
                                                        null,
                                                      )
                                                    }}
                                                  />

                                                  <Group gap={6} wrap="nowrap">
                                                    <NumberInput
                                                      size="xs"
                                                      label="Length (cm)"
                                                      min={0}
                                                      value={
                                                        substrateDimensions.lengthCm
                                                          ? Number(
                                                              substrateDimensions.lengthCm,
                                                            )
                                                          : ""
                                                      }
                                                      onClick={(e) =>
                                                        e.stopPropagation()
                                                      }
                                                      onChange={(value) =>
                                                        handleUpdateSubstrateDimensions(
                                                          subId,
                                                          {
                                                            lengthCm:
                                                              typeof value ===
                                                              "number"
                                                                ? String(value)
                                                                : "",
                                                          },
                                                        )
                                                      }
                                                      style={{ flex: 1 }}
                                                    />
                                                    <NumberInput
                                                      size="xs"
                                                      label="Width (cm)"
                                                      min={0}
                                                      value={
                                                        substrateDimensions.widthCm
                                                          ? Number(
                                                              substrateDimensions.widthCm,
                                                            )
                                                          : ""
                                                      }
                                                      onClick={(e) =>
                                                        e.stopPropagation()
                                                      }
                                                      onChange={(value) =>
                                                        handleUpdateSubstrateDimensions(
                                                          subId,
                                                          {
                                                            widthCm:
                                                              typeof value ===
                                                              "number"
                                                                ? String(value)
                                                                : "",
                                                          },
                                                        )
                                                      }
                                                      style={{ flex: 1 }}
                                                    />
                                                  </Group>
                                                  <NumberInput
                                                    size="xs"
                                                    label="Surface roughness RMS (nm)"
                                                    min={0}
                                                    value={
                                                      substrateDimensions.surfaceRoughnessRmsNm
                                                        ? Number(
                                                            substrateDimensions.surfaceRoughnessRmsNm,
                                                          )
                                                        : ""
                                                    }
                                                    onClick={(e) =>
                                                      e.stopPropagation()
                                                    }
                                                    onChange={(value) =>
                                                      handleUpdateSubstrateDimensions(
                                                        subId,
                                                        {
                                                          surfaceRoughnessRmsNm:
                                                            typeof value ===
                                                            "number"
                                                              ? String(value)
                                                              : "",
                                                        },
                                                      )
                                                    }
                                                  />
                                                </Stack>
                                              ) : (
                                                <Stack gap={2}>
                                                  <Text size="xs" c="dimmed">
                                                    {label?.rigidity ===
                                                    "flexible"
                                                      ? "Flexible"
                                                      : label?.rigidity ===
                                                          "rigid"
                                                        ? "Rigid"
                                                        : "—"}
                                                  </Text>
                                                  <Text size="xs" c="dimmed">
                                                    {`L ${substrateDimensions.lengthCm || "2"} cm · W ${substrateDimensions.widthCm || "2"} cm`}
                                                  </Text>
                                                  <Text size="xs" c="dimmed">
                                                    {`Roughness RMS ${substrateDimensions.surfaceRoughnessRmsNm || "—"} nm`}
                                                  </Text>
                                                </Stack>
                                              )}
                                            </Box>
                                          </Stack>
                                        </Box>
                                      )
                                    })}

                                    {substrateSelectingIdx === -1 && (
                                      <Box
                                        data-step-box="true"
                                        style={{
                                          width: 260,
                                          minHeight: 92,
                                          borderRadius: 8,
                                          padding: "10px 12px",
                                          display: "flex",
                                          flexDirection: "column",
                                          justifyContent: "space-between",
                                          background: `linear-gradient(90deg, ${SUBSTRATE_COLOR}2E 0%, transparent 100%)`,
                                          border: `2px solid ${SUBSTRATE_COLOR}`,
                                        }}
                                      >
                                        <Stack gap={6}>
                                          <Group gap={6} wrap="nowrap">
                                            <IconSquare size={14} />
                                            <Text size="sm" fw={700} c="dimmed">
                                              New substrate
                                            </Text>
                                          </Group>
                                          <Select
                                            size="xs"
                                            placeholder="Select substrate"
                                            data={availableForNew.map(
                                              (opt) => ({
                                                value: opt.value,
                                                label: opt.label,
                                              }),
                                            )}
                                            searchable
                                            clearable
                                            comboboxProps={{
                                              withinPortal: false,
                                            }}
                                            onClick={(e) => e.stopPropagation()}
                                            onChange={(value) => {
                                              if (value)
                                                handleAddSubstrate(value)
                                              setSubstrateSelectingIdx(null)
                                            }}
                                          />
                                        </Stack>
                                      </Box>
                                    )}
                                  </Group>
                                )}
                              </Box>

                              <Box
                                style={{
                                  width: ROW_ACTION_SLOT_WIDTH,
                                  flexShrink: 0,
                                  display: "flex",
                                  justifyContent: "flex-start",
                                }}
                              >
                                {substrateSelectingIdx !== -1 &&
                                subIds.length > 0 ? (
                                  availableForNew.length > 0 ? (
                                    <Button
                                      size="xs"
                                      variant="subtle"
                                      leftSection={<IconPlus size={14} />}
                                      onClick={() =>
                                        setSubstrateSelectingIdx(-1)
                                      }
                                    >
                                      Choose Alternative Substrate
                                    </Button>
                                  ) : (
                                    <Button
                                      size="xs"
                                      variant="subtle"
                                      leftSection={
                                        <IconRowInsertTop size={14} />
                                      }
                                      onClick={handleCreateSubstrateMaterial}
                                    >
                                      New Substrate Material
                                    </Button>
                                  )
                                ) : (
                                  <span />
                                )}
                              </Box>
                            </Box>
                          )
                        })()}

                        {selectedProcess.stages.length > 0 ? (
                          <Stack gap="xs">
                            <Box
                              style={{
                                height: 10,
                                borderRadius: 5,
                                background:
                                  dropInsertIndex === 0
                                    ? "var(--mantine-color-blue-1)"
                                    : "transparent",
                              }}
                              onDragOver={(e) => {
                                e.preventDefault()
                                setDropInsertIndex(0)
                                setDropStagePos(null)
                              }}
                              onDragLeave={() => setDropInsertIndex(null)}
                              onDrop={(e) => {
                                e.preventDefault()
                                if (draggedStep) {
                                  moveStepToNewStageAt(
                                    draggedStep.stepId,
                                    draggedStep.fromStagePos,
                                    0,
                                  )
                                }
                                setDraggedStep(null)
                                setDropInsertIndex(null)
                                setDropStagePos(null)
                              }}
                            />

                            {displayedStages.map(
                              ({ stage, stagePos }, displayIndex) => (
                                <Box key={stage.index}>
                                  <Box
                                    style={{
                                      minHeight: 96,
                                      borderRadius: 10,
                                      display: "flex",
                                      alignItems: "center",
                                      gap: 8,
                                      padding: "8px 12px",
                                      background:
                                        dropStagePos === stagePos
                                          ? "var(--mantine-color-blue-0)"
                                          : "transparent",
                                    }}
                                    onDragOver={(e) => {
                                      e.preventDefault()
                                      setDropStagePos(stagePos)
                                      setDropInsertIndex(null)
                                    }}
                                    onDragLeave={() => setDropStagePos(null)}
                                    onDrop={(e) => {
                                      e.preventDefault()
                                      if (draggedStep) {
                                        moveStepToAlternativeStage(
                                          draggedStep.stepId,
                                          draggedStep.fromStagePos,
                                          stagePos,
                                        )
                                      }
                                      setDraggedStep(null)
                                      setDropStagePos(null)
                                      setDropInsertIndex(null)
                                    }}
                                  >
                                    <Text
                                      size="xl"
                                      fw={700}
                                      w={84}
                                      ta="left"
                                      style={{
                                        color: "var(--mantine-color-gray-5)",
                                      }}
                                    >
                                      #{displayIndex + 1}
                                    </Text>

                                    <Box
                                      style={{
                                        flex: 1,
                                        minWidth: 0,
                                        overflowX: "auto",
                                      }}
                                    >
                                      <Group
                                        justify="center"
                                        gap="sm"
                                        wrap="nowrap"
                                        style={{
                                          width: "fit-content",
                                          minWidth: "100%",
                                          margin: "0 auto",
                                        }}
                                      >
                                        {stage.alternatives.map(
                                          (step, altIdx) => {
                                            const parameterLines =
                                              getParameterFlowLines(step)
                                            const isSelected =
                                              selectedStepId === step.id
                                            const cardMinHeight = isSelected
                                              ? 92
                                              : Math.max(
                                                  92,
                                                  86 +
                                                    parameterLines.length * 16,
                                                )

                                            return (
                                              <Box
                                                key={step.id}
                                                data-step-box="true"
                                                draggable
                                                onDragStart={() => {
                                                  setDraggedStep({
                                                    stepId: step.id,
                                                    fromStagePos: stagePos,
                                                  })
                                                }}
                                                onDragEnd={() => {
                                                  setDraggedStep(null)
                                                  setDropInsertIndex(null)
                                                  setDropStagePos(null)
                                                }}
                                                onClick={() =>
                                                  setSelectedStepId(step.id)
                                                }
                                                style={{
                                                  width: 260,
                                                  minHeight: cardMinHeight,
                                                  borderRadius: 8,
                                                  padding: "10px 12px",
                                                  display: "flex",
                                                  flexDirection: "column",
                                                  justifyContent:
                                                    "space-between",
                                                  cursor: "grab",
                                                  userSelect: "none",
                                                  background: `linear-gradient(90deg, ${step.color}2E 0%, transparent 100%)`,
                                                  border:
                                                    selectedStepId === step.id
                                                      ? `2px solid ${step.color}`
                                                      : "1px solid var(--mantine-color-gray-3)",
                                                }}
                                              >
                                                <Stack gap={6}>
                                                  <Group
                                                    justify="space-between"
                                                    wrap="nowrap"
                                                    gap="xs"
                                                  >
                                                    <Group
                                                      gap={6}
                                                      wrap="nowrap"
                                                      style={{
                                                        flex: 1,
                                                        minWidth: 0,
                                                      }}
                                                    >
                                                      {
                                                        STEP_CATEGORY_ICON_MAP[
                                                          step.stepCategory
                                                        ]
                                                      }
                                                      {stage.alternatives
                                                        .length > 1 && (
                                                        <Text
                                                          size="xs"
                                                          c="dimmed"
                                                          style={{
                                                            fontWeight: 700,
                                                            minWidth: 16,
                                                          }}
                                                        >
                                                          {String.fromCharCode(
                                                            97 + altIdx,
                                                          )}
                                                        </Text>
                                                      )}
                                                      {selectedStepId ===
                                                      step.id ? (
                                                        <TextInput
                                                          size="xs"
                                                          placeholder="Deposition method"
                                                          autoFocus={
                                                            pendingFocusStepId ===
                                                            step.id
                                                          }
                                                          value={
                                                            step
                                                              .depositionMethod
                                                              ?.value ?? ""
                                                          }
                                                          onClick={(e) =>
                                                            e.stopPropagation()
                                                          }
                                                          onFocus={(e) => {
                                                            e.currentTarget.select()
                                                            if (
                                                              pendingFocusStepId ===
                                                              step.id
                                                            ) {
                                                              setPendingFocusStepId(
                                                                null,
                                                              )
                                                            }
                                                          }}
                                                          onChange={(e) =>
                                                            handleUpdateStepParam(
                                                              step.id,
                                                              "depositionMethod",
                                                              {
                                                                value:
                                                                  e
                                                                    .currentTarget
                                                                    .value,
                                                                mode: "constant",
                                                              },
                                                            )
                                                          }
                                                          styles={{
                                                            input: {
                                                              fontWeight: 700,
                                                            },
                                                          }}
                                                          style={{ flex: 1 }}
                                                        />
                                                      ) : (
                                                        <Text
                                                          size="sm"
                                                          fw={700}
                                                          truncate
                                                        >
                                                          {step.depositionMethod?.value?.trim() ||
                                                            step.name ||
                                                            "Unnamed"}
                                                        </Text>
                                                      )}
                                                    </Group>
                                                    <Group
                                                      gap={6}
                                                      wrap="nowrap"
                                                    >
                                                      {selectedStepId ===
                                                        step.id && (
                                                        <input
                                                          type="color"
                                                          value={step.color}
                                                          onClick={(e) =>
                                                            e.stopPropagation()
                                                          }
                                                          onChange={(e) =>
                                                            handleUpdateStepColor(
                                                              step.id,
                                                              e.currentTarget
                                                                .value,
                                                            )
                                                          }
                                                          style={{
                                                            width: 28,
                                                            height: 28,
                                                            border: `1px solid ${step.color}`,
                                                            borderRadius: 6,
                                                            background:
                                                              "transparent",
                                                            padding: 1,
                                                          }}
                                                        />
                                                      )}
                                                      <ActionIcon
                                                        size="xs"
                                                        variant="subtle"
                                                        color="red"
                                                        onClick={(e) => {
                                                          e.stopPropagation()
                                                          handleRemoveStep(
                                                            step.id,
                                                          )
                                                        }}
                                                      >
                                                        <IconX size={12} />
                                                      </ActionIcon>
                                                    </Group>
                                                  </Group>

                                                  <Box>
                                                    {selectedStepId ===
                                                    step.id ? (
                                                      <Select
                                                        size="xs"
                                                        placeholder="Select material"
                                                        value={getStepSourceValue(
                                                          step,
                                                        )}
                                                        data={
                                                          step.stepCategory ===
                                                            "wet_deposition" ||
                                                          step.stepCategory ===
                                                            "surface_treatment"
                                                            ? wetDepositionSourceOptions
                                                            : sourceOptions
                                                        }
                                                        searchable
                                                        clearable
                                                        comboboxProps={{
                                                          withinPortal: false,
                                                        }}
                                                        renderOption={({
                                                          option,
                                                        }) => (
                                                          <Text
                                                            size="xs"
                                                            fw={
                                                              option.value.startsWith(
                                                                "action:",
                                                              )
                                                                ? 700
                                                                : 400
                                                            }
                                                          >
                                                            {option.label}
                                                          </Text>
                                                        )}
                                                        onClick={(e) =>
                                                          e.stopPropagation()
                                                        }
                                                        onChange={(value) =>
                                                          handleUpdateStepSource(
                                                            step.id,
                                                            value,
                                                          )
                                                        }
                                                      />
                                                    ) : (
                                                      <Stack gap={2}>
                                                        <Group
                                                          justify="space-between"
                                                          wrap="nowrap"
                                                          gap="xs"
                                                        >
                                                          <Text
                                                            size="xs"
                                                            c="black"
                                                            truncate
                                                            style={{ flex: 1 }}
                                                          >
                                                            {getStepSourceLabel(
                                                              step,
                                                            )}
                                                          </Text>
                                                          {parameterLines[0] !==
                                                            "No parameters set" && (
                                                            <Badge
                                                              size="xs"
                                                              variant="light"
                                                              color="teal"
                                                            >
                                                              {
                                                                parameterLines.length
                                                              }{" "}
                                                              params
                                                            </Badge>
                                                          )}
                                                        </Group>
                                                        <Stack gap={1}>
                                                          {parameterLines.map(
                                                            (line, lineIdx) => (
                                                              <Text
                                                                key={`${step.id}-param-line-${lineIdx}`}
                                                                size="xs"
                                                                c="dimmed"
                                                                truncate
                                                                style={{
                                                                  whiteSpace:
                                                                    "nowrap",
                                                                }}
                                                              >
                                                                {line}
                                                              </Text>
                                                            ),
                                                          )}
                                                        </Stack>
                                                      </Stack>
                                                    )}
                                                  </Box>
                                                </Stack>
                                              </Box>
                                            )
                                          },
                                        )}
                                      </Group>
                                    </Box>

                                    <Box
                                      style={{
                                        width: ROW_ACTION_SLOT_WIDTH,
                                        flexShrink: 0,
                                        display: "flex",
                                        justifyContent: "flex-start",
                                      }}
                                    >
                                      <Menu shadow="md" width={240}>
                                        <Menu.Target>
                                          <Button
                                            size="xs"
                                            variant="subtle"
                                            leftSection={<IconPlus size={14} />}
                                          >
                                            Add Alternative Step
                                          </Button>
                                        </Menu.Target>
                                        <Menu.Dropdown>
                                          {STEP_CATEGORIES.map((category) => (
                                            <Menu.Item
                                              key={`alt-${stage.index}-${category.value}`}
                                              leftSection={category.icon}
                                              onClick={() =>
                                                handleAddAlternativeStep(
                                                  stage.index,
                                                  category.value,
                                                )
                                              }
                                            >
                                              {category.label}
                                            </Menu.Item>
                                          ))}
                                        </Menu.Dropdown>
                                      </Menu>
                                    </Box>
                                  </Box>

                                  <Box
                                    style={{
                                      height: 10,
                                      borderRadius: 5,
                                      background:
                                        dropInsertIndex === stagePos + 1
                                          ? "var(--mantine-color-blue-1)"
                                          : "transparent",
                                    }}
                                    onDragOver={(e) => {
                                      e.preventDefault()
                                      setDropInsertIndex(stagePos + 1)
                                      setDropStagePos(null)
                                    }}
                                    onDragLeave={() => setDropInsertIndex(null)}
                                    onDrop={(e) => {
                                      e.preventDefault()
                                      if (draggedStep) {
                                        moveStepToNewStageAt(
                                          draggedStep.stepId,
                                          draggedStep.fromStagePos,
                                          stagePos + 1,
                                        )
                                      }
                                      setDraggedStep(null)
                                      setDropInsertIndex(null)
                                      setDropStagePos(null)
                                    }}
                                  />

                                  {selectedStepStagePos === stagePos &&
                                    inlineStepDetailsPanel && (
                                      <Box mt="xs" mb="sm">
                                        {inlineStepDetailsPanel}
                                      </Box>
                                    )}
                                </Box>
                              ),
                            )}
                          </Stack>
                        ) : null}
                      </Box>

                      {(selectedProcess.substrateIds ?? []).length > 0 && (
                        <Box
                          style={{
                            display: "flex",
                            flexDirection: "column",
                            alignItems: "center",
                            justifyContent:
                              selectedProcess.stages.length === 0
                                ? "center"
                                : "flex-start",
                            flex:
                              selectedProcess.stages.length === 0
                                ? 1
                                : undefined,
                            minHeight:
                              selectedProcess.stages.length === 0
                                ? 200
                                : undefined,
                            gap: 16,
                          }}
                        >
                          <Group justify="center" gap="sm">
                            <Menu shadow="md" width={240}>
                              <Menu.Target>
                                <Button
                                  size="xs"
                                  variant="subtle"
                                  leftSection={<IconPlus size={14} />}
                                >
                                  Add Next Step
                                </Button>
                              </Menu.Target>
                              <Menu.Dropdown>
                                {STEP_CATEGORIES.map((category) => (
                                  <Menu.Item
                                    key={`next-${category.value}`}
                                    leftSection={category.icon}
                                    onClick={() =>
                                      handleAddProcessStep(category.value)
                                    }
                                  >
                                    {category.label}
                                  </Menu.Item>
                                ))}
                              </Menu.Dropdown>
                            </Menu>
                          </Group>

                          {hasBothSubstrateAndStep && (
                            <Group justify="center">
                              {generatedStacks.length === 0 ? (
                                <Button
                                  size="lg"
                                  color="blue"
                                  variant="subtle"
                                  leftSection={<IconSparkles size={20} />}
                                  onClick={handleGenerateStacks}
                                >
                                  Generate Resulting Stacks
                                </Button>
                              ) : null}
                            </Group>
                          )}
                        </Box>
                      )}

                      {generatedStacks.length > 0 && (
                        <>
                          <Box
                            mt="xl"
                            pt="xl"
                            style={{
                              borderTop:
                                "2px solid var(--mantine-color-gray-3)",
                            }}
                          >
                            <ResultingStacks
                              stacks={generatedStacks}
                              deletedCombinations={deletedCombinations}
                              onLayerChange={handleUpdateStackLayer}
                              onStackFieldChange={handleUpdateStackField}
                              onDelete={handleDeleteStack}
                              onRecover={handleRecoverStack}
                              onRefresh={handleGenerateStacks}
                            />
                          </Box>

                          <Group justify="center" mt="lg">
                            <Button
                              size="lg"
                              color="green"
                              variant="subtle"
                              leftSection={<IconPlayerPlay size={20} />}
                              onClick={() =>
                                handleSpawnExperiment(selectedProcess)
                              }
                            >
                              Create Experiment from Process
                            </Button>
                          </Group>
                        </>
                      )}
                    </Stack>
                  </Box>
                </Stack>
              </Box>
            </>
          ) : (
            <Box
              style={{ display: "grid", placeItems: "center", height: "100%" }}
            >
              <Stack align="center" gap="md">
                <Text c="dimmed">Select or create a process to begin</Text>
                <Button
                  onClick={handleCreateProcess}
                  leftSection={<IconPlus size={16} />}
                >
                  New Process
                </Button>
              </Stack>
            </Box>
          )}
        </Box>
      </Box>

      <SelectCollectionModal
        opened={collectionModalOpen}
        onClose={() => setCollectionModalOpen(false)}
        onConfirm={doCreateProcess}
        confirmLabel="Add Process"
      />
    </>
  )
}
