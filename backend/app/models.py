import uuid
from datetime import datetime, timezone
from typing import Any, Optional

from pydantic import EmailStr
from sqlalchemy import Column, DateTime
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, Relationship, SQLModel


def get_datetime_utc() -> datetime:
    return datetime.now(timezone.utc)


# Shared properties
class UserBase(SQLModel):
    email: EmailStr = Field(unique=True, index=True, max_length=255)
    is_active: bool = True
    is_superuser: bool = False
    full_name: str | None = Field(default=None, max_length=255)


# Properties to receive via API on creation
class UserCreate(UserBase):
    password: str = Field(min_length=8, max_length=128)


class UserRegister(SQLModel):
    email: EmailStr = Field(max_length=255)
    password: str = Field(min_length=8, max_length=128)
    full_name: str | None = Field(default=None, max_length=255)


# Properties to receive via API on update, all are optional
class UserUpdate(UserBase):
    email: EmailStr | None = Field(default=None, max_length=255)  # type: ignore[assignment]
    password: str | None = Field(default=None, min_length=8, max_length=128)


class UserUpdateMe(SQLModel):
    full_name: str | None = Field(default=None, max_length=255)
    email: EmailStr | None = Field(default=None, max_length=255)


class UpdatePassword(SQLModel):
    current_password: str = Field(min_length=8, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


# Database model, database table inferred from class name
class User(UserBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    hashed_password: str
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),  # type: ignore
    )
    items: list["Item"] = Relationship(back_populates="owner", cascade_delete=True)
    materials: list["Material"] = Relationship(back_populates="owner", cascade_delete=True)
    solutions: list["Solution"] = Relationship(back_populates="owner", cascade_delete=True)
    experiments: list["Experiment"] = Relationship(back_populates="owner", cascade_delete=True)
    results: list["ExperimentResults"] = Relationship(back_populates="owner", cascade_delete=True)
    planes: list["Plane"] = Relationship(back_populates="owner", cascade_delete=True)


# Properties to return via API, id is always required
class UserPublic(UserBase):
    id: uuid.UUID
    created_at: datetime | None = None


class UsersPublic(SQLModel):
    data: list[UserPublic]
    count: int


# Shared properties
class ItemBase(SQLModel):
    title: str = Field(min_length=1, max_length=255)
    description: str | None = Field(default=None, max_length=255)


# Properties to receive on item creation
class ItemCreate(ItemBase):
    pass


# Properties to receive on item update
class ItemUpdate(ItemBase):
    title: str | None = Field(default=None, min_length=1, max_length=255)  # type: ignore[assignment]


# Database model, database table inferred from class name
class Item(ItemBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),  # type: ignore
    )
    owner_id: uuid.UUID = Field(
        foreign_key="user.id", nullable=False, ondelete="CASCADE"
    )
    owner: User | None = Relationship(back_populates="items")


# Properties to return via API, id is always required
class ItemPublic(ItemBase):
    id: uuid.UUID
    owner_id: uuid.UUID
    created_at: datetime | None = None


class ItemsPublic(SQLModel):
    data: list[ItemPublic]
    count: int


# ============================================================================
# Plains GUI Domain Models
# ============================================================================

# Material
class MaterialBase(SQLModel):
    name: str = Field(min_length=1, max_length=255)
    cas_number: str | None = Field(default=None, max_length=255)
    molecular_weight: float | None = None
    density: float | None = None
    density_unit: str = Field(default="g/cm3", max_length=50)
    supplier: str | None = Field(default=None, max_length=255)
    notes: str | None = None


class MaterialCreate(MaterialBase):
    pass


class MaterialUpdate(MaterialBase):
    name: str | None = Field(default=None, min_length=1, max_length=255)


class Material(MaterialBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    owner_id: uuid.UUID = Field(
        foreign_key="user.id", nullable=False, ondelete="CASCADE"
    )
    owner: User | None = Relationship(back_populates="materials")
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),
    )
    frontend_data: dict[str, Any] | None = Field(
        default=None, sa_column=Column(JSONB, nullable=True)
    )
    solution_components: list["SolutionComponent"] = Relationship(
        back_populates="material", cascade_delete=True
    )


class MaterialPublic(MaterialBase):
    id: uuid.UUID
    owner_id: uuid.UUID
    created_at: datetime | None = None


class MaterialsPublic(SQLModel):
    data: list[MaterialPublic]
    count: int


# Solution
class SolutionComponentBase(SQLModel):
    amount: float
    unit: str = Field(max_length=50)
    material_id: uuid.UUID = Field(foreign_key="material.id", nullable=False, ondelete="CASCADE")


class SolutionComponentCreate(SolutionComponentBase):
    pass


