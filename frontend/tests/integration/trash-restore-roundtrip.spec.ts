/**
 * Trash delete → restore round-trip against the REAL stack.
 *
 * The acceptance gate for docs/plans/trash-restore-fix.md. Restoring a trashed
 * object must put it back into the exact dependency branch it came from
 * (plane → collection → process → experiment → result), not merely un-hide the
 * row. The historical failure was invisible in the app until a save+reload:
 * the client flushed its stale pre-restore snapshot over the server's work
 * (F1), and `PUT /planes/{id}/collections` delete-and-recreate NULLed the
 * members' `collection_id` (F2). So every test here asserts state equality
 * twice — right after the restore, and again after a full page reload.
 *
 * Equality is checked on both sides of the wire:
 *   - the GUI, via the test-only `window.__plainsSnapshot()` probe;
 *   - the backend, via `GET /state/bulk`.
 *
 * Deleted objects must also disappear from every list and picker immediately
 * (before any reload), so the user is never offered something that is in the
 * trash.
 */
import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures"
import { apiClient } from "./utils/api"

// One browser session per account: HttpBackend.syncToBackend reconciles
// deletions against the full snapshot, so parallel sessions clobber each
// other's rows (see CLAUDE.md). Run serially.
test.describe.configure({ mode: "serial" })

type Ref = { kind: string; id: string }
type Probe = {
  processes: Array<{ id: string; name: string }>
  experiments: Array<{ id: string; name: string }>
  results: Array<{ id: string }>
  planes: Array<{
    id: string
    name: string
    elements: Array<{
      id: string
      type: string
      name?: string
      position: { x: number; y: number }
      refs?: Ref[]
    }>
  }>
  trashCount: number
}

/** The dependency branch as the GUI sees it, in a stable, comparable shape. */
type GuiState = {
  processes: string[]
  experiments: string[]
  results: string[]
  planes: Array<{
    id: string
    name: string
    collections: Array<{ id: string; name: string; refs: string[] }>
  }>
}

const byString = (a: string, b: string) => a.localeCompare(b)

async function guiState(page: Page): Promise<GuiState> {
  const probe = await page.evaluate(() => {
    const fn = (window as unknown as { __plainsSnapshot?: () => unknown })
      .__plainsSnapshot
    if (!fn) throw new Error("__plainsSnapshot probe missing (non-test build?)")
    return fn() as unknown
  })
  const p = probe as Probe
  return {
    processes: p.processes.map((x) => `${x.id}:${x.name}`).sort(byString),
    experiments: p.experiments.map((x) => `${x.id}:${x.name}`).sort(byString),
    results: p.results.map((x) => x.id).sort(byString),
    planes: p.planes
      .map((plane) => ({
        id: plane.id,
        name: plane.name,
        collections: plane.elements
          .filter((el) => el.type === "collection")
          .map((el) => ({
            id: el.id,
            name: el.name ?? "",
            // Grid position is deliberately excluded: the "Restored: …" fixup
            // may re-pack a collection onto a free cell. Membership is what the
            // dependency structure means.
            refs: (el.refs ?? [])
              .map((r) => `${r.kind}:${r.id}`)
              .sort(byString),
          }))
          .sort((a, b) => byString(a.id, b.id)),
      }))
      .sort((a, b) => byString(a.id, b.id)),
  }
}

type Bulk = {
  processes: Array<{
    id: string
    plane_id: string | null
    collection_id: string | null
  }>
  experiments: Array<{
    id: string
    plane_id: string | null
    collection_id: string | null
  }>
  results: Array<{
    id: string
    plane_id: string | null
    collection_id: string | null
  }>
  planes: Array<{
    id: string
    collections: Array<{ id: string; name: string }>
  }>
}

