/**
 * Infinite React render-loop regression tests against the REAL stack.
 *
 * Reproduces the production-reported crash: "Maximum update depth exceeded"
 * (surfacing as `assignRef → mergeRefs → dispatchSetState` in Mantine ref
 * plumbing) which fired when creating an Experiment from the Processes page,
 * mostly on the SECOND object. Root cause was a bidirectional
 * activeEntity ↔ selectedExpId effect pair in Experiments.page.tsx — see
 * CLAUDE.md §"Strict Mode Pitfalls" #4. These tests drive the exact flow with
 * real persistence and fail if the oscillation ever comes back.
 */
import type { Page } from "@playwright/test"
import { expect, test } from "./fixtures"
import { apiClient } from "./utils/api"

const FRONTEND_BASE_URL =
  process.env.FRONTEND_BASE_URL ?? "http://localhost:5174"

// Both tests log in as the same seeded user. HttpBackend.syncToBackend deletes
// server rows missing from the local snapshot, so two parallel browser sessions
// on one account clobber each other's created objects — run serially.
test.describe.configure({ mode: "serial" })

const LOOP_PATTERNS = [
  /maximum update depth exceeded/i,
  /too many re-renders/i,
  /minified react error #185/i,
  /rendered more hooks than during the previous render/i,
]

function collectLoopErrors(page: Page): string[] {
  const errors: string[] = []
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text())
  })
  page.on("pageerror", (err) => errors.push(err.stack ?? err.message))
  return errors
}

function loopErrors(errors: string[]): string[] {
  return errors.filter((e) => LOOP_PATTERNS.some((re) => re.test(e)))
}

/** The page must still respond to JS — a frozen main thread means a loop. */
async function assertResponsive(page: Page) {
  const result = await Promise.race([
    page.evaluate(() => 1 + 1),
    new Promise((resolve) => setTimeout(() => resolve("frozen"), 5000)),
  ])
  expect(result, "page main thread is frozen (render loop)").toBe(2)
}

/** Seed a fully "spawnable" process: inline substrates + steps + stacks. */
async function seedSpawnableProcess(token: string, name: string) {
  const api = apiClient(token)
  const pid = crypto.randomUUID()
  await api.post("/processes/", {
    id: pid,
    name,
    description: "Loop-regression seed",
    skip_chemistry: false,
  })
  await api.put(`/processes/${pid}/inline-substrates/`, [
    {
      id: crypto.randomUUID(),
      name: "ITO glass",
      rigidity: "rigid",
      length_cm: "2.5",
      width_cm: "2.5",
      height_mm: "1.1",
    },
  ])
  await api.put(`/processes/${pid}/steps/`, [
    {
      id: crypto.randomUUID(),
      stage_index: 0,
      step_index: 0,
      name: "Spin coat perovskite",
      step_category: "solution_deposition",
      color: "#8888ff",
    },
    {
      id: crypto.randomUUID(),
      stage_index: 1,
      step_index: 0,
      name: "Anneal",
      step_category: "thermal_treatment",
      color: "#ff8888",
    },
  ])
  await api.put(`/processes/${pid}/stacks/`, [
    {
      id: crypto.randomUUID(),
      combination: 1,
      is_deleted: false,
      architecture: "n-i-p",
      layers: [
        {
          id: crypto.randomUUID(),
          layer_index: 0,
          name: "ITO glass",
          is_substrate: true,
          layer_type: "substrate",
        },
        {
          id: crypto.randomUUID(),
          layer_index: 1,
          name: "Perovskite",
          is_substrate: false,
          layer_type: "absorber",
          thickness_nm: "500",
        },
      ],
    },
  ])
  return pid
}

async function cleanup(token: string, processId: string) {
  const api = apiClient(token)
  // Delete experiments referencing the process first, then the process.
  const bulk = await api.get<{
    experiments: Array<{ id: string; process_id: string | null }>
  }>("/state/bulk")
  for (const e of bulk.experiments ?? []) {
    if (e.process_id === processId) {
      await api.delete(`/experiments/${e.id}`).catch(() => {})
    }
  }
  await api.delete(`/processes/${processId}`).catch(() => {})
}

