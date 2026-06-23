import { test, expect } from "@playwright/test"

const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL ?? "http://localhost:5174"
const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:8001"

test("unauthenticated user is redirected to login", async ({ page }) => {
  await page.goto(FRONTEND_BASE_URL)
  await expect(page).toHaveURL(/login/)
})

test("invalid credentials show an error", async ({ page }) => {
  await page.goto(`${FRONTEND_BASE_URL}/login`)
  await page.getByLabel(/email/i).fill("wrong@example.com")
  await page.getByLabel(/password/i).fill("wrongpassword")
  await page.getByRole("button", { name: /log in|sign in/i }).click()
  await expect(page.getByText(/incorrect|invalid|error/i)).toBeVisible()
})

test("valid credentials redirect to the main app", async ({ page }) => {
  const email = process.env.INTEGRATION_TEST_EMAIL!
  const password = process.env.INTEGRATION_TEST_PASSWORD!
  await page.goto(`${FRONTEND_BASE_URL}/login`)
  await page.getByLabel(/email/i).fill(email)
  await page.getByLabel(/password/i).fill(password)
  await page.getByRole("button", { name: /log in|sign in/i }).click()
  await expect(page).not.toHaveURL(/login/, { timeout: 15_000 })
})

test("logout redirects back to login", async ({ page }) => {
  const email = process.env.INTEGRATION_TEST_EMAIL!
  const password = process.env.INTEGRATION_TEST_PASSWORD!
  await page.goto(`${FRONTEND_BASE_URL}/login`)
  await page.getByLabel(/email/i).fill(email)
  await page.getByLabel(/password/i).fill(password)
  await page.getByRole("button", { name: /log in|sign in/i }).click()
  await page.waitForURL((url) => !url.href.includes("login"), { timeout: 15_000 })
  await page.getByRole("button", { name: /logout|log out|sign out/i }).click()
  await expect(page).toHaveURL(/login/, { timeout: 10_000 })
})

test("API health check is reachable", async () => {
  const res = await fetch(`${API_BASE_URL}/api/v1/utils/health-check/`)
  expect(res.ok).toBe(true)
})