class SolutionComponent(SolutionComponentBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    solution_id: uuid.UUID = Field(
        foreign_key="solution.id", nullable=False, ondelete="CASCADE"
    )
    solution: Optional["Solution"] = Relationship(back_populates="components")
    material: Optional[Material] = Relationship(back_populates="solution_components")


class SolutionComponentPublic(SolutionComponentBase):
    id: uuid.UUID


class SolutionBase(SQLModel):
    name: str = Field(min_length=1, max_length=255)
    notes: str | None = None


class SolutionCreate(SolutionBase):
    components: list[SolutionComponentCreate] = []


class SolutionUpdate(SolutionBase):
    name: str | None = Field(default=None, min_length=1, max_length=255)


class Solution(SolutionBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    owner_id: uuid.UUID = Field(
        foreign_key="user.id", nullable=False, ondelete="CASCADE"
    )
    owner: User | None = Relationship(back_populates="solutions")
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),
    )
    frontend_data: dict[str, Any] | None = Field(
        default=None, sa_column=Column(JSONB, nullable=True)
    )
    components: list[SolutionComponent] = Relationship(
        back_populates="solution", cascade_delete=True
    )


class SolutionPublic(SolutionBase):
    id: uuid.UUID
    owner_id: uuid.UUID
    created_at: datetime | None = None
    components: list[SolutionComponentPublic]


class SolutionsPublic(SQLModel):
    data: list[SolutionPublic]
    count: int


# Experiment
class SubstrateBase(SQLModel):
    name: str = Field(min_length=1, max_length=255)
    thickness_nm: float | None = None


class SubstrateCreate(SubstrateBase):
    pass


