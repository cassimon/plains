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
    experiment_id: str,
    user_name: str,
    session: Any,
    experiment_snapshot: dict[str, Any] | None = None,
) -> dict[str, Any]:
    """
    Create NOMAD perovskite solar cell metadata JSON structure from experiment data.
    
    This generates a JSON dict matching the NOMAD perovskite_solar_cell schema
    and populates it with data from the experiment's database fields.
    
    Args:
        experiment_id: UUID of the experiment
        user_name: Name of user entering the data
        session: Database session for querying
        experiment_snapshot: Optional frontend experiment payload to use directly
            (preferred for preview/upload so latest UI edits are reflected)
    
    Returns:
        Dictionary containing NOMAD metadata structure
    """
    from sqlmodel import select
    from app.models import Experiment
    import uuid as uuid_module
    
    # Fetch experiment with owner - convert string ID to UUID if needed
    try:
        if isinstance(experiment_id, str):
            exp_uuid = uuid_module.UUID(experiment_id)
        else:
            exp_uuid = experiment_id
    except (ValueError, AttributeError):
        exp_uuid = experiment_id
    
    statement = select(Experiment).where(Experiment.id == exp_uuid)
    experiment = session.exec(statement).first()
    
    if not experiment:
        raise ValueError(f"Experiment {experiment_id} not found")
    
    exp_data: dict[str, Any] = {}

    # Prefer request-provided experiment data so metadata preview reflects
    # unsaved/live edits from the UI.
    if experiment_snapshot and isinstance(experiment_snapshot, dict):
        exp_data = experiment_snapshot
    else:
        # Extract frontend data which contains full experiment definition
        frontend_data = experiment.frontend_data or {}

        # Try to get experiment data using both string and UUID representations
        exp_id_str = str(experiment_id)
        exp_data = frontend_data.get("experiments", {}).get(exp_id_str) or {}

        if not exp_data:
            # Also try with the database experiment ID
            exp_data = frontend_data.get("experiments", {}).get(str(experiment.id)) or {}
    
    if not exp_data:
        # Log available keys for debugging
        if "experiments" in frontend_data and isinstance(frontend_data["experiments"], dict):
            logger.warning(f"Available experiment IDs in frontend_data: {list(frontend_data['experiments'].keys())}")
        logger.warning(f"No frontend data found for experiment {experiment_id}, using database fields")
        
        # Fall back to database fields if frontend_data is empty
        if experiment.layers:
            exp_data = {
                "name": experiment.name,
                "description": experiment.description or "",
                "architecture": experiment.device_type or "n-i-p",
                "substrateMaterial": "Unknown",  # Not stored directly in Experiment model
                "layers": [
                    {
                        "id": str(layer.id),
                        "name": layer.name,
                        "layerType": layer.layer_type,
                        "color": "#888888",
                        "depositionMethod": {"value": "Unknown"},
                        "substrateTemp": None,
                        "depositionAtmosphere": None,
                        "solutionVolume": None,
                        "dryingMethod": None,
                        "annealingTime": None,
                        "annealingTemp": None,
                        "annealingAtmosphere": None,
                    }
                    for layer in experiment.layers
                ]
            }
        else:
            # Create minimal metadata structure even without layers
            exp_data = {
                "name": experiment.name,
                "description": experiment.description or "",
                "architecture": experiment.device_type or "n-i-p",
                "substrateMaterial": "Unknown",
                "layers": []
            }
    
    # Extract layers and group by type
    layers = exp_data.get("layers", [])
    substrate_material = exp_data.get("substrateMaterial", "Unknown")
    architecture = exp_data.get("architecture", "n-i-p")
    comment = exp_data.get("description", "")
    
    # Build concrete stack sequence (substrate | layer1 | layer2 | ...)
    stack_sequence = substrate_material
    if layers:
        layer_names = [layer.get("name", "Unknown") for layer in layers]
        stack_sequence += " | " + " | ".join(layer_names)
    
    # Helper to get param value
    def get_param_value(param: dict | None, default: str = "Unknown") -> str:
        if param and isinstance(param, dict):
            return str(param.get("value", default))
        return default
    
    # Helper to concatenate layers of same type with |
    def concat_layer_names(layer_list: list[dict]) -> str:
        return " | ".join([layer.get("name", "Unknown") for layer in layer_list])
    
    def concat_layer_params(layer_list: list[dict], param_key: str, default: str = "Unknown") -> str:
        values = []
        for layer in layer_list:
            param = layer.get(param_key)
            values.append(get_param_value(param, default))
        return " | ".join(values) if values else default
    
    # Group layers by type
    etl_layers = [l for l in layers if l.get("layerType") == "etl"]
    htl_layers = [l for l in layers if l.get("layerType") == "htl"]
    perovskite_layers = [l for l in layers if l.get("layerType") == "perovskite"]
    additional_layers = [l for l in layers if l.get("layerType") == "additional"]
    backcontact_layers = [l for l in layers if l.get("layerType") == "back_contact"]
    
    # Build NOMAD structure
    nomad_data = {
        "data": {
            "m_def": "perovskite_solar_cell_database.schema.PerovskiteSolarCell",
            "ref": {
                "free_text_comment": comment or "",
                "name_of_person_entering_the_data": user_name,
                "DOI_number": "",
                "lead_author": "Unknown",
                "publication_date": "Unknown",
                "journal": "Unknown",
                "extraction_method": "plains_gui"
            },
            "cell": {
                "stack_sequence": stack_sequence,
                "architecture": architecture
            },
            "substrate": {
                "stack_sequence": substrate_material,
                "thickness": "nan",
                "deposition_procedure": "Unknown"
            },
            "etl": {},
            "perovskite": {},
            "perovskite_deposition": {},
            "htl": {},
            "backcontact": {},
            "add": {},
            "encapsulation": {},
            "jv": {
                "light_intensity": "nan",
                "light_spectra": "AM 1.5G",
                "default_Voc": "nan",
                "default_Jsc": "nan",
                "default_FF": "nan",
                "default_PCE": "nan"
            },
            "stability": {}
        },
        "results": {
            "material": {"Hello World":"Test"
                         }
        }
    }
    
    # Fill ETL section
    if etl_layers:
        nomad_data["data"]["etl"] = {
            "stack_sequence": concat_layer_names(etl_layers),
            "thickness": "nan",
            "deposition_procedure": concat_layer_params(etl_layers, "depositionMethod"),
            "deposition_synthesis_atmosphere": concat_layer_params(etl_layers, "depositionAtmosphere"),
            "deposition_solvents": "Unknown",
            "deposition_reaction_solutions_compounds": "Unknown",
            "deposition_reaction_solutions_concentrations": "Unknown",
            "deposition_reaction_solutions_volumes": concat_layer_params(etl_layers, "solutionVolume"),
            "deposition_reaction_solutions_temperature": "Unknown",
            "deposition_substrate_temperature": concat_layer_params(etl_layers, "substrateTemp"),
            "deposition_thermal_annealing_temperature": concat_layer_params(etl_layers, "annealingTemp"),
            "deposition_thermal_annealing_time": concat_layer_params(etl_layers, "annealingTime"),
            "deposition_thermal_annealing_atmosphere": concat_layer_params(etl_layers, "annealingAtmosphere"),
            "surface_treatment_before_next_deposition_step": "Unknown"
        }
    
    # Fill Perovskite section
    if perovskite_layers:
        perovskite_layer = perovskite_layers[0]  # Use first perovskite layer
        nomad_data["data"]["perovskite"] = {
            "dimension_3D": True,
            "dimension_list_of_layers": "3D",
            "composition_a_ions": "Unknown",
            "composition_a_ions_coefficients": "nan",
            "composition_b_ions": "Unknown",
            "composition_b_ions_coefficients": "nan",
            "composition_c_ions": "Unknown",
            "composition_c_ions_coefficients": "nan",
            "composition_short_form": perovskite_layer.get("name", "Unknown"),
            "composition_long_form": "Unknown",
            "thickness": "nan",
            "band_gap": "nan",
            "surface_treatment_before_next_deposition_step": "Unknown"
        }
        
        # Fill perovskite deposition details
        nomad_data["data"]["perovskite_deposition"] = {
            "number_of_deposition_steps": 1,
            "procedure": get_param_value(perovskite_layer.get("depositionMethod")),
            "aggregation_state_of_reactants": "Unknown",
            "synthesis_atmosphere": get_param_value(perovskite_layer.get("depositionAtmosphere")),
            "synthesis_atmosphere_pressure_total": "Unknown",
            "synthesis_atmosphere_pressure_partial": "Unknown",
            "synthesis_atmosphere_relative_humidity": "Unknown",
            "solvents": "Unknown",
            "solvents_mixing_ratios": "Unknown",
            "solvents_supplier": "Unknown",
            "solvents_purity": "Unknown",
            "reaction_solutions_compounds": "Unknown",
            "reaction_solutions_compounds_supplier": "Unknown",
            "reaction_solutions_compounds_purity": "Unknown",
            "reaction_solutions_concentrations": "Unknown",
            "reaction_solutions_volumes": get_param_value(perovskite_layer.get("solutionVolume")),
            "reaction_solutions_age": "Unknown",
            "reaction_solutions_temperature": "Unknown",
            "substrate_temperature": get_param_value(perovskite_layer.get("substrateTemp")),
            "quenching_induced_crystallisation": False,
            "quenching_media": get_param_value(perovskite_layer.get("dryingMethod")),
            "quenching_media_mixing_ratios": "Unknown",
            "quenching_media_volume": "Unknown",
            "quenching_media_additives_compounds": "Unknown",
            "quenching_media_additives_concentrations": "Unknown",
            "thermal_annealing_temperature": get_param_value(perovskite_layer.get("annealingTemp")),
            "thermal_annealing_time": get_param_value(perovskite_layer.get("annealingTime")),
            "thermal_annealing_atmosphere": get_param_value(perovskite_layer.get("annealingAtmosphere")),
            "thermal_annealing_relative_humidity": "Unknown",
            "thermal_annealing_pressure": "Unknown",
            "solvent_annealing": False,
            "solvent_annealing_timing": "Unknown",
            "solvent_annealing_solvent_atmosphere": "Unknown",
            "solvent_annealing_time": "Unknown",
            "solvent_annealing_temperature": "Unknown",
            "after_treatment_of_formed_perovskite": False,
            "after_treatment_of_formed_perovskite_method": "Unknown"
        }
    
    # Fill HTL section
    if htl_layers:
        nomad_data["data"]["htl"] = {
            "stack_sequence": concat_layer_names(htl_layers),
            "thickness_list": "nan",
            "deposition_procedure": concat_layer_params(htl_layers, "depositionMethod"),
            "deposition_synthesis_atmosphere": concat_layer_params(htl_layers, "depositionAtmosphere"),
            "deposition_solvents": "Unknown",
            "deposition_reaction_solutions_compounds": "Unknown",
            "deposition_reaction_solutions_concentrations": "Unknown",
            "deposition_reaction_solutions_volumes": concat_layer_params(htl_layers, "solutionVolume"),
            "deposition_reaction_solutions_temperature": "Unknown",
            "deposition_substrate_temperature": concat_layer_params(htl_layers, "substrateTemp"),
            "deposition_thermal_annealing_temperature": concat_layer_params(htl_layers, "annealingTemp"),
            "deposition_thermal_annealing_time": concat_layer_params(htl_layers, "annealingTime"),
            "deposition_thermal_annealing_atmosphere": concat_layer_params(htl_layers, "annealingAtmosphere"),
            "surface_treatment_before_next_deposition_step": "Unknown"
        }
    
    # Fill Back Contact section
    if backcontact_layers:
        nomad_data["data"]["backcontact"] = {
            "stack_sequence": concat_layer_names(backcontact_layers),
            "thickness_list": "nan",
            "deposition_procedure": concat_layer_params(backcontact_layers, "depositionMethod"),
            "deposition_synthesis_atmosphere": concat_layer_params(backcontact_layers, "depositionAtmosphere"),
            "deposition_solvents": "Unknown",
            "deposition_reaction_solutions_compounds": "Unknown",
            "deposition_reaction_solutions_concentrations": "Unknown",
            "deposition_reaction_solutions_volumes": concat_layer_params(backcontact_layers, "solutionVolume"),
            "deposition_reaction_solutions_temperature": "Unknown",
            "deposition_substrate_temperature": concat_layer_params(backcontact_layers, "substrateTemp"),
            "deposition_thermal_annealing_temperature": concat_layer_params(backcontact_layers, "annealingTemp"),
            "deposition_thermal_annealing_time": concat_layer_params(backcontact_layers, "annealingTime"),
            "deposition_thermal_annealing_atmosphere": concat_layer_params(backcontact_layers, "annealingAtmosphere"),
            "surface_treatment_before_next_deposition_step": "Unknown"
        }
    
    # Fill Additional layers section
    if additional_layers:
        nomad_data["data"]["add"] = {
            "stack_sequence": concat_layer_names(additional_layers),
            "thickness_list": "nan",
            "deposition_procedure": concat_layer_params(additional_layers, "depositionMethod"),
            "deposition_synthesis_atmosphere": concat_layer_params(additional_layers, "depositionAtmosphere"),
            "deposition_solvents": "Unknown",
            "deposition_reaction_solutions_compounds": "Unknown",
            "deposition_reaction_solutions_concentrations": "Unknown",
            "deposition_reaction_solutions_volumes": concat_layer_params(additional_layers, "solutionVolume"),
            "deposition_reaction_solutions_temperature": "Unknown",
            "deposition_substrate_temperature": concat_layer_params(additional_layers, "substrateTemp"),
            "deposition_thermal_annealing_temperature": concat_layer_params(additional_layers, "annealingTemp"),
            "deposition_thermal_annealing_time": concat_layer_params(additional_layers, "annealingTime"),
            "deposition_thermal_annealing_atmosphere": concat_layer_params(additional_layers, "annealingAtmosphere"),
            "surface_treatment_before_next_deposition_step": "Unknown"
        }
    
    logger.info(f"Generated NOMAD metadata for experiment {experiment_id}")
    
    return nomad_data


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
