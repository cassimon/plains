"""CRUD cascade tests — verify ON DELETE behaviours at the database level."""

import uuid

from sqlmodel import Session, select

from app import crud
from app.core.config import settings
from app.models import (
    ExperimentCreate,
    LabMaterialCreate,
    LabSolutionCreate,
    SolutionComponent,
    SolutionComponentCreate,
    User,
)
from tests.utils.utils import random_lower_string


def _superuser(db: Session) -> User:
    user = db.exec(
        select(User).where(User.email == settings.FIRST_SUPERUSER)
    ).first()
    assert user is not None
    return user


class TestMaterialCascade:
    def test_delete_material_sets_component_material_id_null(self, db: Session) -> None:
        """Deleting a material NULLs SolutionComponent.material_id (SET NULL cascade)."""
        owner = _superuser(db)

        mat = crud.create_material(
            session=db,
            material_in=LabMaterialCreate(name=random_lower_string()),
            owner_id=owner.id,
        )
        sol = crud.create_solution(
            session=db,
            solution_in=LabSolutionCreate(
                name=random_lower_string(),
                components=[
                    SolutionComponentCreate(
                        amount=1.0, unit="g", material_id=mat.id
                    )
                ],
            ),
            owner_id=owner.id,
        )

        comp_before = db.exec(
            select(SolutionComponent).where(SolutionComponent.solution_id == sol.id)
        ).first()
        assert comp_before is not None
        assert comp_before.material_id == mat.id

        db.delete(mat)
        db.commit()
        db.expire_all()

        comp_after = db.exec(
            select(SolutionComponent).where(SolutionComponent.solution_id == sol.id)
        ).first()
        assert comp_after is not None, "Component should still exist"
        assert comp_after.material_id is None, "material_id should be NULLed"

        db.delete(sol)
        db.commit()

    def test_delete_material_removes_experiment_material_ref(self, db: Session) -> None:
        """
        Deleting a material removes ExperimentMaterial junction rows
        (ON DELETE CASCADE on lab_material FK).
        """
        from app.models import ExperimentMaterial

        owner = _superuser(db)

        mat = crud.create_material(
            session=db,
            material_in=LabMaterialCreate(name=random_lower_string()),
            owner_id=owner.id,
        )
        exp = crud.create_experiment(
            session=db,
            experiment_in=ExperimentCreate(name=random_lower_string()),
            owner_id=owner.id,
        )

        # Manually create junction row
        junction = ExperimentMaterial(experiment_id=exp.id, material_id=mat.id)
        db.add(junction)
        db.commit()

        junction_before = db.exec(
            select(ExperimentMaterial).where(
                ExperimentMaterial.experiment_id == exp.id,
                ExperimentMaterial.material_id == mat.id,
            )
        ).first()
        assert junction_before is not None

        db.delete(mat)
        db.commit()
        db.expire_all()

        junction_after = db.exec(
            select(ExperimentMaterial).where(
                ExperimentMaterial.experiment_id == exp.id,
                ExperimentMaterial.material_id == mat.id,
            )
        ).first()
        assert junction_after is None, "ExperimentMaterial should be cascade deleted"

        db.delete(exp)
        db.commit()


class TestSolutionCascade:
    def test_delete_solution_removes_components(self, db: Session) -> None:
        """Deleting a solution removes its SolutionComponent rows (CASCADE)."""
        owner = _superuser(db)

        mat = crud.create_material(
            session=db,
            material_in=LabMaterialCreate(name=random_lower_string()),
            owner_id=owner.id,
        )
        sol = crud.create_solution(
            session=db,
            solution_in=LabSolutionCreate(
                name=random_lower_string(),
                components=[
                    SolutionComponentCreate(amount=2.0, unit="mL", material_id=mat.id)
                ],
            ),
            owner_id=owner.id,
        )
        sol_id = sol.id

        comps_before = db.exec(
            select(SolutionComponent).where(SolutionComponent.solution_id == sol_id)
        ).all()
        assert len(comps_before) == 1

        db.delete(sol)
        db.commit()
        db.expire_all()

        comps_after = db.exec(
            select(SolutionComponent).where(SolutionComponent.solution_id == sol_id)
        ).all()
        assert comps_after == [], "SolutionComponent rows should be cascade deleted"

        db.delete(mat)
        db.commit()

    def test_delete_solution_removes_experiment_solution_ref(self, db: Session) -> None:
        """Deleting a solution removes ExperimentSolution junction rows (CASCADE)."""
        from app.models import ExperimentSolution

        owner = _superuser(db)

        sol = crud.create_solution(
            session=db,
            solution_in=LabSolutionCreate(name=random_lower_string()),
            owner_id=owner.id,
        )
        exp = crud.create_experiment(
            session=db,
            experiment_in=ExperimentCreate(name=random_lower_string()),
            owner_id=owner.id,
        )

        junction = ExperimentSolution(experiment_id=exp.id, solution_id=sol.id)
        db.add(junction)
        db.commit()

        junction_before = db.exec(
            select(ExperimentSolution).where(
                ExperimentSolution.experiment_id == exp.id,
                ExperimentSolution.solution_id == sol.id,
            )
        ).first()
        assert junction_before is not None

        db.delete(sol)
        db.commit()
        db.expire_all()

        junction_after = db.exec(
            select(ExperimentSolution).where(
                ExperimentSolution.experiment_id == exp.id,
                ExperimentSolution.solution_id == sol.id,
            )
        ).first()
        assert junction_after is None, "ExperimentSolution should be cascade deleted"

        db.delete(exp)
        db.commit()