class Substrate(SubstrateBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    experiment_id: uuid.UUID = Field(
        foreign_key="experiment.id", nullable=False, ondelete="CASCADE"
    )
    experiment: Optional["Experiment"] = Relationship(back_populates="substrates")


class SubstratePublic(SubstrateBase):
    id: uuid.UUID


class ExperimentLayerBase(SQLModel):
    name: str = Field(min_length=1, max_length=255)
    material_id: uuid.UUID | None = Field(default=None, foreign_key="material.id", ondelete="SET NULL")
    solution_id: uuid.UUID | None = Field(default=None, foreign_key="solution.id", ondelete="SET NULL")
    temperature: float | None = None
    temperature_unit: str = Field(default="°C", max_length=50)
    duration: float | None = None
    duration_unit: str = Field(default="min", max_length=50)
    notes: str | None = None


class ExperimentLayerCreate(ExperimentLayerBase):
    pass


class ExperimentLayer(ExperimentLayerBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    experiment_id: uuid.UUID = Field(
        foreign_key="experiment.id", nullable=False, ondelete="CASCADE"
    )
    experiment: Optional["Experiment"] = Relationship(back_populates="layers")


class ExperimentLayerPublic(ExperimentLayerBase):
    id: uuid.UUID


class ExperimentBase(SQLModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    device_type: str | None = Field(default=None, max_length=255)
    active_area_cm2: float | None = None
    notes: str | None = None


class ExperimentCreate(ExperimentBase):
    substrates: list[SubstrateCreate] = []
    layers: list[ExperimentLayerCreate] = []


class ExperimentUpdate(ExperimentBase):
    name: str | None = Field(default=None, min_length=1, max_length=255)


class Experiment(ExperimentBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    owner_id: uuid.UUID = Field(
        foreign_key="user.id", nullable=False, ondelete="CASCADE"
    )
    owner: User | None = Relationship(back_populates="experiments")
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),
    )
    frontend_data: dict[str, Any] | None = Field(
        default=None, sa_column=Column(JSONB, nullable=True)
    )
    substrates: list[Substrate] = Relationship(
        back_populates="experiment", cascade_delete=True
    )
    layers: list[ExperimentLayer] = Relationship(
        back_populates="experiment", cascade_delete=True
    )


class ExperimentPublic(ExperimentBase):
    id: uuid.UUID
    owner_id: uuid.UUID
    created_at: datetime | None = None
    substrates: list[SubstratePublic]
    layers: list[ExperimentLayerPublic]


class ExperimentsPublic(SQLModel):
    data: list[ExperimentPublic]
    count: int


# Results
class MeasurementFileBase(SQLModel):
    filename: str = Field(min_length=1, max_length=255)
    file_type: str = Field(max_length=50)
    file_path: str | None = None
    notes: str | None = None


class MeasurementFileCreate(MeasurementFileBase):
    pass


class MeasurementFile(MeasurementFileBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    results_id: uuid.UUID = Field(
        foreign_key="experimentresults.id", nullable=False, ondelete="CASCADE"
    )
    results: Optional["ExperimentResults"] = Relationship(back_populates="measurement_files")


class MeasurementFilePublic(MeasurementFileBase):
    id: uuid.UUID


class DeviceGroupBase(SQLModel):
    name: str = Field(min_length=1, max_length=255)
    substrate_name: str | None = Field(default=None, max_length=255)


class DeviceGroupCreate(DeviceGroupBase):
    pass


class DeviceGroup(DeviceGroupBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    results_id: uuid.UUID = Field(
        foreign_key="experimentresults.id", nullable=False, ondelete="CASCADE"
    )
    results: Optional["ExperimentResults"] = Relationship(back_populates="device_groups")


class DeviceGroupPublic(DeviceGroupBase):
    id: uuid.UUID


class ExperimentResultsBase(SQLModel):
    notes: str | None = None


class ExperimentResultsCreate(ExperimentResultsBase):
    measurement_files: list[MeasurementFileCreate] = []
    device_groups: list[DeviceGroupCreate] = []


class ExperimentResultsUpdate(ExperimentResultsBase):
    pass


class ExperimentResults(ExperimentResultsBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    experiment_id: uuid.UUID = Field(
        foreign_key="experiment.id", nullable=False, ondelete="CASCADE"
    )
    owner_id: uuid.UUID = Field(
        foreign_key="user.id", nullable=False, ondelete="CASCADE"
    )
    owner: User | None = Relationship(back_populates="results")
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),
    )
    frontend_data: dict[str, Any] | None = Field(
        default=None, sa_column=Column(JSONB, nullable=True)
    )
    measurement_files: list[MeasurementFile] = Relationship(
        back_populates="results", cascade_delete=True
    )
    device_groups: list[DeviceGroup] = Relationship(
        back_populates="results", cascade_delete=True
    )


class ExperimentResultsPublic(ExperimentResultsBase):
    id: uuid.UUID
    experiment_id: uuid.UUID
    owner_id: uuid.UUID
    created_at: datetime | None = None
    measurement_files: list[MeasurementFilePublic]
    device_groups: list[DeviceGroupPublic]


class ExperimentResultsListPublic(SQLModel):
    data: list[ExperimentResultsPublic]
    count: int


# Canvas/Organization
class CanvasElementBase(SQLModel):
    element_type: str = Field(max_length=50)
    x: float = 0
    y: float = 0
    width: float = 100
    height: float = 100
    content: str | None = None
    color: str | None = Field(default=None, max_length=50)


class CanvasElementCreate(CanvasElementBase):
    pass


class CanvasElementUpdate(CanvasElementBase):
    pass


class CanvasElement(CanvasElementBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    plane_id: uuid.UUID = Field(
        foreign_key="plane.id", nullable=False, ondelete="CASCADE"
    )
    frontend_data: dict[str, Any] | None = Field(
        default=None, sa_column=Column(JSONB, nullable=True)
    )
    plane: Optional["Plane"] = Relationship(back_populates="elements")


class CanvasElementPublic(CanvasElementBase):
    id: uuid.UUID


class PlaneBase(SQLModel):
    name: str = Field(min_length=1, max_length=255)


class PlaneCreate(PlaneBase):
    elements: list[CanvasElementCreate] = []


class PlaneUpdate(PlaneBase):
    name: str | None = Field(default=None, min_length=1, max_length=255)


class Plane(PlaneBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    owner_id: uuid.UUID = Field(
        foreign_key="user.id", nullable=False, ondelete="CASCADE"
    )
    owner: User | None = Relationship(back_populates="planes")
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),
    )
    frontend_data: dict[str, Any] | None = Field(
        default=None, sa_column=Column(JSONB, nullable=True)
    )
    elements: list[CanvasElement] = Relationship(
        back_populates="plane", cascade_delete=True
    )


class PlanePublic(PlaneBase):
    id: uuid.UUID
    owner_id: uuid.UUID
    created_at: datetime | None = None
    elements: list[CanvasElementPublic]


class PlanesPublic(SQLModel):
    data: list[PlanePublic]
    count: int


# ============================================================================
# User State (JSON blob for full GUI state per user)
# ============================================================================

class UserState(SQLModel, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    owner_id: uuid.UUID = Field(
        foreign_key="user.id", nullable=False, ondelete="CASCADE", unique=True
    )
    data: dict[str, Any] = Field(default_factory=dict, sa_column=Column(JSONB, nullable=False, server_default="{}"))
    updated_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),
    )


class UserStatePublic(SQLModel):
    data: dict[str, Any]
    updated_at: datetime | None = None


class BulkStateResponse(SQLModel):
    """Full application state for bulk loading."""
    materials: list[MaterialPublic]
    solutions: list[SolutionPublic]
    experiments: list[ExperimentPublic]
    results: list[ExperimentResultsPublic]
    planes: list[PlanePublic]


# Generic message
class Message(SQLModel):
    message: str


# JSON payload containing access token
class Token(SQLModel):
    access_token: str
    token_type: str = "bearer"


# Contents of JWT token
class TokenPayload(SQLModel):
    sub: str | None = None


class NewPassword(SQLModel):
    token: str
    new_password: str = Field(min_length=8, max_length=128)
