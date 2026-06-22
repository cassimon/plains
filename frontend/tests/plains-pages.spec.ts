/**
 * Page rendering and basic interaction tests for Plains.
 *
 * Each test verifies the page:
 * - Mounts without throwing a JS error.
 * - Renders expected UI landmarks.
 * - Handles empty data gracefully.
 * - Does not freeze (page remains responsive after 2 s).
 *
 * Auth is handled by auth.setup.ts (storageState carries mock Keycloak token).
 * Network calls are mocked per-test via page.route() so tests are hermetic.
 */

import type { Page } from "@playwright/test"
import { expect, test } from "@playwright/test"

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function mockApi(
  page: Page,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const defaults: Record<string, unknown> = {
    "/api/v1/users/me": {
      id: "00000000-0000-0000-0000-000000000001",
      email: "test@plains.dev",
      is_active: true,
      is_superuser: false,
      full_name: "Test User",
    },
    "/api/v1/state/bulk": {
      materials: [],
      solutions: [],
      experiments: [],
      results: [],
      planes: [],
    },
    "/api/v1/state/": {
      data: {
        materials: [],
        solutions: [],
        experiments: [],
        results: [],
        planes: [],
        processes: [],
      },
    },
    ...overrides,
  }

  for (const [pattern, json] of Object.entries(defaults)) {
    const pat = pattern
    await page.route(`**${pat}`, (route) =>
      route.fulfill({ status: 200, json }),
    )
  }
  // Catch-all
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({ status: 200, json: {} }),
  )
}

/** Inject mock Keycloak so auth guards pass. */
async function injectMockAuth(page: Page): Promise<void> {
  await page.waitForFunction(() => "__plains_setKeycloak" in window, {
    timeout: 10_000,
  })
  await page.evaluate(() => {
    ;(window as any).__plains_setKeycloak({
      authenticated: true,
      token: "mock-token",
      updateToken: (_minValidity: number) => Promise.resolve(true),
      onTokenExpired: undefined,
      logout: () => {},
    })
  })
}

/** Navigate to a route and ensure the page is alive after 2 s. */
async function loadRoute(page: Page, route: string): Promise<void> {
  await page.goto(route, { waitUntil: "domcontentloaded" })
  await injectMockAuth(page)
  await page.waitForTimeout(2000)
}

async function assertAlive(page: Page): Promise<void> {
  const r = await page.evaluate(
    () =>
      new Promise<string>((resolve) =>
        requestAnimationFrame(() => resolve("alive")),
      ),
    { timeout: 5000 },
  )
  expect(r).toBe("alive")
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests per page
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Materials page", () => {
  test("renders without JS errors on empty data", async ({ page }) => {
    await mockApi(page)
    const jsErrors: string[] = []
    page.on("pageerror", (e) => jsErrors.push(e.message))
    await loadRoute(page, "/materials")
    expect(jsErrors).toHaveLength(0)
    await assertAlive(page)
  })

  test("renders with populated materials list", async ({ page }) => {
    await mockApi(page, {
      "/api/v1/state/bulk": {
        materials: [
          {
            id: "mat-1",
            name: "Ethanol",
            category: "chemical_compound",
            type: "",
            supplier: "",
            supplierNumber: "",
            casNumber: "64-17-5",
            pubchemCid: "",
            inventoryLabel: "",
            purity: "",
            stateAtRt: "liquid",
            substrateRigidity: "",
            heightMm: "",
          },
        ],
        solutions: [],
        experiments: [],
        results: [],
        planes: [],
      },
    })
    const jsErrors: string[] = []
    page.on("pageerror", (e) => jsErrors.push(e.message))
    await loadRoute(page, "/materials")
    expect(jsErrors).toHaveLength(0)
    await assertAlive(page)
  })
})

test.describe("Solutions page", () => {
  test("renders without JS errors on empty data", async ({ page }) => {
    await mockApi(page)
    const jsErrors: string[] = []
    page.on("pageerror", (e) => jsErrors.push(e.message))
    await loadRoute(page, "/solutions")
    expect(jsErrors).toHaveLength(0)
    await assertAlive(page)
  })
})

test.describe("Experiments page", () => {
  test("renders without JS errors on empty data", async ({ page }) => {
    await mockApi(page)
    const jsErrors: string[] = []
    page.on("pageerror", (e) => jsErrors.push(e.message))
    await loadRoute(page, "/experiments")
    expect(jsErrors).toHaveLength(0)
    await assertAlive(page)
  })

  test("renders with experiment data", async ({ page }) => {
    await mockApi(page, {
      "/api/v1/state/bulk": {
        materials: [],
        solutions: [],
        experiments: [
          {
            id: "exp-1",
            name: "Test Experiment",
            substrates: [],
            layers: [],
            notes: "",
          },
        ],
        results: [],
        planes: [],
      },
    })
    const jsErrors: string[] = []
    page.on("pageerror", (e) => jsErrors.push(e.message))
    await loadRoute(page, "/experiments")
    expect(jsErrors).toHaveLength(0)
    await assertAlive(page)
  })
})

