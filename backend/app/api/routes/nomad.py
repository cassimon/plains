"""
NOMAD Upload API Routes

Provides endpoints for:
- File upload and secure zip creation
- NOMAD metadata YAML generation and preview
- Upload to NOMAD with authentication
- Upload status checking
"""

import logging
import math
import uuid
import yaml
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# ─────────────────────────────────────────────────────────────────────────────
# Custom YAML Dumper: quote all strings, keep numbers/bools unquoted,
# treat nan/inf as quoted strings, render flat lists in flow style.
# ─────────────────────────────────────────────────────────────────────────────

class _QuotedDumper(yaml.Dumper):
    def represent_mapping(self, tag: str, mapping: Any, flow_style: bool | None = None) -> yaml.MappingNode:
        node = super().represent_mapping(tag, mapping, flow_style)
        # Strip quotes from mapping keys so only values are quoted
        for key_node, _value_node in node.value:
            if isinstance(key_node, yaml.ScalarNode) and key_node.tag == "tag:yaml.org,2002:str":
                key_node.style = None
        return node


def _represent_str_quoted(dumper: yaml.Dumper, data: str) -> yaml.ScalarNode:
    return dumper.represent_scalar("tag:yaml.org,2002:str", data, style='"')


def _represent_float_safe(dumper: yaml.Dumper, data: float) -> yaml.Node:
    if math.isnan(data) or math.isinf(data):
        return dumper.represent_scalar("tag:yaml.org,2002:str", str(data), style='"')
    return yaml.Dumper.represent_float(dumper, data)


def _represent_list_flow_if_flat(dumper: yaml.Dumper, data: list) -> yaml.SequenceNode:
    flat = all(isinstance(item, (str, int, float, bool)) for item in data)
    return dumper.represent_sequence("tag:yaml.org,2002:seq", data, flow_style=flat)


