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

import { getTokenSync } from "../lib/keycloakInstance"
import type {
  CanvasElement,
  Experiment,
  ExperimentResults,
  Plane,
  PlaneFolder,
  Process,
} from "./AppContext"
import * as M from "./backendMapping"

/** Error carrying the HTTP status so callers can branch on 404/409/etc. */
class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message)
  }
}

type TopEntity =
  | "processes"
  | "experiments"
  | "results"
  | "planes"
  | "plane-folders"

/**
 * A soft-deleted item as returned by GET /trash/. The list returns one entry
 * per user delete action (the deletion "root"); its `childCounts`/`summary`
 * describe the descendants trashed together with it.
 */
export type TrashEntry = {
  id: string
  entityType: string // process | experiment | result | analysis | plane | collection
  entityId: string
  name: string
  originalPlaneId: string | null
  originalCollectionId: string | null
  deletedAt: string
  childCount: number
  childCounts: Record<string, number>
  summary: string
}

/** One entity un-trashed by a restore, with its (re-attached) placement. */
export type RestoredItem = {
  entityType: string
  entityId: string
  planeId: string | null
  collectionId: string | null
  originalPlaneId: string | null
  originalCollectionId: string | null
  /** The server could not place it — ask the user for a destination plane. */
  needsPlacement: boolean
  /** It landed on a collection parked at the 0,0 sentinel cell: attached and
   *  visible, but the canvas should move that collection to a free cell. */
  positionFixup: boolean
}

/** One entity a delete cascaded to, as reported by `POST /trash/`. */
export type TrashedRef = {
  entityType: string
  entityId: string
}

/** What `softDelete` returns: the refreshed roots plus the cascaded batch. */
export type TrashDeleteResult = {
  roots: TrashEntry[]
  /** Every id the delete trashed (root + downward closure) — prune exactly
   *  these from local arrays, canvas refs and selections. */
  trashed: TrashedRef[]
}

/**
 * Maps the diff-delete TopEntity buckets to the backend trash `entity_type`.
 * Folders are intentionally absent — they are not trashable (deleting a folder
 * only un-groups its planes) and keep hard-delete semantics.
 */
