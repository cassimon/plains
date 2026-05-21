import {
  PROCESS_PARAMETER_DEFINITIONS,
  type Process,
  type ProcessStep,
} from "@/store/AppContext"
import { summariseQuenchingValue } from "@/components/QuenchingModal"

type NamedEntity = { id: string; name: string }

type ProcessExportInput = {
  process: Process
  materials: NamedEntity[]
  solutions: NamedEntity[]
}

const STEP_CATEGORY_LABELS: Record<string, string> = {
  wet_deposition: "Wet Deposition",
  dry_deposition: "Dry Deposition",
  surface_treatment: "Surface Treatment",
  doping_aging: "Doping / Aging",
  substrate_preparation: "Substrate Preparation",
}

function sanitizeFileBaseName(rawName: string): string {
  const fallback = "process-summary"
  const raw = rawName.trim().toLowerCase()
  const sanitized = raw.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
  return sanitized || fallback
}

function getParamLines(
  step: ProcessStep,
  materials: NamedEntity[],
  solutions: NamedEntity[],
): string[] {
  return PROCESS_PARAMETER_DEFINITIONS.flatMap(({ key, label, unit }) => {
    if (key === "depositionStartTime" || key === "annealingStartTime") {
      return []
    }
    const value = step[key]?.value?.trim()
    if (!value) {
      return []
    }
    // Format quenching parameters in human-readable form
    if (key === "dryingMethod") {
      const summary = summariseQuenchingValue(value, materials, solutions)
      return [
        summary
          ? summary
              .replace(/^D\/Q:\s*/, "Drying/Quenching: ")
              .replace(/\s*\|\s*/g, ", ")
          : `${label}: ${value}`,
      ]
    }
    return [`${label}: ${value}${unit ? ` ${unit}` : ""}`]
  })
}

function getStepSourceLabel(
  step: ProcessStep,
  materialNameById: Map<string, string>,
  solutionNameById: Map<string, string>,
): string {
  if (step.materialId) {
    return materialNameById.get(step.materialId) || "Unknown material"
  }
  if (step.solutionId) {
    return solutionNameById.get(step.solutionId) || "Unknown solution"
  }
  return "No material"
}

export function buildProcessProtocolText({
  process,
  materials,
  solutions,
}: ProcessExportInput): string {
  const materialNameById = new Map(materials.map((m) => [m.id, m.name]))
  const solutionNameById = new Map(solutions.map((s) => [s.id, s.name]))

  const lines: string[] = []
  lines.push("Process Summary Protocol")
  lines.push("")
  lines.push("1. Process Metadata")
  lines.push(`Name: ${process.name || "Untitled Process"}`)
  lines.push(
    `Description: ${process.description?.trim() || "No description provided."}`,
  )
  lines.push(`Number of Stages: ${process.stages.length}`)
  lines.push("")
  lines.push("2. Process Stages")

  if (process.stages.length === 0) {
    lines.push("No stages defined yet.")
    return lines.join("\n")
  }

  process.stages.forEach((stage, stageIdx) => {
    lines.push(`Step ${stageIdx + 1}`)

    if (stage.alternatives.length > 1) {
      lines.push("Alternative processing routes:")
    }

    stage.alternatives.forEach((step, altIdx) => {
      const heading =
        stage.alternatives.length > 1 ? `Alternative ${altIdx + 1}:` : "Route:"
      lines.push(heading)
      lines.push(
        `- Name: ${step.depositionMethod?.value?.trim() || step.name || "Unnamed step"}`,
      )
      lines.push(
        `- Category: ${STEP_CATEGORY_LABELS[step.stepCategory] || step.stepCategory}`,
      )
      lines.push(
        `- Material: ${getStepSourceLabel(step, materialNameById, solutionNameById)}`,
      )

      const params = getParamLines(step, materials, solutions)
      if (params.length > 0) {
        lines.push("- Parameters:")
        params.forEach((param) => {
          lines.push(`  - ${param}`)
        })
      } else {
        lines.push("- Parameters: No parameters set")
      }

      if (step.notes?.trim()) {
        lines.push(`- Notes: ${step.notes.trim()}`)
      }
      lines.push("")
    })
  })

  return lines.join("\n")
}

function triggerDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement("a")
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export async function exportProcessProtocolAsPdf(
  input: ProcessExportInput,
): Promise<void> {
  const protocolText = buildProcessProtocolText(input)
  const { jsPDF } = await import("jspdf")
  const doc = new jsPDF({ unit: "pt", format: "a4" })

  const margin = 42
  const lineHeight = 14
  const pageWidth = doc.internal.pageSize.getWidth()
  const pageHeight = doc.internal.pageSize.getHeight()
  const maxTextWidth = pageWidth - margin * 2
  const lines = doc.splitTextToSize(protocolText, maxTextWidth)

  doc.setFont("helvetica", "normal")
  doc.setFontSize(11)

  let y = margin
  lines.forEach((line: string) => {
    if (y > pageHeight - margin) {
      doc.addPage()
      y = margin
    }
    doc.text(line, margin, y)
    y += lineHeight
  })

  const fileBaseName = sanitizeFileBaseName(
    input.process.name || "process-summary",
  )
  doc.save(`${fileBaseName}.pdf`)
}

export async function exportProcessProtocolAsDocx(
  input: ProcessExportInput,
): Promise<void> {
  const docx = await import("docx")
  const materialNameById = new Map(input.materials.map((m) => [m.id, m.name]))
  const solutionNameById = new Map(input.solutions.map((s) => [s.id, s.name]))
  const children: any[] = []

  children.push(
    new docx.Paragraph({
      text: "Process Summary Protocol",
      heading: docx.HeadingLevel.TITLE,
    }),
  )

  children.push(
    new docx.Paragraph({
      text: "1. Process Metadata",
      heading: docx.HeadingLevel.HEADING_2,
    }),
  )
  children.push(
    new docx.Paragraph({
      children: [
        new docx.TextRun({ text: "Name: ", bold: true }),
        new docx.TextRun(input.process.name || "Untitled Process"),
      ],
    }),
  )
  children.push(
    new docx.Paragraph({
      children: [
        new docx.TextRun({ text: "Description: ", bold: true }),
        new docx.TextRun(
          input.process.description?.trim() || "No description provided.",
        ),
      ],
    }),
  )
  children.push(
    new docx.Paragraph({
      children: [
        new docx.TextRun({ text: "Number of Stages: ", bold: true }),
        new docx.TextRun(String(input.process.stages.length)),
      ],
    }),
  )

  children.push(
    new docx.Paragraph({
      text: "2. Process Stages",
      heading: docx.HeadingLevel.HEADING_2,
    }),
  )

  if (input.process.stages.length === 0) {
    children.push(new docx.Paragraph({ text: "No stages defined yet." }))
  } else {
    input.process.stages.forEach((stage, stageIdx) => {
      children.push(
        new docx.Paragraph({
          text: `Step ${stageIdx + 1}`,
          heading: docx.HeadingLevel.HEADING_3,
        }),
      )

      if (stage.alternatives.length > 1) {
        children.push(
          new docx.Paragraph({ text: "Alternative processing routes:" }),
        )
      }

      stage.alternatives.forEach((step, altIdx) => {
        const heading =
          stage.alternatives.length > 1
            ? `Alternative ${altIdx + 1}:`
            : "Route:"

        children.push(
          new docx.Paragraph({
            text: heading,
            heading: docx.HeadingLevel.HEADING_4,
          }),
        )

        children.push(
          new docx.Paragraph({
            text: `Name: ${step.depositionMethod?.value?.trim() || step.name || "Unnamed step"}`,
          }),
        )
        children.push(
          new docx.Paragraph({
            text: `Category: ${STEP_CATEGORY_LABELS[step.stepCategory] || step.stepCategory}`,
          }),
        )
        children.push(
          new docx.Paragraph({
            text: `Material: ${getStepSourceLabel(step, materialNameById, solutionNameById)}`,
          }),
        )

        const params = getParamLines(step, input.materials, input.solutions)
        if (params.length > 0) {
          children.push(new docx.Paragraph({ text: "Parameters:" }))
          params.forEach((param) => {
            children.push(new docx.Paragraph({ text: `- ${param}` }))
          })
        } else {
          children.push(
            new docx.Paragraph({ text: "Parameters: No parameters set" }),
          )
        }

        if (step.notes?.trim()) {
          children.push(
            new docx.Paragraph({ text: `Notes: ${step.notes.trim()}` }),
          )
        }
        children.push(new docx.Paragraph({ text: "" }))
      })
    })
  }

  const document = new docx.Document({ sections: [{ children }] })
  const blob = await docx.Packer.toBlob(document)
  const fileBaseName = sanitizeFileBaseName(
    input.process.name || "process-summary",
  )
  triggerDownload(blob, `${fileBaseName}.docx`)
}
