import type { Page } from "@playwright/test"
import { expect, test } from "@playwright/test"

// ─────────────────────────────────────────────────────────────────────────────
// Mock API Helper
// ─────────────────────────────────────────────────────────────────────────────

async function mockApi(
  page: Page,
  processesData: any[] = [],
): Promise<void> {
  const planesData = [{
    id: "test-plane-1",
    name: "Test Plane",
    elements: [{
      id: "test-collection-1",
      type: "collection",
      name: "Test Collection",
      refs: [],
      x: 100,
      y: 100,
    }],
  }]

  // Mock user endpoint
  await page.route("**/api/v1/users/me", (route) =>
    route.fulfill({
      status: 200,
      json: {
        id: "00000000-0000-0000-0000-000000000001",
        email: "test@plains.dev",
        is_active: true,
        is_superuser: true,
        full_name: "Playwright Test User",
      },
    }),
  )

  // Mock state endpoint
  await page.route("**/api/v1/state/", (route) =>
    route.fulfill({
      status: 200,
      json: {
        data: {
          materials: [],
          solutions: [],
          experiments: [],
          results: [],
          planes: planesData,
          processes: processesData,
        },
      },
    }),
  )

  // Mock auth config
  await page.route("**/api/v1/auth/config", (route) =>
    route.fulfill({
      status: 200,
      json: {
        keycloak_url: "http://mock-keycloak",
        keycloak_realm: "mock",
        keycloak_client_id: "plains",
      },
    }),
  )

  // Mock process update endpoints (allow any PUT/POST to processes to succeed)
  await page.route("**/api/v1/processes/**", async (route) => {
    if (route.request().method() === "PUT" || route.request().method() === "POST") {
      const body = route.request().postDataJSON()
      route.fulfill({
        status: 200,
        json: body,
      })
    } else {
      route.continue()
    }
  })

  // Mock plane update endpoints
  await page.route("**/api/v1/planes/**", async (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON()
      route.fulfill({
        status: 200,
        json: body,
      })
    } else {
      route.continue()
    }
  })
}

async function setupMockAuth(page: Page): Promise<void> {
  // Set up API mocks first
  await mockApi(page)

  // Navigate to login to load JS bundle
  await page.goto("/login", { waitUntil: "domcontentloaded" })

  // Wait for the __plains_setKeycloak hook
  await page.waitForFunction(() => "__plains_setKeycloak" in window, {
    timeout: 10_000,
  })

  // Inject mock Keycloak
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

  // Navigate to home to complete auth flow
  await page.goto("/", { waitUntil: "networkidle" })
}

// ─────────────────────────────────────────────────────────────────────────────
// Test
// ─────────────────────────────────────────────────────────────────────────────

