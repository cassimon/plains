"""
NOMAD Upload Service

Handles secure file compression and upload to NOMAD (Novel Materials Discovery).

This service provides:
- Secure zip file creation for uploads
- NOMAD metadata YAML generation
- Upload to NOMAD with authentication
- Cleanup of temporary files

Uses the nomad_utility_workflows package for NOMAD API interaction.
"""

import logging
import os
import shutil
import tempfile
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx
import yaml

from app.core.config import settings

logger = logging.getLogger(__name__)

# Temporary directory for zip files (will be cleaned up after upload)
TEMP_UPLOAD_DIR = Path(tempfile.gettempdir()) / "plains_nomad_uploads"


class NomadUploadError(Exception):
    """Raised when NOMAD upload fails."""
    pass


class NomadAuthError(Exception):
    """Raised when NOMAD authentication fails."""
    pass


def ensure_temp_dir() -> Path:
    """Ensure the temporary upload directory exists."""
    TEMP_UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    return TEMP_UPLOAD_DIR


def get_nomad_token(username: str | None = None, password: str | None = None) -> str:
    """
    Get NOMAD authentication token.
    
    Args:
        username: NOMAD username (uses global config if not provided)
        password: NOMAD password (uses global config if not provided)
    
    Returns:
        Authentication token string
    
    Raises:
        NomadAuthError: If authentication fails
    """
    use_username = username or settings.NOMAD_USERNAME
    use_password = password or settings.NOMAD_PASSWORD
    
    if not use_username or not use_password:
        raise NomadAuthError("NOMAD credentials not configured. Add username/password to the NOMAD auth file (../sensitive config/.nomad_auth)")
    
    # NOMAD uses OAuth2 password grant
    auth_url = settings.NOMAD_URL.replace("/api/v1", "/api/v1/auth/token")
    
    # ── MOCK MODE ──────────────────────────────────────────────────────
    if settings.NOMAD_MOCK_MODE:
        logger.info(
            "[MOCK MODE] get_nomad_token — would POST %s for user=%s. "
            "Returning fake token instead.",
            auth_url,
            use_username,
        )
        return "MOCK_TOKEN_no_real_request_was_made"
    # ───────────────────────────────────────────────────────────────────
    
    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.post(
                auth_url,
                data={
                    "grant_type": "password",
                    "username": use_username,
                    "password": use_password,
                },
                headers={"Content-Type": "application/x-www-form-urlencoded"},
            )
            
            if response.status_code != 200:
                logger.error(f"NOMAD auth failed: {response.status_code} - {response.text}")
                raise NomadAuthError(f"NOMAD authentication failed: {response.status_code}")
            
            token_data = response.json()
            return token_data.get("access_token", "")
            
    except httpx.RequestError as e:
        logger.error(f"NOMAD auth request error: {e}")
        raise NomadAuthError(f"Failed to connect to NOMAD: {e}")


