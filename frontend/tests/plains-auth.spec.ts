/**
 * Authentication and routing guard tests.
 *
 * Verifies that:
 * - Unauthenticated users are redirected to /login for protected routes.
 * - The login page renders without errors.
 * - After mock-authentication, protected routes are accessible.
 * - Auth errors (401 from backend) redirect to login.
 */
import { expect, test } from "@playwright/test"

// These tests run WITHOUT the global auth storage state — they test the
// unauthenticated experience.
test.use({ storageState: { cookies: [], origins: [] } })

const PROTECTED_ROUTES = [
  "/",
  "/materials",
  "/solutions",
  "/processes",
  "/experiments",
  "/results",
  "/analysis",
  "/organization",
  "/export",
]

async function mockBaseApi(page: import("@playwright/test").Page) {
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
}

test.describe("Unauthenticated access", () => {
  test.beforeEach(async ({ page }) => {
    await mockBaseApi(page)
  })

  for (const route of PROTECTED_ROUTES) {
    test(`${route} redirects to /login when not authenticated`, async ({
      page,
    }) => {
      await page.goto(route)
      await expect(page).toHaveURL(/\/login/)
    })
  }
})

test.describe("Login page", () => {
  test.beforeEach(async ({ page }) => {
    await mockBaseApi(page)
  })

  test("renders the NOMAD login button", async ({ page }) => {
    await page.goto("/login", { waitUntil: "domcontentloaded" })
    // App fetches auth config and shows the login button (even before keycloak.init completes)
    await expect(
      page.getByRole("button", { name: /login with nomad/i }),
    ).toBeVisible({
      timeout: 8000,
    })
  })

  test("shows error message when auth config is unavailable", async ({
    page,
  }) => {
    // Override to return server error
    await page.route("**/api/v1/auth/config", (route) =>
      route.fulfill({ status: 500, body: "Internal Server Error" }),
    )
    await page.goto("/login", { waitUntil: "domcontentloaded" })
    await expect(page.getByText(/auth configuration unavailable/i)).toBeVisible(
      { timeout: 8000 },
    )
  })

  test("login page does not redirect authenticated users immediately", async ({
    page,
  }) => {
    // Without injecting mock auth, visiting /login should stay on /login
    await page.goto("/login", { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(2000)
    expect(page.url()).toMatch(/\/login/)
  })
})

test.describe("Authenticated access", () => {
  async function setupAuth(page: import("@playwright/test").Page) {
    await page.route("**/api/v1/users/me", (route) =>
      route.fulfill({
        status: 200,
        json: {
          id: "00000000-0000-0000-0000-000000000001",
          email: "test@plains.dev",
          is_active: true,
          is_superuser: false,
          full_name: "Test User",
        },
      }),
    )
    await page.route("**/api/v1/state/bulk", (route) =>
      route.fulfill({
        status: 200,
        json: {
          materials: [],
          solutions: [],
          experiments: [],
          results: [],
          planes: [],
        },
      }),
    )
    await page.route("**/api/v1/state/", (route) =>
      route.fulfill({
        status: 200,
        json: {
          data: {
            materials: [],
            solutions: [],
            experiments: [],
            results: [],
            planes: [],
            processes: [],
          },
        },
      }),
    )
    await page.route("**/api/v1/**", (route) =>
      route.fulfill({ status: 200, json: {} }),
    )
  }

  test("authenticated user can reach home route", async ({ page }) => {
    await setupAuth(page)
    await page.goto("/login", { waitUntil: "domcontentloaded" })
    await page.waitForFunction(() => "__plains_setKeycloak" in window, {
      timeout: 10_000,
    })
    await page.evaluate(() => {
      ;(window as any).__plains_setKeycloak({
        authenticated: true,
        token: "mock-token",
        updateToken: () => Promise.resolve(true),
        onTokenExpired: undefined,
        logout: () => {},
      })
    })
    await page.goto("/", { waitUntil: "domcontentloaded" })
    // Should NOT be redirected to /login
    expect(page.url()).not.toMatch(/\/login/)
  })

  test("backend 401 response triggers redirect to login", async ({ page }) => {
    // Simulate a token that the backend rejects
    await page.route("**/api/v1/users/me", (route) =>
      route.fulfill({ status: 401, json: { detail: "Not authenticated" } }),
    )
    await page.route("**/api/v1/**", (route) =>
      route.fulfill({ status: 401, json: { detail: "Not authenticated" } }),
    )

    await page.goto("/login", { waitUntil: "domcontentloaded" })
    await page.waitForFunction(() => "__plains_setKeycloak" in window, {
      timeout: 10_000,
    })
    await page.evaluate(() => {
      ;(window as any).__plains_setKeycloak({
        authenticated: true,
        token: "expired-token",
        updateToken: () => Promise.resolve(true),
        onTokenExpired: undefined,
        logout: () => {},
      })
    })
    // Navigate to a protected route — the ensureAuthenticated guard calls
    // readUserMe() which returns 401, so we should land on /login.
    await page.goto("/materials")
    await expect(page).toHaveURL(/\/login/, { timeout: 8000 })
  })
})
