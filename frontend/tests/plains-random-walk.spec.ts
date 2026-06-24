/**
 * Random-walk Playwright tests for Plains.
 *
 * KEY DESIGN DECISION:
 * The app's auth state (_keycloak) lives in JS module memory.
 * page.goto() resets all JS state, so we only use it once (for initial load).
 * All in-walk navigation uses history.pushState + popstate events so the
 * _keycloak singleton is never cleared during a walk.
 *
 * Strategy:
 *  - Start: navigate to /login, inject mock Keycloak, then pushState to app routes.
 *  - Each step: pick a random action (click, type, hover, drag, navigate via pushState).
 *  - Collect all console errors and JS exceptions.
 *  - Detect React loop patterns in real time.
 *  - Assert page is still interactive (rAF fires within 500ms) after every step.
 */
import { type ConsoleMessage, expect, type Page, test } from "@playwright/test"

// ─────────────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────────────

const LOOP_PATTERNS = [
  /maximum update depth exceeded/i,
  /too many re-renders/i,
  /cannot update a component.*while rendering a different component/i,
  /rendered more hooks than during the previous render/i,
  /react has detected a change in the order of hooks/i,
]

const NOISE_PATTERNS = [
  /favicon/i,
  /net::ERR_/,
  /Failed to load resource/i,
  /\b404\b/,
  /Cross-Origin/i,
  /Keycloak init failed/i, // expected: mock URL can't be contacted
  /\[HttpBackend\] save network error/i, // expected: /api/v1/state writes not mocked
  /\[Auth\] readUserMe/i, // verbose but not an error
  /\[Keycloak\]/i, // keycloak diagnostic logs
  /\[Login\]/i, // login page logs
  /\[Auth\]/i, // auth diagnostic logs
]

const ROUTES = [
  "/",
  "/materials",
  "/solutions",
  "/processes",
  "/experiments",
  "/results",
  "/analysis",
  "/organization",
  "/export",
]

