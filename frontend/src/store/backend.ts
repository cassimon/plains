/**
 * Backend adapter interface for Plains GUI.
 *
 * Every data mutation in AppContext is routed through a BackendAdapter.
 * The default `InMemoryBackend` keeps everything in-memory (current behaviour).
 * To connect to a real database, implement `HttpBackend` (or similar) and pass
 * it to `<AppProvider backend={myBackend}>`.
 *
 * Design principles:
 *   - The adapter is the single source of truth for persisted state.
 *   - All methods return Promises so that HTTP adapters work naturally.
 *   - The adapter never touches React state directly — AppProvider does that
 *     after the adapter call resolves.
 *   - Auth tokens are managed by `AuthTokenManager` and injected into the
 *     HTTP adapter at construction time.
 */

import type {
  CanvasElement,
  Experiment,
  ExperimentResults,
  Material,
  Plane,
  Solution,
} from "./AppContext"

// ── Auth ──────────────────────────────────────────────────────────────────────

export type AuthTokens = {
  accessToken: string
  refreshToken?: string
  expiresAt?: number // Unix ms
}

export type AuthTokenManager = {
  /** Get the current access token, refreshing if expired. */
  getAccessToken(): Promise<string>
  /** Store new tokens (e.g. after login or refresh). */
  setTokens(tokens: AuthTokens): void
  /** Clear tokens (logout). */
  clearTokens(): void
  /** Register a listener for auth state changes. Returns unsubscribe fn. */
  onAuthChange(listener: (authenticated: boolean) => void): () => void
}

/**
 * A simple token manager that stores tokens in memory with optional
 * localStorage persistence.  Replace with your OAuth / SSO flow as needed.
 */
