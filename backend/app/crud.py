import uuid
from typing import Any

from sqlmodel import Session, select

from app.core.security import get_password_hash, verify_password
from app.models import (
    CanvasElement,
    DeviceGroup,
    Experiment,
    ExperimentCreate,
    ExperimentLayer,
    ExperimentResults,
    ExperimentResultsCreate,
    ExperimentResultsUpdate,
    ExperimentUpdate,
    Item,
    ItemCreate,
    Material,
    MaterialCreate,
    MaterialUpdate,
    MeasurementFile,
    Plane,
    PlaneCreate,
    PlaneUpdate,
    Solution,
    SolutionComponent,
    SolutionCreate,
    SolutionUpdate,
    Substrate,
    User,
    UserCreate,
    UserUpdate,
)


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
# This is an Argon2 hash of a random password, used to ensure constant-time comparison
DUMMY_HASH = "$argon2id$v=19$m=65536,t=3,p=4$MjQyZWE1MzBjYjJlZTI0Yw$YTU4NGM5ZTZmYjE2NzZlZjY0ZWY3ZGRkY2U2OWFjNjk"


def authenticate(*, session: Session, email: str, password: str) -> User | None:
    db_user = get_user_by_email(session=session, email=email)
    if not db_user:
        # Prevent timing attacks by running password verification even when user doesn't exist
        # This ensures the response time is similar whether or not the email exists
        verify_password(password, DUMMY_HASH)
        return None

    # NOMAD OAuth users don't have passwords
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


def create_item(*, session: Session, item_in: ItemCreate, owner_id: uuid.UUID) -> Item:
    db_item = Item.model_validate(item_in, update={"owner_id": owner_id})
    session.add(db_item)
    session.commit()
    session.refresh(db_item)
    return db_item


# ============================================================================
# Material CRUD
# ============================================================================


def create_material(
    *, session: Session, material_in: MaterialCreate, owner_id: uuid.UUID
) -> Material:
    db_material = Material.model_validate(material_in, update={"owner_id": owner_id})
    session.add(db_material)
    session.commit()
    session.refresh(db_material)
    return db_material


def update_material(
    *, session: Session, db_material: Material, material_in: MaterialUpdate
) -> Material:
    material_data = material_in.model_dump(exclude_unset=True)
    db_material.sqlmodel_update(material_data)
    session.add(db_material)
    session.commit()
    session.refresh(db_material)
    return db_material


# ============================================================================
# Solution CRUD
# ============================================================================


def create_solution(
    *, session: Session, solution_in: SolutionCreate, owner_id: uuid.UUID
) -> Solution:
    db_solution = Solution.model_validate(
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
    *, session: Session, db_solution: Solution, solution_in: SolutionUpdate
) -> Solution:
    solution_data = solution_in.model_dump(exclude_unset=True)
    db_solution.sqlmodel_update(solution_data)
    session.add(db_solution)
    session.commit()
    session.refresh(db_solution)
    return db_solution


# ============================================================================
# Experiment CRUD
# ============================================================================


def create_experiment(
    *, session: Session, experiment_in: ExperimentCreate, owner_id: uuid.UUID
) -> Experiment:
    db_experiment = Experiment.model_validate(
        experiment_in.model_dump(exclude={"substrates", "layers"}),
        update={"owner_id": owner_id},
    )
    session.add(db_experiment)
    session.flush()
    for substrate_in in experiment_in.substrates:
        substrate = Substrate.model_validate(
            substrate_in, update={"experiment_id": db_experiment.id}
        )
        session.add(substrate)
    for layer_in in experiment_in.layers:
        layer = ExperimentLayer.model_validate(
            layer_in, update={"experiment_id": db_experiment.id}
        )
        session.add(layer)
    session.commit()
    session.refresh(db_experiment)
    return db_experiment


def update_experiment(
    *, session: Session, db_experiment: Experiment, experiment_in: ExperimentUpdate
) -> Experiment:
    experiment_data = experiment_in.model_dump(exclude_unset=True)
    db_experiment.sqlmodel_update(experiment_data)
    session.add(db_experiment)
    session.commit()
    session.refresh(db_experiment)
    return db_experiment


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
    results_data = results_in.model_dump(exclude_unset=True)
    db_results.sqlmodel_update(results_data)
    session.add(db_results)
    session.commit()
    session.refresh(db_results)
    return db_results


# ============================================================================
# Plane CRUD
# ============================================================================


def create_plane(
    *, session: Session, plane_in: PlaneCreate, owner_id: uuid.UUID
) -> Plane:
    db_plane = Plane.model_validate(plane_in, update={"owner_id": owner_id})
    # Create elements
    for element_in in plane_in.elements:
        element = CanvasElement.model_validate(
            element_in, update={"plane_id": db_plane.id}
        )
        db_plane.elements.append(element)
    session.add(db_plane)
    session.commit()
    session.refresh(db_plane)
    return db_plane


def update_plane(*, session: Session, db_plane: Plane, plane_in: PlaneUpdate) -> Plane:
    plane_data = plane_in.model_dump(exclude_unset=True)
    db_plane.sqlmodel_update(plane_data)
    session.add(db_plane)
    session.commit()
    session.refresh(db_plane)
    return db_plane
