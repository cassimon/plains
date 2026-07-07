import uuid
from datetime import date as date_type
from datetime import datetime, timezone
from typing import Any, Optional

from pydantic import ConfigDict, EmailStr
from sqlalchemy import Column, DateTime, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlmodel import Field, Relationship, SQLModel


def get_datetime_utc() -> datetime:
    return datetime.now(timezone.utc)


def _jsonb_field() -> Any:
    return Field(default=None, sa_column=Column(JSONB, nullable=True))


class ClientIdCreate(SQLModel):
    """Mixin for *Create schemas that lets the frontend supply the
    primary-key UUID, so client-generated IDs and their cross-references
    round-trip through create endpoints. Falls back to a fresh UUID when the
    client omits it (preserving the previous server-generated behaviour)."""

    id: uuid.UUID = Field(default_factory=uuid.uuid4)


# ============================================================================
# User
# ============================================================================
class UserBase(SQLModel):
    email: EmailStr = Field(unique=True, index=True, max_length=255)
    is_active: bool = True
    is_superuser: bool = False
    full_name: str | None = Field(default=None, max_length=255)


class UserCreate(UserBase):
    password: str = Field(min_length=8, max_length=128)


class UserRegister(SQLModel):
    email: EmailStr = Field(max_length=255)
    password: str = Field(min_length=8, max_length=128)
    full_name: str | None = Field(default=None, max_length=255)


class UserUpdate(UserBase):
    email: EmailStr | None = Field(default=None, max_length=255)  # type: ignore[assignment]
    password: str | None = Field(default=None, min_length=8, max_length=128)


class UserUpdateMe(SQLModel):
    full_name: str | None = Field(default=None, max_length=255)
    email: EmailStr | None = Field(default=None, max_length=255)


class UpdatePassword(SQLModel):
    current_password: str = Field(min_length=8, max_length=128)
    new_password: str = Field(min_length=8, max_length=128)


class User(UserBase, table=True):
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    hashed_password: str | None = Field(default=None)
    nomad_sub: str | None = Field(default=None, unique=True, index=True)
    nomad_name: str | None = Field(default=None)
    nomad_email: str | None = Field(default=None)
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),  # type: ignore
    )
    materials: list["LabMaterial"] = Relationship(
        back_populates="owner", cascade_delete=True
    )
    solutions: list["LabSolution"] = Relationship(
        back_populates="owner", cascade_delete=True
    )
    processes: list["Process"] = Relationship(
        back_populates="owner", cascade_delete=True
    )
    experiments: list["Experiment"] = Relationship(
        back_populates="owner", cascade_delete=True
    )
    results: list["ExperimentResults"] = Relationship(
        back_populates="owner", cascade_delete=True
    )
    analyses: list["Analysis"] = Relationship(
        back_populates="owner", cascade_delete=True
    )
    planes: list["Plane"] = Relationship(back_populates="owner", cascade_delete=True)
    shared_planes: list["PlaneShare"] = Relationship(cascade_delete=True)


class UserPublic(UserBase):
    id: uuid.UUID
    created_at: datetime | None = None


class UsersPublic(SQLModel):
    data: list[UserPublic]
    count: int


# ============================================================================
# Plane + Canvas elements
# ============================================================================
class PlaneBase(SQLModel):
    name: str = Field(min_length=1, max_length=255)


class PlaneCreate(ClientIdCreate, PlaneBase):
    pass


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
    frontend_data: dict[str, Any] | None = _jsonb_field()
    sticky_notes: list["StickyNote"] = Relationship(
        back_populates="plane", cascade_delete=True
    )
    text_fields: list["TextField"] = Relationship(
        back_populates="plane", cascade_delete=True
    )
    collections: list["DataCollection"] = Relationship(
        back_populates="plane", cascade_delete=True
    )
    shared_with: list["PlaneShare"] = Relationship(
        back_populates="plane",
        sa_relationship_kwargs={"foreign_keys": "[PlaneShare.plane_id]"},
        cascade_delete=True,
    )


class PlaneShare(SQLModel, table=True):
    __tablename__ = "planeshare"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    plane_id: uuid.UUID = Field(
        foreign_key="plane.id", nullable=False, ondelete="CASCADE"
    )
    user_id: uuid.UUID = Field(
        foreign_key="user.id", nullable=False, ondelete="CASCADE"
    )
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),
    )
    plane: Plane | None = Relationship(
        back_populates="shared_with",
        sa_relationship_kwargs={"foreign_keys": "[PlaneShare.plane_id]"},
    )
    user: User | None = Relationship(
        sa_relationship_kwargs={"overlaps": "shared_planes"}
    )


class PlaneShareCreate(SQLModel):
    user_id: uuid.UUID


class PlaneSharePublic(SQLModel):
    user: UserPublic


# --- Shared canvas note fields (StickyNote and TextField are identical) ---
class CanvasNoteBase(SQLModel):
    i: int = 0
    j: int = 0
    di: int = 1
    dj: int = 1
    content: str | None = None
    color: str | None = Field(default=None, max_length=50)
    fmt_bold: bool | None = None
    fmt_italic: bool | None = None
    fmt_underline: bool | None = None
    fmt_font_size: int | None = None
    hyperlink: str | None = None