/** Backend truth: which entity sits in which collection on which plane. */
async function backendState(token: string) {
  const bulk = await apiClient(token).get<Bulk>("/state/bulk")
  const place = (
    rows: Array<{
      id: string
      plane_id: string | null
      collection_id: string | null
    }>,
  ) =>
    rows
      .map((r) => `${r.id}@${r.plane_id ?? "-"}/${r.collection_id ?? "-"}`)
      .sort(byString)
  return {
    processes: place(bulk.processes),
    experiments: place(bulk.experiments),
    results: place(bulk.results),
    collections: bulk.planes
      .flatMap((pl) => pl.collections.map((c) => `${c.id}@${pl.id}:${c.name}`))
      .sort(byString),
  }
}

/**
 * Pin the active plane before the app boots. Pages filter their lists to the
 * active plane (`isEntityVisible`), and AppContext restores the last active
 * plane from localStorage — so without this, a plane left over from an earlier
 * test in this serial file hides the freshly seeded branch.
 */
async function activatePlane(page: Page, planeId: string) {
  await page.addInitScript((id) => {
    window.localStorage.setItem("plains_active_plane_id", id as string)
  }, planeId)
}

/** Wait until AppContext has loaded the server snapshot into the probe. */
async function waitForApp(page: Page, expectPlaneId: string) {
  await expect
    .poll(
      async () => {
        const state = await guiState(page).catch(() => null)
        return state?.planes.some((p) => p.id === expectPlaneId) ?? false
      },
      { timeout: 30_000, message: "app never loaded the seeded plane" },
    )
    .toBe(true)
}

/**
 * The debounced save is 2.5 s. Let it fire and settle so the next navigation or
 * reload cannot race a save that is still in flight.
 */
async function settleSaves(page: Page) {
  await page.waitForTimeout(4_000)
}

/** Seed plane → collection → process → experiment → result, all placed. */
async function seedBranch(token: string, label: string) {
  const api = apiClient(token)
  const planeId = crypto.randomUUID()
  const collectionId = crypto.randomUUID()
  const processId = crypto.randomUUID()
  const experimentId = crypto.randomUUID()
  const names = {
    plane: `${label} plane`,
    collection: `${label} collection`,
    process: `${label} process`,
    experiment: `${label} experiment`,
  }

  await api.post("/planes/", { id: planeId, name: names.plane })
  await api.put(`/planes/${planeId}/collections`, [
    { id: collectionId, i: 0, j: 0, name: names.collection },
  ])
  const placement = { plane_id: planeId, collection_id: collectionId }
  await api.post("/processes/", {
    id: processId,
    name: names.process,
    skip_chemistry: true,
    ...placement,
  })
  await api.post("/experiments/", {
    id: experimentId,
    name: names.experiment,
    process_id: processId,
    ...placement,
  })
  const result = await api.post<{ id: string }>(
    `/results/?experiment_id=${experimentId}`,
    { notes: `${label} result`, ...placement },
  )
  return {
    planeId,
    collectionId,
    processId,
    experimentId,
    resultId: result.id,
    names,
  }
}

async function trashViaApi(
  token: string,
  entityType: string,
  entityId: string,
) {
  await apiClient(token).post("/trash/", {
    entity_type: entityType,
    entity_id: entityId,
  })
}

/** Click the Restore button of the trash row whose name matches. */
async function restoreFromTrashPage(page: Page, name: string) {
  await page.goto("/trash")
  const row = page.getByRole("row").filter({ hasText: name })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.getByRole("button", { name: "Restore" }).click()
  await expect(page.getByText("Restored", { exact: false })).toBeVisible({
    timeout: 15_000,
  })
}

test("process round-trip: restores into its original collection", async ({
  authedPage: page,
  authToken,
}) => {
  const seed = await seedBranch(authToken, `proc-${Date.now()}`)
  await activatePlane(page, seed.planeId)
  await page.goto("/organization")
  await waitForApp(page, seed.planeId)

  const guiBefore = await guiState(page)
  const backendBefore = await backendState(authToken)
  expect(
    guiBefore.planes.find((p) => p.id === seed.planeId)?.collections[0]?.refs,
  ).toContain(`process:${seed.processId}`)

  await trashViaApi(authToken, "process", seed.processId)
  await restoreFromTrashPage(page, seed.names.process)

  expect(await guiState(page)).toEqual(guiBefore)
  expect(await backendState(authToken)).toEqual(backendBefore)

  // The F1/F2 trap: pre-fix, the damage only surfaced once the client had
  // flushed its stale snapshot and the app reloaded.
  await settleSaves(page)
  await page.reload()
  await waitForApp(page, seed.planeId)
  expect(await guiState(page)).toEqual(guiBefore)
  expect(await backendState(authToken)).toEqual(backendBefore)
})

