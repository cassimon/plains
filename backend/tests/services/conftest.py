"""Shared fixtures for the service-level tests.

The chemicals fixture below is a realistic AppState, used by both halves of the
chemicals round trip: `test_chemicals_materialization.py` checks it becomes
correct inventory rows, and `test_nomad_entities.py` checks those rows come back
out as NOMAD archives.
"""

import uuid
from collections.abc import Generator

import pytest
from sqlmodel import Session, delete

from app.models import (
    Experiment,
    Process,
    ProcessSolutionRecipe,
    ProcessStep,
    RecipeAddedSolution,
    RecipeSolute,
    RecipeSolvent,
    User,
)
from tests.utils.user import create_random_user

# Ids are fixed per-build so the override keys below can be written literally,
# the way the frontend stores them.
PVK_RECIPE = uuid.UUID("11111111-1111-4111-8111-111111111111")
PCBM_RECIPE = uuid.UUID("22222222-2222-4222-8222-222222222222")
COMMERCIAL_RECIPE = uuid.UUID("33333333-3333-4333-8333-333333333333")
DMF_PVK = uuid.UUID("aaaaaaa1-0000-4000-8000-000000000001")
DMSO_PVK = uuid.UUID("aaaaaaa1-0000-4000-8000-000000000002")
PBI2 = uuid.UUID("aaaaaaa1-0000-4000-8000-000000000003")
DMF_PCBM = uuid.UUID("aaaaaaa1-0000-4000-8000-000000000004")
PCBM = uuid.UUID("aaaaaaa1-0000-4000-8000-000000000005")
STEP_INLINE = uuid.UUID("bbbbbbb1-0000-4000-8000-000000000001")
STEP_PVK = uuid.UUID("bbbbbbb1-0000-4000-8000-000000000002")
STEP_PCBM = uuid.UUID("bbbbbbb1-0000-4000-8000-000000000003")
STEP_COMMERCIAL = uuid.UUID("bbbbbbb1-0000-4000-8000-000000000004")


