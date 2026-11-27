import { redirect } from "@tanstack/react-router"

import { ApiError, UsersService } from "@/client"
import { clearKeycloak, isAuthenticated } from "@/lib/keycloakInstance"

export const isLoggedIn = () => isAuthenticated()

const clearAuth = () => clearKeycloak()

const isAuthError = (error: unknown) => {
  return error instanceof ApiError && [401, 403].includes(error.status)
}

export const ensureAuthenticated = async () => {
  const loggedIn = isLoggedIn()
  if (!loggedIn) {
    throw redirect({ to: "/login" })
  }

  try {
    await UsersService.readUserMe()
  } catch (error) {
    console.error("[Auth] readUserMe() failed:", error)
    if (isAuthError(error)) {
      clearAuth()
      throw redirect({ to: "/login" })
    }
    throw error
  }
}

export const redirectIfAuthenticated = async () => {
  const loggedIn = isLoggedIn()
  if (!loggedIn) {
    return
  }

  try {
    await UsersService.readUserMe()
    throw redirect({ to: "/" })
  } catch (error) {
    console.error("[Auth] readUserMe() failed:", error)
    if (isAuthError(error)) {
      clearAuth()
      return
    }
    throw error
  }
}

// NOMAD OAuth is the only supported login method.
