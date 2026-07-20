"""Storing the Chemicals step's answers as real inventory rows.

These tests are the first half of the chemicals -> NOMAD round trip: they check
that an experiment's `chemicals_prep` becomes correct `lab_material` /
`lab_solution` / `solutioncomponent` rows. `test_nomad_entities.py` then covers
reading those rows back out as NOMAD archives.

The AppState they run against lives in `conftest.py`: two mixed recipes that
share a solvent (DMF, so the merge is exercised), a commercial product, an
inline step material, a free-text antisolvent, and one deliberately unlabelled
chemical.
"""

import pytest
from sqlalchemy.exc import IntegrityError
from sqlmodel import Session, select

from app.models import (
    Experiment,
    LabMaterial,
    LabSolution,
    ProcessStep,
    SolutionComponent,
)
from app.services.chemicals_materialization import materialize_experiment_chemicals
from tests.services.conftest import (
    COMMERCIAL_RECIPE,
    DMF_PVK,
    DMSO_PVK,
    PVK_RECIPE,
    STEP_INLINE,
    STEP_PCBM,
    STEP_PVK,
)


def _materials(db: Session, experiment: Experiment) -> dict[str, LabMaterial]:
    rows = db.exec(
        select(LabMaterial).where(LabMaterial.owner_id == experiment.owner_id)
    ).all()
    return {row.inventory_label or str(row.id): row for row in rows}


def _solutions(db: Session, experiment: Experiment) -> dict[str, LabSolution]:
    rows = db.exec(
        select(LabSolution).where(LabSolution.owner_id == experiment.owner_id)
    ).all()
    return {row.inventory_label or str(row.id): row for row in rows}


def test_one_material_per_unique_lab_id(db: Session, experiment: Experiment) -> None:
    report = materialize_experiment_chemicals(db, experiment)

    materials = _materials(db, experiment)
    # INV-PEDOT, INV-CB, INV-DMF, INV-DMSO, INV-PBI2 + the commercial product.
    assert sorted(materials) == [
        "768642",
        "INV-CB",
        "INV-DMF",
        "INV-DMSO",
        "INV-PBI2",
        "INV-PEDOT",
    ]
    assert report.materials_created == 6
    # DMF is described twice (once per recipe) but is one physical chemical.
    assert len([m for m in materials.values() if m.inventory_label == "INV-DMF"]) == 1


def test_unlabelled_chemical_is_skipped_not_invented(
    db: Session, experiment: Experiment
) -> None:
    report = materialize_experiment_chemicals(db, experiment)

    assert "PC61BM" in report.skipped_unlabelled
    materials = _materials(db, experiment)
    assert not [m for m in materials.values() if m.name == "PC61BM"]


def test_material_columns_are_populated(db: Session, experiment: Experiment) -> None:
    materialize_experiment_chemicals(db, experiment)
    materials = _materials(db, experiment)

    dmf = materials["INV-DMF"]
    assert dmf.name == "N,N-Dimethylformamide"
    assert dmf.pubchem_cid == "6228"
    assert dmf.molecular_weight == pytest.approx(73.09)
    assert dmf.density == pytest.approx(0.944)
    assert dmf.purity == "99.8%"
    assert dmf.supplier == "Sigma"
    # The chemicals step calls it "product ID"; the inventory calls the same
    # thing a supplier number.
    assert dmf.supplier_number == "227056"
    assert dmf.type == "solvent"

    pedot = materials["INV-PEDOT"]
    assert pedot.component_cids == ["61503", "62717"]
    assert pedot.type == "p-type (HTL)"

    # A commercial recipe is a bought product, not something mixed in the lab.
    commercial = materials["768642"]
    assert commercial.name == "Clevios P VP AI 4083"
    assert commercial.supplier_number == "768642"


def test_solution_batch_identity(db: Session, experiment: Experiment) -> None:
    materialize_experiment_chemicals(db, experiment)
    solutions = _solutions(db, experiment)

    assert sorted(solutions) == ["PCBM_2026-07-19", "PVK_2026-07-19"]
    pvk = solutions["PVK_2026-07-19"]
    assert pvk.name == "PVK"
    assert pvk.type == "perovskite precursor"
    assert pvk.total_volume_ml == pytest.approx(2.0)
    assert pvk.creation_time is not None
    assert pvk.creation_time.isoformat().startswith("2026-07-19T14:30")
    assert pvk.source_recipe_id == PVK_RECIPE
    # Both recipe handling fields survive; VARCHAR(255) used to truncate them.
    assert pvk.handling == "Stir at 60 C\n\nFilter with 0.45 um PTFE"

    # The commercial recipe must not have become a solution.
    assert not [
        s for s in solutions.values() if s.source_recipe_id == COMMERCIAL_RECIPE
    ]


