import { login } from "./utils/api"

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:8001"
const MAX_WAIT_MS = 60_000
const RETRY_INTERVAL_MS = 2_000

async function waitForStack(): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < MAX_WAIT_MS) {
    try {
      const res = await fetch(`${API_BASE_URL}/api/v1/utils/health-check/`)
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await new Promise((r) => setTimeout(r, RETRY_INTERVAL_MS))
  }
  throw new Error(`Stack not reachable at ${API_BASE_URL} after ${MAX_WAIT_MS}ms`)
}

export default async function globalSetup() {
  await waitForStack()

  const email = process.env.FIRST_SUPERUSER ?? "admin@example.com"
  const password = process.env.FIRST_SUPERUSER_PASSWORD ?? "changethis"
  const token = await login(email, password)

  // Create a test-run-specific user so tests are isolated from the superuser
  const timestamp = Date.now()
  const testEmail = `integration-${timestamp}@test.plains`
  const testPassword = "IntegrationTestPass1!"

  const res = await fetch(`${API_BASE_URL}/api/v1/users/`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      email: testEmail,
      password: testPassword,
      full_name: "Integration Test User",
      is_active: true,
      is_superuser: false,
    }),
  })
  if (!res.ok) throw new Error(`Failed to create test user: ${res.status}`)

  // Expose to tests via env
  process.env.INTEGRATION_TOKEN = token
  process.env.INTEGRATION_TEST_EMAIL = testEmail
  process.env.INTEGRATION_TEST_PASSWORD = testPassword
  const user = await res.json()
  process.env.INTEGRATION_TEST_USER_ID = user.id
}