# --- StickyNote ---
class StickyNoteBase(CanvasNoteBase):
    pass


class StickyNoteCreate(ClientIdCreate, CanvasNoteBase):
    pass


class StickyNoteUpdate(CanvasNoteBase):
    pass


class StickyNote(StickyNoteBase, table=True):
    __tablename__ = "sticky_note"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    plane_id: uuid.UUID = Field(
        foreign_key="plane.id", nullable=False, ondelete="CASCADE"
    )
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc, sa_type=DateTime(timezone=True)
    )
    plane: Plane | None = Relationship(back_populates="sticky_notes")


class StickyNotePublic(StickyNoteBase):
    id: uuid.UUID
    plane_id: uuid.UUID


# --- TextField ---
class TextFieldBase(CanvasNoteBase):
    pass


class TextFieldCreate(ClientIdCreate, CanvasNoteBase):
    pass


class TextFieldUpdate(CanvasNoteBase):
    pass


class TextField(TextFieldBase, table=True):
    __tablename__ = "text_field"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    plane_id: uuid.UUID = Field(
        foreign_key="plane.id", nullable=False, ondelete="CASCADE"
    )
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc, sa_type=DateTime(timezone=True)
    )
    plane: Plane | None = Relationship(back_populates="text_fields")


class TextFieldPublic(TextFieldBase):
    id: uuid.UUID
    plane_id: uuid.UUID


# --- DataCollection ---
class DataCollectionBase(SQLModel):
    i: int = 0
    j: int = 0
    name: str = Field(min_length=1, max_length=255)
    color: str | None = Field(default=None, max_length=50)


class DataCollectionCreate(ClientIdCreate, DataCollectionBase):
    pass


class DataCollectionUpdate(DataCollectionBase):
    name: str | None = Field(default=None, min_length=1, max_length=255)


class DataCollection(DataCollectionBase, table=True):
    __tablename__ = "data_collection"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    plane_id: uuid.UUID = Field(
        foreign_key="plane.id", nullable=False, ondelete="CASCADE"
    )
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc, sa_type=DateTime(timezone=True)
    )
    plane: Plane | None = Relationship(back_populates="collections")


class DataCollectionPublic(DataCollectionBase):
    id: uuid.UUID
    plane_id: uuid.UUID


class PlanePublic(PlaneBase):
    id: uuid.UUID
    owner_id: uuid.UUID
    owner: UserPublic
    created_at: datetime | None = None
    sticky_notes: list[StickyNotePublic] = []
    text_fields: list[TextFieldPublic] = []
    collections: list[DataCollectionPublic] = []
    shared_with: list[UserPublic] = []


class PlanesPublic(SQLModel):
    data: list[PlanePublic]
    count: int


# ============================================================================
# LabMaterial
# ============================================================================
class LabMaterialBase(SQLModel):
    name: str = Field(min_length=1, max_length=255)
    category: str | None = Field(default=None, max_length=50)
    type: str | None = Field(default=None, max_length=100)
    cas_number: str | None = Field(default=None, max_length=255)
    pubchem_cid: str | None = Field(default=None, max_length=255)
    molecular_weight: float | None = None
    density: float | None = None
    density_unit: str = Field(default="g/cm3", max_length=50)
    supplier: str | None = Field(default=None, max_length=255)
    supplier_number: str | None = Field(default=None, max_length=255)
    inventory_label: str | None = Field(default=None, max_length=255)
    purity: str | None = Field(default=None, max_length=255)
    state_at_rt: str | None = Field(default=None, max_length=50)
    substrate_rigidity: str | None = Field(default=None, max_length=50)
    height_mm: str | None = Field(default=None, max_length=50)
    notes: str | None = None
    plane_id: uuid.UUID | None = Field(
        default=None, foreign_key="plane.id", ondelete="SET NULL"
    )


class LabMaterialCreate(ClientIdCreate, LabMaterialBase):
    pass


class LabMaterialUpdate(LabMaterialBase):
    name: str | None = Field(default=None, min_length=1, max_length=255)


class LabMaterial(LabMaterialBase, table=True):
    __tablename__ = "lab_material"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    owner_id: uuid.UUID = Field(
        foreign_key="user.id", nullable=False, ondelete="CASCADE"
    )
    owner: User | None = Relationship(back_populates="materials")
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),
    )
    frontend_data: dict[str, Any] | None = _jsonb_field()


class LabMaterialPublic(LabMaterialBase):
    id: uuid.UUID
    owner_id: uuid.UUID
    created_at: datetime | None = None


class LabMaterialsPublic(SQLModel):
    data: list[LabMaterialPublic]
    count: int


# ============================================================================
# LabSolution
# ============================================================================
class SolutionComponentBase(SQLModel):
    amount: float
    unit: str = Field(max_length=50)
    material_id: uuid.UUID | None = Field(
        default=None, foreign_key="lab_material.id", ondelete="SET NULL"
    )
    solution_ref_id: uuid.UUID | None = Field(
        default=None, foreign_key="lab_solution.id", ondelete="SET NULL"
    )


