/**
 * NOMAD API Client
 *
 * Client-side functions for interacting with the NOMAD upload API.
 */

import { OpenAPI } from "./core/OpenAPI"
import { request } from "./core/request"

// ─────────────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────────────

export interface NomadConfig {
  enabled: boolean
  url: string
  use_global_auth: boolean
  has_credentials: boolean
}

export interface MeasurementFileInfo {
  fileName: string
  fileType: string
  deviceName?: string
  cell?: string
  pixel?: string
  value?: number
}

export interface DeviceGroupInfo {
  id: string
  deviceName: string
  assignedSubstrateId?: string | null
  files: MeasurementFileInfo[]
}

export interface SubstrateInfo {
  id: string
  name: string
}

export interface NomadUploadRequest {
  experiment_id: string
  experiment_name: string
  substrates: SubstrateInfo[]
  measurement_files: MeasurementFileInfo[]
  device_groups: DeviceGroupInfo[]
  notes?: string
  custom_metadata?: Record<string, unknown>
}

export interface NomadMetadataPreview {
  yaml_content: string
  file_count: number
  device_group_count: number
}

export interface NomadUploadResponse {
  success: boolean
  upload_id?: string
  entry_ids: string[]
  upload_create_time?: string
  processing_status?: string
  message?: string
}

export interface NomadUploadStatus {
  upload_id: string
  status?: string
  entries: Array<Record<string, unknown>>
  error?: string
}

export interface NomadAuthTestResult {
  success: boolean
  message: string
  configured: boolean
  url?: string
}

// ─────────────────────────────────────────────────────────────────────────────
// API Functions
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Get NOMAD configuration status.
 */
export async function getNomadConfig(): Promise<NomadConfig> {
  return request(OpenAPI, {
    method: "GET",
    url: "/api/v1/nomad/config",
  })
}

/**
 * Preview NOMAD metadata YAML.
 */
export async function previewNomadMetadata(
  data: NomadUploadRequest
): Promise<NomadMetadataPreview> {
  return request(OpenAPI, {
    method: "POST",
    url: "/api/v1/nomad/metadata/preview",
    body: data,
    mediaType: "application/json",
  })
}

/**
 * Upload files and data to NOMAD.
 */
export async function uploadToNomad(
  data: NomadUploadRequest,
  files: File[]
): Promise<NomadUploadResponse> {
  // Create FormData for file upload
  const formData = new FormData()

  // Add files
  for (const file of files) {
    formData.append("files", file)
  }

  // Add request data as JSON in a special field
  // The backend needs to handle this appropriately
  formData.append("experiment_id", data.experiment_id)
  formData.append("experiment_name", data.experiment_name)

  // Get auth token
  const token = OpenAPI.TOKEN || localStorage.getItem("access_token")

  // Make the request with multipart form data
  const response = await fetch(
    `${OpenAPI.BASE}/api/v1/nomad/upload/nomad`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    }
  )

  if (!response.ok) {
    const error = await response.text()
    throw new Error(`Upload failed: ${error}`)
  }

  return response.json()
}

/**
 * Upload to NOMAD using JSON request (for when files are already uploaded).
 */
export async function uploadToNomadJson(
  data: NomadUploadRequest
): Promise<NomadUploadResponse> {
  return request(OpenAPI, {
    method: "POST",
    url: "/api/v1/nomad/upload/nomad",
    body: data,
    mediaType: "application/json",
  })
}

/**
 * Check the status of a NOMAD upload.
 */
export async function checkNomadUploadStatus(
  uploadId: string
): Promise<NomadUploadStatus> {
  return request(OpenAPI, {
    method: "GET",
    url: `/api/v1/nomad/upload/${uploadId}/status`,
  })
}

/**
 * Test NOMAD authentication.
 */
export async function testNomadAuth(): Promise<NomadAuthTestResult> {
  return request(OpenAPI, {
    method: "POST",
    url: "/api/v1/nomad/auth/test",
  })
}
