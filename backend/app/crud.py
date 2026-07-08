import uuid
from datetime import datetime, timedelta, timezone
from typing import Any

from sqlmodel import Session, col, select

from app.core.config import settings
from app.core.security import get_password_hash, verify_password
from app.models import (
    Analysis,
    AnalysisCreate,
    AnalysisRef,
    AnalysisUpdate,
    DataCollection,
    DataCollectionCreate,
    DataCollectionUpdate,
    DeviceGroup,
    Experiment,
    ExperimentCreate,
    ExperimentResults,
    ExperimentResultsCreate,
    ExperimentResultsUpdate,
    ExperimentUpdate,
    LabMaterial,
    LabMaterialCreate,
    LabMaterialUpdate,
    LabSolution,
    LabSolutionCreate,
    LabSolutionUpdate,
    LabSubstrate,
    MeasurementFile,
    NomadUploadLog,
    Plane,
    PlaneCreate,
    PlaneFolder,
    PlaneFolderCreate,
    PlaneFolderUpdate,
    PlaneUpdate,
    Process,
    ProcessCreate,
    ProcessUpdate,
    SolutionComponent,
    StickyNote,
    StickyNoteCreate,
    StickyNoteUpdate,
    TextField,
    TextFieldCreate,
    TextFieldUpdate,
    User,
    UserCreate,
    UserUpdate,
)
from app.services.nomad import purge_stash_file


def _apply_update(session: Session, db_obj: Any, update_in: Any) -> Any:
    db_obj.sqlmodel_update(update_in.model_dump(exclude_unset=True))
    session.add(db_obj)
    session.commit()
    session.refresh(db_obj)
    return db_obj


def create_user(*, session: Session, user_create: UserCreate) -> User:
    db_obj = User.model_validate(
        user_create, update={"hashed_password": get_password_hash(user_create.password)}
    )
    session.add(db_obj)
    session.commit()
    session.refresh(db_obj)
    return db_obj


def update_user(*, session: Session, db_user: User, user_in: UserUpdate) -> Any:
    user_data = user_in.model_dump(exclude_unset=True)
    extra_data = {}
    if "password" in user_data:
        password = user_data["password"]
        hashed_password = get_password_hash(password)
        extra_data["hashed_password"] = hashed_password
    db_user.sqlmodel_update(user_data, update=extra_data)
    session.add(db_user)
    session.commit()
    session.refresh(db_user)
    return db_user


def get_user_by_email(*, session: Session, email: str) -> User | None:
    statement = select(User).where(User.email == email)
    session_user = session.exec(statement).first()
    return session_user


# Dummy hash to use for timing attack prevention when user is not found
DUMMY_HASH = "$argon2id$v=19$m=65536,t=3,p=4$MjQyZWE1MzBjYjJlZTI0Yw$YTU4NGM5ZTZmYjE2NzZlZjY0ZWY3ZGRkY2U2OWFjNjk"


def authenticate(*, session: Session, email: str, password: str) -> User | None:
    db_user = get_user_by_email(session=session, email=email)
    if not db_user:
        verify_password(password, DUMMY_HASH)
        return None
    if not db_user.hashed_password:
        return None
    verified, updated_password_hash = verify_password(password, db_user.hashed_password)
    if not verified:
        return None
    if updated_password_hash:
        db_user.hashed_password = updated_password_hash
        session.add(db_user)
        session.commit()
        session.refresh(db_user)
    return db_user


# ============================================================================
# LabMaterial CRUD
# ============================================================================
def create_material(
    *, session: Session, material_in: LabMaterialCreate, owner_id: uuid.UUID
) -> LabMaterial:
    db_material = LabMaterial.model_validate(material_in, update={"owner_id": owner_id})
    session.add(db_material)
    session.commit()
    session.refresh(db_material)
    return db_material


def update_material(
    *, session: Session, db_material: LabMaterial, material_in: LabMaterialUpdate
) -> LabMaterial:
    return _apply_update(session, db_material, material_in)


# ============================================================================
# LabSolution CRUD
# ============================================================================
def create_solution(
    *, session: Session, solution_in: LabSolutionCreate, owner_id: uuid.UUID
) -> LabSolution:
    db_solution = LabSolution.model_validate(
        solution_in.model_dump(exclude={"components"}),
        update={"owner_id": owner_id},
    )
    session.add(db_solution)
    session.flush()
    for component_in in solution_in.components:
        component = SolutionComponent.model_validate(
            component_in, update={"solution_id": db_solution.id}
        )
        session.add(component)
    session.commit()
    session.refresh(db_solution)
    return db_solution


