// ─────────────────────────────────────────────────────────────────────────────
// PdfDigestView — the "different view" shown inside UploadFlowPanel when an
// exported Process/Experiment PDF was dropped. While digest docs are pending it
// REPLACES the Process/Experiment target picker (the selection is blocked), and
// resolves each doc into a selected — or newly created — app entity following the
// digestion rules:
//
//   1. Exists for this user (own / shared plane)?  → select it.
//      Not found?                                   → inform + copy with new ids.
//   2. Any PDF value differs from the app's value?  → ask: overwrite the app's
//      values (only the differing, parseable ones) OR create a new object.
//      Values that cannot be parsed are reported and left at their old value.
//
// See lib/pdfDigest.ts (primitives) and lib/pdfImport.ts (`importPdf`).
// ─────────────────────────────────────────────────────────────────────────────

import {
  Alert,
  Badge,
  Button,
  Divider,
  Group,
  Radio,
  Stack,
  Text,
} from "@mantine/core"
import { notifications } from "@mantine/notifications"
import {
  IconAlertTriangle,
  IconCopyPlus,
  IconFileText,
  IconTransferIn,
} from "@tabler/icons-react"
import { useMemo, useState } from "react"
import { useRevealForFlow } from "@/lib/entityReveal"
import {
  applyEditsToEntities,
  copyExperimentWithNewIds,
  copyProcessWithNewIds,
  type DigestDoc,
  findEntityById,
} from "@/lib/pdfDigest"
import type { FieldError } from "@/lib/pdfImport"
import type { FieldPath } from "@/lib/pdfSchema"
import { useAppContext } from "@/store/AppContext"

/** Human label for a decoded field path, for the differences list. */
function describeFieldPath(path: FieldPath): string {
  switch (path.kind) {
    case "processName":
      return "Process name"
    case "processDescription":
      return "Process description"
    case "recipeTotalSolvent":
      return "Recipe · total solvent volume"
    case "recipeCommercialName":
      return "Recipe · commercial name"
    case "recipeSupplierNumber":
      return "Recipe · supplier number"
    case "solventVolume":
      return "Recipe · solvent volume"
    case "soluteAmount":
      return "Recipe · solute amount"
    case "soluteUnit":
      return "Recipe · solute unit"
    case "stepParam":
      return `Step parameter · ${path.paramKey}`
    case "stepNotes":
      return "Step notes"
    case "substrateLength":
      return "Substrate · length"
    case "substrateWidth":
      return "Substrate · width"
    case "substrateHeight":
      return "Substrate · height"
    case "substrateRoughness":
      return "Substrate · roughness"
    case "stackPixelArea":
      return "Device stack · pixel area"
    case "stackNumPixels":
      return "Device stack · pixel count"
    case "stackLayerThickness":
      return "Layer · thickness"
    case "stackLayerBandgap":
      return "Layer · band gap"
    case "experimentDate":
      return "Experiment · start date"
    case "experimentEndDate":
      return "Experiment · end date"
    case "experimentDescription":
      return "Experiment · description"
  }
}

function reportUnparseable(errors: FieldError[]) {
  if (errors.length === 0) {
    return
  }
  notifications.show({
    title: `${errors.length} value${errors.length === 1 ? "" : "s"} could not be parsed`,
    message: errors
      .map((e) => `${describeFieldPath(e.path)}: ${e.reason}`)
      .join("; ")
      .concat(" — left at the previous value."),
    color: "yellow",
    autoClose: 8000,
  })
}

