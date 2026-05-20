import {
  ActionIcon,
  Anchor,
  Box,
  Button,
  Container,
  Group,
  Loader,
  Modal,
  NativeSelect,
  rem,
  ScrollArea,
  Stack,
  Table,
  Text,
  TextInput,
  Title,
  Tooltip,
  UnstyledButton,
} from "@mantine/core"
import { modals } from "@mantine/modals"
import {
  IconCheck,
  IconChevronDown,
  IconChevronUp,
  IconCopy,
  IconPencil,
  IconPlus,
  IconSelector,
  IconTrash,
  IconX,
} from "@tabler/icons-react"
import { useNavigate } from "@tanstack/react-router"
import { useEffect, useMemo, useRef, useState } from "react"
import { DependencyBlockModal } from "../components/DependencyBlockModal"
import {
  type CollectionConfirmParams,
  SelectCollectionModal,
} from "../components/SelectCollectionModal"
import {
  type CanvasCollectionElement,
  getDependentLocations,
  type Material,
  type MaterialCategory,
  newMaterial,
  useAppContext,
  useEntityCollection,
} from "../store/AppContext"

type Column = {
  key: keyof Material
  label: string
}

const MATERIAL_TYPES = [
  "n-type (ETL)",
  "p-type (HTL)",
  "perovskite precursor",
  "solvent",
  "additive",
  "passivation agent/layer",
  "conductor (contact)",
  "encapsulant",
  "semiconductor (i)",
  "other",
]

const COMMON_COLUMNS: Column[] = [
  { key: "name", label: "Name" },
  { key: "supplier", label: "Supplier" },
  { key: "supplierNumber", label: "Supplier Number" },
  { key: "inventoryLabel", label: "Inventory Label" },
]

const CHEMICAL_COLUMNS: Column[] = [
  { key: "type", label: "Type" },
  ...COMMON_COLUMNS,
  { key: "casNumber", label: "CAS Number" },
  { key: "pubchemCid", label: "PubChem CID" },
  { key: "purity", label: "Purity" },
  { key: "stateAtRt", label: "State at RT" },
]

const COMMERCIAL_MIXTURE_COLUMNS: Column[] = [
  { key: "type", label: "Type" },
  ...COMMON_COLUMNS,
  { key: "casNumber", label: "CAS Number" },
  { key: "pubchemCid", label: "CID Numbers (Components)" },
]

const SUBSTRATE_COLUMNS: Column[] = [
  ...COMMON_COLUMNS,
  { key: "substrateRigidity", label: "Flexible / Rigid" },
  { key: "heightMm", label: "Height (mm)" },
]

const CATEGORY_LABEL: Record<MaterialCategory, string> = {
  chemical_compound: "Chemical Compounds",
  commercial_mixture: "Commercial Mixtures",
  substrate_material: "Substrate Materials",
}

const CATEGORY_ADD_LABEL: Record<MaterialCategory, string> = {
  chemical_compound: "Add Compound",
  commercial_mixture: "Add Com. Mixture",
  substrate_material: "Add Substrate Material",
}

const CATEGORY_COLUMNS: Record<MaterialCategory, Column[]> = {
  chemical_compound: CHEMICAL_COLUMNS,
  commercial_mixture: COMMERCIAL_MIXTURE_COLUMNS,
  substrate_material: SUBSTRATE_COLUMNS,
}

type SortState = { key: keyof Material; direction: "asc" | "desc" } | null

type PubChemResult = {
  cid: string
  title: string
  iupacName: string
  molecularFormula: string
}

type PubChemImportDetails = {
  casNumber: string
  stateAtRt: Material["stateAtRt"]
}

function extractCidValues(raw: string): string[] {
  const matches = raw.match(/\d+/g) ?? []
  return [...new Set(matches)]
}

function extractInfoStrings(value: unknown): string[] {
  if (!value || typeof value !== "object") {
    return []
  }

  const maybe = value as {
    StringValue?: string
    StringWithMarkup?: Array<{ String?: string }>
  }
  const out: string[] = []

  if (typeof maybe.StringValue === "string") {
    out.push(maybe.StringValue)
  }
  for (const entry of maybe.StringWithMarkup ?? []) {
    if (entry?.String) {
      out.push(entry.String)
    }
  }

  return out
}

function inferStateAtRt(text: string): Material["stateAtRt"] {
  const lower = text.toLowerCase()
  if (/\bsolid\b/.test(lower)) return "solid"
  if (/\bliquid\b/.test(lower)) return "liquid"
  if (/\bgas\b|\bgaseous\b/.test(lower)) return "gas"
  return ""
}

