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
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml
from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Request,
    UploadFile,
)
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlmodel import col, func, select

from app import crud
from app.api.deps import (
    CurrentUser,
    SessionDep,
    TokenDep,
    get_current_active_superuser,
)
from app.core.config import settings
from app.models import (
    Experiment,
    ExperimentResults,
    NomadUploadLog,
    NomadUploadLogPublic,
    NomadUploadLogsPublic,
    User,
)
from app.services.chemicals_materialization import materialize_experiment_chemicals
from app.services.nomad import (
    TEMP_UPLOAD_DIR,
    NomadAuthError,
    NomadUploadError,
    add_metadata_to_zip,
    append_files_to_zip,
    cleanup_stale_archives,
    cleanup_temp_archive,
    create_nomad_metadata_yaml,
    create_secure_zip,
    find_missing_raw_files,
    get_nomad_token,
    get_upload_entries,
    get_upload_status,
    purge_stash_file,
    stash_archive,
    upload_to_nomad,
)

# ─────────────────────────────────────────────────────────────────────────────
# Custom YAML Dumper: quote all strings, keep numbers/bools unquoted,
# treat nan/inf as quoted strings, render flat lists in flow style.
# ─────────────────────────────────────────────────────────────────────────────


class _QuotedDumper(yaml.Dumper):
    def represent_mapping(
        self, tag: str, mapping: Any, flow_style: bool | None = None
    ) -> yaml.MappingNode:
        node = super().represent_mapping(tag, mapping, flow_style)
        # Strip quotes from mapping keys so only values are quoted
        for key_node, _value_node in node.value:
            if (
                isinstance(key_node, yaml.ScalarNode)
                and key_node.tag == "tag:yaml.org,2002:str"
            ):
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

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/nomad", tags=["nomad"])


def _materialize_chemicals(session: SessionDep, experiment_id: str) -> None:
    """Sync the experiment's chemicals into the inventory before exporting.

    The NOMAD exporter is driven entirely off `lab_material` / `lab_solution`,
    while the Chemicals step records its answers in `Experiment.chemicals_prep`.
    Materializing here — rather than when the user fills the step in — means the
    export always reflects the latest answers, and re-uploading an edited
    experiment updates the inventory instead of duplicating it.

    A failure here must not block an upload: the archives are still valid
    without the chemical entities, so it is logged rather than raised.
    """
    try:
        experiment = session.exec(
            select(Experiment).where(Experiment.id == uuid.UUID(str(experiment_id)))
        ).first()
        if experiment is None:
            return
        report = materialize_experiment_chemicals(session, experiment)
        if report.skipped_unlabelled:
            logger.warning(
                "Experiment %s: %d chemical(s) had no inventory label and were "
                "not materialized: %s",
                experiment_id,
                len(report.skipped_unlabelled),
                ", ".join(sorted(set(report.skipped_unlabelled))),
            )
    except Exception:
        session.rollback()
        logger.exception(
            "Failed to materialize chemicals for experiment %s; "
            "continuing without chemical entities",
            experiment_id,
        )


def _require_nomad_upload_authorized(current_user: CurrentUser) -> None:
    """
    Allow archive creation/upload only for users authorized to use NOMAD uploads.

    When NOMAD OAuth is enabled, require an OAuth-linked user (`nomad_sub`) or
    a superuser account. This prevents local-only users from creating server-side
    upload archives for NOMAD.
    """
    if (
        settings.NOMAD_OAUTH_ENABLED
        and not current_user.nomad_sub
        and not current_user.is_superuser
    ):
        raise HTTPException(
            status_code=403,
            detail="NOMAD upload requires an authenticated NOMAD OAuth user",
        )


def _validated_archive_path(archive_path: str) -> Path:
    """Resolve a client-supplied archive path and confine it to TEMP_UPLOAD_DIR.

    Existence is *not* checked here — callers decide whether a missing archive
    is an error (metadata step) or a fall-back to creating a fresh one (drop
    step, where a stale sessionStorage path may outlive the archive).
    """
    try:
        candidate = Path(archive_path).resolve()
    except Exception as e:
        raise HTTPException(status_code=400, detail="Invalid archive path") from e

    allowed_root = TEMP_UPLOAD_DIR.resolve()
    if not candidate.is_relative_to(allowed_root):
        raise HTTPException(status_code=403, detail="Archive path is not allowed")
    return candidate


