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
import math
import re
import shutil
import tempfile
import time
import uuid
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

# Temporary directory for zip files (will be cleaned up after upload)
TEMP_UPLOAD_DIR = Path(tempfile.gettempdir()) / "plains_nomad_uploads"

# Durable stash for archives of failed / not-yet-succeeded uploads. Backed by a
# named Docker volume so it survives container recreation (see compose.yml).
STASH_DIR = Path(settings.NOMAD_STASH_DIR)


def _safe_json_dict(response: httpx.Response, *, context: str) -> dict[str, Any]:
    """Best-effort JSON parsing for NOMAD responses.

    Some NOMAD/proxy paths may return 2xx with empty or non-JSON bodies.
    In that case, log and return an empty dict instead of raising.
    """
    try:
        parsed = response.json()
    except ValueError:
        body_preview = (response.text or "").strip().replace("\n", " ")[:200]
        logger.warning(
            "NOMAD %s response is not JSON (status=%s, content-type=%s, body=%r)",
            context,
            response.status_code,
            response.headers.get("content-type", ""),
            body_preview,
        )
        return {}

    if isinstance(parsed, dict):
        return parsed

    logger.warning(
        "NOMAD %s response JSON is not an object (status=%s, type=%s)",
        context,
        response.status_code,
        type(parsed).__name__,
    )
    return {}


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

    # Mock mode never contacts a server, so it must not require credentials.
    if not settings.NOMAD_MOCK_MODE and (not use_username or not use_password):
        raise NomadAuthError(
            "NOMAD credentials not configured. Add username/password to the NOMAD auth file (../sensitive config/.nomad_auth)"
        )

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
                logger.error(
                    f"NOMAD auth failed: {response.status_code} - {response.text}"
                )
                raise NomadAuthError(
                    f"NOMAD authentication failed: {response.status_code}"
                )

            token_data = response.json()
            return token_data.get("access_token", "")

    except httpx.RequestError as e:
        logger.error(f"NOMAD auth request error: {e}")
        raise NomadAuthError(f"Failed to connect to NOMAD: {e}")


# Path separators, control characters, and the characters Windows/zip tooling
# cannot represent. Everything else — parentheses, '#', '&', … — is kept: the
# generated archive YAMLs point at raw files *by name*, so any character we drop
# here has to be dropped identically over there or NOMAD's parser reports
# "No such file or directory" for a file that is sitting right next to it.
_UNSAFE_FILENAME_CHARS = re.compile(r'[\x00-\x1f\x7f:*?"<>|]')


def sanitize_upload_filename(filename: str) -> str:
    """Return the flat, zip-safe name a file has *inside* the upload archive.

    This is the single source of truth for that name. Call it anywhere a
    filename is written into the zip **or** referenced from metadata, so the two
    can never disagree.
    """
    # Backslashes are not separators on POSIX, so normalise before taking .name.
    name = Path(filename.replace("\\", "/")).name
    name = _UNSAFE_FILENAME_CHARS.sub("_", name)
    # Leading dots ('..') and trailing dots/spaces are traversal / Windows traps.
    return name.strip(". ")


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

    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zipf:
        # Add data files
        for filename, content in files:
            safe_filename = sanitize_upload_filename(filename)
            if safe_filename:
                zipf.writestr(safe_filename, content)

        # Add metadata YAML files
        if metadata_files:
            for meta_filename, yaml_content in metadata_files:
                safe_meta = sanitize_upload_filename(meta_filename)
                if not safe_meta:
                    continue
                zipf.writestr(safe_meta, yaml_content)

    logger.info(
        f"Created secure zip archive: {zip_path} ({zip_path.stat().st_size} bytes)"
    )
    return zip_path


def add_metadata_to_zip(
    zip_path: Path,
    metadata_files: list[tuple[str, str]],
    files_to_remove: list[str] | None = None,
) -> Path:
    """
    Add metadata YAML files to an existing zip archive, optionally removing files.

    This function modifies the zip archive in place by:
    1. Reading all existing files
    2. Creating a new zip with existing files + new metadata files, minus any ignored files
    3. Replacing the original zip

    Args:
        zip_path: Path to the existing zip file
        metadata_files: List of (filename, yaml_content) tuples to add
        files_to_remove: Optional list of bare filenames to strip from the archive
                         (used for the "Ignore" category — files excluded from upload)

    Returns:
        Path to the updated zip file (same as input)

    Raises:
        FileNotFoundError: If zip_path doesn't exist
    """
    if not zip_path.exists():
        raise FileNotFoundError(f"Zip archive not found: {zip_path}")

    # Callers pass the *original* filenames; zip entries carry the sanitized ones.
    remove_set: set[str] = {
        sanitize_upload_filename(f) for f in (files_to_remove or [])
    }

    # Create temporary zip file
    temp_zip = zip_path.with_suffix(".tmp.zip")

    try:
        # Read existing files and add new metadata
        with zipfile.ZipFile(zip_path, "r") as old_zip:
            with zipfile.ZipFile(temp_zip, "w", zipfile.ZIP_DEFLATED) as new_zip:
                # Copy existing files, skipping YAML files and ignored files
                for item in old_zip.namelist():
                    if item.endswith(".yaml"):
                        continue
                    if sanitize_upload_filename(item) in remove_set:
                        logger.info(f"Stripping ignored file from archive: {item}")
                        continue
                    new_zip.writestr(item, old_zip.read(item))

                # Add new metadata YAML files
                for meta_filename, yaml_content in metadata_files:
                    safe_meta = sanitize_upload_filename(meta_filename)
                    new_zip.writestr(safe_meta, yaml_content)

        # Replace original with updated version
        temp_zip.replace(zip_path)
        logger.info(
            f"Updated archive {zip_path}: added {len(metadata_files)} metadata files, "
            f"removed {len(remove_set)} ignored files ({zip_path.stat().st_size} bytes)"
        )

    except Exception as e:
        # Clean up temp file on error
        if temp_zip.exists():
            temp_zip.unlink()
        raise e

    return zip_path


def read_yaml_files_from_zip(zip_path: Path) -> dict[str, str]:
    """
    Read all YAML files from a zip archive.

    Args:
        zip_path: Path to the zip file

    Returns:
        Dict mapping filename to YAML content (as string)

    Raises:
        FileNotFoundError: If zip_path doesn't exist
    """
    if not zip_path.exists():
        raise FileNotFoundError(f"Zip archive not found: {zip_path}")

    yaml_files: dict[str, str] = {}

    with zipfile.ZipFile(zip_path, "r") as zipf:
        for filename in zipf.namelist():
            if filename.endswith(".yaml") or filename.endswith(".yml"):
                content = zipf.read(filename).decode("utf-8")
                yaml_files[filename] = content

    return yaml_files


# One deposition-stack layer, paired with the process step that produced it.
_LayerEntries = list[tuple[dict[str, Any], str]]


# ── Quenching units ───────────────────────────────────────────────────────────
# The GUI serializes quenching parameters as "<number> <unit>" with a unit the
# user picked (QuenchingModal.tsx). NOMAD quantities carry a fixed unit, and a
# bare number in the YAML is read *in that unit* — so the unit token has to be
# converted here, not dropped. Each target is (factors-to-target-unit, whether a
# value with no unit token may be assumed to already be in the target unit).
_QuenchUnit = tuple[dict[str, float], bool]

MILLIMETER: _QuenchUnit = (
    {"mm": 1.0, "millimeter": 1.0, "cm": 10.0, "centimeter": 10.0, "m": 1000.0},
    True,
)
PASCAL: _QuenchUnit = (
    {
        "pa": 1.0,
        "pascal": 1.0,
        "kpa": 1000.0,
        "psi": 6894.757293168361,
        "bar": 100000.0,
        "mbar": 100.0,
    },
    True,
)
LITER_PER_MIN: _QuenchUnit = (
    {"slm": 1.0, "l/min": 1.0, "lpm": 1.0, "liter/minute": 1.0, "ml/min": 0.001},
    True,
)
# A velocity is not a flow rate: "m/s" gets its own quantity rather than being
# silently read as liter/minute, and never accepts an unitless value.
METER_PER_SEC: _QuenchUnit = ({"m/s": 1.0, "meter/second": 1.0}, False)
MICROLITER: _QuenchUnit = (
    {
        "ul": 1.0,
        "µl": 1.0,
        "μl": 1.0,
        "microliter": 1.0,
        "ml": 1000.0,
        "milliliter": 1000.0,
        "l": 1_000_000.0,
    },
    True,
)
MICROLITER_PER_SEC: _QuenchUnit = (
    {"ul/s": 1.0, "µl/s": 1.0, "μl/s": 1.0, "ml/s": 1000.0},
    True,
)
CM2: _QuenchUnit = (
    {"cm2": 1.0, "cm^2": 1.0, "cm²": 1.0, "mm2": 0.01, "m2": 10000.0, "m^2": 10000.0},
    True,
)
M3: _QuenchUnit = (
    {"m3": 1.0, "m^3": 1.0, "m³": 1.0, "l": 0.001, "liter": 0.001, "ml": 1e-6},
    True,
)
SECOND: _QuenchUnit = (
    {"s": 1.0, "sec": 1.0, "second": 1.0, "ms": 0.001, "min": 60.0, "minute": 60.0},
    True,
)


def _quench_value(raw: Any, unit: _QuenchUnit) -> float | None:
    """Parse "<number> [unit]" and convert it into `unit`'s target unit."""
    text = str(raw or "").strip()
    if not text:
        return None
    match = re.match(r"^([-+]?[0-9]*\.?[0-9]+)\s*(.*)$", text)
    if not match:
        return None
    try:
        value = float(match.group(1))
    except ValueError:
        return None

    factors, accept_bare = unit
    token = match.group(2).strip().lower()
    if not token:
        return value if accept_bare else None
    factor = factors.get(token)
    if factor is None:
        return None
    return round(value * factor, 6)


def _set_quench(target: dict[str, Any], key: str, raw: Any, unit: _QuenchUnit) -> None:
    """Set `target[key]` from a GUI quenching value, or leave it unset."""
    value = _quench_value(raw, unit)
    if value is not None:
        target[key] = value