def create_secure_zip(
    files: list[tuple[str, bytes]],
    metadata_files: list[tuple[str, str]] | None = None,
    archive_name: str | None = None,
) -> Path:
    """
    Create a secure zip archive from uploaded files.
    
    Security measures:
    - Files are placed in a flat structure (no path traversal)
    - Filenames are sanitized
    - Archive is created in a secure temp directory
    
    Args:
        files: List of (filename, file_content_bytes) tuples
        metadata_files: Optional list of (filename, yaml_content) for NOMAD metadata
        archive_name: Optional custom archive name (auto-generated if not provided)
    
    Returns:
        Path to the created zip file
    """
    ensure_temp_dir()
    
    if not archive_name:
        archive_name = f"upload_{uuid.uuid4().hex[:8]}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.zip"
    
    zip_path = TEMP_UPLOAD_DIR / archive_name
    
    with zipfile.ZipFile(zip_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
        # Add data files
        for filename, content in files:
            # Sanitize filename - remove path components
            safe_filename = Path(filename).name
            # Remove any potentially dangerous characters
            safe_filename = "".join(c for c in safe_filename if c.isalnum() or c in "._- ")
            if safe_filename:
                zipf.writestr(safe_filename, content)
        
        # Add metadata YAML files
        if metadata_files:
            for meta_filename, yaml_content in metadata_files:
                safe_meta = Path(meta_filename).name
                zipf.writestr(safe_meta, yaml_content)
    
    logger.info(f"Created secure zip archive: {zip_path} ({zip_path.stat().st_size} bytes)")
    return zip_path


def create_nomad_metadata_yaml(
    experiment_name: str,
    substrates: list[dict[str, Any]],
    measurement_files: list[dict[str, Any]],
    device_groups: list[dict[str, Any]],
    user_notes: str | None = None,
    custom_metadata: dict[str, Any] | None = None,
) -> str:
    """
    Create NOMAD metadata YAML content for data management.
    
    This generates a YAML file that describes how the data should be stored
    and organized in NOMAD.
    
    Args:
        experiment_name: Name of the experiment
        substrates: List of substrate info dicts
        measurement_files: List of measurement file metadata
        device_groups: List of device group info
        user_notes: Optional notes about the upload
        custom_metadata: Optional additional metadata
    
    Returns:
        YAML string content
    """
    metadata = {
        "metadata": {
            "upload_name": experiment_name,
            "upload_create_time": datetime.now(timezone.utc).isoformat(),
            "coauthors": [],
            "references": [],
            "datasets": [],
            "embargo_length": 0,
            "comment": user_notes or f"Automated upload from Plains GUI for experiment: {experiment_name}",
        },
        "entries": [],
    }
    
    # Create entries for each measurement file
    for mf in measurement_files:
        entry = {
            "mainfile": mf.get("fileName", ""),
            "entry_name": mf.get("fileName", "").replace(".", "_"),
            "comment": f"Measurement file: {mf.get('fileType', 'Unknown')}",
        }
        
        # Add device information if available
        if mf.get("deviceName"):
            entry["metadata"] = {
                "device_name": mf.get("deviceName"),
                "cell": mf.get("cell", ""),
                "pixel": mf.get("pixel", ""),
            }
        
        metadata["entries"].append(entry)
    
    # Add device group information
    if device_groups:
        metadata["device_groups"] = []
        for dg in device_groups:
            group_info = {
                "name": dg.get("deviceName", "Unknown"),
                "substrate_id": dg.get("assignedSubstrateId"),
                "files": [f.get("fileName") for f in dg.get("files", [])],
            }
            metadata["device_groups"].append(group_info)
    
    # Add substrate information
    if substrates:
        metadata["substrates"] = [
            {"id": s.get("id"), "name": s.get("name")}
            for s in substrates
        ]
    
    # Merge custom metadata
    if custom_metadata:
        metadata.update(custom_metadata)
    
    logger.info(
            "[yaml] Generated NOMAD metadata YAML for experiment '%s' with %d substrates, %d measurement files, and %d device groups." \
                "nUser notes: %s\nCustom metadata keys: %s",
            experiment_name,
            substrates,
            measurement_files,
            device_groups,
            user_notes,
            yaml.dump(metadata, default_flow_style=False, allow_unicode=True, sort_keys=False)
        )

    return yaml.dump(metadata, default_flow_style=False, allow_unicode=True, sort_keys=False)


def upload_to_nomad(
    zip_path: Path,
    token: str | None = None,
    upload_name: str | None = None,
) -> dict[str, Any]:
    """
    Upload a zip file to NOMAD.
    
    Args:
        zip_path: Path to the zip file to upload
        token: NOMAD auth token (fetches new one if not provided)
        upload_name: Optional name for the upload
    
    Returns:
        Dict with upload_id, entry_ids, and other metadata from NOMAD
    
    Raises:
        NomadUploadError: If upload fails
    """
    if not token:
        token = get_nomad_token()
    
    if not zip_path.exists():
        raise NomadUploadError(f"Zip file not found: {zip_path}")
    
    upload_url = f"{settings.NOMAD_URL}/uploads"
    
    # ── MOCK MODE ──────────────────────────────────────────────────────
    if settings.NOMAD_MOCK_MODE:
        mock_id = f"MOCK_{uuid.uuid4().hex[:12]}"
        logger.info(
            "[MOCK MODE] upload_to_nomad — would POST %s with file=%s (%d bytes), "
            "upload_name=%s. Returning fake upload_id=%s instead.",
            upload_url,
            zip_path.name,
            zip_path.stat().st_size,
            upload_name,
            mock_id,
        )
        return {
            "upload_id": mock_id,
            "upload_create_time": datetime.now(timezone.utc).isoformat(),
            "processing_status": "mock",
            "entries": [],
            "entry_ids": [],
        }
    # ───────────────────────────────────────────────────────────────────
    
    try:
        with httpx.Client(timeout=120.0) as client:
            with open(zip_path, "rb") as f:
                # Prepare multipart form data
                files = {"file": (zip_path.name, f, "application/zip")}
                params = {}
                if upload_name:
                    params["upload_name"] = upload_name
                
                response = client.post(
                    upload_url,
                    files=files,
                    params=params,
                    headers={"Authorization": f"Bearer {token}"},
                )
            
            if response.status_code not in (200, 201):
                logger.error(f"NOMAD upload failed: {response.status_code} - {response.text}")
                raise NomadUploadError(f"NOMAD upload failed: {response.status_code}")
            
            upload_data = response.json()
            logger.info(f"NOMAD upload successful: {upload_data.get('upload_id')}")
            
            return {
                "upload_id": upload_data.get("upload_id"),
                "upload_create_time": upload_data.get("upload_create_time"),
                "processing_status": upload_data.get("process_status"),
                "entries": upload_data.get("entries", []),
                # Extract entry_ids if available
                "entry_ids": [e.get("entry_id") for e in upload_data.get("entries", []) if e.get("entry_id")],
            }
            
    except httpx.RequestError as e:
        logger.error(f"NOMAD upload request error: {e}")
        raise NomadUploadError(f"Failed to connect to NOMAD: {e}")


def get_upload_status(upload_id: str, token: str | None = None) -> dict[str, Any]:
    """
    Get the status of a NOMAD upload.
    
    Args:
        upload_id: The NOMAD upload ID
        token: NOMAD auth token (fetches new one if not provided)
    
    Returns:
        Dict with upload status information
    """
    if not token:
        token = get_nomad_token()
    
    status_url = f"{settings.NOMAD_URL}/uploads/{upload_id}"
    
    # ── MOCK MODE ──────────────────────────────────────────────────────
    if settings.NOMAD_MOCK_MODE:
        logger.info(
            "[MOCK MODE] get_upload_status — would GET %s. "
            "Returning fake 'success' status instead.",
            status_url,
        )
        return {
            "upload_id": upload_id,
            "process_status": "mock_success",
            "entries": [],
        }
    # ───────────────────────────────────────────────────────────────────
    
    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.get(
                status_url,
                headers={"Authorization": f"Bearer {token}"},
            )
            
            if response.status_code != 200:
                logger.error(f"NOMAD status check failed: {response.status_code}")
                return {"error": f"Status check failed: {response.status_code}"}
            
            return response.json()
            
    except httpx.RequestError as e:
        logger.error(f"NOMAD status request error: {e}")
        return {"error": str(e)}


def delete_upload(upload_id: str, token: str | None = None) -> bool:
    """
    Delete a NOMAD upload.
    
    Args:
        upload_id: The NOMAD upload ID to delete
        token: NOMAD auth token (fetches new one if not provided)
    
    Returns:
        True if deletion was successful
    """
    if not token:
        token = get_nomad_token()
    
    delete_url = f"{settings.NOMAD_URL}/uploads/{upload_id}"
    
    # ── MOCK MODE ──────────────────────────────────────────────────────
    if settings.NOMAD_MOCK_MODE:
        logger.info(
            "[MOCK MODE] delete_upload — would DELETE %s. "
            "Returning True (no-op) instead.",
            delete_url,
        )
        return True
    # ───────────────────────────────────────────────────────────────────
    
    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.delete(
                delete_url,
                headers={"Authorization": f"Bearer {token}"},
            )
            
            return response.status_code in (200, 204)
            
    except httpx.RequestError as e:
        logger.error(f"NOMAD delete request error: {e}")
        return False


def cleanup_temp_archive(zip_path: Path) -> bool:
    """
    Delete a temporary archive file.
    
    Args:
        zip_path: Path to the zip file to delete
    
    Returns:
        True if deletion was successful
    """
    try:
        if zip_path.exists() and zip_path.is_file():
            zip_path.unlink()
            logger.info(f"Cleaned up temporary archive: {zip_path}")
            return True
        return False
    except OSError as e:
        logger.error(f"Failed to cleanup temporary archive {zip_path}: {e}")
        return False


def cleanup_all_temp_archives() -> int:
    """
    Clean up all temporary archive files.
    
    Returns:
        Number of files deleted
    """
    if not TEMP_UPLOAD_DIR.exists():
        return 0
    
    count = 0
    for zip_file in TEMP_UPLOAD_DIR.glob("*.zip"):
        try:
            zip_file.unlink()
            count += 1
        except OSError:
            pass
    
    logger.info(f"Cleaned up {count} temporary archives")
    return count
