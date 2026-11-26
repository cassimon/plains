from sqlmodel import Session, create_engine, select

from app import crud
from app.core.config import settings
from app.models import User, UserCreate

engine = create_engine(str(settings.SQLALCHEMY_DATABASE_URI))


def backfill_device_group_ids(conn) -> tuple[int, int, int]:
    """One-time migration: backfill MeasurementFile.device_group_id from the
    legacy name-based association (``device_name == devicegroup.name``).

    Only a *unique* group within the *same* ExperimentResults is matched;
    ambiguous (several same-named groups) and unmatched rows are left NULL
    (explicitly unassigned). Never fabricates an association.

    Returns ``(unambiguous, ambiguous, unmatched)`` counts.
    """
    from sqlalchemy import text

    updated = conn.execute(
        text(
            """
            UPDATE measurementfile mf
            SET device_group_id = (
                SELECT dg.id FROM devicegroup dg
                WHERE dg.results_id = mf.results_id
                  AND dg.name = mf.device_name
                LIMIT 1
            )
            WHERE mf.device_group_id IS NULL
              AND mf.device_name IS NOT NULL
              AND (
                SELECT COUNT(*) FROM devicegroup dg
                WHERE dg.results_id = mf.results_id
                  AND dg.name = mf.device_name
              ) = 1
            """
        )
    ).rowcount

    ambiguous = conn.execute(
        text(
            """
            SELECT COUNT(*) FROM measurementfile mf
            WHERE mf.device_group_id IS NULL
              AND mf.device_name IS NOT NULL
              AND (
                SELECT COUNT(*) FROM devicegroup dg
                WHERE dg.results_id = mf.results_id
                  AND dg.name = mf.device_name
              ) > 1
            """
        )
    ).scalar_one()

    unmatched = conn.execute(
        text(
            """
            SELECT COUNT(*) FROM measurementfile mf
            WHERE mf.device_group_id IS NULL
              AND (
                mf.device_name IS NULL
                OR (
                  SELECT COUNT(*) FROM devicegroup dg
                  WHERE dg.results_id = mf.results_id
                    AND dg.name = mf.device_name
                ) = 0
              )
            """
        )
    ).scalar_one()

    return int(updated), int(ambiguous), int(unmatched)


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
        # Trash batch-tracking columns added after trash_entry shipped
        # (create_all never alters existing tables). These let the Trash page
        # show one row per deletion and re-place restored items.
        conn.execute(
            text(
                "ALTER TABLE trash_entry "
                "ADD COLUMN IF NOT EXISTS original_collection_id UUID"
            )
        )
        conn.execute(
            text(
                "ALTER TABLE trash_entry "
                "ADD COLUMN IF NOT EXISTS root_entity_type VARCHAR(32) "
                "NOT NULL DEFAULT ''"
            )
        )
        conn.execute(
            text(
                "ALTER TABLE trash_entry ADD COLUMN IF NOT EXISTS root_entity_id UUID"
            )
        )
        # MeasurementFile → DeviceGroup persistent membership (RESULTS-INTEGRITY-01).
        # Added after create_all shipped, so create_all() never adds it. The
        # one-time backfill below must NOT run on every startup (it would
        # silently re-assign measurements the user intentionally unassigned), so
        # it runs only when the column did not already exist.
        column_exists = (
            conn.execute(
                text(
                    "SELECT 1 FROM information_schema.columns "
                    "WHERE table_name = 'measurementfile' "
                    "AND column_name = 'device_group_id'"
                )
            ).first()
            is not None
        )
        conn.execute(
            text(
                "ALTER TABLE measurementfile ADD COLUMN IF NOT EXISTS "
                "device_group_id UUID REFERENCES devicegroup(id) ON DELETE SET NULL"
            )
        )
        if not column_exists:
            backfill_device_group_ids(conn)
        # Structured import metadata (exploratory import, WO-03). Additive only;
        # existing rows keep NULL/unknown values. `file_path` carries the
        # original source-relative path where available.
        conn.execute(
            text(
                "ALTER TABLE measurementfile ADD COLUMN IF NOT EXISTS direction VARCHAR(8)"
            )
        )
        conn.execute(
            text(
                "ALTER TABLE measurementfile ADD COLUMN IF NOT EXISTS in_summary BOOLEAN"
            )
        )
        conn.execute(
            text(
                "ALTER TABLE measurementfile ADD COLUMN IF NOT EXISTS batch VARCHAR(255)"
            )
        )
        conn.execute(
            text(
                "ALTER TABLE measurementfile ADD COLUMN IF NOT EXISTS substrate_group VARCHAR(255)"
            )
        )
        conn.execute(
            text(
                "ALTER TABLE measurementfile ADD COLUMN IF NOT EXISTS file_path VARCHAR(512)"
            )
        )
        # Durable provenance (WO-04).
        conn.execute(
            text(
                "ALTER TABLE measurementfile ADD COLUMN IF NOT EXISTS "
                "source_file_id UUID REFERENCES imported_source_file(id) ON DELETE SET NULL"
            )
        )
        conn.execute(
            text(
                "ALTER TABLE measurementfile ADD COLUMN IF NOT EXISTS "
                "source_record_locator VARCHAR(512)"
            )
        )
        conn.execute(
            text(
                "ALTER TABLE measurementfile ADD COLUMN IF NOT EXISTS local_only BOOLEAN"
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
