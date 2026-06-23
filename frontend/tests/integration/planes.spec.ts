import { test, expect } from "@playwright/test"
import { login, apiClient } from "./utils/api"

const API_BASE_URL = process.env.API_BASE_URL ?? "http://localhost:8001"

test("create plane and add sticky note with integer grid coords", async () => {
  const token = await login(
    process.env.INTEGRATION_TEST_EMAIL!,
    process.env.INTEGRATION_TEST_PASSWORD!,
  )
  const api = apiClient(token)
  const plane = await api.createPlane({ name: `TestPlane-${Date.now()}` })

  try {
    // Add a sticky note at (i=2, j=3)
    const noteRes = await fetch(`${API_BASE_URL}/api/v1/planes/${plane.id}/sticky-notes/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ i: 2, j: 3, di: 2, dj: 2, content: "Test note" }),
    })
    expect(noteRes.ok).toBe(true)
    const note = await noteRes.json()
    expect(note.i).toBe(2)
    expect(note.j).toBe(3)
    expect(Number.isInteger(note.i)).toBe(true)
    expect(Number.isInteger(note.j)).toBe(true)

    // Move the note to (i=5, j=1)
    const moveRes = await fetch(
      `${API_BASE_URL}/api/v1/planes/${plane.id}/sticky-notes/${note.id}`,
      {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ i: 5, j: 1 }),
      },
    )
    expect(moveRes.ok).toBe(true)
    const moved = await moveRes.json()
    expect(moved.i).toBe(5)
    expect(moved.j).toBe(1)
  } finally {
    await api.delete(`/planes/${plane.id}`)
  }
})

test("add text field to plane", async () => {
  const token = await login(
    process.env.INTEGRATION_TEST_EMAIL!,
    process.env.INTEGRATION_TEST_PASSWORD!,
  )
  const api = apiClient(token)
  const plane = await api.createPlane({ name: `TFPlane-${Date.now()}` })

  try {
    const tfRes = await fetch(`${API_BASE_URL}/api/v1/planes/${plane.id}/text-fields/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ i: 0, j: 0, content: "Hello" }),
    })
    expect(tfRes.ok).toBe(true)
    const tf = await tfRes.json()
    expect(tf.content).toBe("Hello")
  } finally {
    await api.delete(`/planes/${plane.id}`)
  }
})

test("add data collection and link experiment", async () => {
  const token = await login(
    process.env.INTEGRATION_TEST_EMAIL!,
    process.env.INTEGRATION_TEST_PASSWORD!,
  )
  const api = apiClient(token)
  const plane = await api.createPlane({ name: `CollPlane-${Date.now()}` })
  const exp = await api.createExperiment({ name: `CollExp-${Date.now()}` })

  try {
    // Create collection
    const collRes = await fetch(`${API_BASE_URL}/api/v1/planes/${plane.id}/collections/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ i: 1, j: 1, name: "Test Collection" }),
    })
    expect(collRes.ok).toBe(true)
    const coll = await collRes.json()

    // Link experiment to collection
    const linkRes = await fetch(`${API_BASE_URL}/api/v1/experiments/${exp.id}`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ collection_id: coll.id }),
    })
    expect(linkRes.ok).toBe(true)
    const updated = await linkRes.json()
    expect(updated.collection_id).toBe(coll.id)
  } finally {
    await api.delete(`/experiments/${exp.id}`)
    await api.delete(`/planes/${plane.id}`)
  }
})

test("IDOR: test user cannot write to superuser plane", async () => {
  const superToken = process.env.INTEGRATION_TOKEN!
  const userToken = await login(
    process.env.INTEGRATION_TEST_EMAIL!,
    process.env.INTEGRATION_TEST_PASSWORD!,
  )
  const superApi = apiClient(superToken)
  const plane = await superApi.createPlane({ name: `IDOR-Plane-${Date.now()}` })

  try {
    const res = await fetch(`${API_BASE_URL}/api/v1/planes/${plane.id}/sticky-notes/`, {
      method: "POST",
      headers: { Authorization: `Bearer ${userToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ i: 0, j: 0, content: "IDOR attempt" }),
    })
    expect([403, 404]).toContain(res.status)
  } finally {
    await superApi.delete(`/planes/${plane.id}`)
  }
})
