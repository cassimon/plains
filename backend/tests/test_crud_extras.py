"""Extra unit tests for uncovered crud.py branches."""

import uuid

from sqlmodel import Session, select

from app import crud
from app.core.config import settings
from app.models import (
    LabMaterialCreate,
    LabMaterialUpdate,
    PlaneCreate,
    PlaneUpdate,
    User,
    UserCreate,
)


def test_authenticate_user_no_hashed_password(db: Session):
    """NOMAD OAuth user (no password) returns None when authenticating by password."""
    email = f"nomad-{uuid.uuid4().hex}@test.com"
    user = crud.create_user(
        session=db,
        user_create=UserCreate(email=email, password="whatever", is_superuser=False),
    )
    # Clear the hashed password to simulate NOMAD-only user
    user.hashed_password = None
    db.add(user)
    db.commit()

    result = crud.authenticate(session=db, email=email, password="whatever")
    assert result is None

    db.delete(user)
    db.commit()


def test_authenticate_user_wrong_password(db: Session):
    email = f"pw-{uuid.uuid4().hex}@test.com"
    user = crud.create_user(
        session=db,
        user_create=UserCreate(
            email=email, password="correct_password", is_superuser=False
        ),
    )

    result = crud.authenticate(session=db, email=email, password="wrong_password")
    assert result is None

    db.delete(user)
    db.commit()


def test_create_and_update_material(db: Session):
    superuser = db.exec(
        select(User).where(User.email == settings.FIRST_SUPERUSER)
    ).first()
    owner_id = superuser.id
    mat = crud.create_material(
        session=db,
        material_in=LabMaterialCreate(name="TestMat", type="solvent"),
        owner_id=owner_id,
    )
    assert mat.name == "TestMat"
    assert mat.owner_id == owner_id

    updated = crud.update_material(
        session=db,
        db_material=mat,
        material_in=LabMaterialUpdate(name="UpdatedMat"),
    )
    assert updated.name == "UpdatedMat"

    db.delete(mat)
    db.commit()


def test_create_and_update_plane(db: Session):
    superuser = db.exec(
        select(User).where(User.email == settings.FIRST_SUPERUSER)
    ).first()
    owner_id = superuser.id
    plane = crud.create_plane(
        session=db,
        plane_in=PlaneCreate(name="MyPlane"),
        owner_id=owner_id,
    )
    assert plane.name == "MyPlane"
    assert plane.owner_id == owner_id

    updated = crud.update_plane(
        session=db,
        db_plane=plane,
        plane_in=PlaneUpdate(name="UpdatedPlane"),
    )
    assert updated.name == "UpdatedPlane"

    db.delete(plane)
    db.commit()
