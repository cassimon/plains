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
  throw new Error(
    `Stack not reachable at ${API_BASE_URL} after ${MAX_WAIT_MS}ms`,
  )
}

export default async function globalSetup() {
  await waitForStack()

  // Create a dedicated test user via the unauthenticated /private/users/
  // endpoint (available when ENVIRONMENT=local). This mirrors the backend
  // integration conftest and avoids depending on superuser credentials — the
  // user is created and logged in with the exact same password, so the
  // browser-side login can never mismatch.
  const timestamp = Date.now()
  const testEmail = `integration-${timestamp}@test.plains`
  const testPassword = "IntegrationTestPass1!"

  const res = await fetch(`${API_BASE_URL}/api/v1/private/users/`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      email: testEmail,
      password: testPassword,
      full_name: "Integration Test User",
    }),
  })
  if (!res.ok) {
    throw new Error(
      `Failed to create test user: ${res.status} ${await res.text()}`,
    )
  }
  const user = await res.json()

  // Expose to tests via env (workers spawn after globalSetup and inherit these).
  process.env.INTEGRATION_TEST_EMAIL = testEmail
  process.env.INTEGRATION_TEST_PASSWORD = testPassword
  process.env.INTEGRATION_TEST_USER_ID = user.id
}