export function PdfDigestView() {
  const {
    uploadFlow,
    updateUploadFlow,
    processes,
    experiments,
    setProcesses,
    setExperiments,
    setActiveEntity,
    updateLastSelected,
  } = useAppContext()
  const revealForFlow = useRevealForFlow()

  const allDigests = uploadFlow?.pendingDigests ?? []
  const [activeDocId, setActiveDocId] = useState<string | null>(null)
  // "overwrite" | "new" chosen in the differences prompt.
  const [resolution, setResolution] = useState<"overwrite" | "new">("overwrite")

  // Rule 4: when a process is already selected in the flow, only offer the
  // documents whose (own or derived-from) process matches that selection —
  // mismatched experiments are ignored. Fall back to the full set when nothing
  // matches, so the view is never left empty.
  const selectedProcessId = uploadFlow?.processId ?? null
  const digests = useMemo(() => {
    if (!selectedProcessId) {
      return allDigests
    }
    const matching = allDigests.filter(
      (d) => d.result.original.process.id === selectedProcessId,
    )
    return matching.length > 0 ? matching : allDigests
  }, [allDigests, selectedProcessId])

  const activeDoc: DigestDoc | undefined = useMemo(() => {
    if (digests.length === 0) {
      return undefined
    }
    return digests.find((d) => d.id === activeDocId) ?? digests[0]
  }, [digests, activeDocId])

  if (!uploadFlow || !activeDoc) {
    return null
  }

  const { result } = activeDoc
  const isExperiment = result.kind === "experiment"
  const payloadProcess = result.original.process
  const payloadExperiment = result.original.experiment
  const displayName =
    (isExperiment ? payloadExperiment?.name : payloadProcess.name) ||
    (isExperiment ? "Untitled experiment" : "Untitled process")

  // Ownership check: is the entity (and, for an experiment, its process) already
  // loaded for this user? The frontend only ever holds the user's own + shared
  // entities, so "present" == "assigned to me / shared".
  const appProcess = findEntityById(processes, payloadProcess.id)
  const appExperiment =
    isExperiment && payloadExperiment
      ? findEntityById(experiments, payloadExperiment.id)
      : undefined
  const exists = isExperiment
    ? Boolean(appExperiment && appProcess)
    : Boolean(appProcess)

  const hasDifferences = result.edits.length > 0 || result.errors.length > 0

  // Following a reference out of the flow keeps the selected entity visible in the
  // left bar without discarding the plane context: stay in its collection when
  // we're already there, else drop to the plane's General view (never the
  // cross-plane General view). See `computeRevealView`.
  const selectForFlow = (processId: string, experimentId: string | null) => {
    if (experimentId) {
      revealForFlow("experiment", experimentId)
      updateUploadFlow({ processId, experimentId })
      setActiveEntity({ kind: "experiment", id: experimentId })
      updateLastSelected("experiment", experimentId)
    } else {
      revealForFlow("process", processId)
      updateUploadFlow({ processId, experimentId })
      setActiveEntity({ kind: "process", id: processId })
      updateLastSelected("process", processId)
    }
  }

  const removeActiveDoc = () => {
    // Filter the FULL pending list (not the rule-4-filtered view) so docs hidden
    // by the current-selection filter aren't silently dropped.
    updateUploadFlow({
      pendingDigests: allDigests.filter((d) => d.id !== activeDoc.id),
    })
    setActiveDocId(null)
    setResolution("overwrite")
  }

  // ── Create a fresh copy (new top-level ids) from the PDF's current values ────
  // `forkProcess` forces the process to be copied even when the user already owns
  // it: used by the "differences → create new" path so the new object is fully
  // independent and captures any PROCESS-level edits from the PDF. When false
  // (the not-found path), an already-owned process is reused as the link target.
  const createCopyAndSelect = (forkProcess: boolean) => {
    if (isExperiment) {
      if (!result.edited.experiment) {
        return
      }
      const reuseProcess = appProcess && !forkProcess
      const linkedProcess = reuseProcess
        ? undefined
        : copyProcessWithNewIds(result.edited.process)
      const linkedProcessId = reuseProcess ? appProcess.id : linkedProcess?.id
      if (!linkedProcessId) {
        return
      }
      if (linkedProcess) {
        setProcesses((prev) => [...prev, linkedProcess])
      }
      const newExp = copyExperimentWithNewIds(
        result.edited.experiment,
        linkedProcessId,
      )
      setExperiments((prev) => [...prev, newExp])
      selectForFlow(linkedProcessId, newExp.id)
    } else {
      const newProc = copyProcessWithNewIds(result.edited.process)
      setProcesses((prev) => [...prev, newProc])
      selectForFlow(newProc.id, null)
    }
    reportUnparseable(result.errors)
    notifications.show({
      title: "Copy created",
      message: `A copy of “${displayName}” was created in your workspace and selected.`,
      color: "blue",
    })
    removeActiveDoc()
  }

  // ── Select the existing entity as-is ─────────────────────────────────────────
  const selectExisting = () => {
    if (isExperiment) {
      if (!appExperiment || !appProcess) {
        return
      }
      selectForFlow(appProcess.id, appExperiment.id)
    } else if (appProcess) {
      selectForFlow(appProcess.id, null)
    }
    removeActiveDoc()
  }

  // ── Overwrite the existing entity with the differing, parseable values ───────
  const overwriteExisting = () => {
    if (isExperiment) {
      if (!appExperiment || !appProcess) {
        return
      }
      const patched = applyEditsToEntities(
        appProcess,
        appExperiment,
        result.edits,
      )
      setProcesses((prev) =>
        prev.map((p) => (p.id === patched.process.id ? patched.process : p)),
      )
      if (patched.experiment) {
        setExperiments((prev) =>
          prev.map((e) =>
            e.id === patched.experiment?.id ? patched.experiment : e,
          ),
        )
      }
      selectForFlow(appProcess.id, appExperiment.id)
    } else {
      if (!appProcess) {
        return
      }
      const patched = applyEditsToEntities(appProcess, undefined, result.edits)
      setProcesses((prev) =>
        prev.map((p) => (p.id === patched.process.id ? patched.process : p)),
      )
      selectForFlow(appProcess.id, null)
    }
    reportUnparseable(result.errors)
    notifications.show({
      title: "Values updated",
      message: `Applied ${result.edits.length} change${
        result.edits.length === 1 ? "" : "s"
      } from the PDF to “${displayName}”.`,
      color: "green",
    })
    removeActiveDoc()
  }

  const applyDifferencesChoice = () => {
    if (resolution === "overwrite") {
      overwriteExisting()
    } else {
      // Independent new object → fork the process too, so process-level PDF edits
      // aren't lost and the user's existing entities are left untouched.
      createCopyAndSelect(true)
    }
  }

  return (
    <Stack gap="sm">
      {/* Multi-doc selection: when several PDFs were dropped, choose between them. */}
      {digests.length > 1 && (
        <Stack gap={4}>
          <Text size="xs" fw={600} c="dimmed" tt="uppercase">
            {digests.length} documents to digest
          </Text>
          <Stack gap={4}>
            {digests.map((doc) => {
              const active = doc.id === activeDoc.id
              return (
                <Group
                  key={doc.id}
                  gap="xs"
                  wrap="nowrap"
                  onClick={() => setActiveDocId(doc.id)}
                  style={{
                    cursor: "pointer",
                    padding: "4px 8px",
                    borderRadius: 6,
                    background: active
                      ? "var(--mantine-color-blue-light)"
                      : undefined,
                  }}
                >
                  <IconFileText size={14} />
                  <Text size="sm" fw={active ? 600 : 400} lineClamp={1}>
                    {doc.fileName}
                  </Text>
                </Group>
              )
            })}
          </Stack>
          <Divider />
        </Stack>
      )}

      <Group gap="xs" wrap="nowrap">
        <IconFileText size={18} />
        <Stack gap={0}>
          <Text fw={700} size="sm">
            Digest {isExperiment ? "experiment" : "process"}
          </Text>
          <Text size="xs" c="dimmed" lineClamp={1}>
            {displayName}
          </Text>
        </Stack>
      </Group>

      {/* ── Not found → copy ─────────────────────────────────────────────────── */}
      {!exists && (
        <>
          <Alert
            variant="light"
            color="blue"
            icon={<IconCopyPlus size={16} />}
            p="xs"
          >
            <Text size="sm">
              This {isExperiment ? "experiment" : "process"} isn’t in your
              workspace{" "}
              {isExperiment && !appProcess ? "(neither is its process)" : ""}. A
              copy with fresh identifiers will be created and selected.
            </Text>
          </Alert>
          {result.errors.length > 0 && (
            <UnparseableList errors={result.errors} />
          )}
          <Button
            size="xs"
            leftSection={<IconCopyPlus size={14} />}
            onClick={() => createCopyAndSelect(false)}
          >
            Create copy &amp; select
          </Button>
        </>
      )}

      {/* ── Found, identical → select ────────────────────────────────────────── */}
      {exists && !hasDifferences && (
        <>
          <Alert variant="light" color="teal" p="xs">
            <Text size="sm">
              Matches your existing “{displayName}”. It will be selected as the
              upload target.
            </Text>
          </Alert>
          <Button
            size="xs"
            leftSection={<IconTransferIn size={14} />}
            onClick={selectExisting}
          >
            Use existing &amp; select
          </Button>
        </>
      )}

      {/* ── Found, values differ → overwrite vs new ──────────────────────────── */}
      {exists && hasDifferences && (
        <>
          <Alert
            variant="light"
            color="orange"
            icon={<IconAlertTriangle size={16} />}
            p="xs"
          >
            <Text size="sm">
              The PDF differs from your existing “{displayName}”.
            </Text>
          </Alert>

          {result.edits.length > 0 && (
            <Stack gap={2}>
              <Text size="xs" fw={600} c="dimmed" tt="uppercase">
                Changed values ({result.edits.length})
              </Text>
              {result.edits.map((edit) => (
                <Group key={edit.name} gap={6} wrap="nowrap">
                  <Text size="xs" fw={500} style={{ minWidth: 140 }}>
                    {describeFieldPath(edit.path)}
                  </Text>
                  <Text size="xs" c="dimmed" td="line-through" lineClamp={1}>
                    {edit.oldValue || "—"}
                  </Text>
                  <Text size="xs">→</Text>
                  <Text size="xs" fw={600} lineClamp={1}>
                    {edit.newValue || "—"}
                  </Text>
                </Group>
              ))}
            </Stack>
          )}

          {result.errors.length > 0 && (
            <UnparseableList errors={result.errors} />
          )}

          <Radio.Group
            value={resolution}
            onChange={(v) => setResolution(v as "overwrite" | "new")}
          >
            <Stack gap={6} mt={4}>
              <Radio
                size="xs"
                value="overwrite"
                label="Overwrite the values in the app (only the parseable changes above)"
              />
              <Radio
                size="xs"
                value="new"
                label="Create a new object from the PDF instead"
              />
            </Stack>
          </Radio.Group>

          <Button size="xs" onClick={applyDifferencesChoice}>
            {resolution === "overwrite"
              ? "Overwrite & select"
              : "Create new & select"}
          </Button>
        </>
      )}
    </Stack>
  )
}

function UnparseableList({ errors }: { errors: FieldError[] }) {
  return (
    <Stack gap={2}>
      <Group gap={6}>
        <Badge size="xs" color="yellow" variant="light">
          {errors.length} unparseable
        </Badge>
      </Group>
      {errors.map((err) => (
        <Text key={err.name} size="xs" c="dimmed" lineClamp={1}>
          {describeFieldPath(err.path)}: “{err.value}” — {err.reason}
        </Text>
      ))}
    </Stack>
  )
}