def update_solution(
    *, session: Session, db_solution: LabSolution, solution_in: LabSolutionUpdate
) -> LabSolution:
    return _apply_update(session, db_solution, solution_in)


# ============================================================================
# Experiment CRUD
# ============================================================================
def create_experiment(
    *, session: Session, experiment_in: ExperimentCreate, owner_id: uuid.UUID
) -> Experiment:
    db_experiment = Experiment.model_validate(
        experiment_in.model_dump(exclude={"substrates"}),
        update={"owner_id": owner_id},
    )
    session.add(db_experiment)
    session.flush()
    for substrate_in in experiment_in.substrates:
        substrate = LabSubstrate.model_validate(
            substrate_in, update={"experiment_id": db_experiment.id}
        )
        session.add(substrate)
    session.commit()
    session.refresh(db_experiment)
    return db_experiment


def update_experiment(
    *, session: Session, db_experiment: Experiment, experiment_in: ExperimentUpdate
) -> Experiment:
    return _apply_update(session, db_experiment, experiment_in)


# ============================================================================
# ExperimentResults CRUD
# ============================================================================
def create_experiment_results(
    *,
    session: Session,
    results_in: ExperimentResultsCreate,
    owner_id: uuid.UUID,
    experiment_id: uuid.UUID,
) -> ExperimentResults:
    db_results = ExperimentResults.model_validate(
        results_in.model_dump(exclude={"measurement_files", "device_groups"}),
        update={"owner_id": owner_id, "experiment_id": experiment_id},
    )
    session.add(db_results)
    session.flush()
    for file_in in results_in.measurement_files:
        file_obj = MeasurementFile.model_validate(
            file_in, update={"results_id": db_results.id}
        )
        session.add(file_obj)
    for group_in in results_in.device_groups:
        group = DeviceGroup.model_validate(
            group_in, update={"results_id": db_results.id}
        )
        session.add(group)
    session.commit()
    session.refresh(db_results)
    return db_results


def update_experiment_results(
    *,
    session: Session,
    db_results: ExperimentResults,
    results_in: ExperimentResultsUpdate,
) -> ExperimentResults:
    return _apply_update(session, db_results, results_in)


# ============================================================================
# Process CRUD
# ============================================================================
def create_process(
    *, session: Session, process_in: ProcessCreate, owner_id: uuid.UUID
) -> Process:
    db_process = Process.model_validate(process_in, update={"owner_id": owner_id})
    session.add(db_process)
    session.commit()
    session.refresh(db_process)
    return db_process


def update_process(
    *, session: Session, db_process: Process, process_in: ProcessUpdate
) -> Process:
    return _apply_update(session, db_process, process_in)


# ============================================================================
# Analysis CRUD
# ============================================================================
def create_analysis(
    *, session: Session, analysis_in: AnalysisCreate, owner_id: uuid.UUID
) -> Analysis:
    db_analysis = Analysis.model_validate(
        analysis_in.model_dump(exclude={"refs"}), update={"owner_id": owner_id}
    )
    session.add(db_analysis)
    session.flush()
    for ref_in in analysis_in.refs:
        ref = AnalysisRef.model_validate(ref_in, update={"analysis_id": db_analysis.id})
        session.add(ref)
    session.commit()
    session.refresh(db_analysis)
    return db_analysis


def update_analysis(
    *, session: Session, db_analysis: Analysis, analysis_in: AnalysisUpdate
) -> Analysis:
    return _apply_update(session, db_analysis, analysis_in)


# ============================================================================
# Plane CRUD
# ============================================================================
def create_plane(
    *, session: Session, plane_in: PlaneCreate, owner_id: uuid.UUID
) -> Plane:
    db_plane = Plane.model_validate(plane_in, update={"owner_id": owner_id})
    session.add(db_plane)
    session.commit()
    session.refresh(db_plane)
    return db_plane


def update_plane(*, session: Session, db_plane: Plane, plane_in: PlaneUpdate) -> Plane:
    return _apply_update(session, db_plane, plane_in)


def create_plane_folder(
    *, session: Session, folder_in: PlaneFolderCreate, owner_id: uuid.UUID
) -> PlaneFolder:
    db_folder = PlaneFolder.model_validate(folder_in, update={"owner_id": owner_id})
    session.add(db_folder)
    session.commit()
    session.refresh(db_folder)
    return db_folder