def test_components_are_scaled_to_the_batch_volume(
    db: Session, experiment: Experiment
) -> None:
    materialize_experiment_chemicals(db, experiment)
    solutions = _solutions(db, experiment)
    materials = _materials(db, experiment)

    pvk = solutions["PVK_2026-07-19"]
    components = db.exec(
        select(SolutionComponent).where(SolutionComponent.solution_id == pvk.id)
    ).all()
    by_material = {c.material_id: c for c in components}

    # Recipe is 1 mL at 4:1 DMF:DMSO; the batch is 2 mL, so 1.6 / 0.4 mL.
    assert by_material[materials["INV-DMF"].id].amount == pytest.approx(1.6)
    assert by_material[materials["INV-DMF"].id].unit == "ml"
    assert by_material[materials["INV-DMSO"].id].amount == pytest.approx(0.4)
    # Solutes scale linearly: 461 mg for 1 mL becomes 922 mg for 2 mL.
    assert by_material[materials["INV-PBI2"].id].amount == pytest.approx(922.0)
    assert by_material[materials["INV-PBI2"].id].unit == "mg"

    # A stock solution mixed into another recipe references the batch, not a
    # material: PCBM's recipe is 2 mL and the batch is 2 mL, so 0.5 mL as-is.
    pcbm = solutions["PCBM_2026-07-19"]
    mixed_in = [
        c
        for c in db.exec(
            select(SolutionComponent).where(SolutionComponent.solution_id == pcbm.id)
        ).all()
        if c.solution_ref_id is not None
    ]
    assert len(mixed_in) == 1
    assert mixed_in[0].solution_ref_id == pvk.id
    assert mixed_in[0].amount == pytest.approx(0.5)


def test_process_steps_point_at_the_materialized_entities(
    db: Session, experiment: Experiment
) -> None:
    materialize_experiment_chemicals(db, experiment)
    materials = _materials(db, experiment)
    solutions = _solutions(db, experiment)

    steps = {
        step.id: step
        for step in db.exec(
            select(ProcessStep).where(ProcessStep.process_id == experiment.process_id)
        ).all()
    }
    assert steps[STEP_INLINE].material_id == materials["INV-PEDOT"].id
    assert steps[STEP_PVK].solution_id == solutions["PVK_2026-07-19"].id
    assert steps[STEP_PCBM].solution_id == solutions["PCBM_2026-07-19"].id


def test_materialization_is_idempotent(db: Session, experiment: Experiment) -> None:
    first = materialize_experiment_chemicals(db, experiment)
    before_materials = len(_materials(db, experiment))
    before_solutions = len(_solutions(db, experiment))
    before_components = len(db.exec(select(SolutionComponent)).all())

    second = materialize_experiment_chemicals(db, experiment)

    assert first.materials_created > 0
    assert second.materials_created == 0
    assert second.solutions_created == 0
    assert len(_materials(db, experiment)) == before_materials
    assert len(_solutions(db, experiment)) == before_solutions
    assert len(db.exec(select(SolutionComponent)).all()) == before_components


def test_editing_an_answer_updates_rather_than_duplicates(
    db: Session, experiment: Experiment
) -> None:
    materialize_experiment_chemicals(db, experiment)

    prep = dict(experiment.chemicals_prep or {})
    overrides = dict(prep["materialOverrides"])
    overrides[f"ingredient:{PVK_RECIPE}:{DMF_PVK}"] = {
        "inventoryLabel": "INV-DMF",
        "purity": "99.99%",
        "supplier": "Acros",
        "productId": "227056",
    }
    prep["materialOverrides"] = overrides
    experiment.chemicals_prep = prep
    db.add(experiment)
    db.commit()

    materialize_experiment_chemicals(db, experiment)

    materials = _materials(db, experiment)
    assert len([m for m in materials.values() if m.inventory_label == "INV-DMF"]) == 1
    assert materials["INV-DMF"].purity == "99.99%"
    assert materials["INV-DMF"].supplier == "Acros"


def test_lab_id_uniqueness_is_enforced_by_the_database(
    db: Session, experiment: Experiment
) -> None:
    materialize_experiment_chemicals(db, experiment)

    db.add(
        LabMaterial(
            owner_id=experiment.owner_id, name="Impostor", inventory_label="INV-DMF"
        )
    )
    with pytest.raises(IntegrityError):
        db.commit()
    db.rollback()


def test_reusing_one_lab_id_for_two_chemicals_is_flagged(
    db: Session, experiment: Experiment, caplog: pytest.LogCaptureFixture
) -> None:
    """A lab ID names one substance; reusing it silently mislabels one of them."""
    prep = dict(experiment.chemicals_prep or {})
    overrides = dict(prep["materialOverrides"])
    # DMSO handed the label that already belongs to DMF.
    overrides[f"ingredient:{PVK_RECIPE}:{DMSO_PVK}"] = {"inventoryLabel": "INV-DMF"}
    prep["materialOverrides"] = overrides
    experiment.chemicals_prep = prep
    db.add(experiment)
    db.commit()

    with caplog.at_level("WARNING"):
        materialize_experiment_chemicals(db, experiment)

    assert any(
        "used by two different chemicals" in record.message for record in caplog.records
    )
