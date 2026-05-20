import { createFileRoute, redirect } from "@tanstack/react-router"

// The PKCE callback is no longer used — keycloak-js handles the auth-code
// exchange internally.  Redirect back to / so the app can re-initialise.
export const Route = createFileRoute("/auth/nomad/callback")({
  component: () => null,
  beforeLoad: () => {
    throw redirect({ to: "/" })
  },
})
