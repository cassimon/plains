import { redirect } from "@tanstack/react-router"

import { ApiError, UsersService } from "@/client"
import { clearKeycloak, isAuthenticated } from "@/lib/keycloakInstance"

export const isLoggedIn = () => isAuthenticated()

const clearAuth = () => clearKeycloak()

const isAuthError = (error: unknown) => {
  return error instanceof ApiError && [401, 403].includes(error.status)
}

export const ensureAuthenticated = async () => {
  console.log("[Auth] ensureAuthenticated called")
  const loggedIn = isLoggedIn()
  console.log("[Auth] isLoggedIn():", loggedIn)
  if (!loggedIn) {
    console.log("[Auth] Not logged in, redirecting to /login")
    throw redirect({ to: "/login" })
  }

  try {
    console.log("[Auth] Calling UsersService.readUserMe()")
    const user = await UsersService.readUserMe()
    console.log("[Auth] readUserMe() succeeded, user:", user.email)
  } catch (error) {
    console.error("[Auth] readUserMe() failed:", error)
    if (isAuthError(error)) {
      console.log(
        "[Auth] Auth error detected, clearing auth and redirecting to /login",
      )
      clearAuth()
      throw redirect({ to: "/login" })
    }
    throw error
  }
}

export const redirectIfAuthenticated = async () => {
  console.log("[Auth] redirectIfAuthenticated called")
  const loggedIn = isLoggedIn()
  console.log("[Auth] isLoggedIn():", loggedIn)
  if (!loggedIn) {
    console.log("[Auth] Not logged in, staying on login page")
    return
  }

  try {
    console.log("[Auth] Already logged in, verifying with readUserMe()")
    await UsersService.readUserMe()
    console.log("[Auth] User verified, redirecting to /")
    throw redirect({ to: "/" })
  } catch (error) {
    console.error("[Auth] readUserMe() failed:", error)
    if (isAuthError(error)) {
      console.log("[Auth] Auth error, clearing and staying on login")
      clearAuth()
      return
    }
    throw error
  }
}

// NOMAD OAuth is the only supported login method.