class SolutionComponentCreate(ClientIdCreate, SolutionComponentBase):
    pass


class SolutionComponent(SolutionComponentBase, table=True):
    __tablename__ = "solutioncomponent"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    solution_id: uuid.UUID = Field(
        foreign_key="lab_solution.id", nullable=False, ondelete="CASCADE"
    )
    solution: Optional["LabSolution"] = Relationship(
        back_populates="components",
        sa_relationship_kwargs={"foreign_keys": "[SolutionComponent.solution_id]"},
    )


class SolutionComponentPublic(SolutionComponentBase):
    id: uuid.UUID


class LabSolutionBase(SQLModel):
    name: str = Field(min_length=1, max_length=255)
    type: str | None = Field(default=None, max_length=100)
    handling: str | None = Field(default=None, max_length=255)
    storage: str | None = Field(default=None, max_length=255)
    creation_time: datetime | None = Field(
        default=None, sa_type=DateTime(timezone=True)
    )
    notes: str | None = None
    plane_id: uuid.UUID | None = Field(
        default=None, foreign_key="plane.id", ondelete="SET NULL"
    )


class LabSolutionCreate(ClientIdCreate, LabSolutionBase):
    components: list[SolutionComponentCreate] = []


class LabSolutionUpdate(LabSolutionBase):
    name: str | None = Field(default=None, min_length=1, max_length=255)


class LabSolution(LabSolutionBase, table=True):
    __tablename__ = "lab_solution"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    owner_id: uuid.UUID = Field(
        foreign_key="user.id", nullable=False, ondelete="CASCADE"
    )
    owner: User | None = Relationship(back_populates="solutions")
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),
    )
    frontend_data: dict[str, Any] | None = _jsonb_field()
    components: list[SolutionComponent] = Relationship(
        back_populates="solution",
        cascade_delete=True,
        sa_relationship_kwargs={"foreign_keys": "[SolutionComponent.solution_id]"},
    )


class LabSolutionPublic(LabSolutionBase):
    id: uuid.UUID
    owner_id: uuid.UUID
    created_at: datetime | None = None
    components: list[SolutionComponentPublic] = []


class LabSolutionsPublic(SQLModel):
    data: list[LabSolutionPublic]
    count: int


# ============================================================================
# Process
# ============================================================================
class ProcessBase(SQLModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    skip_chemistry: bool = False
    plane_id: uuid.UUID | None = Field(
        default=None, foreign_key="plane.id", ondelete="SET NULL"
    )
    collection_id: uuid.UUID | None = Field(
        default=None, foreign_key="data_collection.id", ondelete="SET NULL"
    )


class ProcessCreate(ClientIdCreate, ProcessBase):
    pass


class ProcessUpdate(ProcessBase):
    name: str | None = Field(default=None, min_length=1, max_length=255)


class Process(ProcessBase, table=True):
    __tablename__ = "process"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    owner_id: uuid.UUID = Field(
        foreign_key="user.id", nullable=False, ondelete="CASCADE"
    )
    owner: User | None = Relationship(back_populates="processes")
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc, sa_type=DateTime(timezone=True)
    )
    frontend_data: dict[str, Any] | None = _jsonb_field()
    inline_substrates: list["ProcessInlineSubstrate"] = Relationship(
        back_populates="process", cascade_delete=True
    )
    substrate_dimensions: list["ProcessSubstrateDimension"] = Relationship(
        back_populates="process", cascade_delete=True
    )
    recipes: list["ProcessSolutionRecipe"] = Relationship(
        back_populates="process", cascade_delete=True
    )
    steps: list["ProcessStep"] = Relationship(
        back_populates="process", cascade_delete=True
    )
    stacks: list["ProcessGeneratedStack"] = Relationship(
        back_populates="process", cascade_delete=True
    )


class ProcessInlineSubstrateBase(SQLModel):
    name: str = Field(max_length=255)
    rigidity: str | None = Field(default=None, max_length=50)
    length_cm: str | None = Field(default=None, max_length=50)
    width_cm: str | None = Field(default=None, max_length=50)
    height_mm: str | None = Field(default=None, max_length=50)
    surface_roughness_rms_nm: str | None = Field(default=None, max_length=50)


class ProcessInlineSubstrateCreate(ClientIdCreate, ProcessInlineSubstrateBase):
    pass


class ProcessInlineSubstrate(ProcessInlineSubstrateBase, table=True):
    __tablename__ = "process_inline_substrate"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    process_id: uuid.UUID = Field(
        foreign_key="process.id", nullable=False, ondelete="CASCADE"
    )
    process: Process | None = Relationship(back_populates="inline_substrates")


class ProcessInlineSubstratePublic(ProcessInlineSubstrateBase):
    id: uuid.UUID


class ProcessSubstrateDimensionBase(SQLModel):
    material_id: uuid.UUID = Field(foreign_key="lab_material.id", ondelete="CASCADE")
    length_cm: str | None = Field(default=None, max_length=50)
    width_cm: str | None = Field(default=None, max_length=50)
    height_mm: str | None = Field(default=None, max_length=50)
    surface_roughness_rms_nm: str | None = Field(default=None, max_length=50)