test.describe("create Experiment from Processes page (real backend)", () => {
  test("spawning several experiments in a row does not render-loop", async ({
    authedPage: page,
    authToken,
  }) => {
    test.setTimeout(240_000)
    const name = `Loop-Spawn-${Date.now()}`
    const pid = await seedSpawnableProcess(authToken, name)
    const errors = collectLoopErrors(page)

    try {
      await page.goto(`${FRONTEND_BASE_URL}/processes`, {
        waitUntil: "domcontentloaded",
      })
      // Three rounds: the reported crash fires mostly on the SECOND object.
      // Navigation between rounds is client-side (like a real user) — a full
      // reload would abort the debounced save and drop the created objects.
      for (let round = 1; round <= 3; round++) {
        if (round > 1) {
          await page.getByLabel("Processes", { exact: true }).first().click()
          await page.waitForURL("**/processes", { timeout: 8_000 })
          await page.waitForTimeout(400)
        }
        const card = page.getByText(name).first()
        await expect(card).toBeVisible({ timeout: 20_000 })
        await card.click()
        await page.waitForTimeout(400)

        // Scope to main: the sidebar "Experiments" nav icon is ALSO a
        // player-play triangle — an unscoped .first() clicks the nav and
        // navigates without spawning anything (vacuous test).
        const spawn = page
          .locator("main button:has(.tabler-icon-player-play):visible")
          .first()
        await expect(spawn).toBeVisible({ timeout: 8_000 })
        await spawn.click()
        await page.waitForURL("**/experiments", { timeout: 8_000 })
        await page.waitForTimeout(800)

        // Drive the substrate table (this is what synced the failing
        // PUT /experiments/{id}/substrates in the original report).
        const step2 = page.getByText("Processing", { exact: true }).first()
        if (await step2.isVisible().catch(() => false)) {
          await step2.click()
          await page.waitForTimeout(300)
        }
        for (let i = 0; i < 3; i++) {
          const add = page
            .getByText(/Add substrate|Click to add a new substrate/)
            .first()
          if (await add.isVisible().catch(() => false)) {
            await add.click()
            await page.waitForTimeout(200)
          }
        }
        // Let the debounced save (2.5s) flush + effects settle.
        await page.waitForTimeout(4_000)

        await assertResponsive(page)
        const loops = loopErrors(errors)
        expect(
          loops,
          `React render loop on round ${round}:\n${loops.join("\n")}`,
        ).toHaveLength(0)
      }

      // Guard against a vacuous pass: the spawn flow must have actually
      // created and persisted one experiment per round.
      const bulk = await apiClient(authToken).get<{
        experiments: Array<{ process_id: string | null }>
      }>("/state/bulk")
      const spawned = (bulk.experiments ?? []).filter(
        (e) => e.process_id === pid,
      )
      expect(spawned.length, "experiments persisted by the spawn flow").toBe(3)
    } finally {
      await cleanup(authToken, pid)
    }
  })
})

test.describe("File Upload flow picker (real backend)", () => {
  test("creating experiments via the header picker from other pages does not render-loop", async ({
    authedPage: page,
    authToken,
  }) => {
    test.setTimeout(240_000)
    const name = `Loop-Picker-${Date.now()}`
    const pid = await seedSpawnableProcess(authToken, name)
    const errors = collectLoopErrors(page)

    const pickerCreate = async () => {
      // Select the process if none chosen yet, then Create experiment.
      const procSelect = page.getByPlaceholder("Select a process")
      const already = await procSelect.inputValue().catch(() => "")
      if (!already && (await procSelect.isVisible().catch(() => false))) {
        await procSelect.click()
        await page
          .getByRole("option", { name: new RegExp(name) })
          .first()
          .click()
        await page.waitForTimeout(300)
      }
      const enabledCreate = () =>
        page
          .locator("button:not([disabled])", { hasText: "Create experiment" })
          .first()
      // Portal clicks may close the popover — toggle the badge until the
      // enabled Create button is on screen.
      for (let attempt = 0; attempt < 4; attempt++) {
        if (
          await enabledCreate()
            .isVisible()
            .catch(() => false)
        )
          break
        await page
          .getByText(/File Upload/)
          .first()
          .click()
        await page.waitForTimeout(500)
      }
      await enabledCreate().click({ timeout: 10_000 })
      await page
        .waitForURL("**/experiments", { timeout: 8_000 })
        .catch(() => {})
      await page.waitForTimeout(1_500)
    }

    try {
      // Start an upload flow by dropping a file on the Organization canvas.
      await page.goto(`${FRONTEND_BASE_URL}/organization`, {
        waitUntil: "domcontentloaded",
      })
      await page.waitForTimeout(1_500)
      await page.evaluate(() => {
        const dt = new DataTransfer()
        dt.items.add(
          new File(["measurement data"], "jv-curve.csv", { type: "text/csv" }),
        )
        const el = document.elementFromPoint(
          Math.floor(innerWidth / 2),
          Math.floor(innerHeight / 2),
        )
        if (!el) throw new Error("no element at canvas center")
        for (const type of ["dragover", "drop"]) {
          el.dispatchEvent(
            new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: dt,
              clientX: innerWidth / 2,
              clientY: innerHeight / 2,
            }),
          )
        }
      })
      await page.waitForTimeout(800)
      await page.keyboard.press("Escape")

      const badge = page.getByText(/File Upload · \d\/3/).first()
      await expect(badge).toBeVisible({ timeout: 8_000 })

      // Experiment #1: created from the header popover on /organization.
      await badge.click()
      await page.waitForTimeout(500)
      await pickerCreate()

      // Experiment #2 (the reported crash case): client-side navigate to the
      // PROCESSES page — a reload would drop the ephemeral flow — and create
      // another experiment from the header popover there.
      await page.getByLabel("Processes", { exact: true }).first().click()
      await page.waitForURL("**/processes", { timeout: 8_000 })
      await page.waitForTimeout(800)
      const badge2 = page.getByText(/File Upload · \d\/3/).first()
      await expect(badge2).toBeVisible({ timeout: 8_000 })
      await badge2.click()
      await page.waitForTimeout(500)
      await pickerCreate()

      // Let the debounced save (2.5s) flush before checking persistence.
      await page.waitForTimeout(4_000)

      await assertResponsive(page)
      const loops = loopErrors(errors)
      expect(loops, `React render loop:\n${loops.join("\n")}`).toHaveLength(0)

      // Guard against a vacuous pass: both picker creations must have
      // persisted experiments linked to the seeded process.
      const bulk = await apiClient(authToken).get<{
        experiments: Array<{ process_id: string | null }>
      }>("/state/bulk")
      const created = (bulk.experiments ?? []).filter(
        (e) => e.process_id === pid,
      )
      expect(
        created.length,
        "experiments persisted by the picker flow",
      ).toBeGreaterThanOrEqual(2)
    } finally {
      await cleanup(authToken, pid)
    }
  })
})