export function createTokenManager(options?: {
  storageKey?: string
  onRefresh?: (refreshToken: string) => Promise<AuthTokens>
}): AuthTokenManager {
  const storageKey = options?.storageKey ?? "plains_auth"
  const listeners = new Set<(authenticated: boolean) => void>()

  let tokens: AuthTokens | null = loadFromStorage()

  function loadFromStorage(): AuthTokens | null {
    try {
      const raw = localStorage.getItem(storageKey)
      return raw ? (JSON.parse(raw) as AuthTokens) : null
    } catch {
      return null
    }
  }

  function persist() {
    try {
      if (tokens) {
        localStorage.setItem(storageKey, JSON.stringify(tokens))
      } else {
        localStorage.removeItem(storageKey)
      }
    } catch {
      // Storage unavailable (SSR, private mode) — graceful no-op
    }
  }

  function notify() {
    const authed = tokens !== null
    for (const fn of listeners) {
      fn(authed)
    }
  }

  return {
    async getAccessToken(): Promise<string> {
      if (!tokens) {
        throw new Error("Not authenticated")
      }

      // Refresh if expired (with 30 s buffer)
      if (tokens.expiresAt && Date.now() > tokens.expiresAt - 30_000) {
        if (options?.onRefresh && tokens.refreshToken) {
          tokens = await options.onRefresh(tokens.refreshToken)
          persist()
        } else {
          throw new Error("Token expired and no refresh handler configured")
        }
      }

      return tokens.accessToken
    },

    setTokens(t: AuthTokens) {
      tokens = t
      persist()
      notify()
    },

    clearTokens() {
      tokens = null
      persist()
      notify()
    },

    onAuthChange(listener: (authenticated: boolean) => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
  }
}

// ── Backend adapter interface ────────────────────────────────────────────────

/** Full application state snapshot used for initial load and persistence. */
export type AppSnapshot = {
  materials: Material[]
  solutions: Solution[]
  experiments: Experiment[]
  results: ExperimentResults[]
  planes: Plane[]
}

/**
 * Backend adapter — the contract that any persistence layer must fulfil.
 *
 * All mutating methods return the authoritative entity so that the UI can
 * reconcile optimistic updates.  Read-only methods return arrays or snapshots.
 */
export interface BackendAdapter {
  // ── Lifecycle ──────────────────────────────────────────────────────────────

  /** Load the full application state (called once on mount). */
  load(): Promise<AppSnapshot>

  /** Persist the full application state (called on unmount / periodic save). */
  save(snapshot: AppSnapshot): Promise<void>

  // ── Materials ──────────────────────────────────────────────────────────────

  getMaterials(): Promise<Material[]>
  createMaterial(material: Material): Promise<Material>
  updateMaterial(material: Material): Promise<Material>
  deleteMaterial(id: string): Promise<void>

  // ── Solutions ──────────────────────────────────────────────────────────────

  getSolutions(): Promise<Solution[]>
  createSolution(solution: Solution): Promise<Solution>
  updateSolution(solution: Solution): Promise<Solution>
  deleteSolution(id: string): Promise<void>

  // ── Experiments ────────────────────────────────────────────────────────────

  getExperiments(): Promise<Experiment[]>
  createExperiment(experiment: Experiment): Promise<Experiment>
  updateExperiment(experiment: Experiment): Promise<Experiment>
  deleteExperiment(id: string): Promise<void>

  // ── Results ────────────────────────────────────────────────────────────────

  getResults(): Promise<ExperimentResults[]>
  createResults(results: ExperimentResults): Promise<ExperimentResults>
  updateResults(results: ExperimentResults): Promise<ExperimentResults>
  deleteResults(id: string): Promise<void>

  // ── Planes & Elements ──────────────────────────────────────────────────────

  getPlanes(): Promise<Plane[]>
  createPlane(plane: Plane): Promise<Plane>
  updatePlane(plane: Plane): Promise<Plane>
  deletePlane(id: string): Promise<void>

  createElement(planeId: string, element: CanvasElement): Promise<CanvasElement>
  updateElement(planeId: string, element: CanvasElement): Promise<CanvasElement>
  deleteElement(planeId: string, elementId: string): Promise<void>
}

// ── In-memory (default) adapter ──────────────────────────────────────────────

const LOCAL_STORAGE_KEY = "plains_app_state"

/**
 * Key used by AppContext's beforeunload watchdog to persist an emergency
 * snapshot when the page is closed before the debounced HTTP save completes.
 * HttpBackend.load() restores from this key and then pushes to the server.
 */
export const UNLOAD_BACKUP_KEY = "plains_unload_backup"

/**
 * Default backend that keeps state in memory with optional localStorage
 * persistence for page reloads.
 */
export class InMemoryBackend implements BackendAdapter {
  private data: AppSnapshot

  constructor(initial?: Partial<AppSnapshot>) {
    this.data = {
      materials: initial?.materials ?? [],
      solutions: initial?.solutions ?? [],
      experiments: initial?.experiments ?? [],
      results: initial?.results ?? [],
      planes: initial?.planes ?? [],
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async load(): Promise<AppSnapshot> {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<AppSnapshot>
        this.data = {
          materials: parsed.materials ?? this.data.materials,
          solutions: parsed.solutions ?? this.data.solutions,
          experiments: parsed.experiments ?? this.data.experiments,
          results: parsed.results ?? this.data.results,
          planes: parsed.planes ?? this.data.planes,
        }
      }
    } catch {
      // Corrupted storage — start fresh
    }
    return { ...this.data }
  }

  async save(snapshot: AppSnapshot): Promise<void> {
    this.data = snapshot
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(snapshot))
    } catch {
      // Storage full or unavailable
    }
  }

  // ── Materials ──────────────────────────────────────────────────────────────

  async getMaterials() {
    return [...this.data.materials]
  }
  async createMaterial(m: Material) {
    this.data.materials = [...this.data.materials, m]
    return m
  }
  async updateMaterial(m: Material) {
    this.data.materials = this.data.materials.map((x) =>
      x.id === m.id ? m : x,
    )
    return m
  }
  async deleteMaterial(id: string) {
    this.data.materials = this.data.materials.filter((x) => x.id !== id)
  }

  // ── Solutions ──────────────────────────────────────────────────────────────

  async getSolutions() {
    return [...this.data.solutions]
  }
  async createSolution(s: Solution) {
    this.data.solutions = [...this.data.solutions, s]
    return s
  }
  async updateSolution(s: Solution) {
    this.data.solutions = this.data.solutions.map((x) =>
      x.id === s.id ? s : x,
    )
    return s
  }
  async deleteSolution(id: string) {
    this.data.solutions = this.data.solutions.filter((x) => x.id !== id)
  }

  // ── Experiments ────────────────────────────────────────────────────────────

  async getExperiments() {
    return [...this.data.experiments]
  }
  async createExperiment(e: Experiment) {
    this.data.experiments = [...this.data.experiments, e]
    return e
  }
  async updateExperiment(e: Experiment) {
    this.data.experiments = this.data.experiments.map((x) =>
      x.id === e.id ? e : x,
    )
    return e
  }
  async deleteExperiment(id: string) {
    this.data.experiments = this.data.experiments.filter((x) => x.id !== id)
  }

  // ── Results ────────────────────────────────────────────────────────────────

  async getResults() {
    return [...this.data.results]
  }
  async createResults(r: ExperimentResults) {
    this.data.results = [...this.data.results, r]
    return r
  }
  async updateResults(r: ExperimentResults) {
    this.data.results = this.data.results.map((x) => (x.id === r.id ? r : x))
    return r
  }
  async deleteResults(id: string) {
    this.data.results = this.data.results.filter((x) => x.id !== id)
  }

  // ── Planes & Elements ──────────────────────────────────────────────────────

  async getPlanes() {
    return [...this.data.planes]
  }
  async createPlane(p: Plane) {
    this.data.planes = [...this.data.planes, p]
    return p
  }
  async updatePlane(p: Plane) {
    this.data.planes = this.data.planes.map((x) => (x.id === p.id ? p : x))
    return p
  }
  async deletePlane(id: string) {
    this.data.planes = this.data.planes.filter((x) => x.id !== id)
  }

  async createElement(planeId: string, element: CanvasElement) {
    this.data.planes = this.data.planes.map((p) =>
      p.id === planeId ? { ...p, elements: [...p.elements, element] } : p,
    )
    return element
  }
  async updateElement(planeId: string, element: CanvasElement) {
    this.data.planes = this.data.planes.map((p) =>
      p.id === planeId
        ? {
            ...p,
            elements: p.elements.map((e) =>
              e.id === element.id ? element : e,
            ),
          }
        : p,
    )
    return element
  }
  async deleteElement(planeId: string, elementId: string) {
    this.data.planes = this.data.planes.map((p) =>
      p.id === planeId
        ? { ...p, elements: p.elements.filter((e) => e.id !== elementId) }
        : p,
    )
  }
}