class ProcessSubstrateDimensionCreate(ClientIdCreate, ProcessSubstrateDimensionBase):
    pass


class ProcessSubstrateDimension(ProcessSubstrateDimensionBase, table=True):
    __tablename__ = "process_substrate_dimension"
    __table_args__ = (UniqueConstraint("process_id", "material_id"),)
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    process_id: uuid.UUID = Field(
        foreign_key="process.id", nullable=False, ondelete="CASCADE"
    )
    process: Process | None = Relationship(back_populates="substrate_dimensions")


class ProcessSubstrateDimensionPublic(ProcessSubstrateDimensionBase):
    id: uuid.UUID


# --- Recipes ---
class ProcessSolutionRecipeBase(SQLModel):
    name: str = Field(max_length=255)
    type: str | None = Field(default=None, max_length=100)
    is_commercial: bool = False
    commercial_name: str | None = Field(default=None, max_length=255)
    supplier_number: str | None = Field(default=None, max_length=255)
    handling_preparation: str | None = None
    handling_before_use: str | None = None
    total_solvent_volume_ml: str = Field(default="", max_length=50)


class RecipeSolventBase(SQLModel):
    name: str = Field(max_length=255)
    pubchem_cid: str | None = Field(default=None, max_length=255)
    # For mixtures (e.g. PEDOT:PSS): PubChem CIDs of the individual components
    component_cids: list[str] | None = Field(
        default=None, sa_column=Column(JSONB, nullable=True)
    )
    molar_mass: float | None = None
    density: float | None = None
    volume_ratio: float = 0
    color: str = Field(default="", max_length=50)


class RecipeSolventCreate(ClientIdCreate, RecipeSolventBase):
    pass


class RecipeSolvent(RecipeSolventBase, table=True):
    __tablename__ = "recipe_solvent"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    recipe_id: uuid.UUID = Field(
        foreign_key="process_solution_recipe.id", nullable=False, ondelete="CASCADE"
    )
    recipe: Optional["ProcessSolutionRecipe"] = Relationship(back_populates="solvents")


class RecipeSolventPublic(RecipeSolventBase):
    id: uuid.UUID


class RecipeSoluteBase(SQLModel):
    name: str = Field(max_length=255)
    pubchem_cid: str | None = Field(default=None, max_length=255)
    # For mixtures (e.g. PEDOT:PSS): PubChem CIDs of the individual components
    component_cids: list[str] | None = Field(
        default=None, sa_column=Column(JSONB, nullable=True)
    )
    molar_mass: float | None = None
    density: float | None = None
    amount: str = Field(default="", max_length=50)
    unit: str = Field(default="mg", max_length=50)
    color: str = Field(default="", max_length=50)


class RecipeSoluteCreate(ClientIdCreate, RecipeSoluteBase):
    pass


class RecipeSolute(RecipeSoluteBase, table=True):
    __tablename__ = "recipe_solute"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    recipe_id: uuid.UUID = Field(
        foreign_key="process_solution_recipe.id", nullable=False, ondelete="CASCADE"
    )
    recipe: Optional["ProcessSolutionRecipe"] = Relationship(back_populates="solutes")


class RecipeSolutePublic(RecipeSoluteBase):
    id: uuid.UUID


class RecipeAddedSolutionBase(SQLModel):
    referenced_recipe_id: uuid.UUID | None = Field(
        default=None, foreign_key="process_solution_recipe.id", ondelete="SET NULL"
    )
    volume_ml: str = Field(default="", max_length=50)


class RecipeAddedSolutionCreate(ClientIdCreate, RecipeAddedSolutionBase):
    pass


class RecipeAddedSolution(RecipeAddedSolutionBase, table=True):
    __tablename__ = "recipe_added_solution"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    recipe_id: uuid.UUID = Field(
        foreign_key="process_solution_recipe.id", nullable=False, ondelete="CASCADE"
    )
    recipe: Optional["ProcessSolutionRecipe"] = Relationship(
        back_populates="added_solutions",
        sa_relationship_kwargs={"foreign_keys": "[RecipeAddedSolution.recipe_id]"},
    )


class RecipeAddedSolutionPublic(RecipeAddedSolutionBase):
    id: uuid.UUID


class ProcessSolutionRecipeCreate(ClientIdCreate, ProcessSolutionRecipeBase):
    solvents: list[RecipeSolventCreate] = []
    solutes: list[RecipeSoluteCreate] = []
    added_solutions: list[RecipeAddedSolutionCreate] = []


class ProcessSolutionRecipe(ProcessSolutionRecipeBase, table=True):
    __tablename__ = "process_solution_recipe"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    process_id: uuid.UUID = Field(
        foreign_key="process.id", nullable=False, ondelete="CASCADE"
    )
    process: Process | None = Relationship(back_populates="recipes")
    solvents: list[RecipeSolvent] = Relationship(
        back_populates="recipe", cascade_delete=True
    )
    solutes: list[RecipeSolute] = Relationship(
        back_populates="recipe", cascade_delete=True
    )
    added_solutions: list[RecipeAddedSolution] = Relationship(
        back_populates="recipe",
        cascade_delete=True,
        sa_relationship_kwargs={"foreign_keys": "[RecipeAddedSolution.recipe_id]"},
    )