const TRASH_TYPE_FOR: Partial<Record<TopEntity, string>> = {
  processes: "process",
  experiments: "experiment",
  results: "result",
  planes: "plane",
}

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
  experiments: Experiment[]
  processes: Process[]
  results: ExperimentResults[]
  planes: Plane[]
  folders: PlaneFolder[]
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

  // ── Experiments ────────────────────────────────────────────────────────────

  getExperiments(): Promise<Experiment[]>
  createExperiment(experiment: Experiment): Promise<Experiment>
  updateExperiment(experiment: Experiment): Promise<Experiment>
  deleteExperiment(id: string): Promise<void>
  // ── Processes ──────────────────────────────────────────────────────────

  getProcesses(): Promise<Process[]>
  createProcess(process: Process): Promise<Process>
  updateProcess(process: Process): Promise<Process>
  deleteProcess(id: string): Promise<void>
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

  // ── Plane folders ────────────────────────────────────────────────────────
  getFolders(): Promise<PlaneFolder[]>
  createFolder(folder: PlaneFolder): Promise<PlaneFolder>
  updateFolder(folder: PlaneFolder): Promise<PlaneFolder>
  deleteFolder(id: string): Promise<void>

  createElement(planeId: string, element: CanvasElement): Promise<CanvasElement>
  updateElement(planeId: string, element: CanvasElement): Promise<CanvasElement>
  deleteElement(planeId: string, elementId: string): Promise<void>

  // ── Trash (soft-delete) ────────────────────────────────────────────────────
  /** List the current user's trashed items (one row per deletion root). */
  getTrash(): Promise<TrashEntry[]>
  /** Soft-delete an entity + its downward closure. Returns the refreshed root
   *  list (for the badge) and the cascaded batch (to prune local state). */
  softDelete(entityType: string, id: string): Promise<TrashDeleteResult>
  /** Restore a deletion root (and its whole batch) from trash. The server
   *  re-attaches the dependency branch; `destinationPlaneId` re-homes items
   *  whose original plane is gone. Returns the restored entities. */
  restoreTrash(
    entityType: string,
    id: string,
    destinationPlaneId?: string,
  ): Promise<RestoredItem[]>
  /** Permanently delete a single trashed item. */
  purgeTrash(entityType: string, id: string): Promise<void>
  /** Permanently delete everything in trash. */
  emptyTrash(): Promise<void>
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
      experiments: initial?.experiments ?? [],
      processes: initial?.processes ?? [],
      results: initial?.results ?? [],
      planes: initial?.planes ?? [],
      folders: initial?.folders ?? [],
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async load(): Promise<AppSnapshot> {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEY)
      if (raw) {
        const parsed = JSON.parse(raw) as Partial<AppSnapshot>
        this.data = {
          experiments: parsed.experiments ?? this.data.experiments,
          processes: parsed.processes ?? this.data.processes,
          results: parsed.results ?? this.data.results,
          planes: parsed.planes ?? this.data.planes,
          folders: parsed.folders ?? this.data.folders,
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

  // ── Processes ──────────────────────────────────────────────────────────

  async getProcesses() {
    return [...this.data.processes]
  }
  async createProcess(p: Process) {
    this.data.processes = [...this.data.processes, p]
    return p
  }
  async updateProcess(p: Process) {
    this.data.processes = this.data.processes.map((x) =>
      x.id === p.id ? p : x,
    )
    return p
  }
  async deleteProcess(id: string) {
    this.data.processes = this.data.processes.filter((x) => x.id !== id)
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

  async getFolders() {
    return [...this.data.folders]
  }
  async createFolder(f: PlaneFolder) {
    this.data.folders = [...this.data.folders, f]
    return f
  }
  async updateFolder(f: PlaneFolder) {
    this.data.folders = this.data.folders.map((x) => (x.id === f.id ? f : x))
    return f
  }
  async deleteFolder(id: string) {
    this.data.folders = this.data.folders.filter((x) => x.id !== id)
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

  // In-memory backend has no persistent trash — no-op stubs.
  async getTrash(): Promise<TrashEntry[]> {
    return []
  }
  async softDelete(
    _entityType: string,
    _id: string,
  ): Promise<TrashDeleteResult> {
    return { roots: [], trashed: [] }
  }
  async restoreTrash(
    _entityType: string,
    _id: string,
    _destinationPlaneId?: string,
  ): Promise<RestoredItem[]> {
    return []
  }
  async purgeTrash(_entityType: string, _id: string): Promise<void> {}
  async emptyTrash(): Promise<void> {}
}

// ── HTTP adapter ─────────────────────────────────────────────────────────────

const EMPTY_SNAPSHOT: AppSnapshot = {
  experiments: [],
  processes: [],
  results: [],
  planes: [],
  folders: [],
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

  /**
   * IDs of top-level entities currently believed to exist on the server.
   * Populated on load() and after every successful save(); used by save() to
   * decide create-vs-update and to compute deletions.
   */
  private serverIds: Record<TopEntity, Set<string>> = {
    processes: new Set(),
    experiments: new Set(),
    results: new Set(),
    planes: new Set(),
    "plane-folders": new Set(),
  }

  constructor(
    private baseUrl: string = `${import.meta.env.VITE_API_URL}/api/v1`,
  ) {}

  private getToken(): string | null {
    return getTokenSync()
  }

  /** Authenticated JSON request. Throws HttpError on non-2xx. */
  private async request(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<any> {
    const token = this.getToken()
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      throw new HttpError(
        res.status,
        `${method} ${path} → ${res.status} ${text}`,
      )
    }
    if (res.status === 204) return null
    const txt = await res.text()
    return txt ? JSON.parse(txt) : null
  }

  private captureServerIds(): void {
    this.serverIds = {
      processes: new Set(this.data.processes.map((p) => p.id)),
      experiments: new Set(this.data.experiments.map((e) => e.id)),
      results: new Set(this.data.results.map((r) => r.id)),
      planes: new Set(this.data.planes.map((p) => p.id)),
      "plane-folders": new Set(this.data.folders.map((f) => f.id)),
    }
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  async load(): Promise<AppSnapshot> {
    try {
      const token = this.getToken()
      if (!token) {
        console.warn("[HttpBackend] load() skipped — no token")
        return { ...EMPTY_SNAPSHOT }
      }
      // The normalised backend serves the full snapshot from /state/bulk, with
      // every domain object in its own table. backendMapping reconstructs the
      // rich frontend shapes (including DataCollection membership).
      const bulk = await this.request("GET", "/state/bulk")
      this.data = M.bulkToSnapshot(bulk ?? {})
      this.captureServerIds()
      console.log(
        "[HttpBackend] loaded from /state/bulk:",
        "processes:",
        this.data.processes.length,
        "experiments:",
        this.data.experiments.length,
        "results:",
        this.data.results.length,
        "planes:",
        this.data.planes.length,
      )
      // An emergency backup written by the beforeunload watchdog represents work
      // not yet pushed to the server; restore it over the loaded state and
      // re-sync on the next save.
      this.restoreUnloadBackup()
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
      } catch {
        /* ignore */
      }
      return false
    }
  }

  async save(snapshot: AppSnapshot): Promise<void> {
    this.data = snapshot
    const token = this.getToken()
    if (!token) {
      console.warn(
        "[HttpBackend] save() skipped — no token (already logged out)",
      )
      return
    }
    try {
      await this.syncToBackend(snapshot)
      console.log("[HttpBackend] save succeeded")
      // The server now holds the authoritative state — drop the emergency backup.
      try {
        localStorage.removeItem(UNLOAD_BACKUP_KEY)
      } catch {
        /* ignore */
      }
    } catch (err) {
      console.error("[HttpBackend] save failed:", err)
    }
  }

  /** Create the entity if new, otherwise update it. Recovers from a stale
   *  create/update guess (404 on update, conflict on create). */
  private async upsert(
    type: TopEntity,
    id: string,
    body: unknown,
  ): Promise<void> {
    const exists = this.serverIds[type].has(id)
    try {
      if (exists) {
        await this.request("PUT", `/${type}/${id}`, body)
      } else {
        await this.request("POST", `/${type}/`, body)
      }
    } catch (err) {
      if (err instanceof HttpError && exists && err.status === 404) {
        await this.request("POST", `/${type}/`, body)
      } else if (
        err instanceof HttpError &&
        !exists &&
        (err.status === 400 || err.status === 409 || err.status === 500)
      ) {
        // The row likely already existed (client-supplied PK) — update instead.
        await this.request("PUT", `/${type}/${id}`, body)
      } else {
        throw err
      }
    }
  }

  private async deleteRemoved(
    type: TopEntity,
    currentIds: string[],
  ): Promise<void> {
    const current = new Set(currentIds)
    const trashType = TRASH_TYPE_FOR[type]
    for (const id of this.serverIds[type]) {
      if (current.has(id)) continue
      try {
        if (trashType) {
          // Soft-delete: move to trash instead of destroying the row. The trash
          // entry causes the server to hide the item from /state/bulk even if a
          // stale second session re-upserts it, which is what previously let
          // deleted planes reappear. Restorable from the Trash page.
          await this.request("POST", "/trash/", {
            entity_type: trashType,
            entity_id: id,
          })
        } else {
          // Folders are not trashable — hard delete (un-groups its planes).
          await this.request("DELETE", `/${type}/${id}`)
        }
      } catch (err) {
        if (!(err instanceof HttpError && err.status === 404)) throw err
      }
    }
  }

  // ── Trash (soft-delete) ────────────────────────────────────────────────────

  private mapTrashRows(res: any): TrashEntry[] {
    const rows = (res?.data ?? []) as Array<{
      id: string
      entity_type: string
      entity_id: string
      name: string
      original_plane_id: string | null
      original_collection_id: string | null
      deleted_at: string
      child_count?: number
      child_counts?: Record<string, number>
      summary?: string
    }>
    return rows.map((r) => ({
      id: r.id,
      entityType: r.entity_type,
      entityId: r.entity_id,
      name: r.name,
      originalPlaneId: r.original_plane_id,
      originalCollectionId: r.original_collection_id,
      deletedAt: r.deleted_at,
      childCount: r.child_count ?? 0,
      childCounts: r.child_counts ?? {},
      summary: r.summary ?? "",
    }))
  }

  async getTrash(): Promise<TrashEntry[]> {
    return this.mapTrashRows(await this.request("GET", "/trash/"))
  }

  async softDelete(entityType: string, id: string): Promise<TrashDeleteResult> {
    const res = await this.request("POST", "/trash/", {
      entity_type: entityType,
      entity_id: id,
    })
    const trashed = (res?.trashed ?? []) as Array<{
      entity_type: string
      entity_id: string
    }>
    return {
      roots: this.mapTrashRows(res),
      trashed: trashed.map((t) => ({
        entityType: t.entity_type,
        entityId: t.entity_id,
      })),
    }
  }

  async restoreTrash(
    entityType: string,
    id: string,
    destinationPlaneId?: string,
  ): Promise<RestoredItem[]> {
    const res = await this.request("POST", "/trash/restore", {
      entity_type: entityType,
      entity_id: id,
      ...(destinationPlaneId
        ? { destination_plane_id: destinationPlaneId }
        : {}),
    })
    const items = (res?.restored ?? []) as Array<{
      entity_type: string
      entity_id: string
      plane_id: string | null
      collection_id: string | null
      original_plane_id: string | null
      original_collection_id: string | null
      needs_placement: boolean
      position_fixup?: boolean
    }>
    return items.map((i) => ({
      entityType: i.entity_type,
      entityId: i.entity_id,
      planeId: i.plane_id,
      collectionId: i.collection_id,
      originalPlaneId: i.original_plane_id,
      originalCollectionId: i.original_collection_id,
      needsPlacement: i.needs_placement,
      positionFixup: i.position_fixup ?? false,
    }))
  }

  async purgeTrash(entityType: string, id: string): Promise<void> {
    await this.request("POST", `/trash/${entityType}/${id}/purge`)
  }

  async emptyTrash(): Promise<void> {
    await this.request("POST", "/trash/empty")
  }

  /**
   * Reconcile the full snapshot to the normalised backend via per-entity REST.
   * Ordered by FK dependencies: planes (and their collections) before the
   * domain objects that carry plane_id/collection_id; processes before the
   * experiments that reference them; experiments before their results.
   */
  private async syncToBackend(s: AppSnapshot): Promise<void> {
    const place = M.derivePlacement(s.planes)
    const knownProcessIds = new Set(s.processes.map((p) => p.id))
    const knownExperimentIds = new Set(s.experiments.map((e) => e.id))

    // 0. Folders first — planes carry a folder_id FK to them.
    for (const f of s.folders) {
      await this.upsert("plane-folders", f.id, M.folderToApi(f))
    }

    // 1. Planes + canvas elements. Collections are replaced before entities set
    //    their collection_id FK below.
    for (const pl of s.planes) {
      await this.upsert("planes", pl.id, M.planeToApi(pl))
      await this.request(
        "PUT",
        `/planes/${pl.id}/collections`,
        M.collectionsToApi(pl),
      )
      await this.request(
        "PUT",
        `/planes/${pl.id}/sticky-notes`,
        M.stickyNotesToApi(pl),
      )
      await this.request(
        "PUT",
        `/planes/${pl.id}/text-fields`,
        M.textFieldsToApi(pl),
      )
    }

    // 2. Processes + nested children.
    for (const p of s.processes) {
      await this.upsert("processes", p.id, M.processToApi(p, place))
      await this.request(
        "PUT",
        `/processes/${p.id}/recipes/`,
        M.recipesToApi(p),
      )
      await this.request("PUT", `/processes/${p.id}/steps/`, M.stepsToApi(p))
      await this.request("PUT", `/processes/${p.id}/stacks/`, M.stacksToApi(p))
      await this.request(
        "PUT",
        `/processes/${p.id}/inline-substrates/`,
        M.inlineSubstratesToApi(p),
      )
      // Substrate dimensions reference lab_material rows that may live outside
      // this snapshot; tolerate FK failures rather than aborting the save.
      try {
        await this.request(
          "PUT",
          `/processes/${p.id}/substrate-dimensions/`,
          M.substrateDimensionsToApi(p),
        )
      } catch (err) {
        console.warn("[HttpBackend] substrate-dimensions skipped:", err)
      }
    }

    // 3. Experiments + substrates.
    for (const e of s.experiments) {
      await this.upsert(
        "experiments",
        e.id,
        M.experimentToApi(e, place, knownProcessIds),
      )
      await this.request(
        "PUT",
        `/experiments/${e.id}/substrates`,
        M.substratesToApi(e),
      )
    }

    // 4. Results (create requires ?experiment_id=) + files/groups.
    for (const r of s.results) {
      if (this.serverIds.results.has(r.id)) {
        await this.request("PUT", `/results/${r.id}`, M.resultsToApi(r, place))
      } else if (knownExperimentIds.has(r.experimentId)) {
        await this.request(
          "POST",
          `/results/?experiment_id=${r.experimentId}`,
          M.resultsToApi(r, place),
        )
      } else {
        continue // orphan result with no experiment — cannot persist
      }
      await this.request(
        "PUT",
        `/results/${r.id}/measurement-files`,
        M.measurementFilesToApi(r),
      )
      await this.request(
        "PUT",
        `/results/${r.id}/device-groups`,
        M.deviceGroupsToApi(r),
      )
    }

    // 5. Deletions, in reverse dependency order.
    await this.deleteRemoved(
      "results",
      s.results.map((r) => r.id),
    )
    await this.deleteRemoved(
      "experiments",
      s.experiments.map((e) => e.id),
    )
    await this.deleteRemoved(
      "processes",
      s.processes.map((p) => p.id),
    )
    await this.deleteRemoved(
      "planes",
      s.planes.map((p) => p.id),
    )
    // Folders last — after the planes that referenced them are gone/reassigned.
    await this.deleteRemoved(
      "plane-folders",
      s.folders.map((f) => f.id),
    )

    // Server now matches the snapshot.
    this.captureServerIds()
  }

  // ── Per-entity methods (delegate to in-memory copy) ────────────────────────

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

  async getProcesses() {
    return [...this.data.processes]
  }
  async createProcess(p: Process) {
    this.data.processes = [...this.data.processes, p]
    return p
  }
  async updateProcess(p: Process) {
    this.data.processes = this.data.processes.map((x) =>
      x.id === p.id ? p : x,
    )
    return p
  }
  async deleteProcess(id: string) {
    this.data.processes = this.data.processes.filter((x) => x.id !== id)
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

  async getFolders() {
    return [...this.data.folders]
  }
  async createFolder(f: PlaneFolder) {
    this.data.folders = [...this.data.folders, f]
    return f
  }
  async updateFolder(f: PlaneFolder) {
    this.data.folders = this.data.folders.map((x) => (x.id === f.id ? f : x))
    return f
  }
  async deleteFolder(id: string) {
    this.data.folders = this.data.folders.filter((x) => x.id !== id)
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
