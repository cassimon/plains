import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"

import { clearKeycloak, setKeycloak } from "../lib/keycloakInstance"
import { HttpBackend, type AppSnapshot, unloadBackupKey } from "./backend"

type FetchCall = {
  method: string
  url: string
  body?: Record<string, unknown>
}

type FetchResult = { ok: boolean; status: number; json?: unknown }

let fetchCalls: FetchCall[] = []
let fetchHandler: (call: FetchCall) => FetchResult | Promise<FetchResult>

function emptySnapshot(): AppSnapshot {
  return { experiments: [], processes: [], results: [], planes: [], folders: [] }
}

function folder(id: string) {
  return { id, name: id, position: 0 }
}

/** Build a fake JWT whose payload carries the given `sub` (per-user key tests). */
function jwtToken(sub: string): string {
  const payload = btoa(JSON.stringify({ sub }))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "")
  return `e30.${payload}.sig`
}

function makeStorage() {
  const store = new Map<string, string>()
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, String(v)),
    removeItem: (k: string) => void store.delete(k),
    clear: () => void store.clear(),
  }
}

/** Drain the microtask queue so floating async saves settle deterministically. */
async function flushMicrotasks() {
  for (let i = 0; i < 30; i++) await Promise.resolve()
}

beforeEach(() => {
  fetchCalls = []
  fetchHandler = () => ({ ok: true, status: 200, json: {} })

  ;(globalThis as any).fetch = async (url: string, init?: any) => {
    const call: FetchCall = {
      method: init?.method ?? "GET",
      url: String(url),
      body: init?.body ? JSON.parse(init.body) : undefined,
    }
    fetchCalls.push(call)
    const r = await fetchHandler(call)
    return {
      ok: r.ok,
      status: r.status,
      text: async () => (r.json === undefined ? "" : JSON.stringify(r.json)),
    } as any
  }

  ;(globalThis as any).localStorage = makeStorage()

  setKeycloak({
    authenticated: true,
    token: "test-token",
    updateToken: () => Promise.resolve(false),
  } as any)
})