// Seeded PRNG — deterministic and reproducible per seed
function mulberry32(initialSeed: number) {
  let seed = initialSeed
  return () => {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Scale configuration
// ─────────────────────────────────────────────────────────────────────────────
//
// The number of fuzz walks is parameterised so the same spec serves both fast
// local/CI runs and exhaustive "run it a lot of times" fuzzing sessions:
//
//   WALK_COUNT  — how many full-app fuzz walks to generate (default 25)
//   WALK_STEPS  — steps per generated walk            (default 60)
//   WALK_BASE_SEED — base seed for reproducible seed generation (default 0)
//
// Example exhaustive run:
//   WALK_COUNT=500 WALK_STEPS=80 bunx playwright test plains-random-walk
//
// Every generated walk gets a distinct, reproducible seed, so a failure can be
// replayed exactly by reading the seed from the test name.
const intFromEnv = (name: string, fallback: number): number => {
  const raw = process.env[name]
  if (!raw) return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const WALK_COUNT = intFromEnv("WALK_COUNT", 25)
const WALK_STEPS = intFromEnv("WALK_STEPS", 60)
const WALK_BASE_SEED = intFromEnv("WALK_BASE_SEED", 0)

/**
 * Generate `count` reproducible, well-distributed seeds. Seeds are derived from
 * a base via a mulberry32 stream so they spread across the 32-bit space rather
 * than clustering (sequential seeds produce correlated early draws).
 */
function generateSeeds(count: number, baseSeed: number): number[] {
  const stream = mulberry32(baseSeed + 0x9e3779b9)
  const seeds: number[] = []
  for (let i = 0; i < count; i++) {
    seeds.push(Math.floor(stream() * 0xffffffff) >>> 0)
  }
  return seeds
}

// ─────────────────────────────────────────────────────────────────────────────
// Error collection
// ─────────────────────────────────────────────────────────────────────────────

interface ErrorRecord {
  type:
    | "loop"
    | "js_error"
    | "console_error"
    | "unhandled_rejection"
    | "timeout"
  message: string
  route: string
  step: number
}

interface WalkCollector {
  errors: ErrorRecord[]
  route: string
  step: number
  onConsole(msg: ConsoleMessage): void
  onPageError(err: Error): void
}

function makeCollector(initialRoute: string): WalkCollector {
  const c: WalkCollector = {
    errors: [],
    route: initialRoute,
    step: 0,
    onConsole(msg) {
      if (msg.type() !== "error" && msg.type() !== "warning") return
      const text = msg.text()
      if (NOISE_PATTERNS.some((p) => p.test(text))) return
      if (LOOP_PATTERNS.some((p) => p.test(text))) {
        c.errors.push({
          type: "loop",
          message: text.slice(0, 400),
          route: c.route,
          step: c.step,
        })
      } else if (/uncaught|unhandled promise/i.test(text)) {
        c.errors.push({
          type: "unhandled_rejection",
          message: text.slice(0, 400),
          route: c.route,
          step: c.step,
        })
      } else if (msg.type() === "error") {
        c.errors.push({
          type: "console_error",
          message: text.slice(0, 400),
          route: c.route,
          step: c.step,
        })
      }
    },
    onPageError(err) {
      const msg = err.message
      if (LOOP_PATTERNS.some((p) => p.test(msg))) {
        c.errors.push({
          type: "loop",
          message: msg.slice(0, 400),
          route: c.route,
          step: c.step,
        })
      } else if (NOISE_PATTERNS.some((p) => p.test(msg))) {
        // skip
      } else {
        c.errors.push({
          type: "js_error",
          message: msg.slice(0, 400),
          route: c.route,
          step: c.step,
        })
      }
    },
  }
  return c
}

// ─────────────────────────────────────────────────────────────────────────────
// Network & auth helpers
// ─────────────────────────────────────────────────────────────────────────────

async function setupMocks(page: Page) {
  const MOCK_USER = {
    id: "00000000-0000-0000-0000-000000000001",
    email: "test@plains.dev",
    is_active: true,
    is_superuser: true,
    full_name: "Playwright Walker",
  }
  const BULK = {
    materials: [
      {
        id: "mat-1",
        name: "Ethanol",
        category: "chemical_compound",
        type: "",
        supplier: "Sigma",
        supplierNumber: "",
        casNumber: "64-17-5",
        pubchemCid: "",
        inventoryLabel: "",
        purity: "99%",
        stateAtRt: "liquid",
        substrateRigidity: "",
        heightMm: "",
      },
      {
        id: "mat-2",
        name: "ITO Glass",
        category: "substrate_material",
        type: "",
        supplier: "Ossila",
        supplierNumber: "",
        casNumber: "",
        pubchemCid: "",
        inventoryLabel: "",
        purity: "",
        stateAtRt: "",
        substrateRigidity: "rigid",
        heightMm: "1.1",
      },
    ],
    solutions: [
      {
        id: "sol-1",
        name: "Perovskite Ink",
        components: [{ material_id: "mat-1", amount: 100, unit: "mg" }],
      },
    ],
    experiments: [
      {
        id: "exp-1",
        name: "Run A",
        substrates: [],
        layers: [],
        notes: "test run",
      },
      { id: "exp-2", name: "Run B", substrates: [], layers: [], notes: "" },
    ],
    results: [
      {
        id: "res-1",
        experiment_id: "exp-1",
        measurement_files: [],
        device_groups: [],
      },
    ],
    planes: [
      {
        id: "plane-1",
        name: "Overview",
        elements: [
          {
            id: "el-1",
            type: "text",
            position: { x: 100, y: 100 },
            size: { x: 200, y: 60 },
            content: "Hello Canvas",
          },
          {
            id: "el-2",
            type: "experiment",
            position: { x: 350, y: 100 },
            size: { x: 200, y: 120 },
            content: "exp-1",
          },
        ],
      },
    ],
  }

  // Mocked Keycloak OIDC discovery endpoint so login.tsx doesn't get a fetch error
  await page.route("**/.well-known/openid-configuration*", (r) =>
    r.fulfill({
      status: 200,
      json: {
        authorization_endpoint: "http://mock-keycloak/auth",
        token_endpoint: "http://mock-keycloak/token",
        issuer: "http://mock-keycloak/realms/mock",
        jwks_uri: "http://mock-keycloak/jwks",
        end_session_endpoint: "http://mock-keycloak/logout",
      },
    }),
  )
  await page.route("**/api/v1/auth/config", (r) =>
    r.fulfill({
      status: 200,
      json: {
        keycloak_url: "http://mock-keycloak",
        keycloak_realm: "mock",
        keycloak_client_id: "plains",
      },
    }),
  )
  await page.route("**/api/v1/users/me", (r) =>
    r.fulfill({ status: 200, json: MOCK_USER }),
  )
  await page.route("**/api/v1/state/bulk", (r) =>
    r.fulfill({ status: 200, json: BULK }),
  )
  await page.route("**/api/v1/state/**", (r) =>
    r.fulfill({ status: 200, json: { data: { ...BULK, processes: [] } } }),
  )
  await page.route("**/api/v1/materials*", (r) =>
    r.fulfill({
      status: 200,
      json: { data: BULK.materials, count: BULK.materials.length },
    }),
  )
  await page.route("**/api/v1/solutions*", (r) =>
    r.fulfill({
      status: 200,
      json: { data: BULK.solutions, count: BULK.solutions.length },
    }),
  )
  await page.route("**/api/v1/experiments*", (r) =>
    r.fulfill({
      status: 200,
      json: { data: BULK.experiments, count: BULK.experiments.length },
    }),
  )
  await page.route("**/api/v1/results*", (r) =>
    r.fulfill({
      status: 200,
      json: { data: BULK.results, count: BULK.results.length },
    }),
  )
  await page.route("**/api/v1/planes*", (r) =>
    r.fulfill({
      status: 200,
      json: { data: BULK.planes, count: BULK.planes.length },
    }),
  )
  // Catch-all: return empty success for anything else (NOMAD, etc.)
  await page.route("**/api/v1/**", (r) => r.fulfill({ status: 200, json: {} }))
}

/** Inject a mock Keycloak instance that appears fully authenticated. */
async function injectAuth(page: Page) {
  await page.waitForFunction(() => "__plains_setKeycloak" in window, {
    timeout: 10_000,
  })
  await page.evaluate(() => {
    ;(window as any).__plains_setKeycloak({
      authenticated: true,
      token: "mock-walk-token",
      updateToken: () => Promise.resolve(true),
      onTokenExpired: undefined,
      // noop so clicking "Login with NOMAD" button doesn't crash
      login: (_opts: unknown) => {},
      logout: (_opts: unknown) => {},
    })
  })
}

/**
 * Navigate within the SPA using history.pushState + popstate.
 * This is the ONLY safe way to navigate during a walk because page.goto()
 * would reset the JS context and clear _keycloak.
 */
async function clientNavigate(page: Page, route: string) {
  await page.evaluate((r: string) => {
    window.history.pushState({}, "", r)
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }))
  }, route)
  // Give TanStack Router time to process the route change
  await page.waitForTimeout(600)
}

