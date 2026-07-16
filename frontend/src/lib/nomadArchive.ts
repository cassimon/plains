// ─────────────────────────────────────────────────────────────────────────────
// NOMAD temp-archive helpers
//
// While files are staged for a NOMAD upload, the server keeps them in a
// temporary zip archive (backend TEMP_UPLOAD_DIR — see services/nomad.py). The
// archive path is remembered per experiment in sessionStorage so it survives
// in-app remounts of the Results page. Every code path that abandons a staging
// must discard the server-side archive through these helpers, so no orphaned
// zips (or stale sessionStorage pointers) are left behind — this is the single
// implementation of the discard request and of the sessionStorage bookkeeping.
// ─────────────────────────────────────────────────────────────────────────────

import { OpenAPI } from "../client/core/OpenAPI"
import { getTokenSync } from "./keycloakInstance"

const SESSION_KEY_PREFIX = "nomad_archive:"

/** sessionStorage key holding the server archive path for an experiment. */
export function sessionArchiveKey(experimentId: string): string {
  return `${SESSION_KEY_PREFIX}${experimentId}`
}

/**
 * Best-effort discard of a server-side temporary upload archive. Never throws:
 * the backend also TTL-sweeps abandoned archives, so a failure here only
 * delays cleanup. With `keepalive` the token is read synchronously and the
 * request is flagged to survive page unload (for beforeunload handlers).
 */
export async function discardArchive(
  archivePath: string,
  opts?: { keepalive?: boolean },
): Promise<void> {
  try {
    const form = new FormData()
    form.append("archive_path", archivePath)
    const token = opts?.keepalive
      ? (getTokenSync() ?? undefined)
      : typeof OpenAPI.TOKEN === "function"
        ? await OpenAPI.TOKEN({} as any)
        : (OpenAPI.TOKEN ?? undefined)
    await fetch(`${OpenAPI.BASE}/api/v1/nomad/upload/archive/discard`, {
      method: "POST",
      headers: token ? { Authorization: `Bearer ${token}` } : undefined,
      body: form,
      keepalive: opts?.keepalive,
    })
  } catch (_e) {
    // best-effort cleanup — the server-side TTL sweep is the fallback
  }
}

/** Read AND remove the archive-path record for one experiment. */
export function takeSessionArchivePath(experimentId: string): string | null {
  try {
    const key = sessionArchiveKey(experimentId)
    const path = sessionStorage.getItem(key)
    sessionStorage.removeItem(key)
    return path
  } catch (_e) {
    // ignore sessionStorage errors in restrictive environments
    return null
  }
}

/**
 * Enumerate AND clear every per-experiment archive record in this session.
 * Used by the central upload-flow discard and the app-load sweep to catch
 * archives whose owning flow is gone (e.g. after a re-login in the same tab,
 * where sessionStorage survives but the ephemeral flow did not).
 */
export function takeAllSessionArchivePaths(): Array<{
  experimentId: string
  path: string
}> {
  const found: Array<{ experimentId: string; path: string }> = []
  try {
    const keys: string[] = []
    for (let i = 0; i < sessionStorage.length; i++) {
      const key = sessionStorage.key(i)
      if (key?.startsWith(SESSION_KEY_PREFIX)) {
        keys.push(key)
      }
    }
    for (const key of keys) {
      const path = sessionStorage.getItem(key)
      sessionStorage.removeItem(key)
      if (path) {
        found.push({
          experimentId: key.slice(SESSION_KEY_PREFIX.length),
          path,
        })
      }
    }
  } catch (_e) {
    // ignore sessionStorage errors in restrictive environments
  }
  return found
}
