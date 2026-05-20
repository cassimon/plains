import { createFileRoute, redirect } from "@tanstack/react-router"

export const Route = createFileRoute("/_layout/")({
  beforeLoad: async () => {
    console.log("[Layout Index] beforeLoad: redirecting to /organization")
    throw redirect({ to: "/organization" })
  },
})