// ── HTTP adapter ─────────────────────────────────────────────────────────────

const EMPTY_SNAPSHOT: AppSnapshot = {
  materials: [],
  solutions: [],
  experiments: [],
  results: [],
  planes: [],
}

/**
 * HTTP-based backend adapter for Plains.
 *
 * Persistence strategy:
 * - Prefer `GET/PUT /state/` for full snapshot round-trip (exact AppContext sync).
 * - Fall back to `GET /state/bulk` for normalized bootstrap data when `/state/` is empty.
 *
 * Per-entity methods mutate the in-memory copy; `save()` persists the snapshot.
 */
export class HttpBackend implements BackendAdapter {
  private data: AppSnapshot = { ...EMPTY_SNAPSHOT }

  constructor(
    private baseUrl: string = `${import.meta.env.VITE_API_URL}/api/v1`,
  ) {}

  private getToken(): string | null {
    return localStorage.getItem("access_token")
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async load(): Promise<AppSnapshot> {
    try {
      console.log("[HttpBackend] load() called, baseUrl:", this.baseUrl)
      const token = this.getToken()
      if (!token) {
        console.warn("[HttpBackend] load() skipped — no token")
        return { ...EMPTY_SNAPSHOT }
      }
      const stateRes = await fetch(`${this.baseUrl}/state/`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      console.log("[HttpBackend] GET /state/ response:", stateRes.status)
      if (stateRes.ok) {
        const stateJson = await stateRes.json()
        console.log(
          "[HttpBackend] /state/ response data keys:",
          Object.keys(stateJson),
        )
        const raw = stateJson.data ?? {}
        console.log(
          "[HttpBackend] /state/ data keys:",
          Object.keys(raw),
          "materials:",
          Array.isArray(raw.materials) ? raw.materials.length : "none",
          "planes:",
          Array.isArray(raw.planes) ? raw.planes.length : "none",
        )
        const hasSnapshotData =
          Array.isArray(raw.materials) ||
          Array.isArray(raw.solutions) ||
          Array.isArray(raw.experiments) ||
          Array.isArray(raw.results) ||
          Array.isArray(raw.planes)

        if (hasSnapshotData) {
          this.data = {
            materials: raw.materials ?? [],
            solutions: raw.solutions ?? [],
            experiments: raw.experiments ?? [],
            results: raw.results ?? [],
            planes: raw.planes ?? [],
          }
          console.log(
            "[HttpBackend] loaded from /state/ snapshot:",
            "materials:",
            this.data.materials.length,
            "planes:",
            this.data.planes.length,
            "elements:",
            this.data.planes.reduce((n, p) => n + p.elements.length, 0),
          )
          // Check for an emergency backup written by the beforeunload watchdog.
          // If it exists and is recent, it represents work that was not pushed to
          // the server before the tab was closed; restore it and re-sync.
          const restoredFromBackup = this.restoreUnloadBackup()
          if (restoredFromBackup) {
            return { ...this.data }
          }
          return { ...this.data }
        }
      }

      const bulkRes = await fetch(`${this.baseUrl}/state/bulk`, {
        headers: { Authorization: `Bearer ${token}` },
      })
      if (!bulkRes.ok) {
        console.warn(
          `[HttpBackend] bulk load failed (${bulkRes.status}), starting fresh`,
        )
        return { ...EMPTY_SNAPSHOT }
      }
      const json = await bulkRes.json()
      // Apply type conversions from API format to AppContext format
      const materials = (json.materials ?? []).map((m: any) => ({
        id: m.id,
        type: "",
        name: m.name,
        supplier: m.supplier ?? "",
        supplierNumber: "",
        casNumber: m.cas_number ?? "",
        pubchemCid: "",
        inventoryLabel: "",
        purity: "",
      }))

      const solutions = (json.solutions ?? []).map((s: any) => ({
        id: s.id,
        name: s.name,
        handling: s.handling ?? "",
        creationTime: s.creation_time ?? s.created_at ?? new Date().toISOString(),
        components: (s.components ?? []).map((c: any) => ({
          id: c.id,
          materialId: c.material_id,
          solutionId: undefined,
          amount: String(c.amount),
          unit: c.unit as "mg" | "ml",
        })),
      }))

      const experiments = (json.experiments ?? []).map((e: any) => ({
        id: e.id,
        name: e.name,
        description: e.description ?? "",
        date:
          e.created_at?.slice(0, 10) ?? new Date().toISOString().slice(0, 10),
        architecture: "n-i-p" as const,
        substrateMaterial: "Glass/ITO",
        substrateWidth: 2.5,
        substrateLength: 2.5,
        numSubstrates: (e.substrates ?? []).length || 1,
        devicesPerSubstrate: 4,
        deviceArea: e.active_area_cm2 ?? 0.09,
        deviceType: (e.device_type as "film" | "half" | "full") ?? "film",
        layers: (e.layers ?? []).map((l: any, i: number) => ({
          id: l.id,
          name: l.name,
          color: ["#FF6B6B", "#4ECDC4", "#45B7D1"][i % 3],
          materialId: l.material_id ?? undefined,
          solutionId: l.solution_id ?? undefined,
          notes: l.notes ?? undefined,
        })),
        substrates: (e.substrates ?? []).map((s: any) => ({
          id: s.id,
          name: s.name,
        })),
        hasResults: false,
      }))

      const results = (json.results ?? []).map((r: any) => ({
        id: r.id,
        experimentId: r.experiment_id,
        files: (r.measurement_files ?? []).map((f: any) => ({
          id: f.id,
          fileName: f.filename,
          fileType: f.file_type as any,
          deviceName: "",
          cell: "",
          pixel: "",
        })),
        deviceGroups: (r.device_groups ?? []).map((g: any) => ({
          id: g.id,
          deviceName: g.name,
          files: [],
          assignedSubstrateId: null,
        })),
        groupingStrategy: "search" as const,
        matchingStrategy: "fuzzy" as const,
        updatedAt: r.created_at ?? new Date().toISOString(),
      }))

      const planes = (json.planes ?? []).map((p: any) => ({
        id: p.id,
        name: p.name,
        elements: (p.elements ?? []).map((e: any) => {
          const tryParseJson = (s: string) => {
            try {
              return JSON.parse(s)
            } catch {
              return null
            }
          }
          const parsed = e.content ? tryParseJson(e.content) : null

          if (e.element_type === "collection") {
            return {
              id: e.id,
              type: "collection" as const,
              position: { x: e.x, y: e.y },
              size: { x: e.width, y: e.height },
              name: parsed?.name ?? "Collection",
              refs: parsed?.refs ?? [],
              color: e.color ?? undefined,
            }
          }
          if (e.element_type === "line") {
            return {
              id: e.id,
              type: "line" as const,
              points: parsed?.points ?? [
                { x: e.x, y: e.y },
                { x: e.x + e.width, y: e.y + e.height },
              ],
              color: e.color ?? undefined,
            }
          }
          if (e.element_type === "plaintext") {
            return {
              id: e.id,
              type: "plaintext" as const,
              position: { x: e.x, y: e.y },
              size: { x: e.width, y: e.height },
              content: parsed?.content ?? e.content ?? "",
              color: e.color ?? "#000000",
              formatting: parsed?.formatting ?? {},
            }
          }
          return {
            id: e.id,
            type: "text" as const,
            position: { x: e.x, y: e.y },
            size: { x: e.width, y: e.height },
            content: e.content ?? "",
            color: e.color ?? undefined,
          }
        }),
      }))

      // Mark experiments with results
      const experimentIdsWithResults = new Set(
        results.map((r: ExperimentResults) => r.experimentId),
      )
      for (const exp of experiments) {
        exp.hasResults = experimentIdsWithResults.has(exp.id)
      }

      this.data = { materials, solutions, experiments, results, planes }
      // Check for emergency backup from beforeunload watchdog.
      const restoredFromBackup = this.restoreUnloadBackup()
      if (restoredFromBackup) {
        return { ...this.data }
      }
      return { ...this.data }
    } catch (err) {
      console.error("[HttpBackend] load error:", err)
      // Even on error, see if an emergency backup can rescue unsaved work.
      this.restoreUnloadBackup()
      return { ...this.data }
    }
  }

  /**
   * Check localStorage for an emergency snapshot written by the beforeunload
   * watchdog in AppContext.  If one exists and is recent (< 30 min), restore
   * it into this.data and schedule an async push to the server.
   * Returns true if a backup was applied.
   */
  private restoreUnloadBackup(): boolean {
    const BACKUP_MAX_AGE_MS = 30 * 60 * 1000 // 30 minutes
    try {
      const raw = localStorage.getItem(UNLOAD_BACKUP_KEY)
      if (!raw) return false
      const backup = JSON.parse(raw) as {
        snapshot: AppSnapshot
        savedAt: number
      }
      if (!backup?.snapshot || !backup?.savedAt) {
        localStorage.removeItem(UNLOAD_BACKUP_KEY)
        return false
      }
      if (Date.now() - backup.savedAt > BACKUP_MAX_AGE_MS) {
        console.log("[HttpBackend] discarding stale unload backup")
        localStorage.removeItem(UNLOAD_BACKUP_KEY)
        return false
      }
      console.log(
        "[HttpBackend] restoring emergency unload backup from",
        new Date(backup.savedAt).toISOString(),
      )
      this.data = backup.snapshot
      localStorage.removeItem(UNLOAD_BACKUP_KEY)
      // Re-push the restored snapshot to the server asynchronously.
      setTimeout(() => void this.save(this.data), 1_500)
      return true
    } catch {
      try {
        localStorage.removeItem(UNLOAD_BACKUP_KEY)
      } catch { /* ignore */ }
      return false
    }
  }

  async save(snapshot: AppSnapshot): Promise<void> {
    this.data = snapshot
    const summary = {
      materials: snapshot.materials.length,
      solutions: snapshot.solutions.length,
      experiments: snapshot.experiments.length,
      results: snapshot.results.length,
      planes: snapshot.planes.length,
      elements: snapshot.planes.reduce((n, p) => n + p.elements.length, 0),
    }
    console.log("[HttpBackend] save() called:", summary)
    const token = this.getToken()
    if (!token) {
      console.warn(
        "[HttpBackend] save() skipped — no token (already logged out)",
      )
      return
    }
    try {
      const res = await fetch(`${this.baseUrl}/state/`, {
        method: "PUT",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ data: snapshot }),
      })
      if (!res.ok) {
        const text = await res.text()
        console.error("[HttpBackend] save failed:", res.status, text)
      } else {
        console.log("[HttpBackend] save succeeded:", res.status)
        // Clear any emergency backup — the server now has the authoritative state.
        try {
          localStorage.removeItem(UNLOAD_BACKUP_KEY)
        } catch { /* ignore */ }
      }
    } catch (err) {
      console.error("[HttpBackend] save network error:", err)
    }
  }