def _raise_on_missing_raw_files(missing: list[str]) -> None:
    """Turn the guard's missing-file list into a clear, actionable 409."""
    if not missing:
        return
    shown = ", ".join(missing[:8])
    more = f" (+{len(missing) - 8} more)" if len(missing) > 8 else ""
    raise HTTPException(
        status_code=409,
        detail=(
            f"{len(missing)} measurement file(s) referenced by the metadata are "
            f"missing from the uploaded archive: {shown}{more}. Re-drop the "
            "affected files so they are added to the archive, then try again."
        ),
    )


def _maybe_uuid(value: str | None) -> uuid.UUID | None:
    """Best-effort parse of a UUID string; None on failure."""
    if not value:
        return None
    try:
        return uuid.UUID(str(value))
    except (ValueError, AttributeError):
        return None


def _summarize_errors(errors: Any, last_status_message: str | None) -> str | None:
    """Build a short human-readable error note from NOMAD's errors[] / message."""
    parts: list[str] = []
    if isinstance(errors, list):
        parts.extend(str(e) for e in errors if e)
    elif errors:
        parts.append(str(errors))
    summary = "; ".join(parts).strip()
    if not summary and last_status_message:
        summary = str(last_status_message).strip()
    return summary or None


def _archive_available(log: NomadUploadLog) -> bool:
    """True when a stashed archive is still present on disk and downloadable."""
    if not log.archive_stash_path:
        return False
    try:
        return Path(log.archive_stash_path).is_file()
    except OSError:
        return False


def _record_failed_upload(
    session: SessionDep,
    current_user: CurrentUser,
    request: "NomadUploadRequest",
    zip_path: Path | None,
    *,
    status: str,
    error: str,
) -> None:
    """
    Log an upload that failed before/at the NOMAD call and stash its archive
    (if one was built) so it can be re-examined. Best-effort — never raises.
    """
    try:
        log = crud.create_nomad_upload_log(
            session=session,
            user=current_user,
            experiment_id=_maybe_uuid(request.experiment_id),
            experiment_name=request.experiment_name,
            upload_id=None,
            status=status,
            error_message=error,
        )
        if zip_path is not None and zip_path.exists():
            stashed = stash_archive(zip_path, log.id)
            crud.update_nomad_upload_log(
                session=session,
                log=log,
                archive_stash_path=str(stashed),
                archive_size=stashed.stat().st_size,
                archive_expires_at=crud.stash_expiry(),
            )
    except Exception as e:  # noqa: BLE001 — logging must never mask the real error
        logger.warning("Could not record failed NOMAD upload log/stash: %s", e)


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
    value: float | None = None  # PCE (%)
    voc: float | None = None  # Open-circuit voltage (V)
    jsc: float | None = None  # Short-circuit current density (mA/cm²)
    ff: float | None = None  # Fill factor (%)
    illuminationIntensity: float | None = None  # mW/cm² (1 sun = 100)
    user: str | None = None  # Operator / user from file header
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
    ignored_files: list[str] = []


class NomadMetadataPreview(BaseModel):
    """Preview of NOMAD metadata."""

    metadata_json: dict[str, Any]  # filename → yaml_content_dict
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
    entries: int | list[dict] | None = None
    last_status_message: str | None = None
    current_process: str | None = None
    errors: list[Any] | None = None
    warnings: list[Any] | None = None
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
        enabled=settings.nomad_enabled
        or bool(settings.NOMAD_OAUTH_ENABLED and current_user.nomad_sub),
        url=settings.NOMAD_URL,
        use_global_auth=settings.NOMAD_USE_GLOBAL_AUTH,
        has_credentials=bool(settings.NOMAD_USERNAME and settings.NOMAD_PASSWORD),
    )


