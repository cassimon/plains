/**
 * Data persistence across browser sessions (Task 5 C-8).
 *
 * This is the test that was missing. Every other integration test seeds data
 * with server-generated IDs via direct API calls, so none of them exercised the
 * GUI's own persistence path — which is exactly where the bug lived (the app
 * pushed a bulk `PUT /state/ {data: snapshot}` the normalised backend rejects
 * with 422, so nothing was ever written and users reloaded to an empty dataset).
 *
 * These tests fail if data created in the app does not actually reach the DB,
 * or if data in the DB is not restored on a fresh login.
 */

import { expect, test } from "./fixtures"
import { apiClient } from "./utils/api"

const FRONTEND_BASE_URL =
  process.env.FRONTEND_BASE_URL ?? "http://localhost:5174"

// ── Load path ────────────────────────────────────────────────────────────────
// A process in the database must be restored when the user logs in fresh — this
// directly guards the reported symptom ("after logout the elements are not
// there and the user starts with an empty dataset").
test("a process in the DB is restored on a fresh login, not lost", async ({
  authedPage,
  authToken,
}) => {
  const api = apiClient(authToken)
  const id = crypto.randomUUID()
  const name = `Persist-Load-${Date.now()}`
  // Persist with a client-generated UUID, exactly as the GUI's save path does.
  await api.post("/processes/", { id, name })

  try {
    // Fresh navigation boots the app and runs HttpBackend.load() → /state/bulk.
    await authedPage.goto(`${FRONTEND_BASE_URL}/processes`)
    await expect(authedPage.getByText(name).first()).toBeVisible({
      timeout: 20_000,
    })

    // And it is genuinely in the normalised store the GUI reads from.
    const bulk = await api.get<{ processes: Array<{ id: string }> }>(
      "/state/bulk",
    )
    expect(bulk.processes.some((p) => p.id === id)).toBe(true)
  } finally {
    await api.delete(`/processes/${id}`)
  }
})

// ── Save path ────────────────────────────────────────────────────────────────
// An edit made in the browser must be flushed to the database by HttpBackend's
// per-entity sync (this is the exact path that was broken — the app used to push
// a bulk `PUT /state/` the backend rejects with 422, so edits never persisted).
// We rename a plane in the GUI and assert the change reached the DB.
test("an edit made in the browser is written to the database (save path)", async ({
  authedPage,
  authToken,
}) => {
  const api = apiClient(authToken)
  const planeId = crypto.randomUUID()
  const original = `Persist-Save-${Date.now()}`
  const renamed = `${original}-RENAMED`
  await api.post("/planes/", { id: planeId, name: original })

  try {
    await authedPage.goto(`${FRONTEND_BASE_URL}/organization`)
    await expect(
      authedPage.getByText(original, { exact: true }).first(),
    ).toBeVisible({ timeout: 20_000 })

    // The plane update must be flushed by the per-entity sync.
    const saved = authedPage.waitForResponse(
      (r) =>
        new RegExp(`/planes/${planeId}$`).test(r.url()) &&
        r.request().method() === "PUT" &&
        r.ok(),
      { timeout: 20_000 },
    )

    // The plane name renders both as an editable tab and as a card title; only
    // the tab opens a rename input on double-click, so try each candidate.
    const candidates = authedPage.getByText(original, { exact: true })
    const input = authedPage.locator("input:focus")
    for (let i = 0; i < (await candidates.count()); i++) {
      await candidates
        .nth(i)
        .dblclick()
        .catch(() => {})
      if (await input.count()) break
    }
    await expect(input).toBeVisible({ timeout: 5_000 })
    await input.fill(renamed)
    await input.press("Enter")
    await saved

    // The rename is genuinely in the database, not just frontend state.
    await expect
      .poll(
        async () =>
          (await api.get<{ name: string }>(`/planes/${planeId}`)).name,
        { timeout: 15_000 },
      )
      .toBe(renamed)
  } finally {
    await api.delete(`/planes/${planeId}`)
  }
})
