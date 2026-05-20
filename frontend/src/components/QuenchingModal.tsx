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
import { IconX } from "@tabler/icons-react"
import { useEffect, useMemo, useState } from "react"
import { useAppContext, useEntityCollection } from "@/store/AppContext"

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
  kind: "material" | "solution"
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
}

interface AntisolventState {
  media: string
  flowRate: string
  depositionMethod: string
  height: string
  heightUnit: "mm" | "cm"
  pressure: string
  pressureUnit: "Pa" | "Psi"
}

interface VacuumState {
  height: string
  heightUnit: "mm" | "cm"
  baseArea: string
  baseAreaUnit: "cm2" | "m2"
  pumpModel: string
  deadVolume: string
  evacuationTime: string
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
  }
}

function defaultAntisolvent(): AntisolventState {
  return {
    media: "",
    flowRate: "",
    depositionMethod: "",
    height: "",
    heightUnit: "mm",
    pressure: "",
    pressureUnit: "Pa",
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
  }
}

function parseMediaReference(value: string): MediaReference | null {
  const trimmed = value.trim()
  if (!trimmed) return null
  const idx = trimmed.indexOf(":")
  if (idx === -1) return null
  const kind = trimmed.slice(0, idx)
  const id = trimmed.slice(idx + 1).trim()
  if (!id || (kind !== "material" && kind !== "solution")) return null
  return { kind, id }
}

function getMediaLabel(
  value: string,
  materials: Array<{ id: string; name: string }>,
  solutions: Array<{ id: string; name: string }>,
): string {
  const ref = parseMediaReference(value)
  if (!ref) return value
  if (ref.kind === "material") {
    return (
      materials.find((material) => material.id === ref.id)?.name ||
      "Unnamed material"
    )
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
  } else if (type === "Antisolvent") {
    if (antisolvent.media) parts.push(`media=${antisolvent.media}`)
    if (antisolvent.flowRate)
      parts.push(`flowRate=${antisolvent.flowRate} ul/s`)
    if (antisolvent.depositionMethod)
      parts.push(`depositionMethod=${antisolvent.depositionMethod}`)
    if (antisolvent.height)
      parts.push(`height=${antisolvent.height} ${antisolvent.heightUnit}`)
    if (antisolvent.pressure)
      parts.push(`pressure=${antisolvent.pressure} ${antisolvent.pressureUnit}`)
  } else if (type === "Vacuum") {
    if (vacuum.height)
      parts.push(`height=${vacuum.height} ${vacuum.heightUnit}`)
    if (vacuum.baseArea)
      parts.push(`baseArea=${vacuum.baseArea} ${vacuum.baseAreaUnit}`)
    if (vacuum.pumpModel) parts.push(`pumpModel=${vacuum.pumpModel}`)
    if (vacuum.deadVolume) parts.push(`deadVolume=${vacuum.deadVolume} m3`)
    if (vacuum.evacuationTime)
      parts.push(`evacuationTime=${vacuum.evacuationTime} s`)
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
    base.gas = gas
  } else if (type === "Antisolvent") {
    const anti = defaultAntisolvent()
    if (pairs.media) anti.media = pairs.media
    if (pairs.material) anti.media = pairs.material
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
    if (pairs.pressure) {
      const parts = pairs.pressure.split(" ")
      anti.pressure = parts[0] ?? ""
      anti.pressureUnit = (
        parts[1] === "Psi" ? "Psi" : "Pa"
      ) as AntisolventState["pressureUnit"]
    }
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
    base.vacuum = vac
  }

  return base
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
    </SimpleGrid>
  )
}

function AntisolventForm({
  state,
  onChange,
}: {
  state: AntisolventState
  onChange: (s: AntisolventState) => void
}) {
  const { materials, solutions } = useAppContext()
  const { isEntityOnActivePlane } = useEntityCollection()

  const mediaOptions = useMemo(
    () => [
      {
        group: "Materials",
        items: materials
          .filter((material) => isEntityOnActivePlane("material", material.id))
          .filter(
            (material) =>
              (material.category ?? "chemical_compound") !==
              "substrate_material",
          )
          .map((material) => {
            const label = material.name || "Unnamed material"
            return { value: `material:${material.id}`, label }
          }),
      },
      {
        group: "Solutions",
        items: solutions
          .filter((solution) => isEntityOnActivePlane("solution", solution.id))
          .map((solution) => {
            const label = solution.name || "Unnamed solution"
            return { value: `solution:${solution.id}`, label }
          }),
      },
    ],
    [isEntityOnActivePlane, materials, solutions],
  )

  function set(patch: Partial<AntisolventState>) {
    onChange({ ...state, ...patch })
  }

  return (
    <SimpleGrid cols={2} spacing="sm" verticalSpacing="sm">
      <Box style={{ gridColumn: "span 2" }}>
        <FieldLabel>Material / Solution</FieldLabel>
        <ModalSelect
          size="xs"
          data={mediaOptions}
          value={state.media || null}
          onChange={(v) => set({ media: v ?? "" })}
          placeholder="Select material or solution"
          searchable
          clearable
        />
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
              set({
                pressureUnit: (v ?? "Pa") as AntisolventState["pressureUnit"],
              })
            }
            style={{ width: 70 }}
          />
        </Group>
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
}

export function QuenchingModal({
  opened,
  initialValue,
  onClose,
  onApply,
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
          <AntisolventForm state={antisolvent} onChange={setAntisolvent} />
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
}

/** Render a compact human-readable summary of a quenching string. */
function summariseQuenchingValue(
  value: string,
  materials: Array<{ id: string; name: string }>,
  solutions: Array<{ id: string; name: string }>,
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
  } else if (type === "Antisolvent") {
    const media = pairs.media || pairs.material
    if (media) parts.push(getMediaLabel(media, materials, solutions))
    if (pairs.depositionMethod) parts.push(pairs.depositionMethod)
    if (pairs.flowRate) parts.push(`${pairs.flowRate}`)
    if (pairs.height) parts.push(`h=${pairs.height}`)
  } else if (type === "Vacuum") {
    if (pairs.height) parts.push(`h=${pairs.height}`)
    if (pairs.evacuationTime) parts.push(`t=${pairs.evacuationTime}`)
    if (pairs.pumpModel) parts.push(pairs.pumpModel)
  }

  return parts.join(" | ")
}

export function DryingMethodInput({
  label,
  param,
  onChange,
}: DryingMethodInputProps) {
  const [modalOpen, setModalOpen] = useState(false)
  const { materials, solutions } = useAppContext()

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
            >
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
            {summariseQuenchingValue(param?.value ?? "", materials, solutions)}
          </Text>
        </Button>
      </Box>

      <QuenchingModal
        opened={modalOpen}
        initialValue={param?.value}
        onClose={() => setModalOpen(false)}
        onApply={handleApply}
      />
    </>
  )
}
