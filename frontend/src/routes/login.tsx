import { createFileRoute, useNavigate } from "@tanstack/react-router"
import Keycloak from "keycloak-js"
import { useEffect, useRef, useState } from "react"

import { AuthLayout } from "@/components/Common/AuthLayout"
import { Button } from "@/components/ui/button"
import { redirectIfAuthenticated } from "@/lib/auth"
import { getKeycloak, setKeycloak } from "@/lib/keycloakInstance"

export const Route = createFileRoute("/login")({
  component: Login,
  beforeLoad: redirectIfAuthenticated,
  head: () => ({
    meta: [{ title: "Sign In" }],
  }),
})

function Login() {
  const navigate = useNavigate()
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // useRef survives React StrictMode's double-effect cycle (unlike the `active`
  // flag pattern). This ensures keycloak.init() runs exactly once per mount,
  // preventing the second run from discarding the auth-code after the first
  // run already exchanged and removed it from the URL.
  const initDone = useRef(false)

  useEffect(() => {
    if (initDone.current) return
    initDone.current = true

    ;(async () => {
      try {
        const res = await fetch(
          `${import.meta.env.VITE_API_URL}/api/v1/auth/config`,
        )
        if (!res.ok) {
          setError("Auth configuration unavailable.")
          return
        }
        const cfg = await res.json()
        const keycloak = new Keycloak({
          url: cfg.keycloak_url,
          realm: cfg.keycloak_realm,
          clientId: cfg.keycloak_client_id,
        })
        // No onLoad — keycloak.init() exchanges a ?code= in the URL if present
        // (i.e. when Keycloak redirects back after login) but never redirects
        // the page on its own.
        const authenticated = await keycloak.init({
          checkLoginIframe: false,
        })
        setKeycloak(keycloak)
        if (authenticated) navigate({ to: "/" })
      } catch (err) {
        console.error("Keycloak init failed:", err)
        setError("Could not reach the NOMAD auth service.")
      }
    })()
  }, [navigate])

  const handleLogin = () => {
    setLoading(true)
    // Redirect to NOMAD Keycloak; after login Keycloak redirects back to /login
    // where keycloak.init() (on next mount) processes the auth code.
    getKeycloak()?.login({ redirectUri: `${window.location.origin}/login` })
  }

  return (
    <AuthLayout>
      <div className="flex flex-col items-center gap-6 text-center">
        <h1 className="text-2xl font-bold">Sign in to Plains</h1>
        <p className="text-sm text-muted-foreground">
          Use your NOMAD account to continue.
        </p>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Button onClick={handleLogin} disabled={loading} className="w-full">
          {loading ? "Redirecting…" : "Login with NOMAD"}
        </Button>
      </div>
    </AuthLayout>
  )
}
