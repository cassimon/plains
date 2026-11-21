import { createFileRoute } from "@tanstack/react-router"
import { ImportPage } from "../Import.page"

export const Route = createFileRoute("/_gui/import")({
  component: ImportPage,
})
