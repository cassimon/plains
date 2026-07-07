import type { ColumnDef } from "@tanstack/react-table"

import type { NomadUploadLogPublic } from "@/client"
import { Badge } from "@/components/ui/badge"
import { cn } from "@/lib/utils"
import { NomadUploadArchiveButton } from "./NomadUploadArchiveButton"

function statusBadgeVariant(
  status: string | undefined,
): "default" | "secondary" | "destructive" | "outline" {
  switch ((status ?? "").toUpperCase()) {
    case "SUCCESS":
      return "default"
    case "FAILED":
    case "ERROR":
    case "NOT_FOUND":
      return "destructive"
    default:
      return "secondary" // PENDING and anything unknown
  }
}

function formatWhen(value: string | null | undefined): string {
  if (!value) return "—"
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleString()
}

export const nomadUploadColumns: ColumnDef<NomadUploadLogPublic>[] = [
  {
    accessorKey: "user_email",
    header: "User",
    cell: ({ row }) => (
      <span className="font-medium">{row.original.user_email}</span>
    ),
  },
  {
    accessorKey: "experiment_name",
    header: "Experiment",
    cell: ({ row }) => (
      <span className="text-muted-foreground">
        {row.original.experiment_name || "—"}
      </span>
    ),
  },
  {
    accessorKey: "status",
    header: "Status",
    cell: ({ row }) => {
      const status = row.original.status ?? "PENDING"
      return <Badge variant={statusBadgeVariant(status)}>{status}</Badge>
    },
  },
  {
    accessorKey: "created_at",
    header: "Uploaded",
    cell: ({ row }) => (
      <span className="text-muted-foreground whitespace-nowrap">
        {formatWhen(row.original.created_at)}
      </span>
    ),
  },
  {
    id: "detail",
    header: "Detail",
    cell: ({ row }) => {
      const { error_message, last_status_message } = row.original
      const text = error_message || last_status_message
      if (!text) return <span className="text-muted-foreground">—</span>
      return (
        <span
          className={cn(
            "block max-w-[28rem] truncate text-sm",
            row.original.error_message
              ? "text-red-600"
              : "text-muted-foreground",
          )}
          title={text}
        >
          {text}
        </span>
      )
    },
  },
  {
    id: "archive",
    header: () => <span className="sr-only">Archive</span>,
    cell: ({ row }) => {
      const log = row.original
      if (!log.archive_available) {
        return <span className="text-muted-foreground text-xs">—</span>
      }
      const base =
        (log.experiment_name || "upload").replace(/[^\w.-]+/g, "_") || "upload"
      return (
        <div className="flex justify-end">
          <NomadUploadArchiveButton
            logId={log.id}
            fileName={`${base}_${log.upload_id ?? log.id}.zip`}
          />
        </div>
      )
    },
  },
]