async function assertResponsive(
  page: Page,
  collector: WalkCollector,
): Promise<boolean> {
  try {
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const id = setTimeout(() => reject(new Error("rAF timeout")), 500)
          requestAnimationFrame(() => {
            clearTimeout(id)
            resolve()
          })
        }),
      { timeout: 2000 },
    )
    return true
  } catch {
    collector.errors.push({
      type: "timeout",
      message:
        "requestAnimationFrame did not fire within 500ms — page may be frozen",
      route: collector.route,
      step: collector.step,
    })
    return false
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Walk engine
// ─────────────────────────────────────────────────────────────────────────────

async function randomWalk(
  page: Page,
  seed: number,
  steps: number,
  collector: WalkCollector,
  startRouteOverride?: string,
) {
  const rng = mulberry32(seed)

  // Navigate to start route via pushState (no page reload → _keycloak preserved)
  const startRoute =
    startRouteOverride ?? ROUTES[Math.floor(rng() * ROUTES.length)]
  collector.route = startRoute
  await clientNavigate(page, startRoute)
  await page.waitForTimeout(500)

  for (let i = 0; i < steps; i++) {
    collector.step = i
    if (!(await assertResponsive(page, collector))) break

    const action = rng()

    if (action < 0.18) {
      // ── Client-side route change ────────────────────────────────────────────
      const route = ROUTES[Math.floor(rng() * ROUTES.length)]
      collector.route = route
      await clientNavigate(page, route)
    } else if (action < 0.44) {
      // ── Click a random visible interactive element ──────────────────────────
      try {
        const clickables = await page
          .locator(
            "button:visible, a[href]:visible, [role=button]:visible, [role=tab]:visible, [role=option]:visible",
          )
          .all()
        if (clickables.length > 0) {
          const el = clickables[Math.floor(rng() * clickables.length)]
          await el.click({ timeout: 2000, force: false }).catch(() => {})
          await page.waitForTimeout(250)
        }
      } catch {
        /* ignore stale handles */
      }
    } else if (action < 0.58) {
      // ── Type into a random visible text field ───────────────────────────────
      try {
        const inputs = await page
          .locator(
            "input[type=text]:visible, input:not([type]):visible, textarea:visible",
          )
          .all()
        if (inputs.length > 0) {
          const el = inputs[Math.floor(rng() * inputs.length)]
          await el.click({ timeout: 1000 }).catch(() => {})
          await el.fill(`rnd-${i}`).catch(() => {})
          await page.waitForTimeout(150)
          await page.keyboard.press("Escape")
        }
      } catch {
        /* ignore */
      }
    } else if (action < 0.7) {
      // ── Escape key (close modals / dropdowns) ───────────────────────────────
      await page.keyboard.press("Escape")
      await page.waitForTimeout(150)
    } else if (action < 0.82) {
      // ── Hover a random element ──────────────────────────────────────────────
      try {
        const all = await page
          .locator("button:visible, nav a:visible, [role=menuitem]:visible")
          .all()
        if (all.length > 0) {
          const el = all[Math.floor(rng() * all.length)]
          await el.hover({ timeout: 1000 }).catch(() => {})
          await page.waitForTimeout(120)
        }
      } catch {
        /* ignore */
      }
    } else {
      // ── Mouse drag gesture (canvas / drag-drop) ─────────────────────────────
      try {
        const vw = await page.evaluate(() => window.innerWidth)
        const vh = await page.evaluate(() => window.innerHeight)
        const x1 = 80 + Math.floor(rng() * (vw - 160))
        const y1 = 80 + Math.floor(rng() * (vh - 160))
        const dx = Math.floor(rng() * 300 - 150)
        const dy = Math.floor(rng() * 300 - 150)
        await page.mouse.move(x1, y1)
        await page.mouse.down()
        await page.mouse.move(x1 + dx, y1 + dy, { steps: 6 })
        await page.mouse.up()
        await page.waitForTimeout(200)
      } catch {
        /* ignore */
      }
    }

    await page.waitForTimeout(60)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot sequence shared by all tests
// ─────────────────────────────────────────────────────────────────────────────

async function bootWalk(page: Page, collector: WalkCollector) {
  page.on("console", (msg) => collector.onConsole(msg))
  page.on("pageerror", (err) => collector.onPageError(err))
  await setupMocks(page)
  // Load the SPA once via /login (doesn't trigger auth guard)
  await page.goto("/login", { waitUntil: "domcontentloaded" })
  await injectAuth(page)
  // Navigate to home via pushState so auth guard runs with _keycloak set
  await clientNavigate(page, "/")
  await page.waitForTimeout(800)
}

function summarise(walk: string, collector: WalkCollector) {
  if (collector.errors.length === 0) return
  const report = collector.errors
    .map((e) => `[step=${e.step}][route=${e.route}][${e.type}] ${e.message}`)
    .join("\n")
  test.info().annotations.push({ type: "walk-errors", description: report })
  console.error(`\n=== ERRORS in ${walk} ===\n${report}\n`)
}

function assertNoHardErrors(collector: WalkCollector) {
  const hard = collector.errors.filter(
    (e) =>
      e.type === "loop" ||
      e.type === "unhandled_rejection" ||
      e.type === "timeout",
  )
  if (hard.length > 0) {
    const msg = hard
      .map((e) => `[${e.type}@step${e.step}@${e.route}] ${e.message}`)
      .join("\n")
    expect.soft(hard, `Hard errors:\n${msg}`).toHaveLength(0)
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Full-app random walks
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Random-walk: full app", () => {
  // Generate WALK_COUNT distinct, reproducible fuzz walks. Each seed is encoded
  // in the test name so any failure can be replayed via WALK_BASE_SEED + index,
  // or by pinning the printed seed directly.
  const seeds = generateSeeds(WALK_COUNT, WALK_BASE_SEED)

  for (let i = 0; i < seeds.length; i++) {
    const seed = seeds[i]
    const label = `walk-${i + 1}/${WALK_COUNT} (seed=${seed}, ${WALK_STEPS} steps)`
    test(label, async ({ page }) => {
      const collector = makeCollector("/")
      await bootWalk(page, collector)
      await randomWalk(page, seed, WALK_STEPS, collector)
      summarise(label, collector)
      assertNoHardErrors(collector)
    })
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Focused walks on loop-prone pages
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Random-walk: focused pages", () => {
  // The most loop-prone routes (canvas, analysis, nested tables) get repeated
  // fuzzing. WALK_FOCUSED_REPEATS walks per route, each with a distinct seed.
  const FOCUSED_ROUTES = [
    "/analysis",
    "/organization",
    "/processes",
    "/experiments",
  ]
  const repeats = intFromEnv("WALK_FOCUSED_REPEATS", 2)

  for (const route of FOCUSED_ROUTES) {
    // Seed namespace per route, derived from base seed so runs are reproducible
    // yet independent from the full-app seed stream.
    const routeBase = WALK_BASE_SEED + route.length * 0x1000
    const seeds = generateSeeds(repeats, routeBase)
    for (let i = 0; i < seeds.length; i++) {
      const seed = seeds[i]
      const label = `focused${route} #${i + 1} (seed=${seed})`
      test(label, async ({ page }) => {
        const collector = makeCollector(route)
        await bootWalk(page, collector)
        await randomWalk(page, seed, 40, collector, route)
        summarise(label, collector)
        assertNoHardErrors(collector)
      })
    }
  }
})

// ─────────────────────────────────────────────────────────────────────────────
// Stress test
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Random-walk: stress test", () => {
  test("long walk (seed=9999, 200 steps)", async ({ page }) => {
    const collector = makeCollector("/")
    await bootWalk(page, collector)
    await randomWalk(page, 9999, 200, collector)
    summarise("long walk (seed=9999, 200 steps)", collector)
    assertNoHardErrors(collector)
  })
})
