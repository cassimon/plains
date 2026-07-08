import { createFileRoute } from "@tanstack/react-router"
import { TrashPage } from "../Trash.page"

export const Route = createFileRoute("/_gui/trash")({
  component: TrashPage,
})
