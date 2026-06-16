import { createFileRoute } from "@tanstack/react-router"
import { MaterialsPage } from "../Materials.page"

export const Route = createFileRoute("/_gui/materials")({
  component: MaterialsPage,
})
