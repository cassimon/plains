from sqlmodel import Session, create_engine, select

from app import crud
from app.core.config import settings
from app.models import User, UserCreate

engine = create_engine(str(settings.SQLALCHEMY_DATABASE_URI))


# make sure all SQLModel models are imported (app.models) before initializing DB
# otherwise, SQLModel might fail to initialize relationships properly
# for more details: https://github.com/fastapi/full-stack-fastapi-template/issues/28


def init_db(session: Session) -> None:
    from sqlalchemy import text
    from sqlmodel import SQLModel

    SQLModel.metadata.create_all(engine)

    # Databases created before the FK was removed from
    # LabSubstrate.substrate_material_id still carry the constraint;
    # create_all() never alters existing tables, so drop it here.
    # The column holds a process inline-substrate id, not a lab_material id.
    with engine.begin() as conn:
        conn.execute(
            text(
                "ALTER TABLE lab_substrate DROP CONSTRAINT IF EXISTS "
                "lab_substrate_substrate_material_id_fkey"
            )
        )
        # Added after create_all shipped: the step reference a generated stack
        # layer was built from (see ProcessGeneratedStackLayerBase.step_ref).
        conn.execute(
            text(
                "ALTER TABLE process_generated_stack_layer "
                "ADD COLUMN IF NOT EXISTS step_ref VARCHAR(64)"
            )
        )

    user = session.exec(
        select(User).where(User.email == settings.FIRST_SUPERUSER)
    ).first()
    if not user:
        user_in = UserCreate(
            email=settings.FIRST_SUPERUSER,
            password=settings.FIRST_SUPERUSER_PASSWORD,
            is_superuser=True,
        )
        user = crud.create_user(session=session, user_create=user_in)
