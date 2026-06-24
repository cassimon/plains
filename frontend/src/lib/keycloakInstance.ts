/**
 * Module-level Keycloak singleton.
 *
 * All authentication state lives here in memory — nothing is written to
 * localStorage or sessionStorage.  The Keycloak JS adapter manages the
 * access/refresh tokens internally; we only expose typed accessors.
 */

import type Keycloak from "keycloak-js"

let _keycloak: Keycloak | null = null

/** Returns the current Keycloak instance, or null when not initialised. */
export function getKeycloak(): Keycloak | null {
  return _keycloak
}

/** Store the initialised Keycloak instance and register the token-expiry handler. */
export function setKeycloak(kc: Keycloak): void {
  console.log("[Keycloak] setKeycloak called, authenticated:", kc.authenticated)
  _keycloak = kc

  // Keycloak-js fires onTokenExpired at the exact moment the access token expires.
  // We refresh here so that the next API call never receives a stale token.
  kc.onTokenExpired = () => {
    console.log("[Keycloak] Token expired, refreshing")
    kc.updateToken(30).catch(() => {
      console.error(
        "[Keycloak] Token refresh failed, clearing and redirecting to login",
      )
      clearKeycloak()
      window.location.href = `${import.meta.env.BASE_URL}login`
    })
  }
}

/** Clear the instance and remove the expiry handler. */
export function clearKeycloak(): void {
  console.log("[Keycloak] clearKeycloak called")
  if (_keycloak) {
    _keycloak.onTokenExpired = undefined
  }
  _keycloak = null
}

/** Synchronous token read — returns null when no session is active. */
export function getTokenSync(): string | null {
  if (_keycloak?.authenticated && _keycloak.token) return _keycloak.token
  return null
}

/**
 * Async token read — silently refreshes the token first so the caller always
 * gets a valid, non-expired value.  Used by the OpenAPI client interceptor.
 */
export async function getTokenAsync(): Promise<string> {
  console.log(
    "[Keycloak] getTokenAsync called, authenticated:",
    _keycloak?.authenticated,
  )
  if (_keycloak?.authenticated) {
    try {
      await _keycloak.updateToken(30)
      console.log("[Keycloak] Token refreshed/validated, returning token")
    } catch {
      console.error("[Keycloak] Token update failed in getTokenAsync, clearing")
      clearKeycloak()
      window.location.href = `${import.meta.env.BASE_URL}login`
      return ""
    }
    return _keycloak.token ?? ""
  }
  console.log("[Keycloak] Not authenticated, returning empty token")
  return ""
}

/** True when a Keycloak session is active. */
export function isAuthenticated(): boolean {
  const result = _keycloak?.authenticated === true
  console.log("[Keycloak] isAuthenticated() called, result:", result)
  return result
}

/**
 * Test-only auth bypass for integration tests.
 *
 * Active when running a Vite dev build, OR when the build was produced with
 * VITE_ENABLE_TEST_AUTH=true (the integration test image — never the real
 * production image). It lets Playwright authenticate with a genuine
 * backend-issued JWT instead of redirecting through the real NOMAD/Keycloak
 * server, which isn't available in CI.
 *
 * Playwright seeds the token into localStorage (key `__plains_test_token`)
 * before the app boots; we read it here at module load and install a minimal
 * Keycloak-shaped object so isAuthenticated()/getTokenSync() behave as if a
 * real session were active.
 */
const TEST_AUTH_ENABLED =
  import.meta.env.DEV || import.meta.env.VITE_ENABLE_TEST_AUTH === "true"
const TEST_TOKEN_KEY = "__plains_test_token"

function installTestKeycloak(token: string): void {
  const fakeKeycloak = {
    authenticated: true,
    token,
    // The app calls updateToken() before each request; the seeded JWT is
    // already valid for the lifetime of a test run, so this is a no-op.
    updateToken: () => Promise.resolve(false),
    login: () => {},
    logout: () => {
      try {
        window.localStorage.removeItem(TEST_TOKEN_KEY)
      } catch {
        // ignore
      }
      window.location.href = `${import.meta.env.BASE_URL}login`
    },
  } as unknown as Keycloak
  setKeycloak(fakeKeycloak)
}

if (TEST_AUTH_ENABLED) {
  // Expose the raw setter (used by some dev tooling) ...
  ;(window as unknown as Record<string, unknown>).__plains_setKeycloak =
    setKeycloak
  // ... and auto-install a session from the Playwright-seeded token.
  try {
    const seeded = window.localStorage.getItem(TEST_TOKEN_KEY)
    if (seeded) installTestKeycloak(seeded)
  } catch {
    // localStorage may be unavailable; ignore in that case.
  }
}

/**
 * Logout: invalidates the Keycloak server-side session and redirects to /login.
 * Because Keycloak issues a full-page redirect, no further navigation is needed.
 */
export function logout(): void {
  const kc = _keycloak
  clearKeycloak()
  if (kc?.authenticated) {
    kc.logout({
      redirectUri: `${window.location.origin}${import.meta.env.BASE_URL}login`,
    })
  } else {
    window.location.href = `${import.meta.env.BASE_URL}login`
  }
}