@pytest.fixture(name="experiment")
def experiment_fixture(db: Session) -> Generator[Experiment, None, None]:
    """An experiment whose process uses the chemicals described above.

    The ids above are fixed, so each test has to leave the database as it found
    it — the `db` session is session-scoped and shared. Deleting the owner is
    enough: every table here cascades from `user`.
    """
    owner = create_random_user(db)
    process = Process(id=uuid.uuid4(), owner_id=owner.id, name="Test process")
    db.add(process)
    db.flush()

    pvk = ProcessSolutionRecipe(
        id=PVK_RECIPE,
        process_id=process.id,
        name="PVK",
        type="perovskite precursor",
        handling_preparation="Stir at 60 C",
        handling_before_use="Filter with 0.45 um PTFE",
        total_solvent_volume_ml="1",
    )
    pcbm = ProcessSolutionRecipe(
        id=PCBM_RECIPE,
        process_id=process.id,
        name="PCBM",
        type="n-type (ETL)",
        total_solvent_volume_ml="2",
    )
    commercial = ProcessSolutionRecipe(
        id=COMMERCIAL_RECIPE,
        process_id=process.id,
        name="PEDOT:PSS",
        is_commercial=True,
        commercial_name="Clevios P VP AI 4083",
        supplier_number="768642",
    )
    db.add_all([pvk, pcbm, commercial])
    db.flush()

    db.add_all(
        [
            RecipeSolvent(
                id=DMF_PVK,
                recipe_id=PVK_RECIPE,
                name="N,N-Dimethylformamide",
                pubchem_cid="6228",
                molar_mass=73.09,
                density=0.944,
                volume_ratio=4,
            ),
            RecipeSolvent(
                id=DMSO_PVK,
                recipe_id=PVK_RECIPE,
                name="Dimethyl sulfoxide",
                pubchem_cid="679",
                molar_mass=78.13,
                volume_ratio=1,
            ),
            RecipeSolute(
                id=PBI2,
                recipe_id=PVK_RECIPE,
                name="Lead(II) iodide",
                pubchem_cid="24931",
                molar_mass=461.0,
                amount="461",
                unit="mg",
            ),
            # The same chemical again, in the other recipe: it must collapse
            # onto one LabMaterial because both carry the same lab ID.
            RecipeSolvent(
                id=DMF_PCBM,
                recipe_id=PCBM_RECIPE,
                name="N,N-Dimethylformamide",
                pubchem_cid="6228",
                volume_ratio=1,
            ),
            RecipeSolute(
                id=PCBM,
                recipe_id=PCBM_RECIPE,
                name="PC61BM",
                pubchem_cid="53384373",
                amount="20",
                unit="mg",
            ),
            RecipeAddedSolution(
                id=uuid.uuid4(),
                recipe_id=PCBM_RECIPE,
                referenced_recipe_id=PVK_RECIPE,
                volume_ml="0.5",
            ),
        ]
    )

    db.add_all(
        [
            ProcessStep(
                id=STEP_INLINE,
                process_id=process.id,
                stage_index=0,
                step_index=0,
                name="Substrate treatment",
                step_category="surface_treatment",
                inline_material={
                    "name": "PEDOT:PSS",
                    "type": "p-type (HTL)",
                    "pubchemCid": "61503",
                    "componentCids": ["61503", "62717"],
                    "molarMass": 210.0,
                },
            ),
            ProcessStep(
                id=STEP_PVK,
                process_id=process.id,
                stage_index=1,
                step_index=0,
                name="Perovskite",
                step_category="deposition",
                chem_recipe_id=PVK_RECIPE,
                drying_method_value=(
                    "type=Antisolvent|media=Chlorobenzene|mediaCid=7964|flowRate=10 ul/s"
                ),
            ),
            ProcessStep(
                id=STEP_PCBM,
                process_id=process.id,
                stage_index=2,
                step_index=0,
                name="ETL",
                step_category="deposition",
                chem_recipe_id=PCBM_RECIPE,
            ),
            ProcessStep(
                id=STEP_COMMERCIAL,
                process_id=process.id,
                stage_index=3,
                step_index=0,
                name="HTL",
                step_category="deposition",
                chem_recipe_id=COMMERCIAL_RECIPE,
            ),
        ]
    )

    experiment = Experiment(
        id=uuid.uuid4(),
        owner_id=owner.id,
        name="Test experiment",
        process_id=process.id,
        chemicals_prep={
            "materialOverrides": {
                str(STEP_INLINE): {
                    "inventoryLabel": "INV-PEDOT",
                    "purity": "99.9%",
                    "supplier": "Heraeus",
                    "productId": "AI4083",
                },
                f"drying:{STEP_PVK}": {"inventoryLabel": "INV-CB"},
                f"ingredient:{PVK_RECIPE}:{DMF_PVK}": {
                    "inventoryLabel": "INV-DMF",
                    "purity": "99.8%",
                    "supplier": "Sigma",
                    "productId": "227056",
                },
                f"ingredient:{PVK_RECIPE}:{DMSO_PVK}": {"inventoryLabel": "INV-DMSO"},
                f"ingredient:{PVK_RECIPE}:{PBI2}": {"inventoryLabel": "INV-PBI2"},
                # Same chemical as INV-DMF, reached through the other recipe.
                f"ingredient:{PCBM_RECIPE}:{DMF_PCBM}": {"inventoryLabel": "INV-DMF"},
                # PC61BM deliberately left unlabelled.
            },
            "solutionBatches": {
                f"recipe:{PVK_RECIPE}": {
                    "mode": "make",
                    "totalVolumeMl": "2",
                    "preparedAt": "2026-07-19T14:30",
                    "vialLabel": "PVK_2026-07-19",
                },
                f"recipe:{PCBM_RECIPE}": {
                    "mode": "make",
                    "totalVolumeMl": "2",
                    "preparedAt": "2026-07-19T15:00",
                    "vialLabel": "PCBM_2026-07-19",
                },
            },
        },
    )
    db.add(experiment)
    db.commit()
    db.refresh(experiment)

    yield experiment

    db.rollback()
    db.execute(delete(User).where(User.id == owner.id))
    db.commit()
    db.expunge_all()