describe("HttpBackend persistence", () => {
  test("save() propagates a failed synchronization to the caller", async () => {
    const backend = new HttpBackend("http://test/api/v1")
    fetchHandler = () => ({ ok: false, status: 403 })

    const snapshot = { ...emptySnapshot(), folders: [folder("A1")] }
    await expect(backend.save(snapshot)).rejects.toBeTruthy()
  })

  test("a successful save soft-deletes a removed entity exactly once", async () => {
    const backend = new HttpBackend("http://test/api/v1")
    fetchHandler = (call) =>
      call.url.includes("/state/bulk")
        ? {
            ok: true,
            status: 200,
            json: { processes: [{ id: "P1", name: "Test" }] },
          }
        : { ok: true, status: 200, json: {} }

    await backend.load()

    await backend.save(emptySnapshot())

    const trashCalls = () =>
      fetchCalls.filter(
        (c) => c.method === "POST" && c.url.includes("/trash/"),
      )
    expect(trashCalls().length).toBe(1)
    expect(trashCalls()[0].body).toMatchObject({
      entity_type: "process",
      entity_id: "P1",
    })

    // A second save of the same snapshot must not re-delete P1: the server ID
    // bookkeeping now reflects the synchronised snapshot.
    await backend.save(emptySnapshot())
    expect(trashCalls().length).toBe(1)
  })

  test("a failed save does not update the server ID bookkeeping", async () => {
    const backend = new HttpBackend("http://test/api/v1")
    fetchHandler = (call) =>
      call.url.includes("/state/bulk")
        ? {
            ok: true,
            status: 200,
            json: { processes: [{ id: "P1", name: "Test" }] },
          }
        : { ok: true, status: 200, json: {} }

    await backend.load()

    // Failing save (folder create returns 403). It must not capture the new
    // folder id, nor lose the P1 id captured at load().
    fetchHandler = () => ({ ok: false, status: 403 })
    await expect(
      backend.save({ ...emptySnapshot(), folders: [folder("A1")] }),
    ).rejects.toBeTruthy()

    fetchHandler = () => ({ ok: true, status: 200, json: {} })
    await backend.save(emptySnapshot())

    const trashCalls = fetchCalls.filter(
      (c) => c.method === "POST" && c.url.includes("/trash/"),
    )
    expect(trashCalls.length).toBe(1)
    expect(trashCalls[0].body).toMatchObject({
      entity_type: "process",
      entity_id: "P1",
    })
  })

  test("concurrent save() calls are serialised", async () => {
    const backend = new HttpBackend("http://test/api/v1")
    const delay = () => new Promise((r) => setTimeout(r, 1))
    fetchHandler = async () => {
      await delay()
      return { ok: true, status: 200, json: {} }
    }

    const snapA = { ...emptySnapshot(), folders: [folder("A1"), folder("A2")] }
    const snapB = { ...emptySnapshot(), folders: [folder("B1"), folder("B2")] }

    await Promise.all([backend.save(snapA), backend.save(snapB)])

    const ids = fetchCalls
      .filter((c) => c.method === "POST" && c.url.includes("/plane-folders/"))
      .map((c) => c.body?.id as string)

    // All of snapA's writes precede all of snapB's: no interleaving.
    expect(ids.slice(0, 2).sort()).toEqual(["A1", "A2"])
    expect(ids.slice(2, 4).sort()).toEqual(["B1", "B2"])
  })

  test("save() rejects when there is no auth token and performs no network writes", async () => {
    clearKeycloak()
    const backend = new HttpBackend("http://test/api/v1")
    await expect(backend.save(emptySnapshot())).rejects.toThrow(/no token/)
    expect(fetchCalls.length).toBe(0)
  })

  test("a backup with different contents survives even with an older timestamp", async () => {
    setKeycloak({
      authenticated: true,
      token: jwtToken("userA"),
      updateToken: () => Promise.resolve(false),
    } as any)
    const backend = new HttpBackend("http://test/api/v1")
    const key = unloadBackupKey()!
    fetchHandler = () => ({ ok: true, status: 200, json: {} })

    // Another tab's backup: older timestamp, DIFFERENT contents.
    const backupSnapshot = { ...emptySnapshot(), folders: [folder("B1")] }
    ;(globalThis as any).localStorage.setItem(
      key,
      JSON.stringify({ snapshot: backupSnapshot, savedAt: Date.now() - 100_000 }),
    )

    // This tab saves different contents.
    const savedSnapshot = { ...emptySnapshot(), folders: [folder("A1")] }
    await backend.save(savedSnapshot)

    expect((globalThis as any).localStorage.getItem(key)).not.toBeNull()
  })

  test("a backup matching the saved snapshot is cleared", async () => {
    setKeycloak({
      authenticated: true,
      token: jwtToken("userA"),
      updateToken: () => Promise.resolve(false),
    } as any)
    const backend = new HttpBackend("http://test/api/v1")
    const key = unloadBackupKey()!
    const snapshot = { ...emptySnapshot(), folders: [folder("A1")] }
    ;(globalThis as any).localStorage.setItem(
      key,
      JSON.stringify({ snapshot, savedAt: Date.now() }),
    )
    fetchHandler = () => ({ ok: true, status: 200, json: {} })

    await backend.save(snapshot)
    expect((globalThis as any).localStorage.getItem(key)).toBeNull()
  })

  test("a backup replaced during an in-flight save is not cleared", async () => {
    setKeycloak({
      authenticated: true,
      token: jwtToken("userA"),
      updateToken: () => Promise.resolve(false),
    } as any)
    const backend = new HttpBackend("http://test/api/v1")
    const key = unloadBackupKey()!
    const savedSnapshot = { ...emptySnapshot(), folders: [folder("A1")] }
    ;(globalThis as any).localStorage.setItem(
      key,
      JSON.stringify({ snapshot: savedSnapshot, savedAt: Date.now() }),
    )

    let replaced = false
    fetchHandler = async () => {
      if (!replaced) {
        replaced = true
        // Replace the backup with DIFFERENT contents while the save is in flight.
        ;(globalThis as any).localStorage.setItem(
          key,
          JSON.stringify({
            snapshot: { ...emptySnapshot(), folders: [folder("B1")] },
            savedAt: Date.now(),
          }),
        )
      }
      return { ok: true, status: 200, json: {} }
    }

    await backend.save(savedSnapshot)
    // The replaced (different) backup must survive.
    expect((globalThis as any).localStorage.getItem(key)).not.toBeNull()
  })

  test("an expired backup is not automatically deleted", async () => {
    setKeycloak({
      authenticated: true,
      token: jwtToken("userA"),
      updateToken: () => Promise.resolve(false),
    } as any)
    const backend = new HttpBackend("http://test/api/v1")
    const key = unloadBackupKey()!
    const snapshot = { ...emptySnapshot(), folders: [folder("A1")] }
    ;(globalThis as any).localStorage.setItem(
      key,
      JSON.stringify({ snapshot, savedAt: Date.now() - 31 * 60 * 1000 }),
    )

    fetchHandler = () => ({ ok: true, status: 200, json: {} })
    const loaded = await backend.load()

    // Stale backup is not auto-restored...
    expect(loaded.folders.length).toBe(0)
    // ...but is NOT deleted either (kept for manual recovery).
    expect((globalThis as any).localStorage.getItem(key)).not.toBeNull()
  })

  test("the emergency backup is not discarded before its re-push is confirmed", async () => {
    setKeycloak({
      authenticated: true,
      token: jwtToken("userA"),
      updateToken: () => Promise.resolve(false),
    } as any)
    const backend = new HttpBackend("http://test/api/v1")
    const key = unloadBackupKey()!

    const snapshot = { ...emptySnapshot(), folders: [folder("A1")] }
    ;(globalThis as any).localStorage.setItem(
      key,
      JSON.stringify({ snapshot, savedAt: Date.now() }),
    )

    // load() fetches an empty server snapshot, restores the backup and
    // schedules an asynchronous re-push.
    fetchHandler = () => ({ ok: true, status: 200, json: {} })
    await backend.load()

    // The backup must still exist right after load (not optimistically removed).
    expect((globalThis as any).localStorage.getItem(key)).not.toBeNull()

    // The re-push fails → the backup must be kept for the next load to retry.
    fetchHandler = () => ({ ok: false, status: 500 })
    await new Promise((r) => setTimeout(r, 1_600))

    expect((globalThis as any).localStorage.getItem(key)).not.toBeNull()
  })

  test("a backup is only restored for the user who wrote it", async () => {
    setKeycloak({
      authenticated: true,
      token: jwtToken("userA"),
      updateToken: () => Promise.resolve(false),
    } as any)
    const keyA = unloadBackupKey()!
    const snapshotA = { ...emptySnapshot(), folders: [folder("A1")] }
    ;(globalThis as any).localStorage.setItem(
      keyA,
      JSON.stringify({ snapshot: snapshotA, savedAt: Date.now() }),
    )

    // User B loads: must not restore user A's backup.
    setKeycloak({
      authenticated: true,
      token: jwtToken("userB"),
      updateToken: () => Promise.resolve(false),
    } as any)
    const backend = new HttpBackend("http://test/api/v1")
    fetchHandler = () => ({ ok: true, status: 200, json: {} })
    const loaded = await backend.load()

    expect(loaded.folders.length).toBe(0)
    // A's backup is untouched (still under A's own key).
    expect((globalThis as any).localStorage.getItem(keyA)).not.toBeNull()
  })
})

