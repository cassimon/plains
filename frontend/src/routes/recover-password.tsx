import { createFileRoute, redirect } from "@tanstack/react-router"

// Password recovery is not available — login is via NOMAD Keycloak.
export const Route = createFileRoute("/recover-password")({
  component: () => null,
  beforeLoad: () => {
    throw redirect({ to: "/login" })
  },
})
