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
    if (initDone.current) {
      console.log("[Login] useEffect: initDone already true, skipping")
      return
    }
    initDone.current = true
    console.log("[Login] useEffect: Starting keycloak initialization")

    ;(async () => {
      try {
        console.log("[Login] Fetching auth config from backend")
        const res = await fetch(
          `${import.meta.env.VITE_API_URL}/api/v1/auth/config`,
        )
        if (!res.ok) {
          console.error("[Login] Auth config fetch failed:", res.status)
          setError("Auth configuration unavailable.")
          return
        }
        const cfg = await res.json()
        console.log("[Login] Auth config received")
        const keycloak = new Keycloak({
          url: cfg.keycloak_url,
          realm: cfg.keycloak_realm,
          clientId: cfg.keycloak_client_id,
        })
        // No onLoad — keycloak.init() exchanges a ?code= in the URL if present
        // (i.e. when Keycloak redirects back after login) but never redirects
        // the page on its own.
        console.log("[Login] Calling keycloak.init()")
        const authenticated = await keycloak.init({
          checkLoginIframe: false,
        })
        console.log("[Login] keycloak.init() completed, authenticated:", authenticated)
        setKeycloak(keycloak)
        console.log("[Login] Keycloak instance stored globally")
        if (authenticated) {
          console.log("[Login] User is authenticated, navigating to /")
          navigate({ to: "/" })
        } else {
          console.log("[Login] User is NOT authenticated, staying on login page")
        }
      } catch (err) {
        console.error("[Login] Keycloak init failed:", err)
        setError("Could not reach the NOMAD auth service.")
      }
    })()
  }, [navigate])

  const handleLogin = () => {
    console.log("[Login] handleLogin clicked")
    const kc = getKeycloak()
    console.log("[Login] Keycloak instance available:", !!kc)
    console.log("[Login] Already authenticated:", kc?.authenticated)
    setLoading(true)
    // Redirect to NOMAD Keycloak; after login Keycloak redirects back to /login
    // where keycloak.init() (on next mount) processes the auth code.
    console.log("[Login] Calling keycloak.login()")
    getKeycloak()?.login({ redirectUri: `${window.location.origin}/plains/login` })
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
