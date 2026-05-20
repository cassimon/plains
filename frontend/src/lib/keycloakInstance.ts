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
  _keycloak = kc

  // Keycloak-js fires onTokenExpired at the exact moment the access token expires.
  // We refresh here so that the next API call never receives a stale token.
  kc.onTokenExpired = () => {
    kc.updateToken(30).catch(() => {
      clearKeycloak()
      window.location.href = "/login"
    })
  }
}

/** Clear the instance and remove the expiry handler. */
export function clearKeycloak(): void {
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
  if (_keycloak?.authenticated) {
    try {
      await _keycloak.updateToken(30)
    } catch {
      clearKeycloak()
      window.location.href = "/login"
      return ""
    }
    return _keycloak.token ?? ""
  }
  return ""
}

/** True when a Keycloak session is active. */
export function isAuthenticated(): boolean {
  return _keycloak?.authenticated === true
}

/**
 * Logout: invalidates the Keycloak server-side session and redirects to /login.
 * Because Keycloak issues a full-page redirect, no further navigation is needed.
 */
export function logout(): void {
  const kc = _keycloak
  clearKeycloak()
  if (kc?.authenticated) {
    kc.logout({ redirectUri: `${window.location.origin}/login` })
  } else {
    window.location.href = "/login"
  }
}
