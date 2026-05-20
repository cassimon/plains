import { createFileRoute, redirect } from "@tanstack/react-router"

// Password reset is not available — login is via NOMAD Keycloak.
export const Route = createFileRoute("/reset-password")({
  component: () => null,
  beforeLoad: () => {
    throw redirect({ to: "/login" })
  },
})
