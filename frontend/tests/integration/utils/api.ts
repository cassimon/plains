/**
 * Thin HTTP client for seeding and asserting via the REST API from Node
 * (not through the browser). Used by Playwright global-setup and test files.
 */

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:8001"

export async function login(email: string, password: string): Promise<string> {
  const body = new URLSearchParams({ username: email, password })
  const res = await fetch(`${API_BASE_URL}/api/v1/login/access-token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  })
  if (!res.ok)
    throw new Error(`Login failed: ${res.status} ${await res.text()}`)
  const data = await res.json()
  return data.access_token as string
}

export function apiClient(token: string) {
  const headers = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  }

  async function request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const res = await fetch(`${API_BASE_URL}/api/v1${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
    if (!res.ok)
      throw new Error(`${method} ${path} → ${res.status}: ${await res.text()}`)
    if (res.status === 204) return undefined as T
    return res.json() as Promise<T>
  }

  return {
    get: <T>(path: string) => request<T>("GET", path),
    post: <T>(path: string, body: unknown) => request<T>("POST", path, body),
    put: <T>(path: string, body: unknown) => request<T>("PUT", path, body),
    patch: <T>(path: string, body: unknown) => request<T>("PATCH", path, body),
    delete: (path: string) => request<void>("DELETE", path),

    createMaterial: (data: Record<string, unknown>) =>
      request<{ id: string }>("POST", "/materials/", data),
    createSolution: (data: Record<string, unknown>) =>
      request<{ id: string }>("POST", "/solutions/", data),
    createProcess: (data: Record<string, unknown>) =>
      request<{ id: string }>("POST", "/processes/", data),
    createExperiment: (data: Record<string, unknown>) =>
      request<{ id: string }>("POST", "/experiments/", data),
    createPlane: (data: Record<string, unknown>) =>
      request<{ id: string }>("POST", "/planes/", data),
  }
}
