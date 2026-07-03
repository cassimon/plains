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
  // Normalised /state/bulk payload matching what the FastAPI backend serves
  // and what backendMapping.bulkToSnapshot() expects (snake_case rows with
  // collection_id FKs). The process is fully "spawnable": it has inline
  // substrates, steps, and a generated stack, so the walk can exercise the
  // create-Experiment-from-Process flow.
  const BULK = {
    processes: [
      {
        id: "proc-1",
        name: "Spin Coating Baseline",
        description: "Baseline perovskite deposition",
        skip_chemistry: false,
        collection_id: "col-1",
        substrate_dimensions: [],
        inline_substrates: [
          {
            id: "insub-1",
            name: "ITO glass",
            rigidity: "rigid",
            length_cm: "2.5",
            width_cm: "2.5",
            height_mm: "1.1",
          },
        ],
        steps: [
          {
            id: "step-1",
            stage_index: 0,
            step_index: 0,
            name: "Spin coat perovskite",
            step_category: "solution_deposition",
            color: "#8888ff",
          },
          {
            id: "step-2",
            stage_index: 1,
            step_index: 0,
            name: "Anneal",
            step_category: "thermal_treatment",
            color: "#ff8888",
          },
        ],
        stacks: [
          {
            id: "stack-1",
            combination: 1,
            is_deleted: false,
            architecture: "n-i-p",
            layers: [
              {
                id: "lay-1",
                layer_index: 0,
                name: "ITO glass",
                is_substrate: true,
                layer_type: "substrate",
              },
              {
                id: "lay-2",
                layer_index: 1,
                name: "Perovskite",
                is_substrate: false,
                layer_type: "absorber",
                thickness_nm: "500",
              },
            ],
          },
        ],
        recipes: [],
      },
    ],
    experiments: [
      {
        id: "exp-1",
        name: "Run A",
        description: "test run",
        date: "2026-06-01",
        architecture: "n-i-p",
        process_id: "proc-1",
        collection_id: "col-1",
        substrates: [
          { id: "sub-1", name: "substrate 1", outcome_status: "completed" },
        ],
      },
      {
        id: "exp-2",
        name: "Run B",
        description: "",
        process_id: "proc-1",
        collection_id: null,
        substrates: [],
      },
    ],
    results: [
      {
        id: "res-1",
        experiment_id: "exp-1",
        collection_id: "col-1",
        measurement_files: [],
        device_groups: [],
      },
    ],
    analyses: [],
    planes: [
      {
        id: "plane-1",
        name: "Overview",
        owner_id: "00000000-0000-0000-0000-000000000001",
        sticky_notes: [
          { id: "note-1", i: 100, j: 100, di: 60, dj: 200, content: "Hello" },
        ],
        text_fields: [],
        collections: [
          { id: "col-1", name: "Batch 1", i: 60, j: 400, color: "#ffaa00" },
        ],
      },
    ],
  }
  // Legacy list-endpoint fixtures (materials/solutions tabs fetch these).
  const MATERIALS = [
    {
      id: "mat-1",
      name: "Ethanol",
      category: "chemical_compound",
      supplier: "Sigma",
      cas_number: "64-17-5",
      purity: "99%",
      state_at_rt: "liquid",
    },
    {
      id: "mat-2",
      name: "ITO Glass",
      category: "substrate_material",
      supplier: "Ossila",
      substrate_rigidity: "rigid",
      height_mm: "1.1",
    },
  ]
  const SOLUTIONS = [
    {
      id: "sol-1",
      name: "Perovskite Ink",
      components: [{ material_id: "mat-1", amount: 100, unit: "mg" }],
    },
  ]

  // The app calls the API cross-origin (5173 → 8000), so every mock response
  // needs CORS headers or the browser rejects it with "Failed to fetch"
  // (breaking the HttpBackend save path during authenticated walks).
  const CORS = {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-allow-methods": "*",
  }
  const fulfillJson = (
    r: Parameters<Parameters<Page["route"]>[1]>[0],
    body: unknown,
  ) => r.fulfill({ status: 200, headers: CORS, json: body as any })

  // Catch-all FIRST: Playwright matches routes newest-first, so this must be
  // registered before the specific mocks or it would shadow all of them.
  await page.route("**/api/v1/**", (r) => fulfillJson(r, {}))

  // Mocked Keycloak OIDC discovery endpoint so login.tsx doesn't get a fetch error
  await page.route("**/.well-known/openid-configuration*", (r) =>
    fulfillJson(r, {
      authorization_endpoint: "http://mock-keycloak/auth",
      token_endpoint: "http://mock-keycloak/token",
      issuer: "http://mock-keycloak/realms/mock",
      jwks_uri: "http://mock-keycloak/jwks",
      end_session_endpoint: "http://mock-keycloak/logout",
    }),
  )
  await page.route("**/api/v1/auth/config", (r) =>
    fulfillJson(r, {
      keycloak_url: "http://mock-keycloak",
      keycloak_realm: "mock",
      keycloak_client_id: "plains",
    }),
  )
  await page.route("**/api/v1/users/me", (r) => fulfillJson(r, MOCK_USER))
  await page.route("**/api/v1/state/bulk", (r) => fulfillJson(r, BULK))
  await page.route("**/api/v1/materials*", (r) =>
    fulfillJson(r, { data: MATERIALS, count: MATERIALS.length }),
  )
  await page.route("**/api/v1/solutions*", (r) =>
    fulfillJson(r, { data: SOLUTIONS, count: SOLUTIONS.length }),
  )
  await page.route("**/api/v1/experiments*", (r) =>
    fulfillJson(r, { data: BULK.experiments, count: BULK.experiments.length }),
  )
  await page.route("**/api/v1/results*", (r) =>
    fulfillJson(r, { data: BULK.results, count: BULK.results.length }),
  )
  await page.route("**/api/v1/planes*", (r) =>
    fulfillJson(r, { data: BULK.planes, count: BULK.planes.length }),
  )
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
  // A previous random click may have followed a real link (external href,
  // login redirect, chrome error page) and left the SPA origin entirely —
  // pushState then throws a SecurityError. Recover by re-entering the app.
  if (!page.url().startsWith("http://localhost")) {
    await page.goto("/login", { waitUntil: "domcontentloaded" }).catch(() => {})
    await injectAuth(page).catch(() => {})
  }
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
          // 1.5s budget: a genuine render loop blocks the main thread for far
          // longer, while heavy-but-legitimate renders (canvas, big tables)
          // under parallel test workers regularly exceed 500ms.
          const id = setTimeout(() => reject(new Error("rAF timeout")), 1500)
          requestAnimationFrame(() => {
            clearTimeout(id)
            resolve()
          })
        }),
      { timeout: 4000 },
    )
    return true
  } catch {
    collector.errors.push({
      type: "timeout",
      message:
        "requestAnimationFrame did not fire within 1500ms — page may be frozen",
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
            // Exclude external links — following one leaves the SPA origin
            // and kills the walk (auth lives in JS module memory).
            'button:visible, a[href]:not([href^="http"]):not([target="_blank"]):visible, [role=button]:visible, [role=tab]:visible, [role=option]:visible',
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
  // The login page runs keycloak.init() asynchronously and then calls
  // setKeycloak(realInstance, authenticated:false). If we inject the mock
  // before that resolves, the real (unauthenticated) instance clobbers it and
  // the walk silently runs logged-out against InMemoryBackend. Wait for init
  // to settle before injecting.
  const initSettled = page
    .waitForEvent("console", {
      predicate: (m) =>
        /\[Login\] (Keycloak instance stored globally|User is NOT authenticated|keycloak\.init\(\) completed)|Keycloak init failed/.test(
          m.text(),
        ),
      timeout: 8000,
    })
    .catch(() => null)
  // Load the SPA once via /login (doesn't trigger auth guard)
  await page.goto("/login", { waitUntil: "domcontentloaded" })
  await initSettled
  // Inject + navigate, retrying if a late keycloak.init() resolution clobbers
  // the injected mock (the guard then bounces us back to /login). A logged-out
  // walk tests nothing, so this must not pass silently.
  for (let attempt = 0; ; attempt++) {
    await injectAuth(page)
    // Navigate to home via pushState so auth guard runs with _keycloak set
    await clientNavigate(page, "/")
    await page.waitForTimeout(800)
    if (!new URL(page.url()).pathname.endsWith("/login")) break
    if (attempt >= 4) {
      throw new Error(
        "bootWalk: auth guard kept rejecting the injected mock Keycloak (walk would run logged-out)",
      )
    }
    await page.waitForTimeout(500)
  }
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

// ─────────────────────────────────────────────────────────────────────────────
// Structured walk: create Experiment from Process
//
// Regression scenario for the production "Minified React error #185"
// (Maximum update depth exceeded) reported when spawning an experiment from a
// process. Repeatedly drives the exact flow: Processes page → select process →
// spawn experiment (play button) → land on /experiments with the new
// experiment auto-created and linked, then navigates back and does it again.
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Structured walk: create Experiment from Process", () => {
  const ROUNDS = intFromEnv("SPAWN_ROUNDS", 6)

  test(`spawn experiment from process ×${ROUNDS}`, async ({ page }) => {
    const collector = makeCollector("/processes")
    await bootWalk(page, collector)

    for (let round = 0; round < ROUNDS; round++) {
      collector.step = round
      collector.route = "/processes"
      await clientNavigate(page, "/processes")

      // The seeded process card must be visible (proves /state/bulk fixture
      // decoded correctly — guards against silent fixture drift).
      const card = page.getByText("Spin Coating Baseline").first()
      await expect(card).toBeVisible({ timeout: 5000 })
      await card.click()
      await page.waitForTimeout(200)

      // Play button on the process list card ("New experiment").
      // Must be scoped to main: the sidebar "Experiments" nav icon is ALSO a
      // player-play triangle — an unscoped .first() clicks the nav, which
      // navigates to /experiments without spawning anything (vacuous test).
      const spawn = page
        .locator("main button:has(.tabler-icon-player-play):visible")
        .first()
      await expect(spawn).toBeVisible({ timeout: 5000 })
      await expect(spawn).toBeEnabled()
      await spawn.click()

      // handleSpawnExperiment navigates to /experiments where an effect
      // auto-creates the experiment. This is where #185 fired in production.
      await page.waitForURL("**/experiments", { timeout: 5000 })
      collector.route = "/experiments"
      await page.waitForTimeout(600)

      if (!(await assertResponsive(page, collector))) break
      const loops = collector.errors.filter((e) => e.type === "loop")
      expect(
        loops,
        `React update-depth loop on round ${round + 1}:\n${loops
          .map((e) => e.message)
          .join("\n")}`,
      ).toHaveLength(0)
    }

    summarise("spawn experiment from process", collector)
    assertNoHardErrors(collector)
  })
})