class ProcessSolutionRecipePublic(ProcessSolutionRecipeBase):
    id: uuid.UUID
    solvents: list[RecipeSolventPublic] = []
    solutes: list[RecipeSolutePublic] = []
    added_solutions: list[RecipeAddedSolutionPublic] = []


# --- ProcessStep ---
class ProcessStepBase(SQLModel):
    stage_index: int = 0
    step_index: int = 0
    name: str = Field(max_length=255)
    step_category: str = Field(max_length=50)
    color: str = Field(default="", max_length=50)
    material_id: uuid.UUID | None = Field(
        default=None, foreign_key="lab_material.id", ondelete="SET NULL"
    )
    solution_id: uuid.UUID | None = Field(
        default=None, foreign_key="lab_solution.id", ondelete="SET NULL"
    )
    chem_recipe_id: uuid.UUID | None = Field(
        default=None, foreign_key="process_solution_recipe.id", ondelete="SET NULL"
    )
    inline_material: dict[str, Any] | None = _jsonb_field()
    deposition_method_value: str | None = None
    deposition_method_mode: str | None = None
    deposition_start_time_value: str | None = None
    deposition_start_time_mode: str | None = None
    substrate_temp_value: str | None = None
    substrate_temp_mode: str | None = None
    deposition_atmosphere_value: str | None = None
    deposition_atmosphere_mode: str | None = None
    deposition_parameters_value: str | None = None
    deposition_parameters_mode: str | None = None
    solution_volume_value: str | None = None
    solution_volume_mode: str | None = None
    drying_method_value: str | None = None
    drying_method_mode: str | None = None
    annealing_start_time_value: str | None = None
    annealing_start_time_mode: str | None = None
    annealing_time_value: str | None = None
    annealing_time_mode: str | None = None
    annealing_temp_value: str | None = None
    annealing_temp_mode: str | None = None
    annealing_atmosphere_value: str | None = None
    annealing_atmosphere_mode: str | None = None
    notes: str | None = None


class ProcessStepCreate(ClientIdCreate, ProcessStepBase):
    pass


class ProcessStep(ProcessStepBase, table=True):
    __tablename__ = "process_step"
    __table_args__ = (UniqueConstraint("process_id", "stage_index", "step_index"),)
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    process_id: uuid.UUID = Field(
        foreign_key="process.id", nullable=False, ondelete="CASCADE"
    )
    process: Process | None = Relationship(back_populates="steps")


class ProcessStepPublic(ProcessStepBase):
    id: uuid.UUID


# --- Generated stacks ---
class ProcessGeneratedStackBase(SQLModel):
    combination: int = 0
    architecture: str | None = Field(default=None, max_length=255)
    build_device: str | None = Field(default=None, max_length=10)
    pixel_area_cm2: str | None = Field(default=None, max_length=50)
    number_of_pixels: str | None = Field(default=None, max_length=50)
    is_deleted: bool = False


class ProcessGeneratedStackLayerBase(SQLModel):
    layer_index: int = 0
    # Reference to the ProcessStep (or substrate) this layer was generated
    # from. Stack combinations share source steps, so this CANNOT be the row
    # PK — the GUI keys layers by step for metadata generation and edits.
    step_ref: str | None = Field(default=None, max_length=64)
    name: str = Field(default="", max_length=255)
    color: str = Field(default="", max_length=50)
    is_substrate: bool = False
    layer_type: str = Field(default="", max_length=100)
    thickness_nm: str = Field(default="", max_length=50)
    bandgap_ev: str = Field(default="", max_length=50)
    perovskite_a: str = Field(default="", max_length=255)
    perovskite_b: str = Field(default="", max_length=255)
    perovskite_x: str = Field(default="", max_length=255)
    # Source material/solution type (lowercased); drives molecule/polymer-only fields.
    material_type: str = Field(default="", max_length=100)
    # HOMO / LUMO energy levels (eV) — optional, only for molecule/polymer layers.
    homo_ev: str = Field(default="", max_length=50)
    lumo_ev: str = Field(default="", max_length=50)


class ProcessGeneratedStackLayerCreate(ClientIdCreate, ProcessGeneratedStackLayerBase):
    pass


class ProcessGeneratedStackLayer(ProcessGeneratedStackLayerBase, table=True):
    __tablename__ = "process_generated_stack_layer"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    stack_id: uuid.UUID = Field(
        foreign_key="process_generated_stack.id", nullable=False, ondelete="CASCADE"
    )
    stack: Optional["ProcessGeneratedStack"] = Relationship(back_populates="layers")


class ProcessGeneratedStackLayerPublic(ProcessGeneratedStackLayerBase):
    id: uuid.UUID


class ProcessGeneratedStackCreate(ClientIdCreate, ProcessGeneratedStackBase):
    layers: list[ProcessGeneratedStackLayerCreate] = []


class ProcessGeneratedStack(ProcessGeneratedStackBase, table=True):
    __tablename__ = "process_generated_stack"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    process_id: uuid.UUID = Field(
        foreign_key="process.id", nullable=False, ondelete="CASCADE"
    )
    process: Process | None = Relationship(back_populates="stacks")
    layers: list[ProcessGeneratedStackLayer] = Relationship(
        back_populates="stack", cascade_delete=True
    )


