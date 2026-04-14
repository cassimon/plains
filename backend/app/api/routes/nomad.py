"""
NOMAD Upload API Routes

Provides endpoints for:
- File upload and secure zip creation
- NOMAD metadata YAML generation and preview
- Upload to NOMAD with authentication
- Upload status checking
"""

import logging
import uuid
import yaml
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, File, Form, HTTPException, UploadFile
from pydantic import BaseModel

from app.api.deps import CurrentUser, SessionDep
from app.core.config import settings
from app.models import ExperimentResults
from app.services.nomad import (
    NomadAuthError,
    NomadUploadError,
    cleanup_temp_archive,
    create_nomad_metadata_yaml,
    create_secure_zip,
    get_nomad_token,
    get_upload_status,
    upload_to_nomad,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/nomad", tags=["nomad"])


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
    value: float | None = None


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
    metadata_json: dict[str, Any]
    yaml_content: str  # YAML serialization for display
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


@router.post("/metadata/preview", response_model=NomadMetadataPreview)
def preview_nomad_metadata(
    session: SessionDep,
    current_user: CurrentUser,
    request: NomadUploadRequest,
) -> NomadMetadataPreview:
    """
    Preview the NOMAD metadata JSON that would be generated.
    
    This allows users to review the metadata before uploading.
    Provides both:
    - metadata_json: Perovskite solar cell JSON structure
    - yaml_content: Upload archive metadata YAML (file organization)
    """
    try:
        experiment_snapshot = None
        if request.custom_metadata and isinstance(request.custom_metadata, dict):
            candidate = request.custom_metadata.get("experiment")
            if isinstance(candidate, dict):
                experiment_snapshot = candidate

        metadata_json = create_nomad_metadata_yaml(
            experiment_id=request.experiment_id,
            user_name=current_user.full_name or current_user.email,
            session=session,
            experiment_snapshot=experiment_snapshot,
        )
        
        logger.info(f"DEBUG: metadata_json type: {type(metadata_json)}, keys: {list(metadata_json.keys()) if isinstance(metadata_json, dict) else 'N/A'}")
        
        # Generate upload archive metadata (for file organization YAML preview)
        upload_metadata = {
            "metadata": {
                "upload_name": request.experiment_name,
                "upload_create_time": datetime.now(timezone.utc).isoformat(),
                "coauthors": [],
                "references": [],
                "datasets": [],
                "embargo_length": 0,
                "comment": "Automated upload from Plains GUI",
            },
            "entries": [
                {
                    "mainfile": f.fileName,
                    "entry_name": f.fileName.replace(".", "_"),
                    "comment": f"Measurement file: {f.fileType}",
                    "metadata": {
                        "device_name": f.deviceName or "Unknown",
                        "cell": f.cell or "",
                        "pixel": f.pixel or "",
                    }
                }
                for f in request.measurement_files
            ],
            "device_groups": [
                {
                    "name": g.deviceName,
                    "substrate_id": g.assignedSubstrateId or "",
                    "files": [f.fileName for f in g.files],
                }
                for g in request.device_groups
            ],
            "substrates": [
                {"id": str(s.id), "name": s.name}
                for s in request.substrates
            ]
        }
        
        # Convert upload metadata to YAML for file organization preview
        yaml_content = yaml.dump(upload_metadata, default_flow_style=False, allow_unicode=True, sort_keys=False)
        
        logger.info(f"Generated metadata preview with keys: {list(metadata_json.get('data', {}).keys())}")
        
        preview = NomadMetadataPreview(
            metadata_json=metadata_json,
            yaml_content=yaml_content,
            file_count=len(request.measurement_files),
            device_group_count=len(request.device_groups),
        )
        
        logger.info(f"DEBUG: NomadMetadataPreview created. preview has metadata_json: {'metadata_json' in preview.model_dump()}")
        
        return preview
    except Exception as e:
        logger.error(f"Error generating metadata preview: {e}", exc_info=True)
        raise HTTPException(status_code=500, detail=f"Failed to generate metadata: {str(e)}")


@router.post("/upload/files")
async def upload_files_for_nomad(
    current_user: CurrentUser,
    experiment_id: str = Form(...),
    experiment_name: str = Form(...),
    files: list[UploadFile] = File(...),
) -> dict[str, Any]:
    """
    Upload files and create a temporary secure zip archive.
    
    Files are:
    1. Validated for safety
    2. Compressed into a zip archive
    3. Stored temporarily for later NOMAD upload
    
    Returns the archive ID for use in the upload step.
    """
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
    
    # Create secure zip
    try:
        zip_path = create_secure_zip(
            files=file_data,
            archive_name=f"{experiment_id[:8]}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.zip",
        )
        
        return {
            "success": True,
            "archive_path": str(zip_path),
            "archive_name": zip_path.name,
            "file_count": len(file_data),
            "total_size": zip_path.stat().st_size,
        }
        
    except Exception as e:
        logger.error(f"Failed to create zip archive: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to create archive: {e}")


@router.post("/upload/nomad", response_model=NomadUploadResponse)
async def upload_to_nomad_endpoint(
    session: SessionDep,
    current_user: CurrentUser,
    request: NomadUploadRequest,
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
    if not settings.nomad_enabled:
        return NomadUploadResponse(
            success=False,
            message="NOMAD integration is not configured. Add credentials to the NOMAD auth file (../sensitive config/.nomad_auth)",
        )
    
    try:
        experiment_snapshot = None
        if request.custom_metadata and isinstance(request.custom_metadata, dict):
            candidate = request.custom_metadata.get("experiment")
            if isinstance(candidate, dict):
                experiment_snapshot = candidate

        # Generate metadata JSON
        metadata_json = create_nomad_metadata_yaml(
            experiment_id=request.experiment_id,
            user_name=current_user.full_name or current_user.email,
            session=session,
            experiment_snapshot=experiment_snapshot,
        )
        # Convert to YAML for NOMAD upload
        metadata_yaml = yaml.dump(metadata_json, default_flow_style=False, allow_unicode=True, sort_keys=False)
        
        # If files are provided directly, create a new archive
        if files:
            file_data: list[tuple[str, bytes]] = []
            for f in files:
                content = await f.read()
                if f.filename:
                    file_data.append((f.filename, content))
            
            zip_path = create_secure_zip(
                files=file_data,
                metadata_files=[("nomad_metadata.yaml", metadata_yaml)],
                archive_name=f"{request.experiment_id[:8]}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.zip",
            )
        elif archive_path:
            # Use existing archive - we need to add metadata to it
            # For now, we'll create a new one (the archive should have been recent)
            # In a production system, you might want to update the existing archive
            raise HTTPException(
                status_code=400,
                detail="Direct archive upload not yet supported. Please upload files directly.",
            )
        else:
            raise HTTPException(status_code=400, detail="No files or archive provided")
        
        # Get NOMAD token
        token = get_nomad_token()
        
        # Upload to NOMAD
        result = upload_to_nomad(
            zip_path=zip_path,
            token=token,
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
