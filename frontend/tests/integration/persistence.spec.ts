import { test, expect, chromium } from "@playwright/test"
import { login, apiClient } from "./utils/api"

const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL ?? "http://localhost:5174"
const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:8001"

test("data persists across browser sessions", async () => {
  const token = await login(
    process.env.INTEGRATION_TEST_EMAIL!,
    process.env.INTEGRATION_TEST_PASSWORD!,
  )
  const api = apiClient(token)
  const name = `Persist-${Date.now()}`
  const mat = await api.createMaterial({ name, category: "chemical_compound" })

  try {
    // Session 1: log in and verify material is visible
    const browser1 = await chromium.launch()
    const ctx1 = await browser1.newContext()
    const page1 = await ctx1.newPage()
    await page1.goto(`${FRONTEND_BASE_URL}/login`)
    await page1.getByLabel(/email/i).fill(process.env.INTEGRATION_TEST_EMAIL!)
    await page1.getByLabel(/password/i).fill(process.env.INTEGRATION_TEST_PASSWORD!)
    await page1.getByRole("button", { name: /log in|sign in/i }).click()
    await page1.waitForURL((url) => !url.href.includes("login"), { timeout: 15_000 })
    await page1.goto(`${FRONTEND_BASE_URL}/materials`)
    await expect(page1.getByText(name)).toBeVisible({ timeout: 15_000 })
    await browser1.close()

    // Session 2: fresh browser context — material must still be there
    const browser2 = await chromium.launch()
    const ctx2 = await browser2.newContext()
    const page2 = await ctx2.newPage()
    await page2.goto(`${FRONTEND_BASE_URL}/login`)
    await page2.getByLabel(/email/i).fill(process.env.INTEGRATION_TEST_EMAIL!)
    await page2.getByLabel(/password/i).fill(process.env.INTEGRATION_TEST_PASSWORD!)
    await page2.getByRole("button", { name: /log in|sign in/i }).click()
    await page2.waitForURL((url) => !url.href.includes("login"), { timeout: 15_000 })
    await page2.goto(`${FRONTEND_BASE_URL}/materials`)
    await expect(page2.getByText(name)).toBeVisible({ timeout: 15_000 })

    // Also confirm via direct API
    const res = await fetch(`${API_BASE_URL}/api/v1/materials/?limit=200`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await res.json()
    expect(data.data.some((m: { name: string }) => m.name === name)).toBe(true)
    await browser2.close()
  } finally {
    await api.delete(`/materials/${mat.id}`)
  }
})
