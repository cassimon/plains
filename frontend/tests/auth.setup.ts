/**
 * Playwright auth setup.
 *
 * The app uses NOMAD Keycloak (external OAuth). There is no local login form.
 * To test without a live Keycloak server we:
 *   1. Navigate to the app so the JS bundle loads.
 *   2. Inject a mock Keycloak object via the dev-only window.__plains_setKeycloak hook.
 *   3. Mock the /api/v1/users/me backend call so ensureAuthenticated() succeeds.
 *   4. Navigate to the home route and save storage state.
 */
import { test as setup } from "@playwright/test"

const authFile = "playwright/.auth/user.json"

const MOCK_USER = {
  id: "00000000-0000-0000-0000-000000000001",
  email: "test@plains.dev",
  is_active: true,
  is_superuser: true,
  full_name: "Playwright Test User",
}

setup("authenticate via mock keycloak", async ({ page }) => {
  // Mock all backend auth/user calls so the app considers the session valid.
  await page.route("**/api/v1/users/me", (route) =>
    route.fulfill({ status: 200, json: MOCK_USER }),
  )
  await page.route("**/api/v1/auth/config", (route) =>
    route.fulfill({
      status: 200,
      json: {
        keycloak_url: "http://mock-keycloak",
        keycloak_realm: "mock",
        keycloak_client_id: "plains",
      },
    }),
  )

  // Load the app so the JS bundle (including __plains_setKeycloak) is available.
  await page.goto("/login", { waitUntil: "domcontentloaded" })

  // Wait for the Vite bundle to expose the test hook, then inject a mock
  // Keycloak instance that appears fully authenticated.
  await page.waitForFunction(() => "__plains_setKeycloak" in window, {
    timeout: 10_000,
  })
  await page.evaluate(() => {
    const mockKc = {
      authenticated: true,
      token: "mock-test-token",
      updateToken: (_minValidity: number) => Promise.resolve(true),
      onTokenExpired: undefined as (() => void) | undefined,
      logout: (_opts?: unknown) => {},
    }
    ;(window as any).__plains_setKeycloak(mockKc)
  })

  // Navigate to the protected home route — ensureAuthenticated should pass.
  await page.goto("/", { waitUntil: "networkidle" })

  await page.context().storageState({ path: authFile })
})