describe("delayed backup replay (PERSISTENCE-FIX-01)", () => {
  // Fake setTimeout: capture the callback instead of waiting 1.5s, so the
  // replay can be fired deterministically (no sleeps, no real timers).
  let timerCallback: (() => unknown) | null = null
  const realSetTimeout = globalThis.setTimeout.bind(globalThis)

  beforeEach(() => {
    timerCallback = null
    ;(globalThis as any).setTimeout = (
      cb: () => unknown,
      _ms: number,
    ): unknown => {
      timerCallback = cb
      return 1
    }
  })

  afterEach(() => {
    ;(globalThis as any).setTimeout = realSetTimeout
  })

  function fireTimer() {
    const cb = timerCallback
    timerCallback = null
    if (cb) cb()
  }

  function folderPosts() {
    return fetchCalls
      .filter((c) => c.method === "POST" && c.url.endsWith("/plane-folders/"))
      .map((c) => (c.body as { id: string })?.id)
  }

  function seedEmergencyBackup() {
    const key = unloadBackupKey()!
    const snapshot = { ...emptySnapshot(), folders: [folder("A1")] }
    ;(globalThis as any).localStorage.setItem(
      key,
      JSON.stringify({ snapshot, savedAt: Date.now() }),
    )
    return key
  }

  function signInAsUserA() {
    setKeycloak({
      authenticated: true,
      token: jwtToken("userA"),
      updateToken: () => Promise.resolve(false),
    } as any)
  }

  test("1. snapshot A is restored from the emergency backup", async () => {
    signInAsUserA()
    const backend = new HttpBackend("http://test/api/v1")
    seedEmergencyBackup()
    fetchHandler = () => ({ ok: true, status: 200, json: {} })

    const loaded = await backend.load()

    expect(loaded.folders.map((f) => f.id)).toEqual(["A1"])
  })

  test("2. snapshot B is saved successfully before the replay fires", async () => {
    signInAsUserA()
    const backend = new HttpBackend("http://test/api/v1")
    seedEmergencyBackup()
    fetchHandler = () => ({ ok: true, status: 200, json: {} })
    await backend.load()

    const snapB = { ...emptySnapshot(), folders: [folder("B1")] }
    await backend.save(snapB)

    expect(folderPosts()).toEqual(["B1"])
  })

  test("3. the delayed replay writes B, never the older backup A", async () => {
    signInAsUserA()
    const backend = new HttpBackend("http://test/api/v1")
    seedEmergencyBackup()
    fetchHandler = () => ({ ok: true, status: 200, json: {} })
    await backend.load()

    const snapB = { ...emptySnapshot(), folders: [folder("B1")] }
    await backend.save(snapB)

    const saveSpy = spyOn(backend, "save")
    fireTimer()

    const replayed = saveSpy.mock.calls[saveSpy.mock.calls.length - 1][0]
    expect(replayed.folders.map((f) => f.id)).toEqual(["B1"])
  })

  test("4. the replay still persists A when nothing newer exists", async () => {
    signInAsUserA()
    const backend = new HttpBackend("http://test/api/v1")
    seedEmergencyBackup()
    fetchHandler = () => ({ ok: true, status: 200, json: {} })
    await backend.load()

    const saveSpy = spyOn(backend, "save")
    fireTimer()

    const replayed = saveSpy.mock.calls[saveSpy.mock.calls.length - 1][0]
    expect(replayed.folders.map((f) => f.id)).toEqual(["A1"])
  })

  test("5. a failed replay retains the recoverable backup", async () => {
    signInAsUserA()
    const backend = new HttpBackend("http://test/api/v1")
    const key = seedEmergencyBackup()
    fetchHandler = () => ({ ok: true, status: 200, json: {} })
    await backend.load()

    fetchHandler = () => ({ ok: false, status: 500 })
    fireTimer()
    await flushMicrotasks()

    expect((globalThis as any).localStorage.getItem(key)).not.toBeNull()
  })
})