test("collection round-trip: reappears on its plane with all members", async ({
  authedPage: page,
  authToken,
}) => {
  const seed = await seedBranch(authToken, `coll-${Date.now()}`)
  await activatePlane(page, seed.planeId)
  await page.goto("/organization")
  await waitForApp(page, seed.planeId)

  const guiBefore = await guiState(page)
  const backendBefore = await backendState(authToken)

  await trashViaApi(authToken, "collection", seed.collectionId)
  await restoreFromTrashPage(page, seed.names.collection)

  const guiAfter = await guiState(page)
  expect(guiAfter).toEqual(guiBefore)
  // Explicitly: the collection is back on its plane, holding its members.
  const collection = guiAfter.planes
    .find((p) => p.id === seed.planeId)
    ?.collections.find((c) => c.id === seed.collectionId)
  expect(
    collection,
    "restored collection is missing from its plane",
  ).toBeTruthy()
  expect(collection?.refs).toEqual(
    expect.arrayContaining([
      `process:${seed.processId}`,
      `experiment:${seed.experimentId}`,
      `result:${seed.resultId}`,
    ]),
  )
  expect(await backendState(authToken)).toEqual(backendBefore)

  await settleSaves(page)
  await page.reload()
  await waitForApp(page, seed.planeId)
  expect(await guiState(page)).toEqual(guiBefore)
  expect(await backendState(authToken)).toEqual(backendBefore)
})

test("plane round-trip: the whole branch comes back", async ({
  authedPage: page,
  authToken,
}) => {
  const seed = await seedBranch(authToken, `plane-${Date.now()}`)
  // A second plane so the app still has one to show while this one is trashed.
  await apiClient(authToken).post("/planes/", {
    id: crypto.randomUUID(),
    name: "spare plane",
  })
  await activatePlane(page, seed.planeId)
  await page.goto("/organization")
  await waitForApp(page, seed.planeId)

  const guiBefore = await guiState(page)
  const backendBefore = await backendState(authToken)

  await trashViaApi(authToken, "plane", seed.planeId)
  await restoreFromTrashPage(page, seed.names.plane)

  expect(await guiState(page)).toEqual(guiBefore)
  expect(await backendState(authToken)).toEqual(backendBefore)

  await settleSaves(page)
  await page.reload()
  await waitForApp(page, seed.planeId)
  expect(await guiState(page)).toEqual(guiBefore)
  expect(await backendState(authToken)).toEqual(backendBefore)
})

test("deleting an experiment in the UI hides it and its results everywhere", async ({
  authedPage: page,
  authToken,
}) => {
  const seed = await seedBranch(authToken, `hyg-${Date.now()}`)
  await activatePlane(page, seed.planeId)
  await page.goto("/experiments")
  await waitForApp(page, seed.planeId)

  const guiBefore = await guiState(page)
  expect(
    guiBefore.experiments.some((e) => e.startsWith(seed.experimentId)),
  ).toBe(true)
  expect(guiBefore.results).toContain(seed.resultId)

  // Delete through the real UI so the local down-cascade runs. Scope to the
  // seeded experiment's card — earlier tests in this file left theirs behind.
  const card = page
    .locator("main .mantine-Paper-root")
    .filter({ hasText: seed.names.experiment })
    .last()
  await expect(card).toBeVisible({ timeout: 15_000 })
  await card.getByRole("button", { name: "Delete experiment" }).click()
  await page.getByRole("button", { name: "Delete", exact: true }).click()

  // Immediately — no reload — the experiment AND its cascaded result are gone
  // from the app's arrays, so no list or picker can offer them.
  await expect
    .poll(async () => (await guiState(page)).experiments.length, {
      timeout: 15_000,
    })
    .toBe(guiBefore.experiments.length - 1)
  const afterDelete = await guiState(page)
  expect(
    afterDelete.experiments.some((e) => e.startsWith(seed.experimentId)),
  ).toBe(false)
  expect(
    afterDelete.results,
    "cascaded result still in local state",
  ).not.toContain(seed.resultId)
  const refsAfterDelete = afterDelete.planes
    .find((p) => p.id === seed.planeId)
    ?.collections.find((c) => c.id === seed.collectionId)?.refs
  expect(refsAfterDelete).not.toContain(`experiment:${seed.experimentId}`)
  expect(refsAfterDelete).not.toContain(`result:${seed.resultId}`)

  // …and restoring puts both back under the same process and collection.
  await restoreFromTrashPage(page, seed.names.experiment)
  expect(await guiState(page)).toEqual(guiBefore)

  await settleSaves(page)
  await page.reload()
  await waitForApp(page, seed.planeId)
  expect(await guiState(page)).toEqual(guiBefore)
})