class ProcessGeneratedStackPublic(ProcessGeneratedStackBase):
    id: uuid.UUID
    layers: list[ProcessGeneratedStackLayerPublic] = []


class ProcessPublic(ProcessBase):
    id: uuid.UUID
    owner_id: uuid.UUID
    created_at: datetime | None = None
    inline_substrates: list[ProcessInlineSubstratePublic] = []
    substrate_dimensions: list[ProcessSubstrateDimensionPublic] = []
    recipes: list[ProcessSolutionRecipePublic] = []
    steps: list[ProcessStepPublic] = []
    stacks: list[ProcessGeneratedStackPublic] = []


class ProcessesPublic(SQLModel):
    data: list[ProcessPublic]
    count: int


# ============================================================================
# Experiment
# ============================================================================
class LabSubstrateBase(SQLModel):
    name: str = Field(min_length=1, max_length=255)
    # Opaque reference chosen in the GUI: the frontend fills this with a
    # process inline-substrate id (not a lab_material id), so it must not
    # carry a foreign key — see init_db() which drops the legacy constraint.
    substrate_material_id: uuid.UUID | None = Field(default=None)
    notes: str | None = None
    outcome_status: str | None = Field(default=None, max_length=50)
    outcome_stopped_at_step: str | None = Field(default=None, max_length=50)
    outcome_discard_reason: str | None = None
    parameter_values: dict[str, Any] | None = _jsonb_field()


class LabSubstrateCreate(ClientIdCreate, LabSubstrateBase):
    pass


class LabSubstrate(LabSubstrateBase, table=True):
    __tablename__ = "lab_substrate"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    experiment_id: uuid.UUID = Field(
        foreign_key="experiment.id", nullable=False, ondelete="CASCADE"
    )
    experiment: Optional["Experiment"] = Relationship(back_populates="substrates")


class LabSubstratePublic(LabSubstrateBase):
    id: uuid.UUID


class ExperimentMaterialBase(SQLModel):
    material_id: uuid.UUID = Field(foreign_key="lab_material.id", ondelete="CASCADE")
    role: str | None = Field(default=None, max_length=100)


class ExperimentMaterial(ExperimentMaterialBase, table=True):
    __tablename__ = "experiment_material"
    __table_args__ = (UniqueConstraint("experiment_id", "material_id"),)
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    experiment_id: uuid.UUID = Field(
        foreign_key="experiment.id", nullable=False, ondelete="CASCADE"
    )
    experiment: Optional["Experiment"] = Relationship(back_populates="material_refs")


class ExperimentMaterialPublic(ExperimentMaterialBase):
    id: uuid.UUID


class ExperimentSolutionBase(SQLModel):
    solution_id: uuid.UUID = Field(foreign_key="lab_solution.id", ondelete="CASCADE")
    role: str | None = Field(default=None, max_length=100)


class ExperimentSolution(ExperimentSolutionBase, table=True):
    __tablename__ = "experiment_solution"
    __table_args__ = (UniqueConstraint("experiment_id", "solution_id"),)
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    experiment_id: uuid.UUID = Field(
        foreign_key="experiment.id", nullable=False, ondelete="CASCADE"
    )
    experiment: Optional["Experiment"] = Relationship(back_populates="solution_refs")


class ExperimentSolutionPublic(ExperimentSolutionBase):
    id: uuid.UUID


class ExperimentBase(SQLModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    notes: str | None = None
    plane_id: uuid.UUID | None = Field(
        default=None, foreign_key="plane.id", ondelete="SET NULL"
    )
    collection_id: uuid.UUID | None = Field(
        default=None, foreign_key="data_collection.id", ondelete="SET NULL"
    )
    process_id: uuid.UUID | None = Field(
        default=None, foreign_key="process.id", ondelete="SET NULL"
    )
    architecture: str | None = Field(default=None, max_length=100)
    substrate_material: str | None = Field(default=None, max_length=255)
    substrate_width: float | None = None
    substrate_length: float | None = None
    num_substrates: int | None = None
    devices_per_substrate: int | None = None
    device_area: float | None = None
    device_type: str | None = Field(default=None, max_length=50)
    device_layout_image: str | None = None
    date: date_type | None = None
    end_date: date_type | None = None
    has_results: bool = False
    has_completed_upload: bool = False
    chemicals_prep: dict[str, Any] | None = _jsonb_field()
    processing_times: dict[str, Any] | None = _jsonb_field()


class ExperimentCreate(ClientIdCreate, ExperimentBase):
    substrates: list[LabSubstrateCreate] = []


class ExperimentUpdate(ExperimentBase):
    name: str | None = Field(default=None, min_length=1, max_length=255)


class Experiment(ExperimentBase, table=True):
    __tablename__ = "experiment"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    owner_id: uuid.UUID = Field(
        foreign_key="user.id", nullable=False, ondelete="CASCADE"
    )
    owner: User | None = Relationship(back_populates="experiments")
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),
    )
    frontend_data: dict[str, Any] | None = _jsonb_field()
    substrates: list[LabSubstrate] = Relationship(
        back_populates="experiment", cascade_delete=True
    )
    material_refs: list[ExperimentMaterial] = Relationship(
        back_populates="experiment", cascade_delete=True
    )
    solution_refs: list[ExperimentSolution] = Relationship(
        back_populates="experiment", cascade_delete=True
    )