function parsePubChemDetails(raw: unknown): PubChemImportDetails {
  const casCandidates: string[] = []
  const stateCandidates: string[] = []
  const casRegex = /\b\d{2,7}-\d{2}-\d\b/g

  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") {
      return
    }
    const obj = node as {
      TOCHeading?: string
      Information?: Array<{ Value?: unknown }>
      Section?: unknown[]
      Record?: unknown
    }

    const heading = obj.TOCHeading?.toLowerCase() ?? ""
    if (obj.Information && heading) {
      for (const info of obj.Information) {
        const strings = extractInfoStrings(info?.Value)
        if (heading.includes("cas")) {
          for (const text of strings) {
            const matches = text.match(casRegex) ?? []
            casCandidates.push(...matches)
          }
        }
        if (
          heading.includes("physical description") ||
          heading.includes("physical state") ||
          heading.includes("appearance") ||
          heading === "state"
        ) {
          stateCandidates.push(...strings)
        }
      }
    }

    if (Array.isArray(obj.Section)) {
      for (const child of obj.Section) {
        walk(child)
      }
    }

    // PUG View responses commonly wrap data under Record.
    if (obj.Record) {
      walk(obj.Record)
    }
  }

  walk(raw)

  const casNumber = casCandidates[0] ?? ""
  let stateAtRt: Material["stateAtRt"] = ""
  for (const text of stateCandidates) {
    const inferred = inferStateAtRt(text)
    if (inferred) {
      stateAtRt = inferred
      break
    }
  }

  return { casNumber, stateAtRt }
}

function SortIcon({
  sorted,
  direction,
}: {
  sorted: boolean
  direction: "asc" | "desc"
}) {
  if (!sorted) {
    return <IconSelector size={14} />
  }
  return direction === "asc" ? (
    <IconChevronUp size={14} />
  ) : (
    <IconChevronDown size={14} />
  )
}