def create_nomad_metadata_yaml(
    experiment_id: str,
    user_name: str,
    session: Any,
    upload_archive_basename: str | None = None,  # noqa: ARG001
    experiment_snapshot: dict[str, Any] | None = None,
    process_snapshot: dict[str, Any] | None = None,
    measurement_files: list[dict[str, Any]] | None = None,  # noqa: ARG001
    device_groups: list[dict[str, Any]] | None = None,
) -> dict[str, dict[str, Any]]:
    """
    Create NOMAD archive YAML structures from experiment and measurement data.

    Generates one sample archive per pixel (via device groups if provided, otherwise
    per substrate × devicesPerSubstrate) using the perovskite_solar_cell_database
    schema, plus one measurement archive per measurement file using the nomad_chose
    LabJVMeasurement / LabEQEMeasurement / LabStabilityMeasurement schemas.

    Conventions (perovskite_solar_cell_database):
      - Layers separated by ' | '
      - Sub-steps separated by ' >> '
      - Multiple ions/compounds: '; '-separated
      - Unknown/missing values: 'Unknown' (strings) or 'nan' (numeric fields)

    Args:
        experiment_id: UUID of the experiment
        user_name: Default operator / person entering data
        session: DB session for querying
        experiment_snapshot: Frontend Experiment object (live UI state preferred)
        process_snapshot: Frontend Process linked to the experiment
        measurement_files: Flat list of MeasurementFileInfo dicts (optional)
        device_groups: DeviceGroupInfo dicts with assignedSubstrateId (optional)

    Returns:
        dict[filename, yaml_content_dict] — one entry per .archive.yaml file
    """
    import uuid as uuid_module

    from sqlmodel import select

    from app.models import Experiment

    # ── 1. Load experiment ────────────────────────────────────────────────────
    try:
        exp_uuid = (
            uuid_module.UUID(experiment_id)
            if isinstance(experiment_id, str)
            else experiment_id
        )
    except (ValueError, AttributeError):
        exp_uuid = experiment_id

    experiment = session.exec(
        select(Experiment).where(Experiment.id == exp_uuid)
    ).first()
    if not experiment:
        raise ValueError(f"Experiment {experiment_id} not found")

    exp_data: dict[str, Any] = {}

    # Prefer request-provided experiment data so metadata preview reflects
    # unsaved/live edits from the UI.
    if experiment_snapshot and isinstance(experiment_snapshot, dict):
        exp_data = experiment_snapshot
    else:
        # Read directly from normalised columns — no JSONB fallback.
        exp_data = {
            "name": experiment.name,
            "description": experiment.description or "",
            "architecture": experiment.architecture or "n-i-p",
            "substrateMaterial": experiment.substrate_material or "Unknown",
            "substrates": [],
            "devicesPerSubstrate": experiment.devices_per_substrate or 1,
            "deviceArea": experiment.device_area or 0.09,
        }

    # ── 2. Load process ───────────────────────────────────────────────────────
    from app.models import (
        LabMaterial,
        LabSolution,
        Process,
        ProcessGeneratedStack,
        ProcessStep,
    )

    process_data: dict[str, Any] | None = None

    if process_snapshot and isinstance(process_snapshot, dict):
        process_data = process_snapshot
    elif experiment.process_id:
        process_orm = session.exec(
            select(Process).where(Process.id == experiment.process_id)
        ).first()
        if process_orm:
            # Build process_data from normalised ORM relationships
            steps_by_stage: dict[int, list[dict[str, Any]]] = {}
            for step in session.exec(
                select(ProcessStep).where(ProcessStep.process_id == process_orm.id)
            ).all():
                stage = steps_by_stage.setdefault(step.stage_index, [])
                stage.append(
                    {
                        "id": str(step.id),
                        "name": step.name,
                        "stepCategory": step.step_category,
                        "color": step.color,
                        "materialId": str(step.material_id)
                        if step.material_id
                        else None,
                        "solutionId": str(step.solution_id)
                        if step.solution_id
                        else None,
                        "chemRecipeId": str(step.chem_recipe_id)
                        if step.chem_recipe_id
                        else None,
                        "inlineMaterial": step.inline_material,
                        "depositionMethod": {
                            "value": step.deposition_method_value,
                            "mode": step.deposition_method_mode,
                        },
                        "annealingTemp": {
                            "value": step.annealing_temp_value,
                            "mode": step.annealing_temp_mode,
                        },
                        "annealingTime": {
                            "value": step.annealing_time_value,
                            "mode": step.annealing_time_mode,
                        },
                        "annealingAtmosphere": {
                            "value": step.annealing_atmosphere_value,
                            "mode": step.annealing_atmosphere_mode,
                        },
                        "substrateTemp": {
                            "value": step.substrate_temp_value,
                            "mode": step.substrate_temp_mode,
                        },
                        "depositionAtmosphere": {
                            "value": step.deposition_atmosphere_value,
                            "mode": step.deposition_atmosphere_mode,
                        },
                        "solutionVolume": {
                            "value": step.solution_volume_value,
                            "mode": step.solution_volume_mode,
                        },
                        "notes": step.notes,
                    }
                )
            stages = [
                {"alternatives": steps_by_stage[idx]} for idx in sorted(steps_by_stage)
            ]
            stacks_orm = session.exec(
                select(ProcessGeneratedStack).where(
                    ProcessGeneratedStack.process_id == process_orm.id
                )
            ).all()
            generated_stacks = []
            for stack in stacks_orm:
                layers = [
                    {
                        "id": layer.step_ref or str(layer.id),
                        "name": layer.name,
                        "color": layer.color,
                        "isSubstrate": layer.is_substrate,
                        "layerType": layer.layer_type,
                        "thicknessNm": layer.thickness_nm,
                        "bandgapEv": layer.bandgap_ev,
                        "perovskiteA": layer.perovskite_a,
                        "perovskiteB": layer.perovskite_b,
                        "perovskiteX": layer.perovskite_x,
                        "materialType": layer.material_type,
                        "homoEv": layer.homo_ev,
                        "lumoEv": layer.lumo_ev,
                    }
                    for layer in sorted(stack.layers, key=lambda lyr: lyr.layer_index)
                ]
                generated_stacks.append(
                    {
                        "combination": stack.combination,
                        "architecture": stack.architecture,
                        "layers": layers,
                    }
                )
            process_data = {
                "id": str(process_orm.id),
                "name": process_orm.name,
                "stages": stages,
                "generatedStacks": generated_stacks,
                "deletedStackCombinations": [],
                "solutionRecipes": [
                    {
                        "id": str(recipe.id),
                        "name": recipe.name,
                        "type": recipe.type,
                        "isCommercial": recipe.is_commercial,
                        "commercialName": recipe.commercial_name,
                        "supplierNumber": recipe.supplier_number,
                        "totalSolventVolumeMl": recipe.total_solvent_volume_ml,
                        "solvents": [
                            {
                                "name": solvent.name,
                                "pubchemCid": solvent.pubchem_cid,
                                "molarMass": solvent.molar_mass,
                                "density": solvent.density,
                                "volumeRatio": solvent.volume_ratio,
                            }
                            for solvent in recipe.solvents
                        ],
                        "solutes": [
                            {
                                "name": solute.name,
                                "pubchemCid": solute.pubchem_cid,
                                "molarMass": solute.molar_mass,
                                "density": solute.density,
                                "amount": solute.amount,
                                "unit": solute.unit,
                            }
                            for solute in recipe.solutes
                        ],
                        "addedSolutions": [
                            {
                                "recipeId": str(added.referenced_recipe_id)
                                if added.referenced_recipe_id
                                else None,
                                "volumeMl": added.volume_ml,
                            }
                            for added in recipe.added_solutions
                        ],
                    }
                    for recipe in process_orm.recipes
                ],
            }

    if not process_data:
        logger.warning(
            f"No process data found for experiment {experiment_id}; "
            "generated stacks unavailable – layer sections will be empty"
        )

    # Load materials and solutions from normalised tables
    owner_materials = session.exec(
        select(LabMaterial).where(LabMaterial.owner_id == experiment.owner_id)
    ).all()
    owner_solutions = session.exec(
        select(LabSolution).where(LabSolution.owner_id == experiment.owner_id)
    ).all()
    materials_by_id: dict[str, dict[str, Any]] = {
        str(m.id): {
            "id": str(m.id),
            "name": m.name,
            "type": m.type,
            "casNumber": m.cas_number,
            "pubchemCid": m.pubchem_cid,
            "molecularWeight": m.molecular_weight,
            "density": m.density,
            "supplier": m.supplier,
            "supplierNumber": m.supplier_number,
            "purity": m.purity,
            "stateAtRt": m.state_at_rt,
            "heightMm": m.height_mm,
        }
        for m in owner_materials
    }
    solutions_by_id: dict[str, dict[str, Any]] = {
        str(s.id): {
            "id": str(s.id),
            "name": s.name,
            "type": s.type,
            "components": [
                {
                    "materialId": str(c.material_id) if c.material_id else None,
                    "solutionId": str(c.solution_ref_id) if c.solution_ref_id else None,
                    "amount": c.amount,
                    "unit": c.unit,
                }
                for c in s.components
            ],
        }
        for s in owner_solutions
    }

    # Solution recipes live on the Process itself (not the material library), and
    # are what a modern process step points at via `chemRecipeId`.
    recipes_by_id: dict[str, dict[str, Any]] = {
        str(recipe.get("id")): recipe
        for recipe in ((process_data or {}).get("solutionRecipes") or [])
        if isinstance(recipe, dict) and recipe.get("id")
    }

    # ── 3. Build step map: step_id → ProcessStep dict ─────────────────────────
    step_map: dict[str, dict[str, Any]] = {}
    if process_data:
        for stage in process_data.get("stages") or []:
            for step in stage.get("alternatives") or []:
                sid = step.get("id", "")
                if sid:
                    step_map[sid] = step

    # ── 4. Collect active generated stacks (not in deletedStackCombinations) ──
    active_stacks: list[dict[str, Any]] = []
    if process_data:
        deleted_combinations: set[int] = set(
            process_data.get("deletedStackCombinations") or []
        )
        for stack in process_data.get("generatedStacks") or []:
            if not isinstance(stack, dict):
                continue
            if stack.get("combination") not in deleted_combinations:
                active_stacks.append(stack)

    # ── 5. Experiment-level metadata ──────────────────────────────────────────
    substrate_material = exp_data.get("substrateMaterial", "Unknown")
    architecture_raw = exp_data.get("architecture", "n-i-p")
    # Normalise: "n-i-p" → "nip", "p-i-n" → "pin", etc.
    architecture_nomad = architecture_raw.replace("-", "")
    comment = exp_data.get("description", "") or exp_data.get("name", "")

    device_area = exp_data.get("deviceArea", 0.09)
    try:
        device_area = float(device_area)
    except (ValueError, TypeError):
        device_area = 0.09

    devices_per_substrate = (
        exp_data.get("devicesPerSubstrate")
        or exp_data.get("devices_per_substrate")
        or 1
    )
    try:
        devices_per_substrate = int(devices_per_substrate)
    except (ValueError, TypeError):
        devices_per_substrate = 1

    substrates_list: list[dict[str, Any]] = list(exp_data.get("substrates") or [])
    if not substrates_list:
        substrates_list = [{"id": "substrate_0", "name": "substrate_0"}]

    # NOMAD references should always point to flat files under ../upload/raw.
    # Do not include an archive-base directory component in references.
    upload_raw_prefix = "../upload/raw"

    # ── Helper functions ──────────────────────────────────────────────────────

    def _upload_raw_reference(path: str, fragment: str | None = None) -> str:
        # The uploaded zip is intentionally flat, so references must use the
        # archive entry basename (no nested directories).
        archive_entry = Path(str(path or "")).name
        ref = f"{upload_raw_prefix}/{archive_entry}"
        if fragment:
            return f"{ref}#{fragment}"
        return ref

    def _clean_value(value: Any, default: str = "Unknown") -> str:
        text = str(value or "").strip()
        return text if text else default

    def _material_name(
        material: dict[str, Any] | None, fallback: str = "Unknown"
    ) -> str:
        if not isinstance(material, dict):
            return fallback
        for key in ("name", "inventoryLabel", "casNumber", "id"):
            value = str(material.get(key) or "").strip()
            if value:
                return value
        return fallback

    def _material_supplier(material: dict[str, Any] | None) -> str:
        if not isinstance(material, dict):
            return "Unknown"
        return _clean_value(material.get("supplier"))

    def _material_purity(material: dict[str, Any] | None) -> str:
        if not isinstance(material, dict):
            return "Unknown"
        return _clean_value(material.get("purity"))

    def _is_solvent_material(material: dict[str, Any] | None) -> bool:
        if not isinstance(material, dict):
            return False
        material_type = str(material.get("type") or "").lower()
        state_at_rt = str(material.get("stateAtRt") or "").lower()
        return "solvent" in material_type or state_at_rt in {"liquid", "gas"}

    def _format_layer_token_list(values: list[str], empty: str = "Unknown") -> str:
        cleaned = sorted({value.strip() for value in values if value and value.strip()})
        return "; ".join(cleaned) if cleaned else empty

    def _format_substrate_stack_sequence(raw_value: Any) -> str:
        text = str(raw_value or "").strip()
        if not text:
            return "Unknown"
        text = re.sub(r"^substrate\s*:\s*", "", text, flags=re.IGNORECASE)
        parts = [
            part.strip() for part in re.split(r"\s*[/\\|,;]+\s*", text) if part.strip()
        ]
        if len(parts) <= 1:
            parts = [text] if text else []
        return " | ".join(parts) if parts else "Unknown"

    def _flatten_solution_components(
        solution_id: str,
        visited: set[str] | None = None,
    ) -> list[dict[str, str | bool]]:
        if not solution_id:
            return []
        if visited is None:
            visited = set()
        if solution_id in visited:
            return []
        visited = {solution_id, *visited}

        solution = solutions_by_id.get(solution_id)
        if not isinstance(solution, dict):
            return []

        flattened: list[dict[str, str | bool]] = []
        for component in solution.get("components") or []:
            if not isinstance(component, dict):
                continue
            material_id = str(component.get("materialId") or "").strip()
            nested_solution_id = str(component.get("solutionId") or "").strip()

            if material_id:
                material = materials_by_id.get(material_id)
                amount = str(component.get("amount") or "").strip()
                unit = str(component.get("unit") or "").strip()
                flattened.append(
                    {
                        "name": _material_name(material, material_id),
                        "supplier": _material_supplier(material),
                        "purity": _material_purity(material),
                        "amount": f"{amount} {unit}".strip() if amount else "Unknown",
                        "is_solvent": _is_solvent_material(material),
                    }
                )
                continue

            if nested_solution_id:
                flattened.extend(
                    _flatten_solution_components(nested_solution_id, visited)
                )

        return flattened

    def _recipe_solvent_volumes_ml(recipe: dict[str, Any]) -> list[float | None]:
        """Each solvent's volume in mL, split from the recipe's total by ratio."""
        solvents = [s for s in (recipe.get("solvents") or []) if isinstance(s, dict)]
        total_ml = _to_float(recipe.get("totalSolventVolumeMl"))
        ratios = [(_to_float(s.get("volumeRatio")) or 0.0) for s in solvents]
        ratio_sum = sum(ratios)
        if total_ml is None or total_ml <= 0 or ratio_sum <= 0:
            return [None] * len(solvents)
        return [total_ml * ratio / ratio_sum for ratio in ratios]

    def _flatten_recipe_components(
        recipe_id: str,
        visited: set[str] | None = None,
        scale: float = 1.0,
    ) -> list[dict[str, str | bool]]:
        """A process solution recipe as flat components, like a LabSolution.

        Recipes are how the Processes page defines a step's chemistry (the
        `materialId`/`solutionId` entity refs are the legacy path), so without
        this every solvent, compound and concentration of a modern process would
        be missing from the upload.
        """
        if not recipe_id:
            return []
        if visited is None:
            visited = set()
        if recipe_id in visited:
            return []  # a recipe mixed into itself, directly or transitively
        visited = {recipe_id, *visited}

        recipe = recipes_by_id.get(recipe_id)
        if not isinstance(recipe, dict):
            return []

        # A commercial product is bought, not mixed: it has no meaningful
        # composition, so it enters as a single named compound.
        supplier = _clean_value(recipe.get("supplierNumber"))
        if recipe.get("isCommercial"):
            return [
                {
                    "name": _clean_value(
                        recipe.get("commercialName") or recipe.get("name")
                    ),
                    "supplier": supplier,
                    "purity": "Unknown",
                    "amount": "Unknown",
                    "is_solvent": False,
                }
            ]

        flattened: list[dict[str, str | bool]] = []

        solvents = [s for s in (recipe.get("solvents") or []) if isinstance(s, dict)]
        for solvent, volume_ml in zip(
            solvents, _recipe_solvent_volumes_ml(recipe), strict=False
        ):
            flattened.append(
                {
                    "name": _clean_value(solvent.get("name")),
                    "supplier": supplier,
                    "purity": "Unknown",
                    "amount": (
                        f"{round(volume_ml * scale, 6)} ml"
                        if volume_ml is not None
                        else "Unknown"
                    ),
                    "is_solvent": True,
                }
            )

        for solute in recipe.get("solutes") or []:
            if not isinstance(solute, dict):
                continue
            amount = _to_float(solute.get("amount"))
            unit = str(solute.get("unit") or "").strip()
            flattened.append(
                {
                    "name": _clean_value(solute.get("name")),
                    "supplier": supplier,
                    "purity": "Unknown",
                    "amount": (
                        f"{round(amount * scale, 6)} {unit}".strip()
                        if amount is not None
                        else "Unknown"
                    ),
                    "is_solvent": False,
                }
            )

        # Recipes can be mixed into one another by volume; scale the mixed-in
        # recipe's components by the fraction of it that was actually added.
        for added in recipe.get("addedSolutions") or []:
            if not isinstance(added, dict):
                continue
            added_id = str(added.get("recipeId") or "").strip()
            added_ml = _to_float(added.get("volumeMl"))
            if not added_id or added_ml is None or added_ml <= 0:
                continue
            source = recipes_by_id.get(added_id)
            source_total = (
                _to_float(source.get("totalSolventVolumeMl"))
                if isinstance(source, dict)
                else None
            )
            fraction = (
                added_ml / source_total
                if source_total is not None and source_total > 0
                else 1.0
            )
            flattened.extend(
                _flatten_recipe_components(added_id, visited, scale * fraction)
            )

        return flattened

    def _inline_material_component(
        step: dict[str, Any],
    ) -> dict[str, str | bool] | None:
        """A material typed straight onto the step, with no Material entity."""
        inline = step.get("inlineMaterial")
        if not isinstance(inline, dict):
            return None
        name = _clean_value(inline.get("name"), "")
        if not name:
            return None
        return {
            "name": name,
            "supplier": "Unknown",
            "purity": "Unknown",
            "amount": "Unknown",
            "is_solvent": "solvent" in str(inline.get("type") or "").lower(),
        }

    def _step_reaction_components(step: dict[str, Any]) -> list[dict[str, str | bool]]:
        components: list[dict[str, str | bool]] = []

        material_id = str(step.get("materialId") or "").strip()
        if material_id:
            material = materials_by_id.get(material_id)
            components.append(
                {
                    "name": _material_name(material, material_id),
                    "supplier": _material_supplier(material),
                    "purity": _material_purity(material),
                    "amount": "Unknown",
                    "is_solvent": _is_solvent_material(material),
                }
            )

        solution_id = str(step.get("solutionId") or "").strip()
        if solution_id:
            components.extend(_flatten_solution_components(solution_id))

        recipe_id = str(step.get("chemRecipeId") or "").strip()
        if recipe_id:
            components.extend(_flatten_recipe_components(recipe_id))

        inline = _inline_material_component(step)
        if inline:
            components.append(inline)

        return components

    def _is_liquid_deposition(step: dict[str, Any]) -> bool:
        step_category = str(step.get("stepCategory") or "").strip().lower()
        if step_category == "wet_deposition":
            return True
        for component in _step_reaction_components(step):
            if bool(component.get("is_solvent")):
                return True
        return False

    def _aggregate_components_by_name(
        components: list[dict[str, str | bool]],
        *,
        solvents: bool,
    ) -> list[dict[str, str]]:
        grouped: dict[str, dict[str, set[str] | list[str]]] = {}

        for component in components:
            if bool(component.get("is_solvent")) != solvents:
                continue
            name = _clean_value(component.get("name"), default="")
            if not name:
                continue
            bucket = grouped.setdefault(
                name,
                {"supplier": set(), "purity": set(), "amounts": []},
            )
            supplier = _clean_value(component.get("supplier"))
            purity = _clean_value(component.get("purity"))
            amount = _clean_value(component.get("amount"))
            if supplier != "Unknown":
                bucket["supplier"].add(supplier)
            if purity != "Unknown":
                bucket["purity"].add(purity)
            if amount != "Unknown":
                bucket["amounts"].append(amount)

        aggregated: list[dict[str, str]] = []
        for name in sorted(grouped):
            bucket = grouped[name]
            suppliers = sorted(bucket["supplier"])
            purities = sorted(bucket["purity"])
            amounts = sorted(set(bucket["amounts"]))
            aggregated.append(
                {
                    "name": name,
                    "supplier": "; ".join(suppliers) if suppliers else "Unknown",
                    "purity": "; ".join(purities) if purities else "Unknown",
                    "amount": ", ".join(amounts) if amounts else "Unknown",
                }
            )
        return aggregated

    def _extract_numeric_from_amount(amount_str: str) -> str:
        """Extract numeric value from amount string like '1.0 ml' -> '1.0'."""
        if not amount_str or amount_str == "Unknown":
            return "nan"
        # Try to extract the first numeric value from the string
        import re

        match = re.search(r"([0-9]+\.?[0-9]*)", amount_str)
        if match:
            value = match.group(1)
            # Format to remove trailing zeros and decimal point if integer
            try:
                float_val = float(value)
                if float_val.is_integer():
                    return str(int(float_val))
                return value
            except ValueError:
                return "nan"
        return "nan"

    def _format_mixing_ratios(solvent_components: list[dict[str, str]]) -> str:
        """Format solvent volumes as mixing ratios.

        Returns:
            - '1' for single solvent or no solvents
            - 'V1; V2; V3' for multiple solvents
            - 'nan' for unknown
        """
        if not solvent_components:
            return "1"  # Non-solvent process

        if len(solvent_components) == 1:
            # Single solvent - return '1'
            return "1"

        # Multiple solvents - extract volumes
        volumes: list[str] = []
        for item in solvent_components:
            amount = item.get("amount", "Unknown")
            # Handle cases where amount might be comma-separated (multiple measurements)
            if "," in amount:
                # Take the first value if multiple
                amount = amount.split(",")[0].strip()
            numeric = _extract_numeric_from_amount(amount)
            volumes.append(numeric)

        # If all are nan, return nan
        if all(v == "nan" for v in volumes):
            return "nan"

        return "; ".join(volumes)

    def _calculate_concentrations_mg_ml(
        compound_components: list[dict[str, str]],
        solvent_components: list[dict[str, str]],
    ) -> str:
        """Calculate concentration in mg/ml for each compound.

        Args:
            compound_components: List of compound dicts with 'amount' field
            solvent_components: List of solvent dicts with 'amount' field

        Returns:
            Formatted concentration string (e.g., "50.5 mg/ml" or "50.5 mg/ml; 10.2 mg/ml")
            Returns "none" for pure solvents, "nan" for unknown
        """
        import re

        # Calculate total solvent volume in ml
        total_volume_ml = 0.0
        for solvent in solvent_components:
            amount_str = solvent.get("amount", "Unknown")
            if amount_str == "Unknown":
                continue
            # Handle comma-separated values (take first)
            if "," in amount_str:
                amount_str = amount_str.split(",")[0].strip()

            # Parse number and unit
            match = re.match(r"([0-9.]+)\s*([a-zA-Zµμ]+)", amount_str)
            if not match:
                continue
            value_str, unit = match.groups()
            try:
                value_float = float(value_str)
            except ValueError:
                continue

            # Convert to ml
            unit_lower = unit.lower()
            if unit_lower in ("ml", "milliliter", "millilitre"):
                total_volume_ml += value_float
            elif unit_lower in ("l", "liter", "litre"):
                total_volume_ml += value_float * 1000
            elif unit_lower in ("µl", "μl", "ul", "microliter", "microlitre"):
                total_volume_ml += value_float / 1000

        # If no solvent volume, return appropriate value
        if total_volume_ml == 0:
            if not compound_components:
                return "none"  # Pure solvents or gas phase
            return "nan"  # Cannot calculate

        # Calculate concentration for each compound
        concentrations = []
        for compound in compound_components:
            amount_str = compound.get("amount", "Unknown")
            if amount_str == "Unknown":
                concentrations.append("nan")
                continue

            # Handle comma-separated values (take first)
            if "," in amount_str:
                amount_str = amount_str.split(",")[0].strip()

            # Parse number and unit
            match = re.match(r"([0-9.]+)\s*([a-zA-Zµμ]+)", amount_str)
            if not match:
                concentrations.append("nan")
                continue

            value_str, unit = match.groups()
            try:
                value_float = float(value_str)
            except ValueError:
                concentrations.append("nan")
                continue

            # Convert to mg
            mass_mg = None
            unit_lower = unit.lower()
            if unit_lower in ("mg", "milligram"):
                mass_mg = value_float
            elif unit_lower in ("g", "gram"):
                mass_mg = value_float * 1000
            elif unit_lower in ("µg", "μg", "ug", "microgram"):
                mass_mg = value_float / 1000
            elif unit_lower in ("kg", "kilogram"):
                mass_mg = value_float * 1000000
            # For molar units (M, mM) or other units, we can't convert without molecular weight
            else:
                concentrations.append("nan")
                continue

            if mass_mg is not None:
                concentration = mass_mg / total_volume_ml
                # Format with appropriate precision (4 decimal places)
                concentrations.append(f"{concentration:.4f} mg/ml")
            else:
                concentrations.append("nan")

        if not concentrations:
            return "none"

        return "; ".join(concentrations)

    def _layer_solution_metadata(step: dict[str, Any]) -> dict[str, str]:
        if not _is_liquid_deposition(step):
            return {
                "solvents": "Unknown",
                "solvents_supplier": "Unknown",
                "solvents_purity": "Unknown",
                "solvents_mixing_ratios": "1",
                "compounds": "Unknown",
                "compounds_supplier": "Unknown",
                "compounds_purity": "Unknown",
                "concentrations": "Unknown",
            }

        components = _step_reaction_components(step)
        solvent_components = _aggregate_components_by_name(components, solvents=True)
        compound_components = _aggregate_components_by_name(components, solvents=False)

        return {
            "solvents": _format_layer_token_list(
                [item["name"] for item in solvent_components]
            ),
            "solvents_supplier": _format_layer_token_list(
                [item["supplier"] for item in solvent_components],
            ),
            "solvents_purity": _format_layer_token_list(
                [item["purity"] for item in solvent_components],
            ),
            "solvents_mixing_ratios": _format_mixing_ratios(solvent_components),
            "compounds": _format_layer_token_list(
                [item["name"] for item in compound_components]
            ),
            "compounds_supplier": _format_layer_token_list(
                [item["supplier"] for item in compound_components],
            ),
            "compounds_purity": _format_layer_token_list(
                [item["purity"] for item in compound_components],
            ),
            "concentrations": _calculate_concentrations_mg_ml(
                compound_components, solvent_components
            ),
        }

    def _quenching_solution_metadata(solution_id: str) -> dict[str, str]:
        solution = solutions_by_id.get(solution_id)
        if not isinstance(solution, dict):
            return {
                "media": "Unknown",
                "volume": "Unknown",
                "mixing_ratios": "Unknown",
                "additives_compounds": "Unknown",
                "additives_concentrations": "Unknown",
            }

        components = _flatten_solution_components(solution_id)
        solvent_components = _aggregate_components_by_name(components, solvents=True)
        compound_components = _aggregate_components_by_name(components, solvents=False)

        media_names = [item["name"] for item in solvent_components]
        media_amounts = [item["amount"] for item in solvent_components]
        additive_names = [item["name"] for item in compound_components]

        return {
            "media": _format_layer_token_list(media_names)
            or _clean_value(solution.get("name")),
            "volume": _format_layer_token_list(media_amounts),
            "mixing_ratios": _format_layer_token_list(media_amounts),
            "additives_compounds": _format_layer_token_list(additive_names),
            "additives_concentrations": _calculate_concentrations_mg_ml(
                compound_components, solvent_components
            ),
        }

    def _join_layer_solution_field(
        entries: list[tuple[dict[str, Any], str]],
        field: str,
    ) -> str:
        values = [
            _layer_solution_metadata(step).get(field, "Unknown") for step, _ in entries
        ]
        return " | ".join(values) if values else "Unknown"

    def _get_step_param(
        step: dict[str, Any],
        param_key: str,
        substrate: dict[str, Any] | None,
        default: str = "Unknown",
    ) -> str:
        """Return the effective value of a ProcessParam, honouring variation mode."""
        param = step.get(param_key)
        if not param or not isinstance(param, dict):
            return default
        val = str(param.get("value", "") or "")
        if param.get("mode") == "variation" and substrate:
            step_id = step.get("id", "")
            lookup_key = f"{step_id}:{param_key}"
            sub_vals: dict = substrate.get("parameterValues") or {}
            val = str(sub_vals.get(lookup_key, val) or val)
        return val if val else default

    def _join_params(
        entries: list[tuple[dict[str, Any], str]],
        param_key: str,
        substrate: dict[str, Any] | None,
        default: str = "Unknown",
    ) -> str:
        vals = [_get_step_param(e[0], param_key, substrate, default) for e in entries]
        return " | ".join(vals) if vals else default

    def _layer_thickness(entries: list[tuple[dict[str, Any], str]]) -> str:
        thicknesses = [
            (e[0].get("_layer") or {}).get("thicknessNm") or "nan" for e in entries
        ]
        return " | ".join(thicknesses)

    def _to_float(value: Any) -> float | None:
        try:
            text = str(value).strip()
            if not text:
                return None
            return float(text)
        except (ValueError, TypeError):
            return None

    def _resolve_substrate_material(
        substrate: dict[str, Any] | None,
    ) -> dict[str, Any] | None:
        if not isinstance(substrate, dict):
            return None

        material_id = str(substrate.get("substrateMaterialId") or "").strip()
        if material_id:
            return materials_by_id.get(material_id)

        raw_name = str(
            substrate.get("substrateMaterial") or substrate_material or ""
        ).strip()
        if not raw_name:
            return None

        for material in materials_by_id.values():
            if not isinstance(material, dict):
                continue
            name = str(material.get("name") or "").strip()
            if name and name == raw_name:
                return material
        return None

    def _get_substrate_dimensions(substrate: dict[str, Any] | None) -> dict[str, Any]:
        defaults = {
            "lengthCm": "",
            "widthCm": "",
            "surfaceRoughnessRmsNm": "",
        }
        if not process_data or not isinstance(process_data, dict):
            return defaults
        if not isinstance(substrate, dict):
            return defaults

        dims_by_id = process_data.get("substrateDimensionsById") or {}
        if not isinstance(dims_by_id, dict):
            return defaults

        material_id = str(substrate.get("substrateMaterialId") or "").strip()
        dims = dims_by_id.get(material_id) if material_id else None
        if not isinstance(dims, dict):
            return defaults

        return {
            "lengthCm": str(dims.get("lengthCm") or "").strip(),
            "widthCm": str(dims.get("widthCm") or "").strip(),
            "surfaceRoughnessRmsNm": str(
                dims.get("surfaceRoughnessRmsNm") or ""
            ).strip(),
        }

    def _substrate_cleaning_procedure(substrate: dict[str, Any] | None) -> str:
        if not process_data or not isinstance(process_data, dict):
            return "Unknown"

        stages = process_data.get("stages") or []
        if not isinstance(stages, list):
            return "Unknown"

        parameter_values: dict[str, Any] = {}
        if isinstance(substrate, dict):
            raw_params = substrate.get("parameterValues") or {}
            if isinstance(raw_params, dict):
                parameter_values = raw_params

        cleaning_steps: list[str] = []
        for stage_idx, stage in enumerate(stages):
            if not isinstance(stage, dict):
                continue
            alternatives = [
                step
                for step in (stage.get("alternatives") or [])
                if isinstance(step, dict)
            ]
            if not alternatives:
                continue

            selected_step: dict[str, Any] | None = None
            selected_id = str(
                parameter_values.get(f"stageSelection:{stage_idx}") or ""
            ).strip()
            if selected_id:
                selected_step = next(
                    (
                        step
                        for step in alternatives
                        if str(step.get("id") or "") == selected_id
                    ),
                    None,
                )
            if selected_step is None:
                selected_step = alternatives[0]

            if (
                str(selected_step.get("stepCategory") or "").strip().lower()
                != "substrate_preparation"
            ):
                continue

            method = _get_step_param(
                selected_step, "depositionMethod", substrate, "Unknown"
            )
            params = _get_step_param(
                selected_step, "depositionParameters", substrate, ""
            )
            if params and params != "Unknown":
                cleaning_steps.append(f"{method} ({params})")
            else:
                cleaning_steps.append(method)

        return " >> ".join(cleaning_steps) if cleaning_steps else "Unknown"

    # Ions per formula unit of ABX3. The GUI asks for each site's ion *fractions*
    # and validates them to sum to 1 — but a formula unit carries three anions, so
    # the X site's fractions have to be tripled to become coefficients.
    _SITE_STOICHIOMETRY = {"a": 1.0, "b": 1.0, "c": 3.0}

    def _site_stoichiometry(coeff_values: list[str], site: str) -> list[str]:
        """Scale one site's fractions to the coefficients ABX3 calls for.

        Without this, an X site of "Br" got the coefficient 1 and the formula came
        out as FAPbBr rather than FAPbBr3 — NOMAD then derived the material from a
        composition that is not a perovskite.

        A site that already states its coefficients (someone typed "I3", summing
        to 3) is left alone, and so is anything that is not fully numeric.
        """
        target = _SITE_STOICHIOMETRY.get(site, 1.0)
        if target == 1.0:
            return coeff_values
        try:
            numbers = [float(value) for value in coeff_values]
        except ValueError:
            # An unknown ('x') coefficient — nothing to scale, and the list is
            # dropped by _upstream_safe_coefficients anyway.
            return coeff_values
        total = sum(numbers)
        if total <= 0 or math.isclose(total, target, rel_tol=1e-3):
            return coeff_values
        if not math.isclose(total, 1.0, rel_tol=1e-3):
            # Neither fractions nor coefficients — take the user at their word.
            return coeff_values
        return [_format_coeff_value(str(number * target)) for number in numbers]

    def _site_layers(ions: str, coefficients: str) -> list[list[tuple[str, str]]]:
        """Re-pair a site's ion names with its coefficients, layer by layer."""
        ion_layers = [layer.strip() for layer in str(ions or "").split("|")]
        coeff_layers = [layer.strip() for layer in str(coefficients or "").split("|")]

        layers: list[list[tuple[str, str]]] = []
        for idx, ion_layer in enumerate(ion_layers):
            names = [name.strip() for name in ion_layer.split(";") if name.strip()]
            raw = coeff_layers[idx] if idx < len(coeff_layers) else ""
            values = [value.strip() for value in raw.split(";")]
            layers.append(
                [
                    (name, values[i] if i < len(values) else "")
                    for i, name in enumerate(names)
                ]
            )
        return layers

    def _long_coefficient(value: str) -> str:
        """How a coefficient is written in a chemical formula."""
        # An unknown ('x') or absent coefficient: state the ion on its own rather
        # than invent a number. A coefficient of 1 is implicit — "Pb", not "Pb1".
        if not value or value == "x" or value == "1":
            return ""
        return value

    def _composition_forms(
        a_site: tuple[str, str],
        b_site: tuple[str, str],
        c_site: tuple[str, str],
    ) -> tuple[str, str]:
        """Build (short_form, long_form) from the parsed sites.

        The database means two different things by these: the short form is the ion
        names alone ("CsFAPbIBr"), the long form carries the coefficients
        ("Cs0.2FA0.8PbI2.4Br0.6"). Only the long form is fed to the formula
        normalizer, so it is what `results.material` is derived from — sending the
        short form as both is what left the material reading "FAPbBr".
        """
        sites = [_site_layers(*site) for site in (a_site, b_site, c_site)]
        layer_count = max(len(site) for site in sites)

        short_parts: list[str] = []
        long_parts: list[str] = []
        for index in range(layer_count):
            # A site with fewer layers than the stack keeps its last one (a single
            # A site shared by two X layers, say).
            pairs_per_site = [
                site[index] if index < len(site) else site[-1] for site in sites
            ]
            short_parts.append(
                "".join(name for pairs in pairs_per_site for name, _ in pairs)
            )
            long_parts.append(
                "".join(
                    f"{name}{_long_coefficient(value)}"
                    for pairs in pairs_per_site
                    for name, value in pairs
                )
            )

        return " | ".join(short_parts), " | ".join(long_parts)

    def _format_coeff_value(raw: str) -> str:
        value = raw.strip()
        if not value:
            return "x"
        try:
            numeric = float(value)
            if numeric.is_integer():
                return str(int(numeric))
            return (f"{numeric:.6f}").rstrip("0").rstrip(".")
        except ValueError:
            return value

    def _upstream_safe_coefficients(coefficients: str) -> str | None:
        """Return the coefficients string, or None if it would kill the section.

        perovskite_solar_cell_database's `Perovskite.normalize()` runs a bare
        `float(c)` over every ';'-separated token. It cannot parse the schema's
        own documented placeholder for an unknown coefficient ('x'), nor the
        ' | ' layer separator used in its own examples — either one raises and
        the *whole* Perovskite section then fails to normalize, taking the
        composition, thickness and band gap down with it.

        So we only emit coefficients when every token is a number. Omitting the
        quantity costs nothing: upstream just skips building the `Ion`
        subsections, and the composition itself is still carried by
        composition_short_form / composition_long_form.
        """
        tokens = [token.strip() for token in str(coefficients or "").split(";")]
        if not tokens or any(not token for token in tokens):
            return None
        try:
            for token in tokens:
                float(token)
        except ValueError:
            return None
        return coefficients

    def _parse_perovskite_ion_layers(
        raw_ions: Any, site: str = "a"
    ) -> tuple[str, str, int]:
        """
        Parse perovskite ions into aligned `ions` and `coefficients` strings.

        Supports compact notation like `Cs0.1FA0.9` and explicit notation like
        `Cs; FA; MA` (with optional coefficients in tokens). `site` is the ABX3
        site the ions sit on ("a", "b" or "c"), which sets their stoichiometry.
        """
        raw_text = str(raw_ions or "").strip()
        if not raw_text:
            return "Unknown", "x", 1

        layer_chunks = [chunk.strip() for chunk in raw_text.split("|") if chunk.strip()]
        if not layer_chunks:
            return "Unknown", "x", 1

        ion_layers: list[str] = []
        coeff_layers: list[str] = []

        compact_pattern = re.compile(
            r"(\([^)]+\)|[A-Za-z][A-Za-z@+\-]*?)(\d+(?:\.\d+)?)"
        )

        for layer in layer_chunks:
            tokens = [token.strip() for token in layer.split(";") if token.strip()]
            parsed_pairs: list[tuple[str, str]] = []

            for token in tokens or [layer]:
                compact_matches = list(compact_pattern.finditer(token))
                joined = "".join(match.group(0) for match in compact_matches)
                if compact_matches and joined == token:
                    for match in compact_matches:
                        ion_name = (match.group(1) or "").strip()
                        coeff = (match.group(2) or "").strip()
                        if ion_name:
                            parsed_pairs.append((ion_name, coeff))
                    continue

                explicit_match = re.match(r"^(.+?)(\d+(?:\.\d+)?)$", token)
                if explicit_match:
                    ion_name = (explicit_match.group(1) or "").strip()
                    coeff = (explicit_match.group(2) or "").strip()
                    if ion_name:
                        parsed_pairs.append((ion_name, coeff))
                        continue

                parsed_pairs.append((token, ""))

            ion_names = [ion for ion, _ in parsed_pairs if ion]
            if not ion_names:
                ion_layers.append("Unknown")
                coeff_layers.append("x")
                continue

            raw_coeffs = [coeff for _, coeff in parsed_pairs]
            if len(ion_names) == 1 and not raw_coeffs[0]:
                # A lone ion is the whole site — it holds every one of that site's
                # places in the formula unit.
                coeff_values = ["1"]
            else:
                coeff_values = [
                    _format_coeff_value(coeff) if coeff else "x" for coeff in raw_coeffs
                ]
            coeff_values = _site_stoichiometry(coeff_values, site)

            ion_layers.append("; ".join(ion_names))
            coeff_layers.append("; ".join(coeff_values))

        return " | ".join(ion_layers), " | ".join(coeff_layers), len(ion_layers)

    def _is_image_file(filename: str) -> bool:
        """Check if a file is an image based on extension."""
        lower = filename.lower()
        return bool(
            lower.endswith(
                (".png", ".jpg", ".jpeg", ".tiff", ".tif", ".gif", ".webp", ".bmp")
            )
        )

    def _is_document_file(filename: str) -> bool:
        """Check if a file is a document based on extension."""
        lower = filename.lower()
        return bool(lower.endswith((".pdf", ".doc", ".docx", ".odt", ".rtf")))

    def _extract_images_from_files(files: list[dict[str, Any]]) -> list[dict[str, str]]:
        """Extract image files and format them for NOMAD schema.

        Args:
            files: List of measurement file dicts with 'fileName' field

        Returns:
            List of dicts with 'image' and 'caption' fields
        """
        images = []
        for f in files:
            filename = f.get("fileName", "")
            if not filename or not _is_image_file(filename):
                continue

            # Use filename without extension as caption
            caption = Path(filename).stem.replace("_", " ").replace("-", " ")
            images.append(
                {
                    "image": _upload_raw_reference(sanitize_upload_filename(filename)),
                    "caption": caption,
                }
            )
        return images

    def _extract_documents_from_files(
        files: list[dict[str, Any]],
    ) -> list[dict[str, str]]:
        """Extract document files and format them for NOMAD schema.

        Args:
            files: List of measurement file dicts with 'fileName' field

        Returns:
            List of dicts with 'document' and 'title' fields
        """
        documents = []
        for f in files:
            filename = f.get("fileName", "")
            if not filename or not _is_document_file(filename):
                continue

            # Use filename without extension as title
            title = Path(filename).stem.replace("_", " ").replace("-", " ")
            documents.append(
                {
                    "document": _upload_raw_reference(
                        sanitize_upload_filename(filename)
                    ),
                    "title": title,
                }
            )
        return documents

    def _resolve_media_reference(media_ref: str) -> str:
        """Resolve a media reference like 'material:id' or 'solution:id' to the actual name."""
        if not media_ref or ":" not in media_ref:
            return media_ref

        parts = media_ref.split(":", 1)
        if len(parts) != 2:
            return media_ref

        kind, ref_id = parts
        kind = kind.strip().lower()
        ref_id = ref_id.strip()

        if kind == "material":
            material = materials_by_id.get(ref_id)
            if material and isinstance(material, dict):
                return _material_name(material, ref_id)
        elif kind == "solution":
            solution = solutions_by_id.get(ref_id)
            if solution and isinstance(solution, dict):
                return _clean_value(solution.get("name"), default=f"Solution {ref_id}")

        return media_ref

    def _parse_quenching_string(value: str) -> dict[str, Any]:
        """Parse a structured quenching string (type=Gas|gasType=N2|...) into NOMAD schema structure.

        Returns a dict with:
          - "type": "Gas", "Antisolvent", "Vacuum", or None
          - "gas": dict with gas quenching parameters
          - "antisolvent": dict with antisolvent quenching parameters
          - "vacuum": dict with vacuum quenching parameters
        """
        result: dict[str, Any] = {
            "type": None,
            "gas": None,
            "antisolvent": None,
            "vacuum": None,
        }
        if not value or not value.strip():
            return result

        pairs: dict[str, str] = {}
        for segment in value.split("|"):
            idx = segment.find("=")
            if idx == -1:
                continue
            pairs[segment[:idx].strip()] = segment[idx + 1 :].strip()

        qtype = pairs.get("type", "")
        if qtype not in ("Gas", "Antisolvent", "Vacuum"):
            # Legacy / freeform value — no structured quenching
            return result

        result["type"] = qtype

        time_until_start = _quench_value(pairs.get("timeUntilStart"), SECOND)
        if time_until_start is not None:
            result["time_until_start"] = time_until_start

        if qtype == "Gas":
            gas_params: dict[str, Any] = {}
            if pairs.get("gasType"):
                gas_params["gas_type"] = pairs["gasType"]
            _set_quench(gas_params, "pressure", pairs.get("pressure"), PASCAL)
            # The GUI lets the flow be given either as a volumetric flow (Slm)
            # or as a nozzle exit velocity (m/s) — dimensionally different
            # things, so they land in different quantities.
            _set_quench(gas_params, "flow_rate", pairs.get("flowRate"), LITER_PER_MIN)
            _set_quench(gas_params, "velocity", pairs.get("flowRate"), METER_PER_SEC)
            _set_quench(gas_params, "height", pairs.get("height"), MILLIMETER)
            _set_quench(
                gas_params, "nozzle_width", pairs.get("nozzleWidth"), MILLIMETER
            )
            if pairs.get("nozzleForm"):
                gas_params["nozzle_form"] = pairs["nozzleForm"]

            if gas_params:
                result["gas"] = gas_params

        elif qtype == "Antisolvent":
            antisolvent_params: dict[str, Any] = {}
            media = pairs.get("media", "") or pairs.get("material", "")
            if media:
                # Resolve material:id or solution:id to actual name
                antisolvent_params["media"] = _resolve_media_reference(media)
                # Keep the raw reference (never emitted to NOMAD) so the caller
                # can look the solution up for the database's quenching fields.
                result["media_ref"] = media
            if pairs.get("mediaCid"):
                antisolvent_params["media_pubchem_cid"] = pairs["mediaCid"]
            if pairs.get("depositionMethod"):
                antisolvent_params["deposition_method"] = pairs["depositionMethod"]
            _set_quench(
                antisolvent_params,
                "flow_rate",
                pairs.get("flowRate"),
                MICROLITER_PER_SEC,
            )
            _set_quench(antisolvent_params, "height", pairs.get("height"), MILLIMETER)
            _set_quench(antisolvent_params, "volume", pairs.get("volume"), MICROLITER)

            if antisolvent_params:
                result["antisolvent"] = antisolvent_params

        elif qtype == "Vacuum":
            vacuum_params: dict[str, Any] = {}
            _set_quench(vacuum_params, "height", pairs.get("height"), MILLIMETER)
            _set_quench(vacuum_params, "base_area", pairs.get("baseArea"), CM2)
            if pairs.get("pumpModel"):
                vacuum_params["pump_model"] = pairs["pumpModel"]
            _set_quench(vacuum_params, "dead_volume", pairs.get("deadVolume"), M3)
            _set_quench(
                vacuum_params, "evacuation_time", pairs.get("evacuationTime"), SECOND
            )

            if vacuum_params:
                result["vacuum"] = vacuum_params

        return result

    def _build_section(
        entries: list[tuple[dict[str, Any], str]],
        substrate: dict[str, Any] | None,
        thickness_key: str = "thickness",
    ) -> dict[str, Any]:
        """Build a generic deposition section dict (etl/htl/backcontact/add)."""
        procedure = _join_params(entries, "depositionMethod", substrate)
        quenching_parts: list[str] = []
        for e, _ in entries:
            dm = _get_step_param(e, "dryingMethod", substrate, "")
            if dm and dm != "Unknown":
                qd = _parse_quenching_string(dm)
                qtype = qd.get("type")
                if qtype:
                    quenching_parts.append(f"Quenching: {qtype}")
        if quenching_parts:
            procedure = f"{procedure} + {' | '.join(quenching_parts)}"
        return {
            "stack_sequence": " | ".join(name for _, name in entries),
            thickness_key: _layer_thickness(entries),
            "deposition_procedure": procedure,
            "deposition_synthesis_atmosphere": _join_params(
                entries, "depositionAtmosphere", substrate
            ),
            "deposition_solvents": _join_layer_solution_field(entries, "solvents"),
            "deposition_reaction_solutions_compounds": _join_layer_solution_field(
                entries, "compounds"
            ),
            "deposition_reaction_solutions_concentrations": _join_layer_solution_field(
                entries, "concentrations"
            ),
            "deposition_reaction_solutions_volumes": _join_params(
                entries, "solutionVolume", substrate
            ),
            "deposition_reaction_solutions_temperature": "Unknown",
            "deposition_substrate_temperature": _join_params(
                entries, "substrateTemp", substrate
            ),
            "deposition_thermal_annealing_temperature": _join_params(
                entries, "annealingTemp", substrate
            ),
            "deposition_thermal_annealing_time": _join_params(
                entries, "annealingTime", substrate
            ),
            "deposition_thermal_annealing_atmosphere": _join_params(
                entries, "annealingAtmosphere", substrate
            ),
            "surface_treatment_before_next_deposition_step": "Unknown",
        }

    # ── 6. Measurement-data helpers ───────────────────────────────────────────

    JV_TYPES: set[str] = {"JV", "Dark JV", "Stability (JV)"}
    IPCE_TYPES: set[str] = {"IPCE"}
    STABILITY_TYPES: set[str] = {"Stability (Tracking)", "Stability (Parameters)"}

    # 1 sun, AM 1.5G — what a JV is measured under unless the GUI says otherwise.
    DEFAULT_ILLUMINATION_MW_CM2 = 100.0

    def _slug(name: str) -> str:
        """Filesystem-safe lowercase slug."""
        s = str(name).replace(" ", "_").replace("/", "-")
        s = re.sub(r"[^\w\-]", "", s)
        return s.strip("_") or "unknown"

    def _best_jv(files: list[dict[str, Any]]) -> dict[str, Any] | None:
        jv = [f for f in files if f.get("fileType") in JV_TYPES]
        return max(jv, key=lambda f: float(f.get("value") or 0), default=None)

    def _best_ipce(files: list[dict[str, Any]]) -> dict[str, Any] | None:
        ipce = [f for f in files if f.get("fileType") in IPCE_TYPES]
        return max(
            ipce, key=lambda f: float(f.get("jsc") or f.get("value") or 0), default=None
        )

    def _fill_factor_fraction(raw: Any) -> float:
        """The database states FF as a fraction; the app carries it as a percent.

        The GUI normalises whatever the file said up to a percent (Results.page's
        `ff = raw <= 1 ? raw * 100 : raw`), so a 25.38 % fill factor arrives here
        as 25.38 — and was passed straight into `default_FF`, a hundred times the
        value NOMAD expects.
        """
        value = float(raw)
        return value / 100.0 if value > 1.0 else value

    def _jv_section(
        jv_file: dict[str, Any] | None,
        ipce_file: dict[str, Any] | None,
    ) -> dict[str, Any]:
        sec: dict[str, Any] = {"light_spectra": "AM 1.5G"}
        if jv_file:
            if jv_file.get("value") is not None:
                sec["default_PCE"] = round(float(jv_file["value"]), 4)
            if jv_file.get("voc") is not None:
                sec["default_Voc"] = round(float(jv_file["voc"]), 4)
            jsc_val = jv_file.get("jsc")
            if jsc_val is None and ipce_file:
                jsc_val = ipce_file.get("jsc") or ipce_file.get("value")
            if jsc_val is not None:
                sec["default_Jsc"] = round(float(jsc_val), 4)
            if jv_file.get("ff") is not None:
                sec["default_FF"] = round(_fill_factor_fraction(jv_file["ff"]), 6)
            # The efficiency is measured *against* an illumination, so a PCE with
            # no intensity beside it is not interpretable. No instrument file
            # states it; the GUI does, defaulting to 1 sun.
            sec["light_intensity"] = float(
                jv_file.get("illuminationIntensity") or DEFAULT_ILLUMINATION_MW_CM2
            )
        elif ipce_file:
            jsc_val = ipce_file.get("jsc") or ipce_file.get("value")
            if jsc_val is not None:
                sec["default_Jsc"] = round(float(jsc_val), 4)
        return sec

    def _measurement_archive_filename(
        meas_file: dict[str, Any],
        archives: dict[str, Any],
    ) -> str:
        """Name a measurement archive after the raw file it describes.

        The name is load-bearing: nomad_chose's ChoseParser skips a raw file when
        `<raw name>.archive.yaml` sits beside it, so that the app's richer entry
        (sample link, cell area, illumination) is the *only* entry for that
        measurement. A slugged name would not be found and every measurement would
        be parsed twice.
        """
        raw_name = sanitize_upload_filename(str(meas_file.get("fileName", "unknown")))
        fname = f"{raw_name}.archive.yaml"
        counter = 1
        while fname in archives:
            fname = f"{raw_name}_{counter}.archive.yaml"
            counter += 1
        return fname

    def _stability_run_key(file_name: str) -> str:
        """The key both halves of one stability run share."""
        return (
            sanitize_upload_filename(file_name)
            .replace("(Parameters)", "()")
            .replace("(Tracking)", "()")
        )

    def _measurement_runs(
        group_files: list[dict[str, Any]],
    ) -> list[list[dict[str, Any]]]:
        """Group a device's files into measurement *runs*, not files.

        A stability run is exported as two files — (Parameters) and (Tracking) —
        which are two halves of a single MPPTracking measurement: the track itself,
        and the JV parameters sampled along it. One entry per *file* gives two
        half-empty measurements: baseclasses derives the figures of merit (T80/T95)
        from the track, so the (Parameters) half would carry no results at all,
        while the (Tracking) half would lose the JV parameters.
        """
        runs: list[list[dict[str, Any]]] = []
        stability_runs: dict[str, list[dict[str, Any]]] = {}

        for meas_file in group_files:
            if meas_file.get("fileType") not in STABILITY_TYPES:
                runs.append([meas_file])
                continue
            key = _stability_run_key(str(meas_file.get("fileName", "")))
            run = stability_runs.get(key)
            if run is None:
                run = stability_runs[key] = [meas_file]
                runs.append(run)
            else:
                run.append(meas_file)

        return runs

    def _measurement_archive(
        run: list[dict[str, Any]],
        sample_filename: str,
        operator: str,
        cell_area: float | None = None,
    ) -> dict[str, Any] | None:
        """Build a LabXxx measurement data dict, or None for non-measurement types.

        `run` is the file (or, for a stability run, the two files) of one
        measurement — see `_measurement_runs`.
        """
        meas_file = run[0]
        file_type = meas_file.get("fileType", "Unknown")
        file_name = meas_file.get("fileName", "")
        # The measurement points at the raw file by name, so it must be the name
        # the file actually has inside the upload — not the one it had on disk.
        raw_file = sanitize_upload_filename(file_name)
        op = str(meas_file.get("user") or operator)

        # The measurement conditions. A file header that states these wins — the
        # plugin only falls back to what we send here (see nomad_chose's
        # build_jv_dict). Illumination is stated by no instrument file at all.
        conditions: dict[str, Any] = {}
        if cell_area is not None:
            conditions["active_area"] = cell_area
        intensity = meas_file.get("illuminationIntensity")
        if intensity is not None:
            conditions["intensity"] = float(intensity)

        sample_ref = [{"reference": _upload_raw_reference(sample_filename, "/data")}]

        if file_type in JV_TYPES:
            return {
                "m_def": "nomad_chose.schema_packages.schema_package.LabJVMeasurement",
                "name": file_name,
                "operator": op,
                "jv_file": raw_file,
                **conditions,
                "samples": sample_ref,
            }
        if file_type in IPCE_TYPES:
            return {
                "m_def": "nomad_chose.schema_packages.schema_package.LabEQEMeasurement",
                "name": file_name,
                "operator": op,
                "eqe_file": raw_file,
                # LabEQEMeasurement has an active_area but no intensity.
                **{k: v for k, v in conditions.items() if k == "active_area"},
                "samples": sample_ref,
            }
        if file_type in STABILITY_TYPES:
            entry: dict[str, Any] = {
                "m_def": "nomad_chose.schema_packages.schema_package.LabStabilityMeasurement",
                "name": file_name,
                "operator": op,
                **conditions,
                "samples": sample_ref,
            }
            # Both halves of the run go on the one measurement — the track and the
            # JV parameters sampled along it describe the same experiment.
            for half in run:
                half_name = sanitize_upload_filename(str(half.get("fileName", "")))
                if half.get("fileType") == "Stability (Tracking)":
                    entry["stability_tracking_file"] = half_name
                else:
                    entry["stability_parameters_file"] = half_name
            return entry
        # Document / Image / Archive / Unknown → skip
        return None

    def _build_sample_data(
        sample_name: str,
        sample_lab_id: str,
        substrate_layer_name: str,
        cell_stack_sequence: str,
        etl_e: _LayerEntries,
        absorber_e: _LayerEntries,
        htl_e: _LayerEntries,
        backcontact_e: _LayerEntries,
        add_front_e: _LayerEntries,
        add_back_e: _LayerEntries,
        substrate: dict[str, Any] | None,
        jv_sec: dict[str, Any],
        cell_area: float | None,
        cells_per_substrate: int | None = None,
        group_files: list[dict[str, Any]] | None = None,
    ) -> dict[str, Any]:
        """Assemble the PerovskiteSolarCellSampleArea data dict.

        Args:
            cell_area: Device area in cm². If None, area_total is not included.
            group_files: Optional list of measurement files for this device group
        """
        cell_dict: dict[str, Any] = {
            "stack_sequence": cell_stack_sequence,
            "architecture": architecture_nomad,
        }
        if cell_area is not None:
            cell_dict["area_total"] = cell_area
        if cells_per_substrate is not None:
            cell_dict["number_of_cells_per_substrate"] = cells_per_substrate

        # A discarded / unfinished substrate still yields a sample archive — say so
        # on the sample too, not only on the SubstrateSample.
        free_text = comment or ""
        substrate_note = (
            _substrate_description(substrate) if isinstance(substrate, dict) else ""
        )
        if substrate_note:
            free_text = f"{free_text} {substrate_note}".strip()

        d: dict[str, Any] = {
            "m_def": "nomad_perovskite_solar_cell_sample_plains.schema_packages.sample.PerovskiteSolarCellSampleArea",
            "name": sample_name,
            "lab_id": sample_lab_id,
            "ref": {
                "free_text_comment": free_text,
                "name_of_person_entering_the_data": user_name,
            },
            "cell": cell_dict,
            "substrate": {
                "stack_sequence": substrate_layer_name,
                "thickness": "nan",
            },
        }

        experiment_dt = _parse_datetime(str(exp_data.get("date") or ""))
        if experiment_dt:
            d["datetime"] = experiment_dt

        substrate_material_meta = _resolve_substrate_material(substrate)
        substrate_dimensions = _get_substrate_dimensions(substrate)
        substrate_height_mm = _to_float(
            (substrate_material_meta or {}).get("heightMm")
            if isinstance(substrate_material_meta, dict)
            else "",
        )
        substrate_length_cm = _to_float(substrate_dimensions.get("lengthCm"))
        substrate_width_cm = _to_float(substrate_dimensions.get("widthCm"))
        substrate_roughness_nm = _to_float(
            substrate_dimensions.get("surfaceRoughnessRmsNm")
        )

        substrate_area = (
            substrate_length_cm * substrate_width_cm
            if substrate_length_cm is not None and substrate_width_cm is not None
            else "nan"
        )

        d["substrate"].update(
            {
                "area": substrate_area,
                "supplier": _material_supplier(substrate_material_meta),
                "brand_name": _clean_value(
                    (substrate_material_meta or {}).get("supplierNumber")
                    if isinstance(substrate_material_meta, dict)
                    else "",
                ),
                "deposition_procedure": "Commercial",
                "cleaning_procedure": _substrate_cleaning_procedure(substrate),
                "surface_roughness_rms": (
                    substrate_roughness_nm
                    if substrate_roughness_nm is not None
                    else "nan"
                ),
            }
        )
        if substrate_height_mm is not None:
            d["substrate"]["thickness"] = substrate_height_mm

        if etl_e:
            d["etl"] = _build_section(etl_e, substrate, thickness_key="thickness")

        if absorber_e:
            abs_layer = absorber_e[0][0].get("_layer") or {}
            a_ions = abs_layer.get("perovskiteA") or "MA"
            b_ions = abs_layer.get("perovskiteB") or "Pb"
            x_ions = abs_layer.get("perovskiteX") or "I"
            parsed_a_ions, parsed_a_coeffs, a_layers = _parse_perovskite_ion_layers(
                a_ions, "a"
            )
            parsed_b_ions, parsed_b_coeffs, b_layers = _parse_perovskite_ion_layers(
                b_ions, "b"
            )
            parsed_c_ions, parsed_c_coeffs, c_layers = _parse_perovskite_ion_layers(
                x_ions, "c"
            )
            short_form, long_form = _composition_forms(
                (parsed_a_ions, parsed_a_coeffs),
                (parsed_b_ions, parsed_b_coeffs),
                (parsed_c_ions, parsed_c_coeffs),
            )
            max_layers = max(a_layers, b_layers, c_layers, 1)
            dimension_list = " | ".join(["3.0"] * max_layers)
            band_gap = str(abs_layer.get("bandgapEv") or "nan")
            thickness = str(abs_layer.get("thicknessNm") or "nan")
            absorber_solution_meta = {
                "solvents": _join_layer_solution_field(absorber_e, "solvents"),
                "solvents_supplier": _join_layer_solution_field(
                    absorber_e, "solvents_supplier"
                ),
                "solvents_purity": _join_layer_solution_field(
                    absorber_e, "solvents_purity"
                ),
                "solvents_mixing_ratios": _join_layer_solution_field(
                    absorber_e, "solvents_mixing_ratios"
                ),
                "compounds": _join_layer_solution_field(absorber_e, "compounds"),
                "compounds_supplier": _join_layer_solution_field(
                    absorber_e, "compounds_supplier"
                ),
                "compounds_purity": _join_layer_solution_field(
                    absorber_e, "compounds_purity"
                ),
                "concentrations": _join_layer_solution_field(
                    absorber_e, "concentrations"
                ),
            }

            perovskite: dict[str, Any] = {
                "dimension_3D": True,
                "dimension_list_of_layers": dimension_list,
                "composition_perovskite_ABC3_structure": True,
            }
            for site, site_ions, site_coeffs in (
                ("a", parsed_a_ions, parsed_a_coeffs),
                ("b", parsed_b_ions, parsed_b_coeffs),
                ("c", parsed_c_ions, parsed_c_coeffs),
            ):
                perovskite[f"composition_{site}_ions"] = site_ions
                safe_coeffs = _upstream_safe_coefficients(site_coeffs)
                if safe_coeffs is not None:
                    perovskite[f"composition_{site}_ions_coefficients"] = safe_coeffs
            perovskite.update(
                {
                    "composition_short_form": short_form,
                    "composition_long_form": long_form,
                    "thickness": thickness,
                    "band_gap": band_gap,
                }
            )
            d["perovskite"] = perovskite
            # Build quenching_parameters subsection
            quenching_params_section: dict[str, Any] = {}
            quenching_data_list = [
                _parse_quenching_string(
                    _get_step_param(e, "dryingMethod", substrate, "")
                )
                for e, _ in absorber_e
            ]

            # Collect all gas/antisolvent/vacuum parameters
            gas_list = [qd["gas"] for qd in quenching_data_list if qd["gas"]]
            antisolvent_list = [
                qd["antisolvent"] for qd in quenching_data_list if qd["antisolvent"]
            ]
            vacuum_list = [qd["vacuum"] for qd in quenching_data_list if qd["vacuum"]]

            # If we have gas quenching, use the first one (or merge if multiple)
            if gas_list:
                quenching_params_section["gas"] = gas_list[0]

            # If we have antisolvent quenching, use the first one (or merge if multiple)
            if antisolvent_list:
                quenching_params_section["antisolvent"] = antisolvent_list[0]

            # If we have vacuum quenching, use the first one (or merge if multiple)
            if vacuum_list:
                quenching_params_section["vacuum"] = vacuum_list[0]

            time_until_start = next(
                (
                    qd["time_until_start"]
                    for qd in quenching_data_list
                    if qd.get("time_until_start") is not None
                ),
                None,
            )
            if time_until_start is not None:
                quenching_params_section["time_until_start"] = time_until_start

            d["perovskite_deposition"] = {
                "number_of_deposition_steps": len(absorber_e),
                "procedure": _join_params(absorber_e, "depositionMethod", substrate),
                "aggregation_state_of_reactants": "Unknown",
                "synthesis_atmosphere": _join_params(
                    absorber_e, "depositionAtmosphere", substrate
                ),
                "synthesis_atmosphere_pressure_total": "Unknown",
                "synthesis_atmosphere_pressure_partial": "Unknown",
                "synthesis_atmosphere_relative_humidity": "Unknown",
                "solvents": absorber_solution_meta["solvents"],
                "solvents_mixing_ratios": absorber_solution_meta[
                    "solvents_mixing_ratios"
                ],
                "solvents_supplier": absorber_solution_meta["solvents_supplier"],
                "solvents_purity": absorber_solution_meta["solvents_purity"],
                "reaction_solutions_compounds": absorber_solution_meta["compounds"],
                "reaction_solutions_compounds_supplier": absorber_solution_meta[
                    "compounds_supplier"
                ],
                "reaction_solutions_compounds_purity": absorber_solution_meta[
                    "compounds_purity"
                ],
                "reaction_solutions_concentrations": absorber_solution_meta[
                    "concentrations"
                ],
                "reaction_solutions_volumes": _join_params(
                    absorber_e, "solutionVolume", substrate
                ),
                "reaction_solutions_age": "Unknown",
                "reaction_solutions_temperature": "Unknown",
                "substrate_temperature": _join_params(
                    absorber_e, "substrateTemp", substrate
                ),
                "thermal_annealing_temperature": _join_params(
                    absorber_e, "annealingTemp", substrate
                ),
                "thermal_annealing_time": _join_params(
                    absorber_e, "annealingTime", substrate
                ),
                "thermal_annealing_atmosphere": _join_params(
                    absorber_e, "annealingAtmosphere", substrate
                ),
                "thermal_annealing_relative_humidity": "Unknown",
                "thermal_annealing_pressure": "Unknown",
                "solvent_annealing": False,
                "solvent_annealing_timing": "Unknown",
                "solvent_annealing_solvent_atmosphere": "Unknown",
                "solvent_annealing_time": "Unknown",
                "solvent_annealing_temperature": "Unknown",
                "after_treatment_of_formed_perovskite": "false",
                # The upstream quantity name really is truncated at "..._met".
                "after_treatment_of_formed_perovskite_met": "Unknown",
            }

            # The perovskite-database's own quenching fields, alongside the
            # structured `quenching_parameters` subsection above — a NOMAD
            # search over the database schema only sees these.
            quench_types = [qd["type"] for qd in quenching_data_list if qd.get("type")]
            d["perovskite_deposition"]["quenching_induced_crystallisation"] = bool(
                quench_types
            )
            antisolvent_media = [
                str(qd["antisolvent"].get("media") or "")
                for qd in quenching_data_list
                if qd.get("antisolvent")
            ]
            if antisolvent_media:
                d["perovskite_deposition"]["quenching_media"] = (
                    _format_layer_token_list(antisolvent_media)
                )
                volumes = [
                    f"{qd['antisolvent']['volume']} uL"
                    for qd in quenching_data_list
                    if qd.get("antisolvent")
                    and qd["antisolvent"].get("volume") is not None
                ]
                if volumes:
                    d["perovskite_deposition"]["quenching_media_volume"] = "; ".join(
                        volumes
                    )

                # When the antisolvent is one of the lab's solutions rather than
                # a plain material, it can carry additives — keep them.
                for qd in quenching_data_list:
                    kind, _, ref_id = str(qd.get("media_ref") or "").partition(":")
                    if kind.strip().lower() != "solution" or not ref_id.strip():
                        continue
                    meta = _quenching_solution_metadata(ref_id.strip())
                    if meta["additives_compounds"] != "Unknown":
                        d["perovskite_deposition"][
                            "quenching_media_additives_compounds"
                        ] = meta["additives_compounds"]
                        d["perovskite_deposition"][
                            "quenching_media_additives_concentrations"
                        ] = meta["additives_concentrations"]
                    if meta["mixing_ratios"] != "Unknown":
                        d["perovskite_deposition"]["quenching_media_mixing_ratios"] = (
                            meta["mixing_ratios"]
                        )
                    break

            # Add quenching_parameters if any were found
            if quenching_params_section:
                d["perovskite_deposition"]["quenching_parameters"] = (
                    quenching_params_section
                )
        # A stack with no absorber layer has no perovskite, so we emit no
        # Perovskite section. The placeholder we used to send ("Unknown" ions
        # with 'x' coefficients) both fabricated a composition that does not
        # exist and crashed upstream's normalizer on the 'x' — see
        # _upstream_safe_coefficients. `perovskite` is an optional SubSection.

        if htl_e:
            d["htl"] = _build_section(htl_e, substrate, thickness_key="thickness_list")
        if backcontact_e:
            d["backcontact"] = _build_section(
                backcontact_e, substrate, thickness_key="thickness_list"
            )

        # `Add` prefixes every quantity with the side the layer sits on; an
        # unprefixed key resolves to nothing and is silently dropped by NOMAD.
        add_section: dict[str, Any] = {}
        for prefix, entries in (("lay_front", add_front_e), ("lay_back", add_back_e)):
            if not entries:
                continue
            add_section[prefix] = True
            section = _build_section(entries, substrate, thickness_key="thickness_list")
            for key, value in section.items():
                add_section[f"{prefix}_{key}"] = value
        if add_section:
            d["add"] = add_section

        d["jv"] = jv_sec

        # Add images and documents if files are provided
        if group_files:
            images = _extract_images_from_files(group_files)
            if images:
                d["images"] = images

            documents = _extract_documents_from_files(group_files)
            if documents:
                d["documents"] = documents

        return d

    def _stack_for_substrate(sub_idx: int) -> dict[str, Any] | None:
        n = len(active_stacks)
        return active_stacks[sub_idx % n] if n > 0 else None

    def _should_build_device_for_substrate(sub_idx: int) -> bool:
        """Check if buildDevice is Yes (or not set, defaulting to Yes)."""
        stack = _stack_for_substrate(sub_idx)
        if isinstance(stack, dict):
            build_device = str(stack.get("buildDevice") or "Yes").strip()
            return build_device != "No"
        return True

    def _num_pixels_for_substrate(sub_idx: int) -> int:
        stack = _stack_for_substrate(sub_idx)
        if isinstance(stack, dict):
            raw = str(stack.get("numberOfPixels") or "").strip()
            try:
                parsed = int(raw)
                if parsed > 0:
                    return parsed
            except ValueError:
                pass
        return max(devices_per_substrate, 1)

    def _cell_area_for_substrate(sub_idx: int) -> float | None:
        """Return cell area if buildDevice is Yes, otherwise None."""
        if not _should_build_device_for_substrate(sub_idx):
            return None
        stack = _stack_for_substrate(sub_idx)
        if isinstance(stack, dict):
            raw = str(stack.get("pixelAreaCm2") or "").strip()
            try:
                parsed = float(raw)
                if parsed > 0:
                    return parsed
            except ValueError:
                pass
        return device_area

    def _step_type_for_nomad(step_category: str) -> str:
        mapping = {
            "wet_deposition": "Wet Deposition",
            "dry_deposition": "Dry Deposition",
            "surface_treatment": "Surface Modification",
            "substrate_preparation": "Substrate Treatment",
            "doping_aging": "Aging Doping",
        }
        return mapping.get(step_category.strip().lower(), "Wet Deposition")

    def _parse_datetime(value: str) -> str | None:
        raw = str(value or "").strip()
        if not raw:
            return None
        try:
            return datetime.fromisoformat(raw).isoformat()
        except ValueError:
            try:
                return datetime.fromisoformat(raw.replace("Z", "+00:00")).isoformat()
            except ValueError:
                return None

    def _duration_minutes(start: str | None, end: str | None) -> float | None:
        """Minutes from `start` to `end`, or None when that isn't a real interval."""
        if not start or not end:
            return None
        try:
            delta = datetime.fromisoformat(end) - datetime.fromisoformat(start)
        except ValueError:
            return None
        minutes = delta.total_seconds() / 60.0
        # A non-positive gap means the times are inconsistent (the GUI flags
        # those cells in red); emitting a negative duration would corrupt the
        # workflow, so leave it unset instead.
        if minutes <= 0:
            return None
        return round(minutes, 4)

    def _solution_molar_concentration(solution_id: str) -> float | None:
        """Molarity (mol/l) of the solution's solutes, when it can be derived.

        Only solutes given as a mass (mg/g) with a known molar mass, dissolved in
        a known solvent volume, can be converted; anything else stays unset rather
        than guessed.
        """
        solution = solutions_by_id.get(solution_id)
        if not isinstance(solution, dict):
            return None

        total_volume_l = 0.0
        moles = 0.0
        for component in solution.get("components") or []:
            if not isinstance(component, dict):
                continue
            material = materials_by_id.get(str(component.get("materialId") or ""))
            if not isinstance(material, dict):
                continue
            amount = _to_float(component.get("amount"))
            if amount is None:
                continue
            unit = str(component.get("unit") or "").strip().lower()

            if _is_solvent_material(material):
                if unit in ("ml", "milliliter"):
                    total_volume_l += amount / 1000.0
                elif unit in ("l", "liter"):
                    total_volume_l += amount
                elif unit in ("µl", "μl", "ul", "microliter"):
                    total_volume_l += amount / 1_000_000.0
                continue

            if unit == "mol":
                moles += amount
                continue
            molar_mass = _to_float(material.get("molecularWeight"))
            if molar_mass is None or molar_mass <= 0:
                continue
            if unit in ("mg", "milligram"):
                moles += (amount / 1000.0) / molar_mass
            elif unit in ("g", "gram"):
                moles += amount / molar_mass

        if total_volume_l <= 0 or moles <= 0:
            return None
        return round(moles / total_volume_l, 6)

    def _recipe_molar_concentration(recipe_id: str) -> float | None:
        """Molarity (mol/l) of a process recipe, when its solutes can be converted."""
        components = _flatten_recipe_components(recipe_id)
        if not components:
            return None

        total_volume_l = 0.0
        moles = 0.0
        # Molar masses live on the recipe's own solute entries, not the material
        # library, so index them by name.
        molar_masses: dict[str, float] = {}
        for recipe in recipes_by_id.values():
            for solute in recipe.get("solutes") or []:
                if not isinstance(solute, dict):
                    continue
                mass = _to_float(solute.get("molarMass"))
                name = _clean_value(solute.get("name"), "")
                if name and mass and mass > 0:
                    molar_masses[name] = mass

        for component in components:
            amount_text = str(component.get("amount") or "")
            value = _to_float(amount_text.split(" ")[0]) if amount_text else None
            if value is None:
                continue
            unit = amount_text.partition(" ")[2].strip().lower()

            if component.get("is_solvent"):
                if unit in ("ml", "milliliter"):
                    total_volume_l += value / 1000.0
                elif unit in ("l", "liter"):
                    total_volume_l += value
                continue

            if unit == "mol":
                moles += value
                continue
            molar_mass = molar_masses.get(str(component.get("name") or ""))
            if molar_mass is None:
                continue
            if unit == "mg":
                moles += (value / 1000.0) / molar_mass
            elif unit == "g":
                moles += value / molar_mass

        if total_volume_l <= 0 or moles <= 0:
            return None
        return round(moles / total_volume_l, 6)

    def _step_material_payload(step: dict[str, Any]) -> dict[str, Any] | None:
        recipe_id = str(step.get("chemRecipeId") or "").strip()
        if recipe_id:
            recipe = recipes_by_id.get(recipe_id)
            if isinstance(recipe, dict):
                payload: dict[str, Any] = {
                    "name": _clean_value(
                        recipe.get("commercialName")
                        if recipe.get("isCommercial")
                        else recipe.get("name"),
                        "Unknown",
                    ),
                    "supplier": _clean_value(recipe.get("supplierNumber")),
                }
                concentration = _recipe_molar_concentration(recipe_id)
                if concentration is not None:
                    payload["concentration"] = concentration
                return payload

        inline = step.get("inlineMaterial")
        if isinstance(inline, dict) and _clean_value(inline.get("name"), ""):
            return {
                "name": _clean_value(inline.get("name")),
                "supplier": "Unknown",
            }

        solution_id = str(step.get("solutionId") or "").strip()
        if solution_id:
            solution = solutions_by_id.get(solution_id)
            if isinstance(solution, dict):
                solution_payload: dict[str, Any] = {
                    "name": _clean_value(solution.get("name"), "Unknown"),
                    "supplier": "Unknown",
                }
                concentration = _solution_molar_concentration(solution_id)
                if concentration is not None:
                    solution_payload["concentration"] = concentration
                return solution_payload

        material_id = str(step.get("materialId") or "").strip()
        if material_id:
            material = materials_by_id.get(material_id)
            return {
                "name": _material_name(material, material_id),
                "supplier": _material_supplier(material),
            }

        return None

    # ── Processing times ──────────────────────────────────────────────────────
    # Mirror of frontend/src/lib/processingTimes.ts. A substrate follows one
    # alternative per stage; substrates that pick the same alternative
    # everywhere share one timing row ("stack"), and from the first stage where
    # two substrates disagree ("divergence") each stack carries its own times.
    # The cells therefore live under either `stage:{i}` (shared prefix) or
    # `stage:{i}:stack:{key}` (diverged) — reading only the former, as this used
    # to, silently loses every timestamp after the divergence.
    #
    # Index `len(stages)` is not a stage but the *end of the experiment* cell,
    # which is what gives the last step a duration.

    _process_stages: list[dict[str, Any]] = [
        stage
        for stage in ((process_data or {}).get("stages") or [])
        if isinstance(stage, dict)
    ]
    _end_stage_idx = len(_process_stages)
    _processing_times: dict[str, str] = {
        str(key): str(value)
        for key, value in (exp_data.get("processingTimes") or {}).items()
        if isinstance(value, str)
    }

    def _stage_selection(substrate: dict[str, Any], stage_idx: int) -> str:
        stored = str(
            (substrate.get("parameterValues") or {}).get(f"stageSelection:{stage_idx}")
            or ""
        ).strip()
        if stored:
            return stored
        alternatives = _process_stages[stage_idx].get("alternatives") or []
        first = alternatives[0] if alternatives else None
        return str(first.get("id") or "") if isinstance(first, dict) else "SKIP"

    def _stack_key_for(substrate: dict[str, Any]) -> str:
        return "|".join(
            _stage_selection(substrate, idx) for idx in range(_end_stage_idx)
        )

    def _stack_order() -> list[str]:
        """Stack keys in the order the Processing table renders its rows."""
        order: list[str] = []
        for substrate in substrates_list:
            if not isinstance(substrate, dict):
                continue
            key = _stack_key_for(substrate)
            if key not in order:
                order.append(key)
        return order

    _stacks = _stack_order()

    def _diverge_idx() -> int:
        if len(_stacks) <= 1:
            return -1
        for idx in range(_end_stage_idx):
            if len({key.split("|")[idx] for key in _stacks}) > 1:
                return idx
        return -1

    _divergence = _diverge_idx()

    def _date_part(value: str) -> str:
        return value.split("T")[0] if value else ""

    def _has_time(value: str) -> bool:
        return bool(_date_part(value)) and "T" in value and bool(value.split("T")[1])

    def _resolve_processing_time(stage_idx: int, stack_key: str | None) -> str:
        """The effective time of one Processing-table cell (see processingTimes.ts)."""
        if stage_idx < 0:
            return ""
        effective_key = (
            stack_key if _divergence >= 0 and stage_idx >= _divergence else None
        )

        if effective_key:
            as_above = _processing_times.get(
                f"asAbove:stage:{stage_idx}:stack:{effective_key}"
            )
            if as_above == "true":
                row_idx = (
                    _stacks.index(effective_key) if effective_key in _stacks else 0
                )
                if row_idx > 0:
                    return _resolve_processing_time(stage_idx, _stacks[row_idx - 1])

        own = _processing_times.get(
            f"stage:{stage_idx}:stack:{effective_key}"
            if effective_key
            else f"stage:{stage_idx}"
        )
        if not own and effective_key:
            own = _processing_times.get(f"stage:{stage_idx}")
        if own:
            return own

        # Only the date cascades forward, never the time — same as the GUI.
        return _date_part(_resolve_processing_time(stage_idx - 1, stack_key))

    def _experiment_end_for(substrate: dict[str, Any]) -> str:
        """The 'end of experiment' cell of this substrate's row, else the experiment's."""
        end = _resolve_processing_time(_end_stage_idx, _stack_key_for(substrate))
        if _has_time(end):
            return end
        return str(exp_data.get("endDate") or "")

    def _selected_steps_for_substrate(
        substrate: dict[str, Any],
    ) -> list[tuple[int, dict[str, Any]]]:
        if not process_data or not isinstance(process_data, dict):
            return []

        parameter_values = substrate.get("parameterValues") or {}
        stages = process_data.get("stages") or []
        selected_steps: list[tuple[int, dict[str, Any]]] = []

        for stage_idx, stage in enumerate(stages):
            if not isinstance(stage, dict):
                continue
            alternatives = [
                step
                for step in (stage.get("alternatives") or [])
                if isinstance(step, dict)
            ]
            if not alternatives:
                continue

            selected_id = str(
                parameter_values.get(f"stageSelection:{stage_idx}") or ""
            ).strip()
            if selected_id.upper() == "SKIP":
                continue

            selected_step = None
            if selected_id:
                selected_step = next(
                    (
                        step
                        for step in alternatives
                        if str(step.get("id") or "") == selected_id
                    ),
                    None,
                )
            if selected_step is None:
                selected_step = alternatives[0]

            selected_steps.append((stage_idx, selected_step))

        return selected_steps

    def _build_substrate_section(
        substrate_layer_name: str,
        substrate: dict[str, Any] | None,
    ) -> dict[str, Any]:
        substrate_data: dict[str, Any] = {
            "stack_sequence": substrate_layer_name,
            "thickness": "nan",
        }

        substrate_material_meta = _resolve_substrate_material(substrate)
        substrate_dimensions = _get_substrate_dimensions(substrate)
        substrate_height_mm = _to_float(
            (substrate_material_meta or {}).get("heightMm")
            if isinstance(substrate_material_meta, dict)
            else "",
        )
        substrate_length_cm = _to_float(substrate_dimensions.get("lengthCm"))
        substrate_width_cm = _to_float(substrate_dimensions.get("widthCm"))
        substrate_roughness_nm = _to_float(
            substrate_dimensions.get("surfaceRoughnessRmsNm")
        )

        substrate_area = (
            substrate_length_cm * substrate_width_cm
            if substrate_length_cm is not None and substrate_width_cm is not None
            else "nan"
        )

        substrate_data.update(
            {
                "area": substrate_area,
                "supplier": _material_supplier(substrate_material_meta),
                "brand_name": _clean_value(
                    (substrate_material_meta or {}).get("supplierNumber")
                    if isinstance(substrate_material_meta, dict)
                    else "",
                ),
                "deposition_procedure": "Commercial",
                "cleaning_procedure": _substrate_cleaning_procedure(substrate),
                "surface_roughness_rms": (
                    substrate_roughness_nm
                    if substrate_roughness_nm is not None
                    else "nan"
                ),
            }
        )
        if substrate_height_mm is not None:
            substrate_data["thickness"] = substrate_height_mm

        return substrate_data

    def _substrate_description(substrate: dict[str, Any]) -> str:
        """The substrate's notes and its outcome (discarded / stopped early).

        A discarded or incomplete substrate still produces a sample archive, so
        the fact that it was discarded has to travel with it — otherwise a failed
        run is indistinguishable from a good one in NOMAD.
        """
        parts: list[str] = []
        notes = _clean_value(substrate.get("notes"), "")
        if notes:
            parts.append(notes)

        outcome = substrate.get("outcome")
        if isinstance(outcome, dict):
            status = str(outcome.get("status") or "").strip().lower()
            if status == "discarded":
                reason = _clean_value(outcome.get("discardReason"), "")
                parts.append(f"Discarded: {reason}" if reason else "Discarded.")
            elif status == "incomplete":
                stopped = _clean_value(outcome.get("stoppedAtStep"), "")
                parts.append(
                    f"Incomplete: processing stopped at step {stopped}."
                    if stopped
                    else "Incomplete: processing did not finish."
                )

        return " ".join(parts)

    def _build_substrate_entity_data(
        substrate: dict[str, Any],
        substrate_layer_name: str,
    ) -> dict[str, Any]:
        experiment_dt = _parse_datetime(str(exp_data.get("date") or ""))
        payload: dict[str, Any] = {
            "m_def": "nomad_perovskite_solar_cell_sample_plains.schema_packages.sample.SubstrateSample",
            "name": str(substrate.get("name") or substrate.get("id") or "substrate"),
            "lab_id": str(substrate.get("id") or substrate.get("name") or "substrate"),
            "substrate": _build_substrate_section(substrate_layer_name, substrate),
        }
        if experiment_dt:
            payload["datetime"] = experiment_dt
        description = _substrate_description(substrate)
        if description:
            payload["description"] = description
        return payload

    def _build_deposition_routine_data(
        substrate: dict[str, Any],
        substrate_sample_ref: str,
    ) -> dict[str, Any]:
        selected_steps = _selected_steps_for_substrate(substrate)
        stack_key = _stack_key_for(substrate)
        step_payloads: list[dict[str, Any]] = []

        # Resolve every step's start first: a step's duration is the gap to the
        # step that follows it, so it can only be known once the next start is.
        starts: list[str | None] = []
        for stage_idx, step in selected_steps:
            start = _parse_datetime(_resolve_processing_time(stage_idx, stack_key))
            if not start:
                start = _parse_datetime(
                    _get_step_param(step, "depositionStartTime", substrate, "")
                )
            starts.append(start)

        # The last step runs until the end of the experiment.
        routine_end = _parse_datetime(_experiment_end_for(substrate))
        boundaries: list[str | None] = [*starts[1:], routine_end]

        known_starts = [start for start in starts if start]
        start_ts = min(known_starts) if known_starts else None
        end_ts = routine_end or (max(known_starts) if known_starts else None)

        for step_idx, (_stage_idx, step) in enumerate(selected_steps, start=1):
            start = starts[step_idx - 1]

            name = _clean_value(step.get("name"), "")
            if not name:
                name = _get_step_param(step, "depositionMethod", substrate, "Unknown")

            step_payload: dict[str, Any] = {
                "step_index": step_idx,
                "step_type": _step_type_for_nomad(str(step.get("stepCategory") or "")),
                "name": name,
            }
            if start:
                step_payload["start_time"] = start
                duration = _duration_minutes(start, boundaries[step_idx - 1])
                if duration is not None:
                    step_payload["duration"] = duration

            deposition_method = _get_step_param(step, "depositionMethod", substrate, "")
            if deposition_method and deposition_method != "Unknown":
                step_payload["deposition_method"] = deposition_method

            color = _clean_value(step.get("color"), "")
            if color:
                step_payload["color"] = color

            notes = _clean_value(step.get("notes"), "")
            if notes:
                step_payload["notes"] = notes

            # Add atmosphere
            atmosphere = _get_step_param(step, "depositionAtmosphere", substrate, "")
            if atmosphere and atmosphere != "Unknown":
                step_payload["atmosphere"] = atmosphere

            # Add substrate temperature
            substrate_temp = _to_float(
                _get_step_param(step, "substrateTemp", substrate, "")
            )
            if substrate_temp is not None:
                step_payload["temperature"] = substrate_temp

            # Add deposition parameters
            depo_params = _get_step_param(step, "depositionParameters", substrate, "")
            if depo_params and depo_params != "Unknown":
                step_payload["deposition_parameters"] = depo_params

            # Solution volume — the GUI collects µL, the schema quantity is mL.
            solution_vol = _to_float(
                _get_step_param(step, "solutionVolume", substrate, "")
            )
            if solution_vol is not None:
                step_payload["solution_volume"] = solution_vol / 1000.0

            # Add drying method
            drying_method = _get_step_param(step, "dryingMethod", substrate, "")
            if drying_method and drying_method != "Unknown":
                step_payload["drying_method"] = drying_method

            # Add annealing parameters
            annealing_start = _parse_datetime(
                _get_step_param(step, "annealingStartTime", substrate, "")
            )
            if annealing_start:
                step_payload["annealing_start_time"] = annealing_start

            annealing_time = _to_float(
                _get_step_param(step, "annealingTime", substrate, "")
            )
            if annealing_time is not None:
                step_payload["annealing_time"] = annealing_time
                # Deliberately NOT the step's `duration`: annealing time is how
                # long the sample was annealed, duration is how long the step
                # occupied the routine (i.e. until the next step began). Falling
                # back to it here is only for a step whose start is unknown, so
                # the workflow keeps some notion of how long the step took.
                step_payload.setdefault("duration", annealing_time)

            annealing_temp = _to_float(
                _get_step_param(step, "annealingTemp", substrate, "")
            )
            if annealing_temp is not None:
                step_payload["annealing_temperature"] = annealing_temp

            annealing_atmos = _get_step_param(
                step, "annealingAtmosphere", substrate, ""
            )
            if annealing_atmos and annealing_atmos != "Unknown":
                step_payload["annealing_atmosphere"] = annealing_atmos

            # Add material/solution
            material_payload = _step_material_payload(step)
            if material_payload:
                step_payload["material"] = material_payload

            step_payloads.append(step_payload)

        process_payload: dict[str, Any] = {
            "m_def": "nomad_perovskite_solar_cell_sample_plains.schema_packages.sample.DepositionRoutine",
            "name": f"{str(substrate.get('name') or substrate.get('id') or 'substrate')} deposition",
            "lab_id": f"{str(substrate.get('id') or substrate.get('name') or 'substrate')}_deposition",
            "samples": [{"reference": substrate_sample_ref}],
            "steps": step_payloads,
        }

        # `Process` has no `start_time` — the start of an activity is `datetime`
        # (only its *steps* carry a start_time). Writing one would be silently
        # dropped by NOMAD's deserializer.
        experiment_dt = _parse_datetime(str(exp_data.get("date") or ""))
        if start_ts:
            process_payload["datetime"] = start_ts
        elif experiment_dt:
            process_payload["datetime"] = experiment_dt
        if end_ts:
            process_payload["end_time"] = end_ts

        return process_payload

    def _reserve_archive_filename(base_name: str) -> str:
        candidate = base_name
        counter = 1
        while candidate in archives:
            stem = Path(base_name).stem.replace(".archive", "")
            candidate = f"{stem}_{counter}.archive.yaml"
            counter += 1
        return candidate

    def _write_deduplicated_depositions(
        pending: list[tuple[str, dict[str, Any]]],
        archives: dict[str, dict[str, Any]],
    ) -> None:
        """Write DepositionRoutine archives, merging identical ones.

        Two routines are considered equal when their steps share the same
        fabrication parameters and step choices (timestamps are excluded from
        the comparison).  Identical routines are collapsed into a single YAML
        file whose ``samples`` list references all involved SubstrateSamples.
        """
        import json as _json

        def _steps_key(data: dict[str, Any]) -> str:
            """Canonical, timestamp-free representation of the step list."""
            steps = data.get("steps") or []
            normalized = [
                {
                    k: v
                    for k, v in sorted(step.items())
                    if k not in ("timestamp", "annealing_start_time", "step_index")
                }
                for step in steps
            ]
            return _json.dumps(normalized, sort_keys=True, default=str)

        # Group by step-content key; preserve insertion order
        groups: dict[str, list[tuple[str, dict[str, Any]]]] = {}
        for fname, data in pending:
            key = _steps_key(data)
            groups.setdefault(key, []).append((fname, data))

        for items in groups.values():
            canonical_fname, canonical_data = items[0]
            # Collect all substrate-sample references from every duplicate
            all_samples: list[dict[str, str]] = []
            for _, data in items:
                all_samples.extend(data.get("samples") or [])
            canonical_data["samples"] = all_samples
            archives[canonical_fname] = {"data": canonical_data}
            # The other filenames were reserved but not written – they are simply
            # omitted so no duplicate YAML file is created.

    # ── 7. Per-substrate layer grouping (shared logic) ────────────────────────

    def _layers_for_substrate(
        sub_idx: int,
        substrate: dict[str, Any],  # noqa: ARG001
    ) -> tuple[
        str,
        str,
        _LayerEntries,
        _LayerEntries,
        _LayerEntries,
        _LayerEntries,
        _LayerEntries,
        _LayerEntries,
    ]:
        """
        Return (substrate_layer_name, cell_stack_sequence,
                etl_entries, absorber_entries, htl_entries,
                backcontact_entries, add_front_entries, add_back_entries)
        for the given substrate index using the cyclically-assigned stack.
        """
        stack = _stack_for_substrate(sub_idx)

        sub_layer_name: str = substrate_material
        stack_layers: list[dict[str, Any]] = []
        if stack:
            for layer in stack.get("layers") or []:
                if not isinstance(layer, dict):
                    continue
                if layer.get("isSubstrate"):
                    sub_layer_name = layer.get("name") or substrate_material
                else:
                    stack_layers.append(layer)

        sub_layer_name = _format_substrate_stack_sequence(sub_layer_name)

        etl_e: list[tuple[dict[str, Any], str]] = []
        htl_e: list[tuple[dict[str, Any], str]] = []
        absorber_e: list[tuple[dict[str, Any], str]] = []
        bc_e: list[tuple[dict[str, Any], str]] = []
        # The database's `Add` section splits additional layers by which side of
        # the device they sit on, so interlayers are bucketed by whether they
        # were deposited before or after the absorber.
        add_front_e: list[tuple[dict[str, Any], str]] = []
        add_back_e: list[tuple[dict[str, Any], str]] = []
        ordered_names: list[str] = []
        seen_absorber = False

        for layer in stack_layers:
            layer_id = layer.get("id", "")
            layer_name = layer.get("name", "Unknown")
            ordered_names.append(layer_name)
            step = dict(step_map.get(layer_id, {}))
            step["_layer"] = layer
            entry: tuple[dict[str, Any], str] = (step, layer_name)
            lt = layer.get("layerType", "")
            if lt == "ETL":
                etl_e.append(entry)
            elif lt == "HTL":
                htl_e.append(entry)
            elif lt == "absorber":
                absorber_e.append(entry)
                seen_absorber = True
            elif lt == "contact":
                bc_e.append(entry)
            elif lt == "interlayer":
                (add_back_e if seen_absorber else add_front_e).append(entry)

        stack_seq = sub_layer_name
        if ordered_names:
            stack_seq += " | " + " | ".join(ordered_names)

        return (
            sub_layer_name,
            stack_seq,
            etl_e,
            absorber_e,
            htl_e,
            bc_e,
            add_front_e,
            add_back_e,
        )

    # ── 8. Build device-group lookup by substrate ─────────────────────────────
    groups_by_substrate: dict[str, list[dict[str, Any]]] = {}
    unassigned_groups: list[dict[str, Any]] = []
    if device_groups:
        for group in device_groups:
            sub_id = str(group.get("assignedSubstrateId") or "")
            if sub_id:
                groups_by_substrate.setdefault(sub_id, []).append(group)
            else:
                unassigned_groups.append(group)

    # ── 9. Generate archives ──────────────────────────────────────────────────
    archives: dict[str, dict[str, Any]] = {}
    # Deposition routines are collected here and written after deduplication.
    _pending_depositions: list[tuple[str, dict[str, Any]]] = []

    for sub_idx, substrate in enumerate(substrates_list):
        if isinstance(substrate, dict):
            substrate_id = str(
                substrate.get("id") or substrate.get("name") or f"substrate_{sub_idx}"
            )
        else:
            substrate_id = str(getattr(substrate, "id", f"substrate_{sub_idx}"))
            substrate = {"id": substrate_id, "name": substrate_id}

        sub_name_slug = _slug(str(substrate.get("name") or substrate_id))

        (
            sub_layer,
            stack_seq,
            etl_e,
            absorber_e,
            htl_e,
            bc_e,
            add_front_e,
            add_back_e,
        ) = _layers_for_substrate(sub_idx, substrate)

        # Reserve filenames up-front so nothing collides later
        substrate_sample_fname = _reserve_archive_filename(
            f"{sub_name_slug}_substrate.archive.yaml",
        )
        substrate_sample_ref = _upload_raw_reference(substrate_sample_fname, "/data")

        deposition_fname = _reserve_archive_filename(
            f"{sub_name_slug}_deposition.archive.yaml",
        )

        substrate_groups = groups_by_substrate.get(substrate_id, [])
        num_pixels = _num_pixels_for_substrate(sub_idx)
        cell_area = _cell_area_for_substrate(sub_idx)

        sample_count = max(num_pixels, len(substrate_groups), 1)
        sample_filenames: list[str] = []

        # ── Build PerovskiteSolarCellSampleArea archives ───────────────────
        for dev_idx in range(sample_count):
            sample_fname = _reserve_archive_filename(
                f"{sub_name_slug}_dev{dev_idx + 1}_sample.archive.yaml",
            )
            sample_filenames.append(sample_fname)

            group_files: list[dict[str, Any]] = []
            group: dict[str, Any] | None = None
            if dev_idx < len(substrate_groups):
                group = substrate_groups[dev_idx]
                group_files = list(group.get("files") or [])

            sample_name = str(
                (group or {}).get("deviceName")
                or f"{str(substrate.get('name') or substrate_id)} device {dev_idx + 1}"
            )
            sample_lab_id = str(
                (group or {}).get("id") or f"{substrate_id}_dev{dev_idx + 1}"
            )

            best_jv = _best_jv(group_files)
            best_ipce = _best_ipce(group_files)
            jv_sec = _jv_section(best_jv, best_ipce)

            sample_data = _build_sample_data(
                sample_name,
                sample_lab_id,
                sub_layer,
                stack_seq,
                etl_e,
                absorber_e,
                htl_e,
                bc_e,
                add_front_e,
                add_back_e,
                substrate,
                jv_sec,
                cell_area=cell_area,
                cells_per_substrate=num_pixels,
                group_files=group_files,
            )
            archives[sample_fname] = {"data": sample_data}

        # ── Build SubstrateSample archive (with cell_areas) ───────────────
        substrate_sample_data = _build_substrate_entity_data(substrate, sub_layer)
        substrate_sample_data["cell_areas"] = [
            {"reference": _upload_raw_reference(fname, "/data")}
            for fname in sample_filenames
        ]
        archives[substrate_sample_fname] = {"data": substrate_sample_data}

        # ── Collect DepositionRoutine data for later deduplication ────────
        deposition_data = _build_deposition_routine_data(
            substrate, substrate_sample_ref
        )
        _pending_depositions.append((deposition_fname, deposition_data))

        for group_idx, group in enumerate(substrate_groups):
            group_files = list(group.get("files") or [])
            if not sample_filenames:
                continue
            target_sample_fname = sample_filenames[group_idx % len(sample_filenames)]

            for run in _measurement_runs(group_files):
                meas_data = _measurement_archive(
                    run, target_sample_fname, user_name, cell_area
                )
                if meas_data is None:
                    continue
                archives[_measurement_archive_filename(run[0], archives)] = {
                    "data": meas_data
                }

    # ── 10. Unassigned device groups (no substrate match) ─────────────────────
    for group in unassigned_groups:
        device_name = str(group.get("deviceName") or "unassigned")
        dev_slug = _slug(device_name)
        # No sample YAML — just measurement YAMLs with a placeholder reference
        sample_placeholder = f"sample_{dev_slug}_sample.archive.yaml"
        group_files = list(group.get("files") or [])
        for run in _measurement_runs(group_files):
            meas_data = _measurement_archive(run, sample_placeholder, user_name)
            if meas_data is None:
                continue
            archives[_measurement_archive_filename(run[0], archives)] = {
                "data": meas_data
            }

    # ── 11. Write deduplicated DepositionRoutine archives ────────────────────
    _write_deduplicated_depositions(_pending_depositions, archives)

    logger.info(
        f"Generated {len(archives)} NOMAD archive files for experiment {experiment_id}"
    )
    return archives


