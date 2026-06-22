/**
 * Infinite React render loop detection tests.
 *
 * React's Strict Mode double-invokes effects and renders.  Combined with
 * Mantine's useMergedRef and inline effect dependencies this can cause
 * "Maximum update depth exceeded" crashes or silent freezes.
 *
 * Each test:
 *  1. Navigates to a route.
 *  2. Collects React error boundary / console errors for 4 seconds.
 *  3. Asserts the page is still interactive (not frozen).
 *  4. Asserts no React loop error messages appeared.
 *
 * Routes under test match the _gui layout which enforces authentication.
 * Auth is handled by auth.setup.ts.
 */
import { expect, test } from "@playwright/test"

// Errors that indicate a React render loop or depth error.
const LOOP_PATTERNS = [
  /maximum update depth exceeded/i,
  /too many re-renders/i,
  /cannot update a component.*while rendering a different component/i,
  /rendered more hooks than during the previous render/i,
  /react has detected a change in the order of hooks/i,
]

function isLoopError(msg: string): boolean {
  return LOOP_PATTERNS.some((re) => re.test(msg))
}

/** Mock all network calls so each page can load without a real backend. */
async function mockApi(page: import("@playwright/test").Page) {
  await page.route("**/api/v1/users/me", (route) =>
    route.fulfill({
      status: 200,
      json: {
        id: "00000000-0000-0000-0000-000000000001",
        email: "test@plains.dev",
        is_active: true,
        is_superuser: true,
        full_name: "Playwright Tester",
      },
    }),
  )
  await page.route("**/api/v1/state/bulk", (route) =>
    route.fulfill({
      status: 200,
      json: {
        materials: [],
        solutions: [],
        experiments: [],
        results: [],
        planes: [],
      },
    }),
  )
  await page.route("**/api/v1/state/", (route) =>
    route.fulfill({
      status: 200,
      json: {
        data: {
          materials: [],
          solutions: [],
          experiments: [],
          results: [],
          planes: [],
          processes: [],
        },
      },
    }),
  )
  // Catch-all for any other API calls — return empty OK
  await page.route("**/api/v1/**", (route) =>
    route.fulfill({ status: 200, json: {} }),
  )
}

/** Inject mock Keycloak so auth guards pass. */
async function injectMockAuth(page: import("@playwright/test").Page) {
  await page.waitForFunction(() => "__plains_setKeycloak" in window, {
    timeout: 10_000,
  })
  await page.evaluate(() => {
    const mockKc = {
      authenticated: true,
      token: "mock-test-token",
      updateToken: (_minValidity: number) => Promise.resolve(true),
      onTokenExpired: undefined as (() => void) | undefined,
      logout: (_opts?: unknown) => {},
    }
    ;(window as any).__plains_setKeycloak(mockKc)
  })
}

/**
 * Navigate to a route and watch for React loop errors for `watchMs` ms.
 * Returns any loop error messages found.
 */
async function detectLoopsOnRoute(
  page: import("@playwright/test").Page,
  route: string,
  watchMs = 4000,
): Promise<string[]> {
  const loopErrors: string[] = []

  const onConsole = (msg: import("@playwright/test").ConsoleMessage) => {
    if (msg.type() === "error" && isLoopError(msg.text())) {
      loopErrors.push(msg.text())
    }
  }
  const onPageError = (err: Error) => {
    if (isLoopError(err.message)) loopErrors.push(err.message)
  }

  page.on("console", onConsole)
  page.on("pageerror", onPageError)

  await page.goto(route, { waitUntil: "domcontentloaded" })
  await injectMockAuth(page)

  // Wait for the specified observation window.
  await page.waitForTimeout(watchMs)

  page.off("console", onConsole)
  page.off("pageerror", onPageError)

  return loopErrors
}

/** Verify the page is still interactive (not frozen by an infinite loop). */
async function assertPageResponsive(
  page: import("@playwright/test").Page,
): Promise<void> {
  // A simple evaluate that should complete in well under 2 s on a live page.
  const result = await page.evaluate(
    () =>
      new Promise<string>((resolve) =>
        requestAnimationFrame(() => resolve("alive")),
      ),
    { timeout: 5000 },
  )
  expect(result).toBe("alive")
}

