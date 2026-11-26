// Client helpers for measurement corrections (WO-05). The backend endpoint is
// authoritative and atomic: it applies the change and records the traceable
// history in one transaction.

import { OpenAPI } from "@/client/core/OpenAPI"
import { getTokenAsync } from "@/lib/keycloakInstance"

export type CorrectionOperation = "scale" | "exclude" | "restore" | "edit"

export type CorrectionHistory = {
  id: string
  measurement_id: string
  field: string
  operation: string
  previous_value: string | null
  new_value: string | null
  reason: string
  actor_email: string
  created_at: string | null
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getTokenAsync()
  const res = await fetch(`${OpenAPI.BASE}/api/v1${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : undefined),
      ...(init?.headers ?? {}),
    },
  })
  if (!res.ok) {
    let detail: string | undefined
    try {
      detail = (await res.json())?.detail
    } catch {
      /* non-JSON error */
    }
    throw new Error(detail ?? `Request failed (${res.status})`)
  }
  return (await res.json()) as T
}

export function applyCorrection(
  resultId: string,
  payload: {
    measurement_id: string
    operation: CorrectionOperation
    field?: string
    factor?: number
    value?: string
    reason: string
  },
): Promise<CorrectionHistory> {
  return request(`/results/${resultId}/corrections`, {
    method: "POST",
    body: JSON.stringify(payload),
  })
}

export function listCorrections(
  resultId: string,
): Promise<CorrectionHistory[]> {
  return request(`/results/${resultId}/corrections`)
}