test("orphan restore: original plane gone → user picks a destination", async ({
  authedPage: page,
  authToken,
}) => {
  const stamp = Date.now()
  const seed = await seedBranch(authToken, `orphan-${stamp}`)
  const destinationId = crypto.randomUUID()
  const destinationName = `Destination plane ${stamp}`
  await apiClient(authToken).post("/planes/", {
    id: destinationId,
    name: destinationName,
  })

  // Delete the collection, then the plane it lived on: its home is gone.
  await trashViaApi(authToken, "collection", seed.collectionId)
  await trashViaApi(authToken, "plane", seed.planeId)

  await activatePlane(page, destinationId)
  await page.goto("/organization")
  await waitForApp(page, destinationId)

  await page.goto("/trash")
  const row = page.getByRole("row").filter({ hasText: seed.names.collection })
  await expect(row).toBeVisible({ timeout: 15_000 })
  await row.getByRole("button", { name: "Restore" }).click()

  // The destination picker appears because the original plane is gone. Pick the
  // destination explicitly — the Select defaults to planes[0], which after the
  // earlier tests in this serial file is some other accumulated plane, not ours.
  const dialog = page.getByRole("dialog")
  await expect(dialog.getByText("Choose a plane")).toBeVisible()
  const selectInput = dialog.locator("input:not([type=hidden])")
  // The dropdown renders over the modal footer and fades in, so a single click
  // on the option can be swallowed mid-transition (the option ends up covered by
  // the Cancel button). Retry open→select until the value actually sticks —
  // otherwise the restore silently lands on the default plane and the re-home
  // assertion below fails intermittently.
  await expect(async () => {
    await selectInput.click()
    await page
      .getByRole("option", { name: destinationName, exact: true })
      .click({ force: true })
    await expect(selectInput).toHaveValue(destinationName, { timeout: 2_000 })
  }).toPass({ timeout: 15_000 })
  // Let the dropdown close and the modal layout settle before confirming, else
  // the footer button re-renders mid-click and detaches.
  await expect(page.getByRole("listbox")).toBeHidden()
  await dialog
    .getByRole("button", { name: "Restore here" })
    .click({ force: true })
  await expect(page.getByText("Restored", { exact: false })).toBeVisible({
    timeout: 15_000,
  })

  // The collection kept its identity and members, re-homed onto the destination.
  const afterRestore = await guiState(page)
  const rehomed = afterRestore.planes
    .find((p) => p.id === destinationId)
    ?.collections.find((c) => c.id === seed.collectionId)
  expect(
    rehomed,
    "collection was not re-homed onto the chosen plane",
  ).toBeTruthy()
  expect(rehomed?.refs).toEqual(
    expect.arrayContaining([
      `process:${seed.processId}`,
      `experiment:${seed.experimentId}`,
      `result:${seed.resultId}`,
    ]),
  )

  await settleSaves(page)
  await page.reload()
  await waitForApp(page, destinationId)
  expect(await guiState(page)).toEqual(afterRestore)
})