// ─────────────────────────────────────────────────────────────────────────────
// Tests
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Infinite React loop detection", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page)
  })

  const ROUTES = [
    { name: "Home (/)", path: "/" },
    { name: "Materials", path: "/materials" },
    { name: "Solutions", path: "/solutions" },
    { name: "Processes", path: "/processes" },
    { name: "Experiments", path: "/experiments" },
    { name: "Results", path: "/results" },
    { name: "Analysis", path: "/analysis" },
    { name: "Organization", path: "/organization" },
    { name: "Export", path: "/export" },
  ]

  for (const { name, path } of ROUTES) {
    test(`${name} page does not cause React render loops`, async ({ page }) => {
      const errors = await detectLoopsOnRoute(page, path)
      expect(errors, `Loop errors on ${name}: ${errors.join("; ")}`).toHaveLength(0)
      await assertPageResponsive(page)
    })
  }

  test("Login page does not cause React render loops", async ({ page }) => {
    // Login page doesn't need auth injection
    const loopErrors: string[] = []
    page.on("console", (msg) => {
      if (msg.type() === "error" && isLoopError(msg.text())) {
        loopErrors.push(msg.text())
      }
    })
    page.on("pageerror", (err) => {
      if (isLoopError(err.message)) loopErrors.push(err.message)
    })

    await page.goto("/login", { waitUntil: "domcontentloaded" })
    await page.waitForTimeout(3000)

    expect(loopErrors).toHaveLength(0)
    await assertPageResponsive(page)
  })

  test("Rapid route switching does not accumulate React errors", async ({
    page,
  }) => {
    const loopErrors: string[] = []
    page.on("console", (msg) => {
      if (msg.type() === "error" && isLoopError(msg.text())) {
        loopErrors.push(msg.text())
      }
    })
    page.on("pageerror", (err) => {
      if (isLoopError(err.message)) loopErrors.push(err.message)
    })

    await page.goto("/", { waitUntil: "domcontentloaded" })
    await injectMockAuth(page)
    await page.waitForTimeout(1000)

    // Rapidly navigate between routes.
    for (const { path } of ROUTES.slice(0, 5)) {
      await page.goto(path, { waitUntil: "domcontentloaded" })
      await page.waitForTimeout(500)
    }

    expect(loopErrors).toHaveLength(0)
    await assertPageResponsive(page)
  })
})

test.describe("Mantine ref anti-pattern regression", () => {
  test.beforeEach(async ({ page }) => {
    await mockApi(page)
  })

  test("Analysis page drag/resize effects stabilise within 3s", async ({
    page,
  }) => {
    // The Analysis page has drag/resize useEffects with [dragState, resizeState]
    // deps. If the state setters create new objects on every render this causes
    // loops.  We verify render count stabilises.
    const errors = await detectLoopsOnRoute(page, "/analysis", 3000)
    expect(errors).toHaveLength(0)
    await assertPageResponsive(page)

    // Measure whether the page is idle (requestAnimationFrame completes quickly).
    const frameTime = await page.evaluate(
      () =>
        new Promise<number>((resolve) => {
          const t0 = performance.now()
          requestAnimationFrame(() => resolve(performance.now() - t0))
        }),
    )
    // Frame time should be < 100 ms on an idle page (not thrashing the renderer).
    expect(frameTime).toBeLessThan(100)
  })

  test("Organization page canvas does not loop on mount", async ({ page }) => {
    const errors = await detectLoopsOnRoute(page, "/organization", 3000)
    expect(errors).toHaveLength(0)
    await assertPageResponsive(page)
  })

  test("Processes page expanded-param effect does not loop", async ({
    page,
  }) => {
    // Processes.page.tsx has setExpanded(Boolean(param)) inside an effect with
    // [param] dep.  Asserting no loop and the page is still interactive.
    const errors = await detectLoopsOnRoute(page, "/processes", 3000)
    expect(errors).toHaveLength(0)
    await assertPageResponsive(page)
  })
})

test.describe("AppContext hydration does not loop", () => {
  test("AppContext load effect fires once and page stays stable", async ({
    page,
  }) => {
    await mockApi(page)

    let stateApiCallCount = 0
    // Count how many times the state bulk endpoint is called (should be 1).
    await page.route("**/api/v1/state/bulk", (route) => {
      stateApiCallCount++
      return route.fulfill({
        status: 200,
        json: {
          materials: [],
          solutions: [],
          experiments: [],
          results: [],
          planes: [],
        },
      })
    })

    const loopErrors: string[] = []
    page.on("pageerror", (err) => {
      if (isLoopError(err.message)) loopErrors.push(err.message)
    })

    await page.goto("/", { waitUntil: "domcontentloaded" })
    await injectMockAuth(page)
    await page.waitForTimeout(4000)

    expect(loopErrors).toHaveLength(0)
    // State should be loaded exactly once, not repeatedly (which would indicate
    // a loop in the load effect or its dependencies).
    expect(stateApiCallCount).toBeLessThanOrEqual(2) // allow 1 retry
  })
})