  // ── Per-entity methods (delegate to in-memory copy) ────────────────────────

  async getMaterials() {
    return [...this.data.materials]
  }
  async createMaterial(m: Material) {
    this.data.materials = [...this.data.materials, m]
    return m
  }
  async updateMaterial(m: Material) {
    this.data.materials = this.data.materials.map((x) =>
      x.id === m.id ? m : x,
    )
    return m
  }
  async deleteMaterial(id: string) {
    this.data.materials = this.data.materials.filter((x) => x.id !== id)
  }

  async getSolutions() {
    return [...this.data.solutions]
  }
  async createSolution(s: Solution) {
    this.data.solutions = [...this.data.solutions, s]
    return s
  }
  async updateSolution(s: Solution) {
    this.data.solutions = this.data.solutions.map((x) =>
      x.id === s.id ? s : x,
    )
    return s
  }
  async deleteSolution(id: string) {
    this.data.solutions = this.data.solutions.filter((x) => x.id !== id)
  }

  async getExperiments() {
    return [...this.data.experiments]
  }
  async createExperiment(e: Experiment) {
    this.data.experiments = [...this.data.experiments, e]
    return e
  }
  async updateExperiment(e: Experiment) {
    this.data.experiments = this.data.experiments.map((x) =>
      x.id === e.id ? e : x,
    )
    return e
  }
  async deleteExperiment(id: string) {
    this.data.experiments = this.data.experiments.filter((x) => x.id !== id)
  }

