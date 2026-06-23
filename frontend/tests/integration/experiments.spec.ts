import { test, expect } from "@playwright/test"
import { login, apiClient } from "./utils/api"

const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL ?? "http://localhost:5174"
const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:8001"

async function loginToApp(page: import("@playwright/test").Page) {
  await page.goto(`${FRONTEND_BASE_URL}/login`)
  await page.getByLabel(/email/i).fill(process.env.INTEGRATION_TEST_EMAIL!)
  await page.getByLabel(/password/i).fill(process.env.INTEGRATION_TEST_PASSWORD!)
  await page.getByRole("button", { name: /log in|sign in/i }).click()
  await page.waitForURL((url) => !url.href.includes("login"), { timeout: 15_000 })
}

test("seeded experiment appears in the list", async ({ page }) => {
  const token = await login(
    process.env.INTEGRATION_TEST_EMAIL!,
    process.env.INTEGRATION_TEST_PASSWORD!,
  )
  const api = apiClient(token)
  const name = `Exp-${Date.now()}`
  const exp = await api.createExperiment({ name })

  try {
    await loginToApp(page)
    await page.goto(`${FRONTEND_BASE_URL}/experiments`)
    await expect(page.getByText(name)).toBeVisible({ timeout: 15_000 })
  } finally {
    await api.delete(`/experiments/${exp.id}`)
  }
})

test("attach material and solution to experiment via API", async () => {
  const token = await login(
    process.env.INTEGRATION_TEST_EMAIL!,
    process.env.INTEGRATION_TEST_PASSWORD!,
  )
  const api = apiClient(token)
  const mat = await api.createMaterial({ name: `ExpMat-${Date.now()}`, category: "substrate" })
  const sol = await api.createSolution({ name: `ExpSol-${Date.now()}` })
  const exp = await api.createExperiment({ name: `ExpWithRefs-${Date.now()}` })

  try {
    // Attach material
    const matRes = await fetch(`${API_BASE_URL}/api/v1/experiments/${exp.id}/materials`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([mat.id]),
    })
    expect(matRes.ok).toBe(true)

    // Attach solution
    const solRes = await fetch(`${API_BASE_URL}/api/v1/experiments/${exp.id}/solutions`, {
      method: "PUT",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify([sol.id]),
    })
    expect(solRes.ok).toBe(true)

    // Read back and verify
    const detail = await fetch(`${API_BASE_URL}/api/v1/experiments/${exp.id}`, {
      headers: { Authorization: `Bearer ${token}` },
    })
    const data = await detail.json()
    expect(data.material_ids ?? data.materials?.map((m: { id: string }) => m.id)).toContain(mat.id)
  } finally {
    await api.delete(`/experiments/${exp.id}`)
    await api.delete(`/materials/${mat.id}`)
    await api.delete(`/solutions/${sol.id}`)
  }
})

test("cascade delete: deleting experiment removes substrates", async () => {
  const token = await login(
    process.env.INTEGRATION_TEST_EMAIL!,
    process.env.INTEGRATION_TEST_PASSWORD!,
  )
  const api = apiClient(token)
  const exp = await api.createExperiment({ name: `CascadeExp-${Date.now()}` })

  // Add substrate
  const subRes = await fetch(`${API_BASE_URL}/api/v1/experiments/${exp.id}/substrates/`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "Substrate 1" }),
  })
  expect(subRes.ok).toBe(true)

  await api.delete(`/experiments/${exp.id}`)
  const check = await fetch(`${API_BASE_URL}/api/v1/experiments/${exp.id}`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  expect(check.status).toBe(404)
})

test("IDOR: test user cannot read superuser experiment", async () => {
  const superToken = process.env.INTEGRATION_TOKEN!
  const userToken = await login(
    process.env.INTEGRATION_TEST_EMAIL!,
    process.env.INTEGRATION_TEST_PASSWORD!,
  )
  const superApi = apiClient(superToken)
  const exp = await superApi.createExperiment({ name: `IDOR-Exp-${Date.now()}` })

  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/experiments/${exp.id}`, {
      headers: { Authorization: `Bearer ${userToken}` },
    })
    expect([403, 404]).toContain(res.status)
  } finally {
    await superApi.delete(`/experiments/${exp.id}`)
  }
})
