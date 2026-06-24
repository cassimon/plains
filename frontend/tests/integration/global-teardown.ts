/**
 * No teardown needed: the CI workflow runs `docker compose down -v` after the
 * suite, which drops the database volume and removes the per-run test user
 * along with all of its data. Kept as an explicit hook for local runs.
 */
export default async function globalTeardown() {
  // intentionally empty
}
