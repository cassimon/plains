import { createFileRoute, redirect } from "@tanstack/react-router"

// User registration is handled by NOMAD — this route is no longer active.
export const Route = createFileRoute("/signup")({
  component: () => null,
  beforeLoad: () => {
    throw redirect({ to: "/login" })
  },
})