class ExperimentPublic(ExperimentBase):
    id: uuid.UUID
    owner_id: uuid.UUID
    created_at: datetime | None = None
    substrates: list[LabSubstratePublic] = []
    material_refs: list[ExperimentMaterialPublic] = []
    solution_refs: list[ExperimentSolutionPublic] = []


class ExperimentsPublic(SQLModel):
    data: list[ExperimentPublic]
    count: int


class EntityRefList(SQLModel):
    ids: list[uuid.UUID] = []


# ============================================================================
# ExperimentResults
# ============================================================================
class MeasurementFileBase(SQLModel):
    filename: str = Field(min_length=1, max_length=255)
    file_type: str = Field(max_length=50)
    file_path: str | None = None
    notes: str | None = None
    device_name: str | None = Field(default=None, max_length=255)
    cell: str | None = Field(default=None, max_length=255)
    pixel_label: str | None = Field(default=None, max_length=255)
    value: float | None = None
    voc: float | None = None
    jsc: float | None = None
    ff: float | None = None
    measurement_date: str | None = Field(default=None, max_length=100)
    measurement_user: str | None = Field(default=None, max_length=255)


class MeasurementFileCreate(ClientIdCreate, MeasurementFileBase):
    pass


class MeasurementFile(MeasurementFileBase, table=True):
    __tablename__ = "measurementfile"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    results_id: uuid.UUID = Field(
        foreign_key="experimentresults.id", nullable=False, ondelete="CASCADE"
    )
    results: Optional["ExperimentResults"] = Relationship(
        back_populates="measurement_files"
    )


class MeasurementFilePublic(MeasurementFileBase):
    id: uuid.UUID


class DeviceGroupBase(SQLModel):
    name: str = Field(min_length=1, max_length=255)
    substrate_name: str | None = Field(default=None, max_length=255)
    assigned_substrate_id: uuid.UUID | None = None
    suggested_substrate_id: uuid.UUID | None = None
    match_score: float | None = None


class DeviceGroupCreate(ClientIdCreate, DeviceGroupBase):
    pass


class DeviceGroup(DeviceGroupBase, table=True):
    __tablename__ = "devicegroup"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    results_id: uuid.UUID = Field(
        foreign_key="experimentresults.id", nullable=False, ondelete="CASCADE"
    )
    results: Optional["ExperimentResults"] = Relationship(
        back_populates="device_groups"
    )


class DeviceGroupPublic(DeviceGroupBase):
    id: uuid.UUID


class ExperimentResultsBase(SQLModel):
    notes: str | None = None
    plane_id: uuid.UUID | None = Field(
        default=None, foreign_key="plane.id", ondelete="SET NULL"
    )
    collection_id: uuid.UUID | None = Field(
        default=None, foreign_key="data_collection.id", ondelete="SET NULL"
    )
    grouping_strategy: str | None = Field(default=None, max_length=50)
    matching_strategy: str | None = Field(default=None, max_length=50)
    nomad_upload_id: str | None = Field(default=None, max_length=255)
    nomad_upload_time: datetime | None = Field(
        default=None, sa_type=DateTime(timezone=True)
    )
    nomad_upload_status: str | None = Field(default=None, max_length=50)
    nomad_entries: int | None = None


class ExperimentResultsCreate(ClientIdCreate, ExperimentResultsBase):
    measurement_files: list[MeasurementFileCreate] = []
    device_groups: list[DeviceGroupCreate] = []


class ExperimentResultsUpdate(ExperimentResultsBase):
    pass


class ExperimentResults(ExperimentResultsBase, table=True):
    __tablename__ = "experimentresults"
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
    frontend_data: dict[str, Any] | None = _jsonb_field()
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
    measurement_files: list[MeasurementFilePublic] = []
    device_groups: list[DeviceGroupPublic] = []


class ExperimentResultsListPublic(SQLModel):
    data: list[ExperimentResultsPublic]
    count: int


# ============================================================================
# NOMAD Upload Log
# ============================================================================
# Central audit log of every NOMAD upload attempt. Deliberately NOT linked to
# User/Experiment via cascade relationships: the log must survive deletion of
# either, so the owning identifiers are denormalized (user_email is authoritative).
# Failed / not-yet-succeeded uploads keep their file archive stashed on disk
# (archive_stash_path) until they succeed or the one-week TTL sweeps them.
class NomadUploadLogBase(SQLModel):
    user_id: uuid.UUID | None = Field(default=None, index=True)
    user_email: str = Field(max_length=255, index=True)
    experiment_id: uuid.UUID | None = Field(default=None, index=True)
    experiment_name: str = Field(default="", max_length=255)
    upload_id: str | None = Field(default=None, max_length=255, index=True)
    # PENDING | SUCCESS | FAILED | NOT_FOUND | ERROR
    status: str = Field(default="PENDING", max_length=50, index=True)
    nomad_process_status: str | None = Field(default=None, max_length=100)
    current_process: str | None = Field(default=None, max_length=100)
    last_status_message: str | None = Field(default=None)
    error_message: str | None = Field(default=None)
    entries_count: int | None = None
    processing_failed: int | None = None
    archive_stash_path: str | None = Field(default=None, max_length=1024)
    archive_size: int | None = None
    archive_expires_at: datetime | None = Field(
        default=None, sa_type=DateTime(timezone=True)
    )