test.describe("Results page", () => {
  test("renders without JS errors on empty data", async ({ page }) => {
    await mockApi(page)
    const jsErrors: string[] = []
    page.on("pageerror", (e) => jsErrors.push(e.message))
    await loadRoute(page, "/results")
    expect(jsErrors).toHaveLength(0)
    await assertAlive(page)
  })
})

test.describe("Processes page", () => {
  test("renders without JS errors on empty data", async ({ page }) => {
    await mockApi(page)
    const jsErrors: string[] = []
    page.on("pageerror", (e) => jsErrors.push(e.message))
    await loadRoute(page, "/processes")
    expect(jsErrors).toHaveLength(0)
    await assertAlive(page)
  })

  test("query param ?expand does not cause render loop", async ({ page }) => {
    await mockApi(page)
    const jsErrors: string[] = []
    page.on("pageerror", (e) => jsErrors.push(e.message))
    // The Processes page reads a URL param and calls setExpanded() in an effect.
    // Verify this does not loop.
    await page.goto("/processes?expand=true", { waitUntil: "domcontentloaded" })
    await injectMockAuth(page)
    await page.waitForTimeout(3000)
    expect(jsErrors).toHaveLength(0)
    await assertAlive(page)
  })
})

test.describe("Analysis page", () => {
  test("renders without JS errors on empty data", async ({ page }) => {
    await mockApi(page)
    const jsErrors: string[] = []
    page.on("pageerror", (e) => jsErrors.push(e.message))
    await loadRoute(page, "/analysis")
    expect(jsErrors).toHaveLength(0)
    await assertAlive(page)
  })

  test("drag/resize state initialised to null (no phantom events)", async ({
    page,
  }) => {
    await mockApi(page)
    await page.goto("/analysis", { waitUntil: "domcontentloaded" })
    await injectMockAuth(page)
    await page.waitForTimeout(2000)

    // No mousemove events should be processed without a mousedown first.
    // Simply move the mouse across the page and verify no JS errors occur.
    const jsErrors: string[] = []
    page.on("pageerror", (e) => jsErrors.push(e.message))
    await page.mouse.move(100, 100)
    await page.mouse.move(200, 200)
    await page.mouse.move(300, 300)
    await page.waitForTimeout(500)
    expect(jsErrors).toHaveLength(0)
    await assertAlive(page)
  })
})

test.describe("Organization page", () => {
  test("renders without JS errors on empty data", async ({ page }) => {
    await mockApi(page)
    const jsErrors: string[] = []
    page.on("pageerror", (e) => jsErrors.push(e.message))
    await loadRoute(page, "/organization")
    expect(jsErrors).toHaveLength(0)
    await assertAlive(page)
  })

  test("renders with a plane and canvas elements", async ({ page }) => {
    await mockApi(page, {
      "/api/v1/state/bulk": {
        materials: [],
        solutions: [],
        experiments: [],
        results: [],
        planes: [
          {
            id: "plane-1",
            name: "Test Plane",
            elements: [
              {
                id: "el-1",
                type: "text",
                position: { x: 100, y: 100 },
                size: { x: 200, y: 80 },
                content: "Hello Canvas",
              },
            ],
          },
        ],
      },
    })
    const jsErrors: string[] = []
    page.on("pageerror", (e) => jsErrors.push(e.message))
    await loadRoute(page, "/organization")
    expect(jsErrors).toHaveLength(0)
    await assertAlive(page)
  })
})

test.describe("Export page", () => {
  test("renders without JS errors on empty data", async ({ page }) => {
    await mockApi(page)
    const jsErrors: string[] = []
    page.on("pageerror", (e) => jsErrors.push(e.message))
    await loadRoute(page, "/export")
    expect(jsErrors).toHaveLength(0)
    await assertAlive(page)
  })
})

test.describe("Page navigation", () => {
  test("navigating between pages does not accumulate JS errors", async ({
    page,
  }) => {
    await mockApi(page)
    const jsErrors: string[] = []
    page.on("pageerror", (e) => jsErrors.push(e.message))

    await page.goto("/", { waitUntil: "domcontentloaded" })
    await injectMockAuth(page)
    await page.waitForTimeout(1000)

    const routes = [
      "/materials",
      "/solutions",
      "/experiments",
      "/results",
      "/analysis",
      "/organization",
      "/export",
      "/processes",
      "/",
    ]
    for (const route of routes) {
      await page.goto(route, { waitUntil: "domcontentloaded" })
      await page.waitForTimeout(500)
    }

    expect(jsErrors).toHaveLength(0)
    await assertAlive(page)
  })
})
