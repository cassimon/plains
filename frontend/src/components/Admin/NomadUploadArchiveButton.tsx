import { notifications } from "@mantine/notifications"
import { Download } from "lucide-react"
import { useState } from "react"

import { OpenAPI } from "@/client"
import { Button } from "@/components/ui/button"

/**
 * Downloads a stashed failed-upload archive. The endpoint is superuser-only, so
 * the request must carry the auth token — a plain <a href> can't. We fetch the
 * zip as a blob with the bearer header (same pattern as Results.page.tsx) and
 * trigger a client-side download.
 */
export function NomadUploadArchiveButton({
  logId,
  fileName,
}: {
  logId: string
  fileName: string
}) {
  const [downloading, setDownloading] = useState(false)

  const handleDownload = async () => {
    setDownloading(true)
    try {
      const token =
        typeof OpenAPI.TOKEN === "function"
          ? await OpenAPI.TOKEN({} as never)
          : (OpenAPI.TOKEN ?? undefined)

      const res = await fetch(
        `${OpenAPI.BASE}/api/v1/nomad/upload-log/${logId}/archive`,
        { headers: token ? { Authorization: `Bearer ${token}` } : undefined },
      )
      if (!res.ok) {
        throw new Error(
          res.status === 404
            ? "Archive no longer available (upload succeeded or expired)"
            : `Download failed (${res.status})`,
        )
      }
      const blob = await res.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement("a")
      a.href = url
      a.download = fileName
      document.body.appendChild(a)
      a.click()
      a.remove()
      URL.revokeObjectURL(url)
    } catch (err) {
      notifications.show({
        color: "red",
        title: "Could not download archive",
        message: err instanceof Error ? err.message : String(err),
      })
    } finally {
      setDownloading(false)
    }
  }

  return (
    <Button
      variant="outline"
      size="sm"
      onClick={handleDownload}
      disabled={downloading}
    >
      <Download className="mr-1 size-3.5" />
      {downloading ? "…" : "Archive"}
    </Button>
  )
}