class NomadUploadLog(NomadUploadLogBase, table=True):
    __tablename__ = "nomad_upload_log"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    # Full NOMAD errors/warnings arrays (maximum diagnostic info).
    errors: list[Any] | None = _jsonb_field()
    warnings: list[Any] | None = _jsonb_field()
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),
    )
    updated_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),
    )


class NomadUploadLogPublic(NomadUploadLogBase):
    id: uuid.UUID
    errors: list[Any] | None = None
    warnings: list[Any] | None = None
    created_at: datetime | None = None
    updated_at: datetime | None = None
    # Derived: whether a stashed archive is still on disk and downloadable.
    archive_available: bool = False


class NomadUploadLogsPublic(SQLModel):
    data: list[NomadUploadLogPublic]
    count: int


# ============================================================================
# Analysis
# ============================================================================
class AnalysisRefBase(SQLModel):
    kind: str = Field(max_length=50)
    entity_id: uuid.UUID


class AnalysisRefCreate(ClientIdCreate, AnalysisRefBase):
    pass


class AnalysisRef(AnalysisRefBase, table=True):
    __tablename__ = "analysis_ref"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    analysis_id: uuid.UUID = Field(
        foreign_key="analysis.id", nullable=False, ondelete="CASCADE"
    )
    analysis: Optional["Analysis"] = Relationship(back_populates="refs")


class AnalysisRefPublic(AnalysisRefBase):
    id: uuid.UUID


class AnalysisBase(SQLModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None
    is_meta: bool = False
    plane_id: uuid.UUID | None = Field(
        default=None, foreign_key="plane.id", ondelete="SET NULL"
    )
    collection_id: uuid.UUID | None = Field(
        default=None, foreign_key="data_collection.id", ondelete="SET NULL"
    )
    primary_result_id: uuid.UUID | None = Field(
        default=None, foreign_key="experimentresults.id", ondelete="SET NULL"
    )


class AnalysisCreate(ClientIdCreate, AnalysisBase):
    refs: list[AnalysisRefCreate] = []


class AnalysisUpdate(AnalysisBase):
    name: str | None = Field(default=None, min_length=1, max_length=255)


class Analysis(AnalysisBase, table=True):
    __tablename__ = "analysis"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    owner_id: uuid.UUID = Field(
        foreign_key="user.id", nullable=False, ondelete="CASCADE"
    )
    owner: User | None = Relationship(back_populates="analyses")
    created_at: datetime | None = Field(
        default_factory=get_datetime_utc, sa_type=DateTime(timezone=True)
    )
    frontend_data: dict[str, Any] | None = _jsonb_field()
    refs: list[AnalysisRef] = Relationship(
        back_populates="analysis", cascade_delete=True
    )


class AnalysisPublic(AnalysisBase):
    id: uuid.UUID
    owner_id: uuid.UUID
    created_at: datetime | None = None
    refs: list[AnalysisRefPublic] = []


class AnalysesPublic(SQLModel):
    data: list[AnalysisPublic]
    count: int


# ============================================================================
# User State (UI prefs only)
# ============================================================================
class UserState(SQLModel, table=True):
    __tablename__ = "userstate"
    id: uuid.UUID = Field(default_factory=uuid.uuid4, primary_key=True)
    owner_id: uuid.UUID = Field(
        foreign_key="user.id", nullable=False, ondelete="CASCADE", unique=True
    )
    data: dict[str, Any] = Field(
        default_factory=dict,
        sa_column=Column(JSONB, nullable=False, server_default="{}"),
    )
    updated_at: datetime | None = Field(
        default_factory=get_datetime_utc,
        sa_type=DateTime(timezone=True),
    )


class UiPrefsUpdate(SQLModel):
    model_config = ConfigDict(extra="forbid")

    ui_prefs: dict[str, Any]


class UserStatePublic(SQLModel):
    data: dict[str, Any]
    updated_at: datetime | None = None


class BulkStateResponse(SQLModel):
    """Full application state for bulk loading."""

    materials: list[LabMaterialPublic]
    solutions: list[LabSolutionPublic]
    processes: list[ProcessPublic]
    experiments: list[ExperimentPublic]
    results: list[ExperimentResultsPublic]
    analyses: list[AnalysisPublic]
    planes: list[PlanePublic]


# ============================================================================
# Generic
# ============================================================================
class Message(SQLModel):
    message: str


class Token(SQLModel):
    access_token: str
    token_type: str = "bearer"


class TokenPayload(SQLModel):
    sub: str | None = None


class NewPassword(SQLModel):
    token: str
    new_password: str = Field(min_length=8, max_length=128)
