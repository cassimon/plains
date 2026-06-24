/**
 * Playwright fixtures for integration tests.
 *
 * The Plains app authenticates exclusively through NOMAD/Keycloak SSO, which
 * isn't available in CI. The integration frontend image is built with
 * VITE_ENABLE_TEST_AUTH=true, which makes the app read a JWT from localStorage
 * (key `__plains_test_token`) on boot and install a Keycloak-shaped session.
 *
 * The `authedPage` fixture obtains a real backend-issued JWT for the seeded
 * test user and injects it before the app loads, so tests run as an
 * authenticated user without a live Keycloak server.
 */

import { test as base, expect } from "@playwright/test"

import { login } from "./utils/api"

const TEST_TOKEN_KEY = "__plains_test_token"

type Fixtures = {
  authedPage: import("@playwright/test").Page
  authToken: string
}

export const test = base.extend<Fixtures>({
  // biome-ignore lint/correctness/noEmptyPattern: Playwright detects fixture deps from the destructured param; this fixture has none.
  authToken: async ({}, use) => {
    const token = await login(
      process.env.INTEGRATION_TEST_EMAIL as string,
      process.env.INTEGRATION_TEST_PASSWORD as string,
    )
    await use(token)
  },

  authedPage: async ({ page, authToken }, use) => {
    await page.addInitScript(
      ([key, value]) => {
        window.localStorage.setItem(key, value)
      },
      [TEST_TOKEN_KEY, authToken] as const,
    )
    await use(page)
  },
})

export { expect }