@router.post("/upload/files")
async def upload_files_for_nomad(
    request: Request,
    session: SessionDep,
    current_user: CurrentUser,
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
    # Opportunistic sweep: drop archives abandoned beyond the inactivity window.
    cleanup_stale_archives()

    # Parse form manually so we can raise the per-request limits above Starlette's
    # default of 1000 files — researchers routinely drop thousands of files at once.
    form = await request.form(max_files=100_000, max_fields=100_000)
    experiment_id = str(form.get("experiment_id") or "")
    str(form.get("experiment_name") or "")
    request_json: str | None = form.get("request_json")  # type: ignore[assignment]
    # When set, append this drop to the existing archive instead of creating a
    # fresh one — otherwise a later drop *replaces* the archive and the
    # metadata ends up referencing raw files NOMAD cannot find.
    existing_archive_path = str(form.get("archive_path") or "")
    files: list[UploadFile] = form.getlist("files")  # type: ignore[assignment]

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

    archive_name = f"{experiment_id[:8]}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.zip"
    archive_basename = Path(archive_name).stem

    # Generate YAML metadata if request metadata is provided
    archive_yaml_files: list[tuple[str, str]] = []
    archives_for_guard: dict[str, Any] | None = None
    if request_json:
        try:
            upload_request = NomadUploadRequest.model_validate_json(request_json)

            experiment_snapshot = None
            process_snapshot = None
            if upload_request.custom_metadata and isinstance(
                upload_request.custom_metadata, dict
            ):
                candidate = upload_request.custom_metadata.get("experiment")
                if isinstance(candidate, dict):
                    experiment_snapshot = candidate
                proc_candidate = upload_request.custom_metadata.get("process")
                if isinstance(proc_candidate, dict):
                    process_snapshot = proc_candidate

            measurement_files_dicts = [
                f.model_dump() for f in upload_request.measurement_files
            ]
            device_groups_dicts = [g.model_dump() for g in upload_request.device_groups]

            _materialize_chemicals(session, upload_request.experiment_id)

            # Generate per-archive YAML files
            archives = create_nomad_metadata_yaml(
                experiment_id=upload_request.experiment_id,
                user_name=current_user.full_name or current_user.email,
                session=session,
                upload_archive_basename=archive_basename,
                experiment_snapshot=experiment_snapshot,
                process_snapshot=process_snapshot,
                measurement_files=measurement_files_dicts,
                device_groups=device_groups_dicts,
            )
            archives_for_guard = archives

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

            logger.info(
                f"Generated {len(archive_yaml_files)} YAML metadata files for archive"
            )
        except Exception as e:
            logger.error(f"Failed to generate YAML metadata: {e}", exc_info=True)
            raise HTTPException(
                status_code=500, detail=f"Failed to generate metadata: {str(e)}"
            )

    # Append to the existing archive when one is given (and still exists),
    # otherwise create a fresh secure zip.
    append_target: Path | None = None
    if existing_archive_path:
        candidate = _validated_archive_path(existing_archive_path)
        if candidate.exists():
            append_target = candidate
        else:
            logger.warning(
                "[upload_files_for_nomad] archive_path given but not on disk, "
                "creating a new archive instead: %s",
                candidate,
            )

    try:
        if append_target is not None:
            zip_path = append_files_to_zip(append_target, file_data)
            if archive_yaml_files:
                # Rare legacy combination (archive_path + request_json): keep
                # the freshly generated metadata rather than dropping it.
                add_metadata_to_zip(zip_path, archive_yaml_files)
            logger.info(
                f"Appended {len(file_data)} files to existing archive {zip_path}, "
                f"total size: {zip_path.stat().st_size} bytes"
            )
        else:
            zip_path = create_secure_zip(
                files=file_data,
                metadata_files=archive_yaml_files if archive_yaml_files else None,
                archive_name=archive_name,
            )
            logger.info(
                f"Created temporary zip archive at {zip_path} with {len(file_data)} files + {len(archive_yaml_files)} YAML files, total size: {zip_path.stat().st_size} bytes"
            )
    except Exception as e:
        logger.error(f"Failed to create zip archive: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to create archive: {e}")

    # Guard: every raw file the generated metadata references must actually be
    # in the archive — otherwise NOMAD fails each entry with "… is not found".
    if archives_for_guard is not None:
        _raise_on_missing_raw_files(
            find_missing_raw_files(zip_path, archives_for_guard)
        )

    return {
        "success": True,
        "archive_path": str(zip_path),
        "archive_name": zip_path.name,
        "file_count": len(file_data),
        "metadata_file_count": len(archive_yaml_files),
        "total_size": zip_path.stat().st_size,
    }


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

    logger.info(
        "[add_metadata_to_archive] request received — archive_path=%s user=%s",
        archive_path,
        current_user.email,
    )

    try:
        request = NomadUploadRequest.model_validate_json(request_json)
    except Exception as e:
        logger.error(
            "[add_metadata_to_archive] could not parse request_json: %s",
            e,
            exc_info=True,
        )
        raise HTTPException(status_code=422, detail="Invalid upload request metadata")

    logger.info(
        "[add_metadata_to_archive] parsed request — experiment=%s files=%d groups=%d ignored=%d",
        request.experiment_id,
        len(request.measurement_files),
        len(request.device_groups),
        len(request.ignored_files),
    )

    # Validate archive path
    candidate = _validated_archive_path(archive_path)

    if not candidate.exists():
        logger.error(
            "[add_metadata_to_archive] archive not found on disk: %s", candidate
        )
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

        _materialize_chemicals(session, request.experiment_id)

        # Generate per-archive YAML files
        archives = create_nomad_metadata_yaml(
            experiment_id=request.experiment_id,
            user_name=current_user.full_name or current_user.email,
            session=session,
            upload_archive_basename=candidate.stem,
            experiment_snapshot=experiment_snapshot,
            process_snapshot=process_snapshot,
            measurement_files=measurement_files_dicts,
            device_groups=device_groups_dicts,
        )

        # Guard: every raw file the generated metadata references must actually
        # be in the archive — a stale/replaced archive would otherwise make
        # NOMAD fail each entry at process time with "…/raw/<file> is not found".
        _raise_on_missing_raw_files(
            find_missing_raw_files(
                candidate, archives, files_to_remove=request.ignored_files
            )
        )

        # Serialize each archive dict to its own YAML string
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

        # Add metadata to the existing archive, removing any ignored files
        add_metadata_to_zip(
            candidate,
            archive_yaml_files,
            files_to_remove=request.ignored_files,
        )

        logger.info(
            "[add_metadata_to_archive] done — added %d YAML files, removed %d ignored files, archive=%s size=%d",
            len(archive_yaml_files),
            len(request.ignored_files),
            candidate,
            candidate.stat().st_size,
        )

        return {
            "success": True,
            "archive_path": str(candidate),
            "archive_name": candidate.name,
            "metadata_file_count": len(archive_yaml_files),
            "total_size": candidate.stat().st_size,
        }

    except HTTPException:
        # E.g. the missing-raw-files guard — pass its status/detail through.
        raise
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
    if not candidate.is_relative_to(allowed_root):
        raise HTTPException(status_code=403, detail="Archive path is not allowed")

    if not candidate.exists():
        raise HTTPException(status_code=404, detail="Archive not found")

    try:
        import zipfile

        from app.services.nomad import read_yaml_files_from_zip

        # Read YAML files from archive
        yaml_files = read_yaml_files_from_zip(candidate)

        # Get list of all files in archive
        with zipfile.ZipFile(candidate, "r") as zipf:
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
        raise HTTPException(
            status_code=500, detail=f"Failed to read metadata: {str(e)}"
        )


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
    if not candidate.is_relative_to(allowed_root):
        raise HTTPException(status_code=403, detail="Archive path is not allowed")

    deleted = cleanup_temp_archive(candidate)
    # Opportunistic sweep (same as /upload/files and /upload/nomad): an explicit
    # discard is a natural moment to also drop archives abandoned beyond the
    # inactivity window, so orphans from crashed sessions don't linger.
    cleanup_stale_archives()
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
    archive_path: str | None = Form(None),
    existing_upload_id: str | None = Form(None),
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
    # Opportunistic sweep: drop archives abandoned beyond the inactivity window,
    # and purge any stashed failed-upload archives past their one-week TTL.
    cleanup_stale_archives()
    crud.purge_expired_stash(session)

    try:
        request = NomadUploadRequest.model_validate_json(request_json)
    except Exception:
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

    validated_archive_path: Path | None = None
    new_archive_name = f"{request.experiment_id[:8]}_{datetime.now(timezone.utc).strftime('%Y%m%d_%H%M%S')}.zip"
    upload_archive_basename = Path(new_archive_name).stem

    if archive_path:
        try:
            candidate = Path(archive_path).resolve()
        except Exception as e:
            raise HTTPException(status_code=400, detail="Invalid archive path") from e

        allowed_root = TEMP_UPLOAD_DIR.resolve()
        if not candidate.is_relative_to(allowed_root):
            raise HTTPException(status_code=403, detail="Archive path is not allowed")

        if not candidate.exists():
            raise HTTPException(status_code=404, detail="Archive not found")

        validated_archive_path = candidate
        upload_archive_basename = candidate.stem

    # Resolved inside the try; kept here so the except blocks can stash it.
    zip_path: Path | None = None

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

        _materialize_chemicals(session, request.experiment_id)

        # Generate per-archive YAML files
        archives = create_nomad_metadata_yaml(
            experiment_id=request.experiment_id,
            user_name=current_user.full_name or current_user.email,
            session=session,
            upload_archive_basename=upload_archive_basename,
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
            # Use already-validated pre-created archive
            if validated_archive_path is None:
                raise HTTPException(status_code=400, detail="Invalid archive path")
            zip_path = validated_archive_path
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
                archive_name=new_archive_name,
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
            existing_upload_id=existing_upload_id or None,
        )

        # Record the attempt in the central log and stash its archive. NOMAD only
        # reports PENDING here — the real SUCCESS/FAILURE verdict arrives later via
        # the status poll (check_upload_status), which purges the stash on success
        # or keeps it (with error notes) on failure. The one-week TTL is a backstop.
        try:
            entries_val = result.get("entries")
            log = crud.create_nomad_upload_log(
                session=session,
                user=current_user,
                experiment_id=_maybe_uuid(request.experiment_id),
                experiment_name=request.experiment_name,
                upload_id=result.get("upload_id"),
                status="PENDING",
                nomad_process_status=result.get("processing_status"),
                entries_count=entries_val if isinstance(entries_val, int) else None,
            )
            stashed = stash_archive(zip_path, log.id)
            crud.update_nomad_upload_log(
                session=session,
                log=log,
                archive_stash_path=str(stashed),
                archive_size=stashed.stat().st_size,
                archive_expires_at=crud.stash_expiry(),
            )
        except Exception as log_err:  # noqa: BLE001 — never fail the upload for logging
            logger.warning("Could not record NOMAD upload log/stash: %s", log_err)

        # Clean up the temporary archive (the durable copy now lives in the stash)
        cleanup_temp_archive(zip_path)

        # Update experiment results with NOMAD info (if result exists)
        try:
            exp_uuid = uuid.UUID(request.experiment_id)
            statement = select(ExperimentResults).where(
                ExperimentResults.experiment_id == exp_uuid,
                ExperimentResults.owner_id == current_user.id,
            )
            db_results = session.exec(statement).first()

            if db_results:
                # Persist to the normalised nomad_* columns — these are what
                # GET /state/bulk serves and what the frontend
                # (backendMapping.resultsFromApi) reads back after a reload.
                db_results.nomad_upload_id = result.get("upload_id")
                db_results.nomad_upload_status = result.get("processing_status")
                upload_time = result.get("upload_create_time")
                if upload_time:
                    try:
                        db_results.nomad_upload_time = datetime.fromisoformat(
                            str(upload_time).replace("Z", "+00:00")
                        )
                    except ValueError:
                        db_results.nomad_upload_time = datetime.now(timezone.utc)
                else:
                    db_results.nomad_upload_time = datetime.now(timezone.utc)
                db_results.nomad_entries = len(result.get("entry_ids") or [])

                # Keep the legacy frontend_data mirror for older clients that
                # still read frontend_data["nomad"].
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
        _record_failed_upload(
            session, current_user, request, zip_path, status="ERROR", error=str(e)
        )
        return NomadUploadResponse(
            success=False,
            message=str(e),
        )
    except NomadUploadError as e:
        logger.error(f"NOMAD upload error: {e}")
        _record_failed_upload(
            session, current_user, request, zip_path, status="FAILED", error=str(e)
        )
        return NomadUploadResponse(
            success=False,
            message=str(e),
        )
    except Exception as e:
        logger.error(f"Unexpected error during NOMAD upload: {e}")
        _record_failed_upload(
            session, current_user, request, zip_path, status="ERROR", error=str(e)
        )
        return NomadUploadResponse(
            success=False,
            message=f"Upload failed: {e}",
        )


@router.get("/upload/{upload_id}/status", response_model=NomadUploadStatus)
def check_upload_status(
    session: SessionDep,
    current_user: CurrentUser,
    token: TokenDep,
    upload_id: str,
) -> NomadUploadStatus:
    """
    Check the status of a NOMAD upload.

    Use this to monitor processing progress after upload. In addition to
    returning the status, this resolves the central upload log entry: on a
    terminal SUCCESS the stashed archive is purged; on a terminal failure the
    archive is kept and enriched with NOMAD's error/warning diagnostics so an
    admin can re-examine it.

    Works with both OAuth user tokens and global service credentials.
    """
    use_user_token = bool(settings.NOMAD_OAUTH_ENABLED and current_user.nomad_sub)
    if (
        not settings.NOMAD_MOCK_MODE
        and not settings.nomad_enabled
        and not use_user_token
    ):
        raise HTTPException(status_code=503, detail="NOMAD integration not configured")

    nomad_token: str | None = token if use_user_token else None

    try:
        status = get_upload_status(upload_id, token=nomad_token)

        logger.info(f"[NOMAD][status] Raw response for upload {upload_id}: {status}")

        if "error" in status:
            logger.warning(f"[NOMAD][status] Error in status: {status['error']}")
            # A 404 means the upload was deleted on NOMAD — record it as such and
            # keep any stashed archive for inspection.
            if "404" in str(status["error"]):
                _resolve_upload_log(
                    session,
                    upload_id,
                    status="NOT_FOUND",
                    error_message="Upload not found on NOMAD (deleted externally)",
                )
            return NomadUploadStatus(
                upload_id=upload_id,
                error=status["error"],
            )

        process_status = status.get("process_status")
        last_status_message = status.get("last_status_message")
        entries_raw = status.get("entries")
        current_process = status.get("current_process")
        errors = status.get("errors") or None
        warnings = status.get("warnings") or None

        logger.info(
            f"[NOMAD][status] Extracted fields - process_status: {process_status}, "
            f"last_status_message: {last_status_message}, entries: {entries_raw}"
        )

        # NOMAD completion is sometimes only reflected in last_status_message.
        normalized_status = process_status
        if isinstance(last_status_message, str):
            lower_msg = last_status_message.lower()
            if "completed successfully" in lower_msg:
                normalized_status = "SUCCESS"
            elif "failed" in lower_msg or "error" in lower_msg:
                normalized_status = "FAILURE"

        logger.info(
            f"[NOMAD][status] Normalized status for {upload_id}: {normalized_status}"
        )

        # Resolve the central upload log against this status.
        _resolve_upload_log(
            session,
            upload_id,
            status=normalized_status,
            nomad_process_status=process_status,
            current_process=current_process,
            last_status_message=last_status_message,
            errors=errors,
            warnings=warnings,
            entries=entries_raw,
            nomad_token=nomad_token,
        )

        return NomadUploadStatus(
            upload_id=upload_id,
            status=normalized_status,
            entries=entries_raw,
            last_status_message=last_status_message,
            current_process=current_process,
            errors=errors,
            warnings=warnings,
        )

    except Exception as e:
        return NomadUploadStatus(
            upload_id=upload_id,
            error=str(e),
        )


def _resolve_upload_log(
    session: SessionDep,
    upload_id: str,
    *,
    status: str | None,
    nomad_process_status: str | None = None,
    current_process: str | None = None,
    last_status_message: str | None = None,
    errors: Any = None,
    warnings: Any = None,
    entries: Any = None,
    error_message: str | None = None,
    nomad_token: str | None = None,
) -> None:
    """
    Update the central log row for `upload_id` from a status response, resolving
    the stashed archive: purge it on terminal SUCCESS, keep+enrich it on terminal
    failure. Best-effort — a logging failure must never break status polling.
    """
    try:
        log = crud.get_nomad_upload_log_by_upload_id(
            session=session, upload_id=upload_id
        )
        if log is None:
            return

        norm = (status or "").upper()
        fields: dict[str, Any] = {
            "nomad_process_status": nomad_process_status,
            "current_process": current_process,
            "last_status_message": last_status_message,
        }
        if errors is not None:
            fields["errors"] = errors
        if warnings is not None:
            fields["warnings"] = warnings
        if isinstance(entries, int):
            fields["entries_count"] = entries

        if norm == "SUCCESS":
            fields["status"] = "SUCCESS"
            purge_stash_file(log.archive_stash_path)
            fields["archive_stash_path"] = None
        elif norm in ("FAILURE", "FAILED", "NOT_FOUND", "ERROR"):
            fields["status"] = "FAILED" if norm in ("FAILURE", "FAILED") else norm
            summary = error_message or _summarize_errors(errors, last_status_message)
            # Pull per-entry failure detail for the richest diagnostics.
            entry_info = get_upload_entries(upload_id, token=nomad_token)
            if entry_info.get("processing_failed") is not None:
                fields["processing_failed"] = entry_info["processing_failed"]
            entry_errors = entry_info.get("entry_errors") or []
            if entry_errors:
                merged = list(errors) if isinstance(errors, list) else []
                merged.append({"entry_errors": entry_errors})
                fields["errors"] = merged
                if not summary:
                    summary = _summarize_errors(
                        [e for ee in entry_errors for e in ee.get("errors", [])],
                        last_status_message,
                    )
            if summary:
                fields["error_message"] = summary
            # Stash is intentionally retained for failed uploads.
        elif status:
            fields["status"] = status

        crud.update_nomad_upload_log(session=session, log=log, **fields)
    except Exception as e:  # noqa: BLE001
        logger.warning("Could not resolve NOMAD upload log for %s: %s", upload_id, e)


@router.post("/auth/test")
def test_nomad_auth(_current_user: CurrentUser) -> dict[str, Any]:
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
        get_nomad_token()
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


# ─────────────────────────────────────────────────────────────────────────────
# Admin: central upload log + failed-archive stash
# ─────────────────────────────────────────────────────────────────────────────


@router.get("/upload-log", response_model=NomadUploadLogsPublic)
def list_nomad_upload_log(
    session: SessionDep,
    _admin: User = Depends(get_current_active_superuser),
    skip: int = 0,
    limit: int = 100,
) -> NomadUploadLogsPublic:
    """
    Central log of every NOMAD upload attempt (superuser only).

    Lists all uploads — by user email, experiment, and outcome — newest first.
    Purges any expired stashed archives as a side effect (one-week retention).
    """
    crud.purge_expired_stash(session)

    count = session.exec(select(func.count()).select_from(NomadUploadLog)).one()
    rows = session.exec(
        select(NomadUploadLog)
        .order_by(col(NomadUploadLog.created_at).desc())
        .offset(skip)
        .limit(limit)
    ).all()

    data = [
        NomadUploadLogPublic.model_validate(
            row, update={"archive_available": _archive_available(row)}
        )
        for row in rows
    ]
    return NomadUploadLogsPublic(data=data, count=count)


@router.get("/upload-log/{log_id}/archive")
def download_nomad_upload_archive(
    session: SessionDep,
    log_id: uuid.UUID,
    _admin: User = Depends(get_current_active_superuser),
) -> FileResponse:
    """
    Download the stashed archive of a (typically failed) upload (superuser only).

    404 when the upload succeeded (archive purged) or the one-week TTL expired.
    """
    log = session.get(NomadUploadLog, log_id)
    if log is None:
        raise HTTPException(status_code=404, detail="Upload log not found")
    if not log.archive_stash_path:
        raise HTTPException(
            status_code=404,
            detail="No stashed archive for this upload (succeeded or expired)",
        )
    path = Path(log.archive_stash_path)
    if not path.is_file():
        raise HTTPException(
            status_code=404, detail="Stashed archive is no longer available"
        )

    download_name = f"{log.experiment_name or 'upload'}_{log.upload_id or log.id}.zip"
    return FileResponse(path, media_type="application/zip", filename=download_name)