test.describe("Process Creation", () => {
  test("Create Process with Solutions and Steps", async ({ page }) => {
    // Set up mock authentication
    await setupMockAuth(page)

    // Navigate to Processes page
    await page.getByRole("link", { name: "Processes" }).click()
    await expect(page).toHaveURL(/.*processes/)

    // Create a new Process
    // Click the "+" button or "Create Process" button
    await page.getByRole("button", { name: /create|new.*process/i }).click()

    // Set process name
    await page.getByPlaceholder(/process name/i).fill("Test Perovskite Process")

    // Open the Chemistry tab
    await page.getByRole("tab", { name: /chemistry/i }).click()

    // Add Solution Recipe 1 (n-type ETL)
    await page.getByRole("button", { name: /add.*solution|custom solution/i }).click()
    await page.getByLabel(/name/i).first().fill("PCBM Solution")
    await page.getByLabel(/type/i).first().selectOption("n-type (ETL)")

    // Add solvent (Chlorobenzene)
    await page.getByRole("button", { name: /add.*solvent/i }).click()
    await page.getByPlaceholder(/search.*pubchem|name/i).fill("Chlorobenzene")
    await page.keyboard.press("Enter")
    await page.getByText("Chlorobenzene").click()
    await page.getByLabel(/volume.*ratio/i).fill("1")

    // Add solute (PCBM)
    await page.getByRole("button", { name: /add.*solute/i }).click()
    await page.getByPlaceholder(/search.*pubchem|name/i).last().fill("PCBM")
    await page.keyboard.press("Enter")
    await page.getByText(/PCBM|Phenyl-C61-butyric/i).click()
    await page.getByLabel(/amount/i).fill("20")
    await page.getByLabel(/unit/i).selectOption("mg")

    // Add Solution Recipe 2 (Perovskite precursor)
    await page.getByRole("button", { name: /add.*solution|custom solution/i }).click()
    await page.locator('input[placeholder*="name"]').nth(1).fill("Perovskite Precursor")
    await page.locator('select').nth(1).selectOption("perovskite precursor")

    // Add solvent (DMF)
    await page.getByRole("button", { name: /add.*solvent/i }).last().click()
    await page.getByPlaceholder(/search.*pubchem|name/i).last().fill("DMF")
    await page.keyboard.press("Enter")
    await page.getByText(/DMF|Dimethylformamide/i).click()

    // Add solute (MAI)
    await page.getByRole("button", { name: /add.*solute/i }).last().click()
    await page.getByPlaceholder(/search.*pubchem|name/i).last().fill("Methylammonium iodide")
    await page.keyboard.press("Enter")
    await page.getByText(/Methylammonium iodide|MAI/i).click()
    await page.getByLabel(/amount/i).last().fill("15")

    // Add Solution Recipe 3 (p-type HTL)
    await page.getByRole("button", { name: /add.*solution|custom solution/i }).click()
    await page.locator('input[placeholder*="name"]').nth(2).fill("Spiro-OMeTAD Solution")
    await page.locator('select').nth(2).selectOption("p-type (HTL)")

    // Add solvent (Chlorobenzene)
    await page.getByRole("button", { name: /add.*solvent/i }).last().click()
    await page.getByPlaceholder(/search.*pubchem|name/i).last().fill("Chlorobenzene")
    await page.keyboard.press("Enter")

    // Add solute (Spiro-OMeTAD)
    await page.getByRole("button", { name: /add.*solute/i }).last().click()
    await page.getByPlaceholder(/search.*pubchem|name/i).last().fill("Spiro-OMeTAD")
    await page.keyboard.press("Enter")
    await page.getByLabel(/amount/i).last().fill("25")

    // Switch to Process Flow/Steps tab
    await page.getByRole("tab", { name: /flow|steps|process/i }).click()

    // Add Step 1 - Substrate Preparation
    await page.getByRole("button", { name: /add.*step/i }).click()
    await page.getByRole("menuitem", { name: /substrate.*preparation/i }).click()
    await page.getByLabel(/step.*name|name/i).fill("Substrate Cleaning")
    await page.getByRole("button", { name: /add.*inline.*material|custom material/i }).click()
    await page.getByLabel(/material.*name|name/i).fill("ITO Glass")

    // Add Step 2 - Wet Deposition (ETL)
    await page.getByRole("button", { name: /add.*step/i }).click()
    await page.getByRole("menuitem", { name: /wet.*deposition/i }).click()
    await page.getByLabel(/step.*name|name/i).last().fill("ETL Deposition")

    // Link to Solution Recipe 1
    await page.getByRole("button", { name: /select.*recipe|link.*solution/i }).first().click()
    await page.getByText("PCBM Solution").click()

    // Set deposition parameters
    await page.getByLabel(/deposition.*method/i).fill("Spin coating")
    await page.getByLabel(/substrate.*temp/i).fill("25")
    await page.getByLabel(/solution.*volume/i).fill("100")

    // Add Step 3 - Dry Deposition
    await page.getByRole("button", { name: /add.*step/i }).click()
    await page.getByRole("menuitem", { name: /dry.*deposition/i }).click()
    await page.getByLabel(/step.*name|name/i).last().fill("Gold Contact")
    await page.getByRole("button", { name: /add.*inline.*material/i }).last().click()
    await page.getByLabel(/material.*name/i).last().fill("Evaporated Gold")
    await page.getByLabel(/deposition.*method/i).last().fill("Thermal evaporation")

    // Add Step 4 - Surface Treatment
    await page.getByRole("button", { name: /add.*step/i }).click()
    await page.getByRole("menuitem", { name: /surface.*treatment/i }).click()
    await page.getByLabel(/step.*name|name/i).last().fill("UV-Ozone Treatment")

    // Add Step 5 - Wet Deposition (Perovskite)
    await page.getByRole("button", { name: /add.*step/i }).click()
    await page.getByRole("menuitem", { name: /wet.*deposition/i }).click()
    await page.getByLabel(/step.*name|name/i).last().fill("Perovskite Layer")

    // Link to Solution Recipe 2
    await page.getByRole("button", { name: /select.*recipe|link.*solution/i }).nth(1).click()
    await page.getByText("Perovskite Precursor").click()
    await page.getByLabel(/deposition.*method/i).nth(1).fill("Spin coating")

    // Add Step 6 - Doping/Aging
    await page.getByRole("button", { name: /add.*step/i }).click()
    await page.getByRole("menuitem", { name: /doping|aging/i }).click()
    await page.getByLabel(/step.*name|name/i).last().fill("Doping Step")

    // Add Step 7 - Wet Deposition (HTL)
    await page.getByRole("button", { name: /add.*step/i }).click()
    await page.getByRole("menuitem", { name: /wet.*deposition/i }).click()
    await page.getByLabel(/step.*name|name/i).last().fill("HTL Deposition")

    // Link to Solution Recipe 3
    await page.getByRole("button", { name: /select.*recipe|link.*solution/i }).nth(2).click()
    await page.getByText("Spiro-OMeTAD Solution").click()

    // Generate device stacks
    await page.getByRole("tab", { name: /stacks|device/i }).click()
    await page.getByRole("button", { name: /generate.*stacks/i }).click()

    // Fill in stack fields for the first generated stack
    await page.getByLabel(/architecture/i).first().selectOption("n-i-p")
    await page.getByLabel(/build.*device/i).first().selectOption("Yes")
    await page.getByLabel(/pixel.*area/i).first().fill("0.1")
    await page.getByLabel(/number.*of.*pixels/i).first().fill("4")

    // Fill in layer details (thickness, bandgap)
    await page.getByLabel(/thickness/i).first().fill("50")
    await page.getByLabel(/bandgap/i).first().fill("3.5")

    // Verify all data is saved
    await expect(page.getByText("Test Perovskite Process")).toBeVisible()
    await expect(page.getByText("PCBM Solution")).toBeVisible()
    await expect(page.getByText("Perovskite Precursor")).toBeVisible()
    await expect(page.getByText("Spiro-OMeTAD Solution")).toBeVisible()

    // Verify stacks are generated
    await expect(page.getByRole("tab", { name: /stacks|device/i })).toBeVisible()
    await expect(page.getByText(/generated.*stacks|device.*stacks/i)).toBeVisible()
  })
})
