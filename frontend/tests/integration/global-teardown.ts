const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:8001"

export default async function globalTeardown() {
  const token = process.env.INTEGRATION_TOKEN
  const userId = process.env.INTEGRATION_TEST_USER_ID
  if (!token || !userId) return

  await fetch(`${API_BASE_URL}/api/v1/users/${userId}`, {
    method: "DELETE",
    headers: { Authorization: `Bearer ${token}` },
  })
}