export function MaterialsPage() {
  const {
    materials,
    setMaterials,
    setProcesses,
    solutions,
    experiments,
    processes,
    planes,
    updateElement,
    removeCollectionRefs,
    pendingCollectionLink,
    setPendingCollectionLink,
    activeCollectionId,
    activePlaneId,
    activeEntity,
    setActiveEntity,
    lastSelectedByKind,
    updateLastSelected,
  } = useAppContext()
  const { getEntityColor, isEntityVisible, getEntityCollection } =
    useEntityCollection()
  const [sort, setSort] = useState<SortState>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editBuffer, setEditBuffer] = useState<Material | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [selectedMaterialId, setSelectedMaterialId] = useState<string | null>(
    () => lastSelectedByKind.material ?? null,
  )
  const processedPendingRequestIdsRef = useRef<Set<string>>(new Set())
  const returnToRef = useRef<string | null>(null)
  const returnToProcessIdRef = useRef<string | null>(null)
  const navigate = useNavigate()
  const [collectionModalOpen, setCollectionModalOpen] = useState(false)
  const pendingCategoryRef = useRef<MaterialCategory | null>(null)
  const pendingImportRef = useRef<Partial<Material> | null>(null)
  const [pubChemModalOpen, setPubChemModalOpen] = useState(false)
  const [pubChemCategory, setPubChemCategory] =
    useState<MaterialCategory>("chemical_compound")
  const [pubChemQuery, setPubChemQuery] = useState("")
  const [pubChemLoading, setPubChemLoading] = useState(false)
  const [pubChemError, setPubChemError] = useState<string | null>(null)
  const [pubChemResults, setPubChemResults] = useState<PubChemResult[]>([])
  const [pubChemImportingCid, setPubChemImportingCid] = useState<string | null>(
    null,
  )
  const [pubChemCidSearchingId, setPubChemCidSearchingId] = useState<
    string | null
  >(null)
  const [pubChemUpdateField, setPubChemUpdateField] = useState<
    "casNumber" | "stateAtRt" | null
  >(null)
  const [pubChemUpdateMaterialId, setPubChemUpdateMaterialId] = useState<
    string | null
  >(null)

  const selectMaterial = (id: string | null) => {
    setSelectedMaterialId(id)
    if (id) updateLastSelected("material", id)
  }

  const startEdit = (m: Material) => {
    setEditingId(m.id)
    setEditBuffer({ ...m })
  }

  useEffect(() => {
    if (!editingId) {
      if (
        activeEntity?.kind === "material" ||
        activeEntity?.kind === "process"
      ) {
        return
      }
      setActiveEntity(null)
      return
    }

    const editingMaterial = materials.find((m) => m.id === editingId)
    if (!editingMaterial || !isEntityVisible("material", editingId)) {
      setEditingId(null)
      setEditBuffer(null)
      setActiveEntity(null)
      return
    }

    if (activeEntity?.kind !== "material" || activeEntity.id !== editingId) {
      setActiveEntity({ kind: "material", id: editingId })
    }
  }, [activeEntity, editingId, isEntityVisible, materials, setActiveEntity])

  useEffect(() => {
    if (activeEntity?.kind !== "material") {
      return
    }
    if (editingId === activeEntity.id) {
      return
    }
    const material = materials.find((m) => m.id === activeEntity.id)
    if (!material || !isEntityVisible("material", material.id)) {
      return
    }
    setSelectedMaterialId(material.id)
    setSelected((prev) => {
      const next = new Set(prev)
      next.add(material.id)
      return next
    })
    setEditingId(null)
    setEditBuffer(null)
    setActiveEntity(null)
  }, [activeEntity, editingId, isEntityVisible, materials, setActiveEntity])

  // Auto-create material + link to collection when navigated from action bubble
  // biome-ignore lint/correctness/useExhaustiveDependencies: run once on mount
  useEffect(() => {
    if (!pendingCollectionLink || pendingCollectionLink.kind !== "material") {
      return
    }
    if (
      processedPendingRequestIdsRef.current.has(pendingCollectionLink.requestId)
    ) {
      return
    }
    processedPendingRequestIdsRef.current.add(pendingCollectionLink.requestId)

    const {
      collectionId,
      planeId,
      materialCategory,
      processAttachment,
      returnTo,
    } = pendingCollectionLink
    setPendingCollectionLink(null)

    if (returnTo) returnToRef.current = returnTo
    if (returnTo && processAttachment?.processId) {
      returnToProcessIdRef.current = processAttachment.processId
    }

    const m = newMaterial(materialCategory)
    setMaterials((prev) => [...prev, m])

    if (processAttachment) {
      setProcesses((prev) =>
        prev.map((process) => {
          if (process.id !== processAttachment.processId) {
            return process
          }
          if (processAttachment.target === "substrate") {
            const substrateIds = process.substrateIds ?? []
            if (substrateIds.includes(m.id)) {
              return process
            }
            return {
              ...process,
              substrateIds: [...substrateIds, m.id],
              substrateDimensionsById: {
                ...(process.substrateDimensionsById ?? {}),
                [m.id]: {
                  lengthCm: "2",
                  widthCm: "2",
                  surfaceRoughnessRmsNm: "",
                },
              },
            }
          }
          if (
            processAttachment.target === "step-material" &&
            processAttachment.stepId
          ) {
            return {
              ...process,
              stages: process.stages.map((stage) => ({
                ...stage,
                alternatives: stage.alternatives.map((step) =>
                  step.id === processAttachment.stepId
                    ? { ...step, materialId: m.id, solutionId: undefined }
                    : step,
                ),
              })),
            }
          }
          return process
        }),
      )
    }

    const plane = planes.find((p) => p.id === planeId)
    if (plane) {
      const col = plane.elements.find((e) => e.id === collectionId)
      if (col && col.type === "collection") {
        const updated = {
          ...col,
          refs: [...col.refs, { kind: "material" as const, id: m.id }],
        }
        updateElement(planeId, updated)
      }
    }

    startEdit(m)
  }, [])

  const toggleSort = (key: keyof Material) => {
    setSort((prev) => {
      if (prev?.key === key) {
        return { key, direction: prev.direction === "asc" ? "desc" : "asc" }
      }
      return { key, direction: "asc" }
    })
  }

  const sorted = [...materials]
    .filter((m) => isEntityVisible("material", m.id))
    .sort((a, b) => {
      if (!sort) {
        return 0
      }
      const av = String(a[sort.key] ?? "").toLowerCase()
      const bv = String(b[sort.key] ?? "").toLowerCase()
      const cmp = av.localeCompare(bv)
      return sort.direction === "asc" ? cmp : -cmp
    })

  const groupedByCategory = useMemo(() => {
    return {
      chemical_compound: sorted.filter(
        (m) => (m.category ?? "chemical_compound") === "chemical_compound",
      ),
      commercial_mixture: sorted.filter(
        (m) => (m.category ?? "chemical_compound") === "commercial_mixture",
      ),
      substrate_material: sorted.filter(
        (m) => (m.category ?? "chemical_compound") === "substrate_material",
      ),
    }
  }, [sorted])

  const copyMaterial = (m: Material) => {
    const copied: Material = {
      ...m,
      id: crypto.randomUUID(),
      name: `Copy of ${m.name}`,
    }
    setMaterials((prev) => [...prev, copied])
    const owner = getEntityCollection("material", m.id)
    if (owner) {
      updateElement(owner.plane.id, {
        ...owner.collection,
        refs: [
          ...owner.collection.refs,
          { kind: "material" as const, id: copied.id },
        ],
      })
    }
    startEdit(copied)
  }

  const deleteMaterial = (id: string) => {
    const mat = materials.find((m) => m.id === id)
    const dependents = getDependentLocations("material", id, {
      solutions,
      experiments,
      processes,
      planes,
    })
    if (dependents.length > 0) {
      modals.open({
        title: "Cannot delete material",
        children: (
          <DependencyBlockModal
            itemName={mat?.name ?? id}
            dependents={dependents}
          />
        ),
      })
      return
    }
    modals.openConfirmModal({
      title: "Delete material",
      children: (
        <Text size="sm">
          Are you sure you want to delete the material "{mat?.name || id}"? This
          cannot be undone.
        </Text>
      ),
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => {
        setMaterials((prev) => prev.filter((m) => m.id !== id))
        removeCollectionRefs("material", [id])
        if (selectedMaterialId === id) {
          selectMaterial(null)
        }
      },
    })
  }

  const doAddMaterial = (
    category: MaterialCategory,
    { planeId, collection }: CollectionConfirmParams,
    overrides?: Partial<Material>,
  ) => {
    const m = { ...newMaterial(category), ...overrides }
    setMaterials((prev) => [...prev, m])
    updateElement(planeId, {
      ...collection,
      refs: [...collection.refs, { kind: "material" as const, id: m.id }],
    })
    startEdit(m)
  }

  const addMaterial = (category: MaterialCategory) => {
    pendingImportRef.current = null
    if (activeCollectionId && activePlaneId) {
      const plane = planes.find((p) => p.id === activePlaneId)
      const col = plane?.elements.find((e) => e.id === activeCollectionId)
      if (col && col.type === "collection") {
        doAddMaterial(category, {
          planeId: activePlaneId,
          collectionId: activeCollectionId,
          collection: col as CanvasCollectionElement,
        })
        return
      }
    }
    pendingCategoryRef.current = category
    setCollectionModalOpen(true)
  }

  const addImportedMaterial = (
    category: MaterialCategory,
    overrides: Partial<Material>,
  ) => {
    if (activeCollectionId && activePlaneId) {
      const plane = planes.find((p) => p.id === activePlaneId)
      const col = plane?.elements.find((e) => e.id === activeCollectionId)
      if (col && col.type === "collection") {
        doAddMaterial(
          category,
          {
            planeId: activePlaneId,
            collectionId: activeCollectionId,
            collection: col as CanvasCollectionElement,
          },
          overrides,
        )
        return
      }
    }
    pendingCategoryRef.current = category
    pendingImportRef.current = overrides
    setCollectionModalOpen(true)
  }

  const openPubChemImporter = (category: MaterialCategory) => {
    setPubChemCategory(category)
    setPubChemUpdateField(null)
    setPubChemUpdateMaterialId(null)
    setPubChemModalOpen(true)
    setPubChemError(null)
    setPubChemResults([])
    setPubChemQuery("")
  }

  const openFieldSearchModal = (
    material: Material,
    field: "casNumber" | "stateAtRt",
  ) => {
    const name =
      editBuffer && editBuffer.id === material.id
        ? (editBuffer.name ?? "").trim()
        : (material.name ?? "").trim()
    setPubChemUpdateField(field)
    setPubChemUpdateMaterialId(material.id)
    setPubChemQuery(name)
    setPubChemResults([])
    setPubChemError(null)
    setPubChemModalOpen(true)
  }

  const searchPubChem = async () => {
    const query = pubChemQuery.trim()
    if (!query) {
      setPubChemError("Please enter a search term.")
      setPubChemResults([])
      return
    }

    setPubChemLoading(true)
    setPubChemError(null)
    try {
      const cidRes = await fetch(
        `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(query)}/cids/JSON`,
      )
      if (!cidRes.ok) {
        throw new Error("PubChem lookup failed")
      }
      const cidData = (await cidRes.json()) as {
        IdentifierList?: { CID?: number[] }
      }
      const cids = (cidData.IdentifierList?.CID ?? []).slice(0, 20)
      if (cids.length === 0) {
        setPubChemResults([])
        setPubChemError("No compounds found for this query.")
        return
      }

      const propRes = await fetch(
        `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/cid/${cids.join(",")}/property/Title,IUPACName,MolecularFormula/JSON`,
      )
      if (!propRes.ok) {
        throw new Error("PubChem property fetch failed")
      }
      const propData = (await propRes.json()) as {
        PropertyTable?: {
          Properties?: Array<{
            CID: number
            Title?: string
            IUPACName?: string
            MolecularFormula?: string
          }>
        }
      }

      const results: PubChemResult[] = (
        propData.PropertyTable?.Properties ?? []
      ).map((item) => ({
        cid: String(item.CID),
        title: item.Title || item.IUPACName || `CID ${item.CID}`,
        iupacName: item.IUPACName || "",
        molecularFormula: item.MolecularFormula || "",
      }))
      setPubChemResults(results)
      if (results.length === 0) {
        setPubChemError("No compounds found for this query.")
      }
    } catch {
      setPubChemError("PubChem search failed. Please try again.")
      setPubChemResults([])
    } finally {
      setPubChemLoading(false)
    }
  }

  const applyFieldFromPubChem = async (result: PubChemResult) => {
    const field = pubChemUpdateField
    const materialId = pubChemUpdateMaterialId
    if (!field || !materialId) return

    setPubChemImportingCid(result.cid)
    try {
      const detailRes = await fetch(
        `https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/${result.cid}/JSON`,
      )
      if (!detailRes.ok) throw new Error("PubChem detail fetch failed")
      const detailData = (await detailRes.json()) as unknown
      const details = parsePubChemDetails(detailData)

      setEditBuffer((prev) => {
        if (!prev || prev.id !== materialId) return prev
        // Always update the CID when a chemical is selected
        const updated = { ...prev, pubchemCid: result.cid }
        if (field === "casNumber") {
          return { ...updated, casNumber: details.casNumber }
        }
        return { ...updated, stateAtRt: details.stateAtRt }
      })
    } catch {
      // Keep existing value if fetch fails
    } finally {
      setPubChemImportingCid(null)
      setPubChemModalOpen(false)
      setPubChemUpdateField(null)
      setPubChemUpdateMaterialId(null)
    }
  }

  const fetchFieldByCid = async (
    material: Material,
    field: "casNumber" | "stateAtRt",
  ) => {
    const cid = (
      editBuffer && editBuffer.id === material.id
        ? (editBuffer.pubchemCid ?? "").trim()
        : (material.pubchemCid ?? "").trim()
    )

    if (!cid) {
      modals.open({
        title: "Missing CID",
        children: (
          <Text size="sm">
            Please enter a PubChem CID first, then try "Fetch by CID" again.
          </Text>
        ),
      })
      return
    }

    // Extract the first CID if multiple are present
    const cidValues = extractCidValues(cid)
    const firstCid = cidValues[0] ?? cid

    setPubChemCidSearchingId(material.id)
    try {
      const detailRes = await fetch(
        `https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/${firstCid}/JSON`,
      )
      if (!detailRes.ok) {
        throw new Error("PubChem detail fetch failed")
      }
      const detailData = (await detailRes.json()) as unknown
      const details = parsePubChemDetails(detailData)

      setEditBuffer((prev) => {
        if (!prev || prev.id !== material.id) return prev
        if (field === "casNumber") {
          return { ...prev, casNumber: details.casNumber }
        }
        return { ...prev, stateAtRt: details.stateAtRt }
      })
    } catch {
      modals.open({
        title: "PubChem fetch failed",
        children: (
          <Text size="sm">
            Could not fetch data from PubChem for CID {firstCid}. Please try
            again.
          </Text>
        ),
      })
    } finally {
      setPubChemCidSearchingId(null)
    }
  }

  const importPubChemResult = async (result: PubChemResult) => {
    let details: PubChemImportDetails = { casNumber: "", stateAtRt: "" }

    if (pubChemCategory === "chemical_compound") {
      setPubChemImportingCid(result.cid)
      try {
        const detailRes = await fetch(
          `https://pubchem.ncbi.nlm.nih.gov/rest/pug_view/data/compound/${result.cid}/JSON`,
        )
        if (detailRes.ok) {
          const detailData = (await detailRes.json()) as unknown
          details = parsePubChemDetails(detailData)
        }
      } catch {
        // Best effort import: keep remaining fields even when detail lookup fails.
      } finally {
        setPubChemImportingCid(null)
      }
    }

    addImportedMaterial(pubChemCategory, {
      name: result.title,
      pubchemCid: result.cid,
      ...(pubChemCategory === "chemical_compound"
        ? {
            casNumber: details.casNumber,
            stateAtRt: details.stateAtRt,
            purity: "",
          }
        : {}),
    })
    setPubChemModalOpen(false)
  }

  const handleCollectionConfirmed = (params: CollectionConfirmParams) => {
    const category = pendingCategoryRef.current
    const overrides = pendingImportRef.current
    pendingCategoryRef.current = null
    pendingImportRef.current = null
    if (category) {
      doAddMaterial(category, params, overrides ?? undefined)
    }
  }

  const searchCidByMaterialName = async (material: Material) => {
    const typedName =
      editBuffer && editBuffer.id === material.id
        ? (editBuffer.name ?? "").trim()
        : (material.name ?? "").trim()

    if (!typedName) {
      modals.open({
        title: "Missing name",
        children: (
          <Text size="sm">
            Please enter a material name first, then try "Search Name..." again.
          </Text>
        ),
      })
      return
    }

    setPubChemCidSearchingId(material.id)
    try {
      const response = await fetch(
        `https://pubchem.ncbi.nlm.nih.gov/rest/pug/compound/name/${encodeURIComponent(typedName)}/cids/JSON`,
      )
      if (!response.ok) {
        throw new Error("PubChem lookup failed")
      }

      const data = (await response.json()) as {
        IdentifierList?: { CID?: number[] }
      }
      const cid = data.IdentifierList?.CID?.[0]

      if (!cid) {
        modals.open({
          title: "No CID found",
          children: (
            <Text size="sm">
              PubChem did not return a CID for "{typedName}".
            </Text>
          ),
        })
        return
      }

      setEditBuffer((prev) =>
        prev && prev.id === material.id
          ? { ...prev, pubchemCid: String(cid) }
          : prev,
      )
    } catch {
      modals.open({
        title: "PubChem search failed",
        children: (
          <Text size="sm">
            Could not fetch a PubChem CID right now. Please try again.
          </Text>
        ),
      })
    } finally {
      setPubChemCidSearchingId(null)
    }
  }

  const commitEdit = () => {
    if (!editBuffer) {
      return
    }
    if (!(editBuffer.name ?? "").trim()) {
      cancelEdit(editBuffer.id)
      return
    }
    setMaterials((prev) =>
      prev.map((m) => (m.id === editBuffer.id ? editBuffer : m)),
    )
    setEditingId(null)
    setEditBuffer(null)
    if (returnToRef.current) {
      const route = returnToRef.current
      const processId = returnToProcessIdRef.current
      returnToRef.current = null
      returnToProcessIdRef.current = null
      if (processId) setActiveEntity({ kind: "process", id: processId })
      void navigate({ to: route as never })
    } else {
      setActiveEntity(null)
    }
  }

  const cancelEdit = (id: string) => {
    const original = materials.find((m) => m.id === id)
    if (original && !(original.name ?? "").trim()) {
      // Row has no name — remove it
      setMaterials((prev) => prev.filter((m) => m.id !== id))
      removeCollectionRefs("material", [id])
    }
    setEditingId(null)
    setEditBuffer(null)
    setActiveEntity(null)
  }

  const confirmDelete = () => {
    // Build dependency report for all selected materials
    const depReport: { materialName: string; count: number }[] = []
    for (const id of selected) {
      const mat = materials.find((m) => m.id === id)
      const dependents = getDependentLocations("material", id, {
        solutions,
        experiments,
        processes,
        planes,
      })
      if (dependents.length > 0) {
        depReport.push({
          materialName: mat?.name || id,
          count: dependents.length,
        })
      }
    }
    if (depReport.length > 0) {
      // Collect all dependents for the first blocked material and show a blocking modal
      const firstBlockedId = [...selected].find(
        (id) =>
          getDependentLocations("material", id, {
            solutions,
            experiments,
            processes,
            planes,
          }).length > 0,
      )!
      const firstMat = materials.find((m) => m.id === firstBlockedId)
      const firstDeps = getDependentLocations("material", firstBlockedId, {
        solutions,
        experiments,
        processes,
        planes,
      })
      modals.open({
        title: "Cannot delete material",
        children: (
          <DependencyBlockModal
            itemName={firstMat?.name ?? firstBlockedId}
            dependents={firstDeps}
          />
        ),
      })
      return
    }
    modals.openConfirmModal({
      title: "Delete materials",
      children: (
        <Text size="sm">
          Are you sure you want to delete {selected.size} material
          {selected.size > 1 ? "s" : ""}? This cannot be undone.
        </Text>
      ),
      labels: { confirm: "Delete", cancel: "Cancel" },
      confirmProps: { color: "red" },
      onConfirm: () => {
        const deletedIds = [...selected]
        setMaterials((prev) => prev.filter((m) => !selected.has(m.id)))
        removeCollectionRefs("material", deletedIds)
        setSelected(new Set())
        if (selectedMaterialId && selected.has(selectedMaterialId)) {
          selectMaterial(null)
        }
      },
    })
  }

  const toggleSelect = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const toggleSelectAllInCategory = (ids: string[]) => {
    if (ids.length === 0) return
    const allSelected = ids.every((id) => selected.has(id))
    setSelected((prev) => {
      const next = new Set(prev)
      if (allSelected) {
        for (const id of ids) {
          next.delete(id)
        }
      } else {
        for (const id of ids) {
          next.add(id)
        }
      }
      return next
    })
  }

  const renderCellEditor = (material: Material, colKey: keyof Material) => {
    if (!editBuffer) {
      return null
    }
    if (colKey === "type") {
      return (
        <NativeSelect
          size="xs"
          value={editBuffer.type}
          data={[
            { label: "", value: "" },
            ...MATERIAL_TYPES.map((t) => ({ label: t, value: t })),
          ]}
          onChange={(e) => {
            const value = e.currentTarget.value
            setEditBuffer((prev) => (prev ? { ...prev, type: value } : prev))
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitEdit()
            }
            if (e.key === "Escape") {
              cancelEdit(material.id)
            }
          }}
          autoFocus
        />
      )
    }
    if (colKey === "stateAtRt") {
      const hasCid = (editBuffer.pubchemCid ?? "").trim()
      return (
        <Group gap={6} wrap="nowrap">
          <NativeSelect
            size="xs"
            value={editBuffer.stateAtRt}
            data={[
              { label: "", value: "" },
              { label: "liquid", value: "liquid" },
              { label: "solid", value: "solid" },
              { label: "gas", value: "gas" },
            ]}
            onChange={(e) => {
              const value = e.currentTarget.value as Material["stateAtRt"]
              setEditBuffer((prev) =>
                prev ? { ...prev, stateAtRt: value } : prev,
              )
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitEdit()
              }
              if (e.key === "Escape") {
                cancelEdit(material.id)
              }
            }}
            style={{ flex: 1 }}
          />
          {hasCid ? (
            <Button
              size="xs"
              variant="light"
              onClick={() => void fetchFieldByCid(material, "stateAtRt")}
              loading={pubChemCidSearchingId === material.id}
            >
              Fetch by CID
            </Button>
          ) : (
            <Button
              size="xs"
              variant="light"
              onClick={() => openFieldSearchModal(material, "stateAtRt")}
            >
              Search Name...
            </Button>
          )}
        </Group>
      )
    }
    if (colKey === "substrateRigidity") {
      return (
        <NativeSelect
          size="xs"
          value={editBuffer.substrateRigidity}
          data={[
            { label: "", value: "" },
            { label: "Flexible", value: "flexible" },
            { label: "Rigid", value: "rigid" },
          ]}
          onChange={(e) => {
            const value = e.currentTarget.value as Material["substrateRigidity"]
            setEditBuffer((prev) =>
              prev ? { ...prev, substrateRigidity: value } : prev,
            )
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              commitEdit()
            }
            if (e.key === "Escape") {
              cancelEdit(material.id)
            }
          }}
        />
      )
    }

    if (colKey === "casNumber") {
      const hasCid = (editBuffer.pubchemCid ?? "").trim()
      return (
        <Group gap={6} wrap="nowrap">
          <TextInput
            size="xs"
            value={String(editBuffer.casNumber ?? "")}
            onChange={(e) => {
              const value = e.currentTarget.value
              setEditBuffer((prev) =>
                prev ? { ...prev, casNumber: value } : prev,
              )
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitEdit()
              }
              if (e.key === "Escape") {
                cancelEdit(material.id)
              }
            }}
            style={{ flex: 1 }}
          />
          {hasCid ? (
            <Button
              size="xs"
              variant="light"
              onClick={() => void fetchFieldByCid(material, "casNumber")}
              loading={pubChemCidSearchingId === material.id}
            >
              Fetch by CID
            </Button>
          ) : (
            <Button
              size="xs"
              variant="light"
              onClick={() => openFieldSearchModal(material, "casNumber")}
            >
              Search Name...
            </Button>
          )}
        </Group>
      )
    }

    if (colKey === "pubchemCid") {
      return (
        <Group gap={6} wrap="nowrap">
          <TextInput
            size="xs"
            value={String(editBuffer.pubchemCid ?? "")}
            onChange={(e) => {
              const value = e.currentTarget.value
              setEditBuffer((prev) =>
                prev ? { ...prev, pubchemCid: value } : prev,
              )
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                commitEdit()
              }
              if (e.key === "Escape") {
                cancelEdit(material.id)
              }
            }}
            style={{ flex: 1 }}
          />
          <Button
            size="xs"
            variant="light"
            onClick={() => void searchCidByMaterialName(material)}
            loading={pubChemCidSearchingId === material.id}
          >
            Search Name...
          </Button>
        </Group>
      )
    }

    return (
      <TextInput
        size="xs"
        value={String(editBuffer[colKey] ?? "")}
        onChange={(e) => {
          const value = e.currentTarget.value
          setEditBuffer((prev) => (prev ? { ...prev, [colKey]: value } : prev))
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            commitEdit()
          }
          if (e.key === "Escape") {
            cancelEdit(material.id)
          }
        }}
        autoFocus={colKey === "name"}
      />
    )
  }

  const renderMaterialRow = (material: Material, categoryColumns: Column[]) => {
    const isEditing = editingId === material.id
    return (
      <Table.Tr
        key={material.id}
        bg={
          selected.has(material.id)
            ? "var(--mantine-color-blue-light)"
            : undefined
        }
        onClick={() => selectMaterial(material.id)}
        style={{ cursor: "pointer" }}
      >
        <Table.Td
          style={{
            padding: 0,
            width: 6,
            minWidth: 6,
            background:
              getEntityColor("material", material.id) ?? "transparent",
          }}
        />
        <Table.Td>
          <input
            type="checkbox"
            checked={selected.has(material.id)}
            onChange={() => toggleSelect(material.id)}
          />
        </Table.Td>
        {categoryColumns.map((col) => (
          <Table.Td key={col.key}>
            {isEditing && editBuffer ? (
              renderCellEditor(material, col.key)
            ) : col.key === "pubchemCid" &&
              String(material.pubchemCid ?? "").trim() ? (
              (() => {
                const raw = String(material.pubchemCid ?? "")
                const cidValues = extractCidValues(raw)
                if (cidValues.length === 0) {
                  return <Text size="sm">{raw}</Text>
                }
                return (
                  <Group gap={6} wrap="wrap">
                    {cidValues.map((cid) => (
                      <Anchor
                        key={cid}
                        href={`https://pubchem.ncbi.nlm.nih.gov/compound/${cid}`}
                        target="_blank"
                        rel="noreferrer"
                        size="sm"
                        onClick={(e) => e.stopPropagation()}
                      >
                        {cid}
                      </Anchor>
                    ))}
                  </Group>
                )
              })()
            ) : (
              <Text size="sm">
                {String(material[col.key] ?? "") || (
                  <Text span c="dimmed" size="sm">
                    —
                  </Text>
                )}
              </Text>
            )}
          </Table.Td>
        ))}
        <Table.Td>
          <Group gap={4} justify="center">
            {isEditing ? (
              <>
                <Tooltip label="Save">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="green"
                    onClick={commitEdit}
                  >
                    <IconCheck size={14} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Cancel">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="gray"
                    onClick={() => cancelEdit(material.id)}
                  >
                    <IconX size={14} />
                  </ActionIcon>
                </Tooltip>
              </>
            ) : (
              <>
                <Tooltip label="Edit">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="blue"
                    onClick={() => startEdit(material)}
                  >
                    <IconPencil size={14} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Duplicate">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="teal"
                    onClick={() => copyMaterial(material)}
                  >
                    <IconCopy size={14} />
                  </ActionIcon>
                </Tooltip>
                <Tooltip label="Delete">
                  <ActionIcon
                    size="sm"
                    variant="subtle"
                    color="red"
                    onClick={() => deleteMaterial(material.id)}
                  >
                    <IconTrash size={14} />
                  </ActionIcon>
                </Tooltip>
              </>
            )}
          </Group>
        </Table.Td>
      </Table.Tr>
    )
  }

  const renderCategoryTable = (category: MaterialCategory) => {
    const columns = CATEGORY_COLUMNS[category]
    const items = groupedByCategory[category]
    const itemIds = items.map((item) => item.id)
    const allSelectedInCategory =
      itemIds.length > 0 && itemIds.every((id) => selected.has(id))
    const someSelectedInCategory =
      !allSelectedInCategory && itemIds.some((id) => selected.has(id))

    return (
      <Box key={category}>
        <Group justify="space-between" mb="xs" mt="md">
          <Title order={4}>{CATEGORY_LABEL[category]}</Title>
          <Group gap="xs">
            {category !== "substrate_material" && (
              <Button
                variant="light"
                onClick={() => openPubChemImporter(category)}
                size="xs"
              >
                Import from PubChem
              </Button>
            )}
            <Button
              leftSection={<IconPlus size={16} />}
              onClick={() => addMaterial(category)}
              size="xs"
            >
              {CATEGORY_ADD_LABEL[category]}
            </Button>
          </Group>
        </Group>

        <ScrollArea>
          <Table
            striped
            highlightOnHover
            withTableBorder
            withColumnBorders
            stickyHeader
          >
            <Table.Thead>
              <Table.Tr>
                <Table.Th style={{ padding: 0, width: 6 }} />
                <Table.Th style={{ width: rem(36) }}>
                  <input
                    type="checkbox"
                    checked={allSelectedInCategory}
                    ref={(el) => {
                      if (el) {
                        el.indeterminate = someSelectedInCategory
                      }
                    }}
                    onChange={() => toggleSelectAllInCategory(itemIds)}
                    title={
                      allSelectedInCategory ? "Deselect all" : "Select all"
                    }
                  />
                </Table.Th>
                {columns.map((col) => (
                  <Table.Th key={`${category}-${col.key}`}>
                    <UnstyledButton
                      onClick={() => toggleSort(col.key)}
                      style={{
                        display: "flex",
                        alignItems: "center",
                        gap: rem(4),
                      }}
                    >
                      <Text fw={600} size="sm">
                        {col.label}
                      </Text>
                      <SortIcon
                        sorted={sort?.key === col.key}
                        direction={
                          sort?.key === col.key ? sort.direction : "asc"
                        }
                      />
                    </UnstyledButton>
                  </Table.Th>
                ))}
                <Table.Th style={{ width: rem(130) }} />
              </Table.Tr>
            </Table.Thead>
            <Table.Tbody>
              {items.length === 0 ? (
                <Table.Tr>
                  <Table.Td colSpan={columns.length + 3}>
                    <Text c="dimmed" ta="center" py="md">
                      No {CATEGORY_LABEL[category].toLowerCase()} in the
                      selected collection.
                    </Text>
                  </Table.Td>
                </Table.Tr>
              ) : (
                items.map((material) => renderMaterialRow(material, columns))
              )}
            </Table.Tbody>
          </Table>
        </ScrollArea>
      </Box>
    )
  }

  return (
    <Container fluid>
      <Group justify="space-between" mb="md" mt="md">
        <Title order={2}>Materials</Title>
        <Group>
          {selected.size > 0 && (
            <Button
              color="red"
              leftSection={<IconTrash size={16} />}
              variant="light"
              onClick={confirmDelete}
            >
              Delete ({selected.size})
            </Button>
          )}
        </Group>
      </Group>

      {renderCategoryTable("chemical_compound")}
      {renderCategoryTable("commercial_mixture")}
      {renderCategoryTable("substrate_material")}

      {materials.length > 0 && (
        <Box mt="xs">
          <Text size="xs" c="dimmed">
            {materials.length} material{materials.length > 1 ? "s" : ""}
          </Text>
        </Box>
      )}

      <SelectCollectionModal
        opened={collectionModalOpen}
        onClose={() => setCollectionModalOpen(false)}
        onConfirm={handleCollectionConfirmed}
        confirmLabel="Add Material"
      />

      <Modal
        opened={pubChemModalOpen}
        onClose={() => {
          setPubChemModalOpen(false)
          setPubChemUpdateField(null)
          setPubChemUpdateMaterialId(null)
        }}
        title={
          pubChemUpdateField
            ? `Search PubChem for ${pubChemUpdateField === "casNumber" ? "CAS Number" : "State at RT"}`
            : `Import ${CATEGORY_LABEL[pubChemCategory]} from PubChem`
        }
        size="lg"
      >
        <Stack gap="sm">
          <Group align="flex-end">
            <TextInput
              label="Search PubChem"
              placeholder="Name, IUPAC, formula..."
              value={pubChemQuery}
              onChange={(e) => setPubChemQuery(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  void searchPubChem()
                }
              }}
              style={{ flex: 1 }}
            />
            <Button
              onClick={() => void searchPubChem()}
              loading={pubChemLoading}
            >
              Search
            </Button>
          </Group>

          {pubChemError && (
            <Text size="sm" c="red">
              {pubChemError}
            </Text>
          )}

          {pubChemLoading ? (
            <Group justify="center" py="lg">
              <Loader size="sm" />
            </Group>
          ) : (
            <ScrollArea.Autosize mah={360}>
              <Stack gap="xs">
                {pubChemResults.map((result) => (
                  <Box
                    key={result.cid}
                    p="sm"
                    style={{
                      border: "1px solid var(--mantine-color-gray-3)",
                      borderRadius: rem(8),
                    }}
                  >
                    <Group
                      justify="space-between"
                      align="flex-start"
                      wrap="nowrap"
                    >
                      <Box style={{ minWidth: 0 }}>
                        <Text fw={600} size="sm" truncate>
                          {result.title}
                        </Text>
                        <Text size="xs" c="dimmed">
                          CID: {result.cid}
                        </Text>
                        {result.molecularFormula && (
                          <Text size="xs">
                            Formula: {result.molecularFormula}
                          </Text>
                        )}
                        {result.iupacName && (
                          <Text size="xs" c="dimmed" lineClamp={2}>
                            {result.iupacName}
                          </Text>
                        )}
                      </Box>
                      <Button
                        size="xs"
                        onClick={() =>
                          pubChemUpdateField
                            ? void applyFieldFromPubChem(result)
                            : void importPubChemResult(result)
                        }
                        loading={pubChemImportingCid === result.cid}
                      >
                        {pubChemUpdateField ? "Select" : "Import"}
                      </Button>
                    </Group>
                  </Box>
                ))}
              </Stack>
            </ScrollArea.Autosize>
          )}
        </Stack>
      </Modal>
    </Container>
  )
}
