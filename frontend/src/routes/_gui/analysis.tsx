import { createFileRoute } from "@tanstack/react-router"
import { AnalysisPage } from "../Analysis.page"

export const Route = createFileRoute("/_gui/analysis")({
  component: AnalysisPage,
  validateSearch: (search: Record<string, unknown>) => ({
    experimentId:
      typeof search.experimentId === "string" ? search.experimentId : undefined,
  }),
})
