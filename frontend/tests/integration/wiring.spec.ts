import { expect, test } from "./fixtures"
import { apiClient } from "./utils/api"

const FRONTEND_BASE_URL =
  process.env.FRONTEND_BASE_URL ?? "http://localhost:5174"

// The real GUI routes (the _gui layout is pathless, so these are top-level).
const GUI_ROUTES = [
  "/processes",
  "/experiments",
  "/results",
  "/analysis",
  "/organization",
  "/export",
]

test("every main GUI route loads while authenticated (no bounce to login)", async ({
  authedPage,
}) => {
  for (const route of GUI_ROUTES) {
    await authedPage.goto(`${FRONTEND_BASE_URL}${route}`)
    // ensureAuthenticated would redirect to /login if the session were
    // rejected; staying on the route proves the injected JWT is accepted and
    // readUserMe() succeeded against the backend.
    await expect(
      authedPage,
      `route ${route} should stay authenticated`,
    ).toHaveURL(new RegExp(route), { timeout: 15_000 })
  }
})

test("an experiment seeded via the API is loaded into the experiments view", async ({
  authedPage,
  authToken,
}) => {
  const api = apiClient(authToken)
  const name = `E2E-Experiment-${Date.now()}`
  const exp = await api.createExperiment({ name })

  try {
    await authedPage.goto(`${FRONTEND_BASE_URL}/experiments`)
    // The GUI bulk-loads all entities from the backend on boot; the seeded
    // experiment must therefore render in the experiments view.
    await expect(authedPage.getByText(name).first()).toBeVisible({
      timeout: 20_000,
    })
  } finally {
    await api.delete(`/experiments/${exp.id}`)
  }
})

test("a material seeded via the API is returned by the backend the GUI reads from", async ({
  authToken,
}) => {
  // Direct round-trip against the same endpoints the GUI uses, asserting the
  // create → read path the frontend depends on is wired correctly.
  const api = apiClient(authToken)
  const name = `E2E-Material-${Date.now()}`
  const mat = await api.createMaterial({ name, type: "substrate" })

  try {
    const list = await api.get<{ data: Array<{ id: string; name: string }> }>(
      "/materials/?limit=200",
    )
    expect(list.data.some((m) => m.name === name)).toBe(true)
  } finally {
    await api.delete(`/materials/${mat.id}`)
  }
})
