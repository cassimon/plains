import { expect, test } from "./fixtures"

const FRONTEND_BASE_URL =
  process.env.FRONTEND_BASE_URL ?? "http://localhost:5174"
const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:8001"

test("unauthenticated user is redirected to login", async ({ page }) => {
  await page.goto(FRONTEND_BASE_URL)
  await expect(page).toHaveURL(/login/, { timeout: 15_000 })
})

test("login page offers NOMAD SSO sign-in", async ({ page }) => {
  // Plains authenticates via NOMAD/Keycloak only — the login page shows a
  // single SSO button, not a local email/password form.
  await page.goto(`${FRONTEND_BASE_URL}/login`)
  await expect(
    page.getByRole("button", { name: /login with nomad/i }),
  ).toBeVisible({ timeout: 15_000 })
})

test("API health check is reachable", async () => {
  const res = await fetch(`${API_BASE_URL}/api/v1/utils/health-check/`)
  expect(res.ok).toBe(true)
})

test("authenticated session reaches the app and is not bounced to login", async ({
  authedPage,
}) => {
  // The app bootstraps by calling GET /state/ with the injected token; a 200
  // proves both that the session is accepted and that the GUI is wired to the
  // backend.
  const stateResponse = authedPage.waitForResponse(
    (r) => r.url().includes("/api/v1/state/") && r.request().method() === "GET",
    { timeout: 20_000 },
  )
  await authedPage.goto(FRONTEND_BASE_URL)
  const res = await stateResponse
  expect(res.status()).toBe(200)
  await expect(authedPage).not.toHaveURL(/login/, { timeout: 15_000 })
})
