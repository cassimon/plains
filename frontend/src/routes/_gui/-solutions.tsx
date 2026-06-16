import { createFileRoute } from "@tanstack/react-router"
import { SolutionsPage } from "../Solutions.page"

export const Route = createFileRoute("/_gui/solutions")({
  component: SolutionsPage,
})