_QuotedDumper.add_representer(str, _represent_str_quoted)
_QuotedDumper.add_representer(float, _represent_float_safe)
_QuotedDumper.add_representer(list, _represent_list_flow_if_flat)

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app.api.deps import CurrentUser, SessionDep, TokenDep
from app.core.config import settings
from app.models import ExperimentResults
from app.services.nomad import (
    NomadAuthError,
    NomadUploadError,
    TEMP_UPLOAD_DIR,
    cleanup_temp_archive,
    create_nomad_metadata_yaml,
    create_secure_zip,
    get_nomad_token,
    get_upload_status,
    upload_to_nomad,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/nomad", tags=["nomad"])


def _require_nomad_upload_authorized(current_user: CurrentUser) -> None:
    """
    Allow archive creation/upload only for users authorized to use NOMAD uploads.

    When NOMAD OAuth is enabled, require an OAuth-linked user (`nomad_sub`) or
    a superuser account. This prevents local-only users from creating server-side
    upload archives for NOMAD.
    """
    if settings.NOMAD_OAUTH_ENABLED and not current_user.nomad_sub and not current_user.is_superuser:
        raise HTTPException(
            status_code=403,
            detail="NOMAD upload requires an authenticated NOMAD OAuth user",
        )


# ─────────────────────────────────────────────────────────────────────────────
# Request/Response Models
# ─────────────────────────────────────────────────────────────────────────────

class NomadConfigResponse(BaseModel):
    """NOMAD configuration status."""
    enabled: bool
    url: str
    use_global_auth: bool
    has_credentials: bool


class MeasurementFileInfo(BaseModel):
    """Measurement file metadata for NOMAD upload."""
    fileName: str
    fileType: str
    deviceName: str | None = None
    cell: str | None = None
    pixel: str | None = None
    value: float | None = None        # PCE (%)
    voc: float | None = None          # Open-circuit voltage (V)
    jsc: float | None = None          # Short-circuit current density (mA/cm²)
    ff: float | None = None           # Fill factor (%)
    user: str | None = None           # Operator / user from file header
    measurementDate: str | None = None  # Date from file header


class DeviceGroupInfo(BaseModel):
    """Device group info for NOMAD upload."""
    id: str
    deviceName: str
    assignedSubstrateId: str | None = None
    files: list[MeasurementFileInfo] = []


class SubstrateInfo(BaseModel):
    """Substrate info for NOMAD upload."""
    id: str
    name: str


class NomadUploadRequest(BaseModel):
    """Request body for NOMAD upload."""
    experiment_id: str
    experiment_name: str
    substrates: list[SubstrateInfo] = []
    measurement_files: list[MeasurementFileInfo] = []
    device_groups: list[DeviceGroupInfo] = []
    notes: str | None = None
    custom_metadata: dict[str, Any] | None = None


class NomadMetadataPreview(BaseModel):
    """Preview of NOMAD metadata."""
    metadata_json: dict[str, Any]      # filename → yaml_content_dict
    metadata_yaml: str  # YAML serialization of all archive files
    yaml_content: str  # YAML serialization for upload file organization
    file_count: int
    device_group_count: int


class NomadUploadResponse(BaseModel):
    """Response from NOMAD upload."""
    success: bool
    upload_id: str | None = None
    entry_ids: list[str] = []
    upload_create_time: str | None = None
    processing_status: str | None = None
    message: str | None = None


class NomadUploadStatus(BaseModel):
    """Status of a NOMAD upload."""
    upload_id: str
    status: str | None = None
    entries: list[dict] = []
    error: str | None = None


# ─────────────────────────────────────────────────────────────────────────────
# Endpoints
# ─────────────────────────────────────────────────────────────────────────────

@router.get("/config", response_model=NomadConfigResponse)
def get_nomad_config(current_user: CurrentUser) -> NomadConfigResponse:
    """
    Get NOMAD configuration status.
    
    This endpoint returns the current NOMAD configuration,
    allowing the frontend to display appropriate UI elements.
    """
    return NomadConfigResponse(
        enabled=settings.nomad_enabled,
        url=settings.NOMAD_URL,
        use_global_auth=settings.NOMAD_USE_GLOBAL_AUTH,
        has_credentials=bool(settings.NOMAD_USERNAME and settings.NOMAD_PASSWORD),
    )


@router.post("/upload/files")
async def upload_files_for_nomad(
    session: SessionDep,
    current_user: CurrentUser,
    experiment_id: str = Form(...),
    experiment_name: str = Form(...),
    files: list[UploadFile] = File(...),
    request_json: str | None = Form(None),
) -> dict[str, Any]:
    """
    Upload files and create a temporary secure zip archive.
    
    Files are:
    1. Validated for safety
    2. Compressed into a zip archive
    3. Optionally combined with NOMAD metadata YAML files (if request_json provided)
    4. Stored temporarily for later NOMAD upload
    
    Returns the archive ID for use in the upload step.
    
    If request_json is provided, YAML metadata files will be generated and included
    in the archive. This allows the frontend to prepare the upload earlier in the workflow.
    """
    _require_nomad_upload_authorized(current_user)

    if not files:
        raise HTTPException(status_code=400, detail="No files provided")
    
    # Read file contents
    file_data: list[tuple[str, bytes]] = []
    for f in files:
        content = await f.read()
        if f.filename:
            file_data.append((f.filename, content))
    
    if not file_data:
        raise HTTPException(status_code=400, detail="No valid files to upload")
    
    # Generate YAML metadata if request metadata is provided
    archive_yaml_files: list[tuple[str, str]] = []
    if request_json:
        try:
            request = NomadUploadRequest.model_validate_json(request_json)
            
            experiment_snapshot = None
            process_snapshot = None
            if request.custom_metadata and isinstance(request.custom_metadata, dict):
                candidate = request.custom_metadata.get("experiment")
                if isinstance(candidate, dict):
                    experiment_snapshot = candidate
                proc_candidate = request.custom_metadata.get("process")
                if isinstance(proc_candidate, dict):
                    process_snapshot = proc_candidate

            measurement_files_dicts = [f.model_dump() for f in request.measurement_files]
            device_groups_dicts = [g.model_dump() for g in request.device_groups]

            # Generate per-archive YAML files
            archives = create_nomad_metadata_yaml(
                experiment_id=request.experiment_id,
                user_name=current_user.full_name or current_user.email,
                session=session,
                experiment_snapshot=experiment_snapshot,
                process_snapshot=process_snapshot,
                measurement_files=measurement_files_dicts,
                device_groups=device_groups_dicts,
            )

            # Serialise each archive dict to its own YAML string
            archive_yaml_files = [
                (
                    filename,
                    yaml.dump(
                        content,
                        Dumper=_QuotedDumper,
                        default_flow_style=False,
                        allow_unicode=True,
                        sort_keys=False,
                    ),
                )
                for filename, content in archives.items()
            ]
            
            logger.info(f"Generated {len(archive_yaml_files)} YAML metadata files for archive")
        except Exception as e:
            logger.error(f"Failed to generate YAML metadata: {e}", exc_info=True)
            raise HTTPException(status_code=500, detail=f"Failed to generate metadata: {str(e)}")
    
    # Create secure zip
    try:
        zip_path = create_secure_zip(
            files=file_data,
            metadata_files=archive_yaml_files if archive_yaml_files else None,
            archive_name=f"{experiment_id[:8]}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.zip",
        )
        
        logger.info(f"Created temporary zip archive at {zip_path} with {len(file_data)} files + {len(archive_yaml_files)} YAML files, total size: {zip_path.stat().st_size} bytes")

        return {
            "success": True,
            "archive_path": str(zip_path),
            "archive_name": zip_path.name,
            "file_count": len(file_data),
            "metadata_file_count": len(archive_yaml_files),
            "total_size": zip_path.stat().st_size,
        }
        
    except Exception as e:
        logger.error(f"Failed to create zip archive: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to create archive: {e}")


@router.post("/upload/metadata")
async def add_metadata_to_archive(
    session: SessionDep,
    current_user: CurrentUser,
    archive_path: str = Form(...),
    request_json: str = Form(...),
) -> dict[str, Any]:
    """
    Add NOMAD metadata YAML files to an existing archive.
    
    This endpoint generates metadata from the provided request and adds
    the YAML files to an existing zip archive without re-uploading the
    measurement files.
    
    Args:
        archive_path: Path to the existing zip archive
        request_json: JSON string containing NomadUploadRequest data
    
    Returns:
        Dict with success status, archive info, and metadata file count
    """
    _require_nomad_upload_authorized(current_user)
    
    try:
        request = NomadUploadRequest.model_validate_json(request_json)
    except Exception as e:
        logger.error("Invalid NOMAD upload metadata", exc_info=True)
        raise HTTPException(status_code=422, detail="Invalid upload request metadata")
    
    # Validate archive path
    try:
        candidate = Path(archive_path).resolve()
    except Exception as e:
        raise HTTPException(status_code=400, detail="Invalid archive path") from e
    
    allowed_root = TEMP_UPLOAD_DIR.resolve()
    if not str(candidate).startswith(str(allowed_root)):
        raise HTTPException(status_code=403, detail="Archive path is not allowed")
    
    if not candidate.exists():
        raise HTTPException(status_code=404, detail="Archive not found")
    
    try:
        experiment_snapshot = None
        process_snapshot = None
        if request.custom_metadata and isinstance(request.custom_metadata, dict):
            candidate_exp = request.custom_metadata.get("experiment")
            if isinstance(candidate_exp, dict):
                experiment_snapshot = candidate_exp
            proc_candidate = request.custom_metadata.get("process")
            if isinstance(proc_candidate, dict):
                process_snapshot = proc_candidate
        
        measurement_files_dicts = [f.model_dump() for f in request.measurement_files]
        device_groups_dicts = [g.model_dump() for g in request.device_groups]
        
        # Generate per-archive YAML files
        archives = create_nomad_metadata_yaml(
            experiment_id=request.experiment_id,
            user_name=current_user.full_name or current_user.email,
            session=session,
            experiment_snapshot=experiment_snapshot,
            process_snapshot=process_snapshot,
            measurement_files=measurement_files_dicts,
            device_groups=device_groups_dicts,
        )
        
        # Serialize each archive dict to its own YAML string
        from app.services.nomad import add_metadata_to_zip
        
        archive_yaml_files: list[tuple[str, str]] = [
            (
                filename,
                yaml.dump(
                    content,
                    Dumper=_QuotedDumper,
                    default_flow_style=False,
                    allow_unicode=True,
                    sort_keys=False,
                ),
            )
            for filename, content in archives.items()
        ]
        
        # Add metadata to the existing archive
        add_metadata_to_zip(candidate, archive_yaml_files)
        
        logger.info(f"Added {len(archive_yaml_files)} YAML metadata files to archive {candidate}")
        
        return {
            "success": True,
            "archive_path": str(candidate),
            "archive_name": candidate.name,
            "metadata_file_count": len(archive_yaml_files),
            "total_size": candidate.stat().st_size,
        }
        
    except Exception as e:
        logger.error(f"Failed to add metadata to archive: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to add metadata: {str(e)}")


@router.post("/metadata/preview")
async def preview_metadata_from_archive(
    current_user: CurrentUser,
    archive_path: str = Form(...),
) -> dict[str, Any]:
    """
    Preview NOMAD metadata YAML files from an existing archive.
    
    This endpoint reads all .yaml files from the archive and returns
    their content for review before uploading to NOMAD.
    
    Args:
        archive_path: Path to the zip archive containing YAML files
    
    Returns:
        Dict with yaml_files (dict of filename -> content), file_list, and metadata_count
    """
    _require_nomad_upload_authorized(current_user)
    
    # Validate archive path
    try:
        candidate = Path(archive_path).resolve()
    except Exception as e:
        raise HTTPException(status_code=400, detail="Invalid archive path") from e
    
    allowed_root = TEMP_UPLOAD_DIR.resolve()
    if not str(candidate).startswith(str(allowed_root)):
        raise HTTPException(status_code=403, detail="Archive path is not allowed")
    
    if not candidate.exists():
        raise HTTPException(status_code=404, detail="Archive not found")
    
    try:
        from app.services.nomad import read_yaml_files_from_zip
        import zipfile
        
        # Read YAML files from archive
        yaml_files = read_yaml_files_from_zip(candidate)
        
        # Get list of all files in archive
        with zipfile.ZipFile(candidate, 'r') as zipf:
            all_files = zipf.namelist()
        
        return {
            "success": True,
            "yaml_files": yaml_files,
            "all_files": all_files,
            "metadata_count": len(yaml_files),
            "total_file_count": len(all_files),
        }
        
    except Exception as e:
        logger.error(f"Failed to read metadata from archive: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to read metadata: {str(e)}")


@router.post("/upload/archive/discard")
async def discard_uploaded_archive(
    current_user: CurrentUser,
    archive_path: str = Form(...),
) -> dict[str, Any]:
    """Discard a previously created temporary archive from /upload/files."""
    _require_nomad_upload_authorized(current_user)

    try:
        candidate = Path(archive_path).resolve()
    except Exception as e:
        raise HTTPException(status_code=400, detail="Invalid archive path") from e

    allowed_root = TEMP_UPLOAD_DIR.resolve()
    if not str(candidate).startswith(str(allowed_root)):
        raise HTTPException(status_code=403, detail="Archive path is not allowed")

    deleted = cleanup_temp_archive(candidate)
    return {
        "success": deleted,
        "archive_path": str(candidate),
    }


@router.post("/upload/nomad", response_model=NomadUploadResponse)
async def upload_to_nomad_endpoint(
    session: SessionDep,
    current_user: CurrentUser,
    token: TokenDep,  # Get the user's current auth token
    request_json: str = Form(...),
    archive_path: str | None = None,
    files: list[UploadFile] | None = File(None),
) -> NomadUploadResponse:
    """
    Upload data to NOMAD.
    
    This endpoint:
    1. Creates a secure zip with files and NOMAD metadata
    2. Uploads to NOMAD using global authentication
    3. Updates the experiment results with NOMAD metadata
    4. Cleans up temporary files
    
    Can accept either:
    - archive_path: Path to a pre-created archive (from /upload/files)
    - files: Direct file upload
    """
    _require_nomad_upload_authorized(current_user)

    try:
        request = NomadUploadRequest.model_validate_json(request_json)
    except Exception as e:
        logger.error("Invalid NOMAD upload metadata", exc_info=True)
        raise HTTPException(status_code=422, detail="Invalid upload request metadata")

    logger.info(
        f"Received NOMAD upload request for experiment_id: {request.experiment_id}, experiment_name: {request.experiment_name}, archive_path: {archive_path}, file_count: {len(files) if files else 0}"
    )

    use_user_nomad_token = bool(settings.NOMAD_OAUTH_ENABLED and current_user.nomad_sub)

    if not use_user_nomad_token and not settings.nomad_enabled:
        return NomadUploadResponse(
            success=False,
            message="NOMAD integration is not configured. Add credentials to the NOMAD auth file (../sensitive config/.nomad_auth)",
        )
    
    try:
        experiment_snapshot = None
        process_snapshot = None
        if request.custom_metadata and isinstance(request.custom_metadata, dict):
            candidate = request.custom_metadata.get("experiment")
            if isinstance(candidate, dict):
                experiment_snapshot = candidate
            proc_candidate = request.custom_metadata.get("process")
            if isinstance(proc_candidate, dict):
                process_snapshot = proc_candidate

        measurement_files_dicts = [f.model_dump() for f in request.measurement_files]
        device_groups_dicts = [g.model_dump() for g in request.device_groups]

        # Generate per-archive YAML files
        archives = create_nomad_metadata_yaml(
            experiment_id=request.experiment_id,
            user_name=current_user.full_name or current_user.email,
            session=session,
            experiment_snapshot=experiment_snapshot,
            process_snapshot=process_snapshot,
            measurement_files=measurement_files_dicts,
            device_groups=device_groups_dicts,
        )

        # Serialise each archive dict to its own YAML string
        archive_yaml_files: list[tuple[str, str]] = [
            (
                filename,
                yaml.dump(
                    content,
                    Dumper=_QuotedDumper,
                    default_flow_style=False,
                    allow_unicode=True,
                    sort_keys=False,
                ),
            )
            for filename, content in archives.items()
        ]

        # Use pre-created archive or create a new one
        if archive_path:
            # Validate and use the pre-created archive
            try:
                candidate = Path(archive_path).resolve()
            except Exception as e:
                raise HTTPException(status_code=400, detail="Invalid archive path") from e

            allowed_root = TEMP_UPLOAD_DIR.resolve()
            if not str(candidate).startswith(str(allowed_root)):
                raise HTTPException(status_code=403, detail="Archive path is not allowed")
            
            if not candidate.exists():
                raise HTTPException(status_code=404, detail="Archive not found")
            
            zip_path = candidate
            logger.info(f"Using pre-created archive at {zip_path}")
        elif files:
            # Create a new archive from uploaded files
            file_data: list[tuple[str, bytes]] = []
            for f in files:
                content_bytes = await f.read()
                if f.filename:
                    file_data.append((f.filename, content_bytes))

            zip_path = create_secure_zip(
                files=file_data,
                metadata_files=archive_yaml_files,
                archive_name=f"{request.experiment_id[:8]}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.zip",
            )
            logger.info(f"Created new archive at {zip_path}")
        else:
            raise HTTPException(status_code=400, detail="No files or archive provided")
        
        # Get NOMAD token
        # If user is authenticated via NOMAD OAuth, use that token
        # Otherwise, use global credentials
        if use_user_nomad_token:
            nomad_token = token  # Use the user's OAuth token directly
            logger.info("Using user's NOMAD OAuth token for upload")
        else:
            nomad_token = get_nomad_token()
            logger.info("Using global NOMAD credentials for upload")
        
        # Upload to NOMAD
        result = upload_to_nomad(
            zip_path=zip_path,
            token=nomad_token,
            upload_name=request.experiment_name,
        )
        
        # Clean up temporary archive
        cleanup_temp_archive(zip_path)
        
        # Update experiment results with NOMAD info (if result exists)
        try:
            from sqlmodel import select
            exp_uuid = uuid.UUID(request.experiment_id)
            statement = select(ExperimentResults).where(
                ExperimentResults.experiment_id == exp_uuid,
                ExperimentResults.owner_id == current_user.id,
            )
            db_results = session.exec(statement).first()
            
            if db_results:
                # Store NOMAD info in frontend_data
                nomad_info = {
                    "nomad_upload_id": result.get("upload_id"),
                    "nomad_entry_ids": result.get("entry_ids", []),
                    "nomad_upload_time": result.get("upload_create_time"),
                    "nomad_processing_status": result.get("processing_status"),
                    "nomad_uploaded_at": datetime.now(timezone.utc).isoformat(),
                }
                
                if db_results.frontend_data:
                    db_results.frontend_data.update({"nomad": nomad_info})
                else:
                    db_results.frontend_data = {"nomad": nomad_info}
                
                session.add(db_results)
                session.commit()
                
        except Exception as e:
            logger.warning(f"Could not update experiment results with NOMAD info: {e}")
        
        return NomadUploadResponse(
            success=True,
            upload_id=result.get("upload_id"),
            entry_ids=result.get("entry_ids", []),
            upload_create_time=result.get("upload_create_time"),
            processing_status=result.get("processing_status"),
            message="Successfully uploaded to NOMAD",
        )
        
    except NomadAuthError as e:
        logger.error(f"NOMAD auth error: {e}")
        return NomadUploadResponse(
            success=False,
            message=str(e),
        )
    except NomadUploadError as e:
        logger.error(f"NOMAD upload error: {e}")
        return NomadUploadResponse(
            success=False,
            message=str(e),
        )
    except Exception as e:
        logger.error(f"Unexpected error during NOMAD upload: {e}")
        return NomadUploadResponse(
            success=False,
            message=f"Upload failed: {e}",
        )


@router.get("/upload/{upload_id}/status", response_model=NomadUploadStatus)
def check_upload_status(
    current_user: CurrentUser,
    upload_id: str,
) -> NomadUploadStatus:
    """
    Check the status of a NOMAD upload.
    
    Use this to monitor processing progress after upload.
    """
    if not settings.nomad_enabled:
        raise HTTPException(status_code=503, detail="NOMAD integration not configured")
    
    try:
        status = get_upload_status(upload_id)
        
        if "error" in status:
            return NomadUploadStatus(
                upload_id=upload_id,
                error=status["error"],
            )
        
        return NomadUploadStatus(
            upload_id=upload_id,
            status=status.get("process_status"),
            entries=status.get("entries", []),
        )
        
    except Exception as e:
        return NomadUploadStatus(
            upload_id=upload_id,
            error=str(e),
        )


@router.post("/auth/test")
def test_nomad_auth(current_user: CurrentUser) -> dict[str, Any]:
    """
    Test NOMAD authentication with configured credentials.
    
    Returns success/failure and any error messages.
    """
    if not settings.NOMAD_USERNAME or not settings.NOMAD_PASSWORD:
        return {
            "success": False,
            "message": "NOMAD credentials not configured",
            "configured": False,
        }
    
    try:
        token = get_nomad_token()
        return {
            "success": True,
            "message": "Authentication successful",
            "configured": True,
            "url": settings.NOMAD_URL,
        }
    except NomadAuthError as e:
        return {
            "success": False,
            "message": str(e),
            "configured": True,
            "url": settings.NOMAD_URL,
        }