  async getResults() {
    return [...this.data.results]
  }
  async createResults(r: ExperimentResults) {
    this.data.results = [...this.data.results, r]
    return r
  }
  async updateResults(r: ExperimentResults) {
    this.data.results = this.data.results.map((x) => (x.id === r.id ? r : x))
    return r
  }
  async deleteResults(id: string) {
    this.data.results = this.data.results.filter((x) => x.id !== id)
  }

  async getPlanes() {
    return [...this.data.planes]
  }
  async createPlane(p: Plane) {
    this.data.planes = [...this.data.planes, p]
    return p
  }
  async updatePlane(p: Plane) {
    this.data.planes = this.data.planes.map((x) => (x.id === p.id ? p : x))
    return p
  }
  async deletePlane(id: string) {
    this.data.planes = this.data.planes.filter((x) => x.id !== id)
  }

  async createElement(planeId: string, element: CanvasElement) {
    this.data.planes = this.data.planes.map((p) =>
      p.id === planeId ? { ...p, elements: [...p.elements, element] } : p,
    )
    return element
  }
  async updateElement(planeId: string, element: CanvasElement) {
    this.data.planes = this.data.planes.map((p) =>
      p.id === planeId
        ? {
            ...p,
            elements: p.elements.map((e) =>
              e.id === element.id ? element : e,
            ),
          }
        : p,
    )
    return element
  }
  async deleteElement(planeId: string, elementId: string) {
    this.data.planes = this.data.planes.map((p) =>
      p.id === planeId
        ? { ...p, elements: p.elements.filter((e) => e.id !== elementId) }
        : p,
    )
  }
}