def update_plane_folder(
    *, session: Session, db_folder: PlaneFolder, folder_in: PlaneFolderUpdate
) -> PlaneFolder:
    return _apply_update(session, db_folder, folder_in)


# ============================================================================
# Canvas element CRUD
# ============================================================================
def create_sticky_note(
    *, session: Session, note_in: StickyNoteCreate, plane_id: uuid.UUID
) -> StickyNote:
    note = StickyNote.model_validate(note_in, update={"plane_id": plane_id})
    session.add(note)
    session.commit()
    session.refresh(note)
    return note


def update_sticky_note(
    *, session: Session, db_note: StickyNote, note_in: StickyNoteUpdate
) -> StickyNote:
    return _apply_update(session, db_note, note_in)


def create_text_field(
    *, session: Session, field_in: TextFieldCreate, plane_id: uuid.UUID
) -> TextField:
    field = TextField.model_validate(field_in, update={"plane_id": plane_id})
    session.add(field)
    session.commit()
    session.refresh(field)
    return field


def update_text_field(
    *, session: Session, db_field: TextField, field_in: TextFieldUpdate
) -> TextField:
    return _apply_update(session, db_field, field_in)


def create_collection(
    *, session: Session, collection_in: DataCollectionCreate, plane_id: uuid.UUID
) -> DataCollection:
    collection = DataCollection.model_validate(
        collection_in, update={"plane_id": plane_id}
    )
    session.add(collection)
    session.commit()
    session.refresh(collection)
    return collection


def update_collection(
    *,
    session: Session,
    db_collection: DataCollection,
    collection_in: DataCollectionUpdate,
) -> DataCollection:
    return _apply_update(session, db_collection, collection_in)


# ─────────────────────────────────────────────────────────────────────────────
# NOMAD upload log + failed-archive stash
# ─────────────────────────────────────────────────────────────────────────────


def create_nomad_upload_log(
    *,
    session: Session,
    user: User,
    experiment_id: uuid.UUID | None,
    experiment_name: str,
    upload_id: str | None,
    status: str,
    **fields: Any,
) -> NomadUploadLog:
    """Record a NOMAD upload attempt in the central audit log."""
    log = NomadUploadLog(
        user_id=user.id,
        user_email=user.email,
        experiment_id=experiment_id,
        experiment_name=experiment_name or "",
        upload_id=upload_id,
        status=status,
        **fields,
    )
    session.add(log)
    session.commit()
    session.refresh(log)
    return log


def update_nomad_upload_log(
    *, session: Session, log: NomadUploadLog, **fields: Any
) -> NomadUploadLog:
    """Update a log row and bump updated_at."""
    for key, value in fields.items():
        setattr(log, key, value)
    log.updated_at = datetime.now(timezone.utc)
    session.add(log)
    session.commit()
    session.refresh(log)
    return log


def get_nomad_upload_log_by_upload_id(
    *, session: Session, upload_id: str
) -> NomadUploadLog | None:
    """Most recent log row for a NOMAD upload id (re-uploads reuse the id)."""
    return session.exec(
        select(NomadUploadLog)
        .where(NomadUploadLog.upload_id == upload_id)
        .order_by(col(NomadUploadLog.created_at).desc())
    ).first()


def purge_expired_stash(session: Session) -> int:
    """
    Delete stashed archives past their retention window and null their path
    (the log row itself is kept as history). Enforces the one-week cap and is
    called opportunistically from the NOMAD endpoints. Returns the count purged.
    """
    now = datetime.now(timezone.utc)
    stale = session.exec(
        select(NomadUploadLog).where(
            col(NomadUploadLog.archive_stash_path).is_not(None),
            col(NomadUploadLog.archive_expires_at).is_not(None),
            col(NomadUploadLog.archive_expires_at) < now,
        )
    ).all()
    purged = 0
    for log in stale:
        purge_stash_file(log.archive_stash_path)
        log.archive_stash_path = None
        session.add(log)
        purged += 1
    if purged:
        session.commit()
    return purged


def stash_expiry() -> datetime:
    """Retention deadline for a newly stashed archive (now + one week cap)."""
    return datetime.now(timezone.utc) + timedelta(
        seconds=settings.NOMAD_STASH_MAX_AGE_S
    )