def upload_to_nomad(
    zip_path: Path,
    token: str | None = None,
    upload_name: str | None = None,
    existing_upload_id: str | None = None,
) -> dict[str, Any]:
    """
    Upload a zip file to NOMAD.

    When *existing_upload_id* is provided the zip is streamed via
    ``PUT /uploads/{existing_upload_id}`` so that additional data is added
    to the same upload rather than creating a new one.

    Args:
        zip_path: Path to the zip file to upload
        token: NOMAD auth token (fetches new one if not provided)
        upload_name: Optional name for the upload (ignored on re-upload)
        existing_upload_id: Existing NOMAD upload ID to add data to

    Returns:
        Dict with upload_id, entry_ids, and other metadata from NOMAD

    Raises:
        NomadUploadError: If upload fails
    """
    if not token:
        token = get_nomad_token()

    if not zip_path.exists():
        raise NomadUploadError(f"Zip file not found: {zip_path}")

    # ── MOCK MODE ──────────────────────────────────────────────────────
    if settings.NOMAD_MOCK_MODE:
        mock_id = existing_upload_id or f"MOCK_{uuid.uuid4().hex[:12]}"
        action = "PUT" if existing_upload_id else "POST"
        upload_url = (
            f"{settings.NOMAD_URL}/uploads/{existing_upload_id}"
            if existing_upload_id
            else f"{settings.NOMAD_URL}/uploads"
        )
        logger.info(
            "[MOCK MODE] upload_to_nomad — would %s %s with file=%s (%d bytes), "
            "upload_name=%s. Returning fake upload_id=%s instead.",
            action,
            upload_url,
            zip_path.name,
            zip_path.stat().st_size,
            upload_name,
            mock_id,
        )
        return {
            "upload_id": mock_id,
            "upload_create_time": datetime.now(timezone.utc).isoformat(),
            "processing_status": "PENDING",
            "entries": [],
            "entry_ids": [],
        }
    # ───────────────────────────────────────────────────────────────────

    try:
        with httpx.Client(timeout=120.0) as client:
            with open(zip_path, "rb") as f:
                if existing_upload_id:
                    # Add data to an existing upload via streaming PUT
                    put_url = f"{settings.NOMAD_URL}/uploads/{existing_upload_id}"
                    logger.info(
                        f"Re-uploading to existing NOMAD upload {existing_upload_id}"
                    )
                    response = client.put(
                        put_url,
                        content=f.read(),
                        headers={
                            "Authorization": f"Bearer {token}",
                            "Content-Type": "application/zip",
                            "Accept": "application/json",
                        },
                    )
                    if response.status_code not in (200, 201):
                        logger.error(
                            f"NOMAD re-upload failed: {response.status_code} - {response.text}"
                        )
                        raise NomadUploadError(
                            f"NOMAD re-upload failed: {response.status_code}"
                        )
                    raw = _safe_json_dict(response, context="re-upload")
                    upload_data = raw.get("data", raw)
                    location = response.headers.get("location", "")
                    location_upload_id = (
                        location.rstrip("/").split("/")[-1]
                        if "/uploads/" in location
                        else None
                    )
                    result_upload_id = (
                        upload_data.get("upload_id")
                        or raw.get("upload_id")
                        or location_upload_id
                        or existing_upload_id
                    )
                else:
                    # Create a new upload
                    upload_url = f"{settings.NOMAD_URL}/uploads"
                    files = {"file": (zip_path.name, f, "application/zip")}
                    params: dict[str, str] = {}
                    if upload_name:
                        params["upload_name"] = upload_name
                    response = client.post(
                        upload_url,
                        files=files,
                        params=params,
                        headers={
                            "Authorization": f"Bearer {token}",
                            "Accept": "application/json",
                        },
                    )
                    if response.status_code not in (200, 201):
                        logger.error(
                            f"NOMAD upload failed: {response.status_code} - {response.text}"
                        )
                        raise NomadUploadError(
                            f"NOMAD upload failed: {response.status_code}"
                        )
                    raw = _safe_json_dict(response, context="upload")
                    upload_data = raw.get("data", raw)
                    location = response.headers.get("location", "")
                    location_upload_id = (
                        location.rstrip("/").split("/")[-1]
                        if "/uploads/" in location
                        else None
                    )
                    result_upload_id = (
                        upload_data.get("upload_id")
                        or raw.get("upload_id")
                        or location_upload_id
                    )

                    if not result_upload_id:
                        raise NomadUploadError(
                            "NOMAD upload succeeded but response did not include upload_id"
                        )

            logger.info(f"NOMAD upload successful: {result_upload_id}")
            logger.info(f"Data: {upload_data}")
            entries_val = upload_data.get("entries", [])
            # NOMAD returns entries as a count (int) or a list; normalize to count
            if isinstance(entries_val, int):
                entries_count = entries_val
            elif isinstance(entries_val, list):
                entries_count = len(entries_val)
            else:
                entries_count = 0

            return {
                "upload_id": result_upload_id,
                "upload_create_time": upload_data.get("upload_create_time"),
                "processing_status": upload_data.get("process_status", "PENDING"),
                "entries": entries_count,
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
            "Returning fake 'SUCCESS' status instead.",
            status_url,
        )
        return {
            "upload_id": upload_id,
            "process_status": "SUCCESS",
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

            raw = _safe_json_dict(response, context="status")
            # NOMAD wraps GET /uploads/{id} responses in a top-level "data" key
            return raw.get("data", raw)

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


def cleanup_stale_archives(max_age_seconds: int | None = None) -> list[Path]:
    """
    Delete temporary upload archives that have been inactive for longer than
    ``max_age_seconds`` (default: settings.NOMAD_ARCHIVE_MAX_AGE_S).

    "Inactive" means the file's mtime is older than the window — every write
    (adding files or metadata) refreshes the mtime, so an archive the user is
    still working on is never swept. Called opportunistically from the NOMAD
    endpoints so orphaned archives (browser closed, flow abandoned) do not
    accumulate on disk.

    Returns the list of deleted archive paths.
    """
    max_age = (
        settings.NOMAD_ARCHIVE_MAX_AGE_S if max_age_seconds is None else max_age_seconds
    )
    deleted: list[Path] = []
    if not TEMP_UPLOAD_DIR.exists():
        return deleted
    cutoff = time.time() - max_age
    for candidate in TEMP_UPLOAD_DIR.glob("*.zip"):
        try:
            if candidate.is_file() and candidate.stat().st_mtime < cutoff:
                candidate.unlink()
                deleted.append(candidate)
                logger.info(
                    "Swept stale NOMAD upload archive (inactive > %ss): %s",
                    max_age,
                    candidate,
                )
        except OSError:
            # Already gone or not deletable — never fail the caller for this.
            logger.warning("Could not sweep stale archive %s", candidate)
    return deleted


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


# ─────────────────────────────────────────────────────────────────────────────
# Failed-upload stash
# ─────────────────────────────────────────────────────────────────────────────


def ensure_stash_dir() -> Path:
    """Ensure the durable stash directory exists."""
    STASH_DIR.mkdir(parents=True, exist_ok=True)
    return STASH_DIR


def stash_archive(zip_path: Path, log_id: uuid.UUID | str) -> Path:
    """
    Copy an upload archive into the durable stash, keyed by its log id.

    The archive is *copied* (not moved) so the caller's existing temp-archive
    cleanup is unaffected. Returns the path to the stashed copy.

    Raises:
        FileNotFoundError: If the source archive does not exist.
    """
    if not zip_path.exists():
        raise FileNotFoundError(f"Archive to stash not found: {zip_path}")
    ensure_stash_dir()
    dest = STASH_DIR / f"{log_id}.zip"
    shutil.copy2(zip_path, dest)
    logger.info(
        "Stashed upload archive for log %s: %s (%d bytes)",
        log_id,
        dest,
        dest.stat().st_size,
    )
    return dest


def purge_stash_file(stash_path: str | Path | None) -> bool:
    """Delete a single stashed archive. Returns True if a file was removed."""
    if not stash_path:
        return False
    path = Path(stash_path)
    try:
        # Only ever touch files inside the stash dir.
        if not path.resolve().is_relative_to(STASH_DIR.resolve()):
            logger.warning("Refusing to purge stash path outside stash dir: %s", path)
            return False
        if path.exists() and path.is_file():
            path.unlink()
            logger.info("Purged stashed archive: %s", path)
            return True
        return False
    except OSError as e:
        logger.error("Failed to purge stashed archive %s: %s", path, e)
        return False


def get_upload_entries(upload_id: str, token: str | None = None) -> dict[str, Any]:
    """
    Fetch per-entry processing data for an upload (maximum diagnostic info).

    Returns a dict with ``processing_failed`` (int) and ``entry_errors`` (a list
    of ``{entry_id, mainfile, errors}`` for entries that reported errors). On any
    problem returns an empty dict — this is best-effort enrichment only.
    """
    if not token:
        token = get_nomad_token()

    entries_url = f"{settings.NOMAD_URL}/uploads/{upload_id}/entries"

    # ── MOCK MODE ──────────────────────────────────────────────────────
    if settings.NOMAD_MOCK_MODE:
        logger.info(
            "[MOCK MODE] get_upload_entries — would GET %s. Returning empty.",
            entries_url,
        )
        return {"processing_failed": 0, "entry_errors": []}
    # ───────────────────────────────────────────────────────────────────

    try:
        with httpx.Client(timeout=30.0) as client:
            response = client.get(
                entries_url,
                params={"page_size": 100},
                headers={"Authorization": f"Bearer {token}"},
            )
            if response.status_code != 200:
                logger.warning("NOMAD entries check failed: %s", response.status_code)
                return {}
            raw = _safe_json_dict(response, context="entries")
            entry_errors: list[dict[str, Any]] = []
            for entry in raw.get("data") or []:
                if not isinstance(entry, dict):
                    continue
                errs = entry.get("errors") or []
                if errs:
                    entry_errors.append(
                        {
                            "entry_id": entry.get("entry_id"),
                            "mainfile": entry.get("mainfile"),
                            "errors": errs,
                        }
                    )
            return {
                "processing_failed": raw.get("processing_failed"),
                "processing_successful": raw.get("processing_successful"),
                "entry_errors": entry_errors,
            }
    except httpx.RequestError as e:
        logger.warning("NOMAD entries request error: %s", e)
        return {}
