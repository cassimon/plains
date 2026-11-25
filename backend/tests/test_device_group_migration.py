"""RESULTS-INTEGRITY-01 — conservative legacy backfill of device_group_id.

Runs the one-time name-based migration against an isolated database and verifies
the unambiguous / ambiguous / unmatched classification. Device names are unique
per run so the assertions are not polluted by other tests sharing the database.
"""

import uuid

import pytest
from sqlalchemy import create_engine as sa_create_engine
from sqlalchemy import text
from sqlmodel import SQLModel, Session, create_engine, select

from app.core.config import settings
from app.core.db import backfill_device_group_ids, engine, init_db
from app.models import DeviceGroup, Experiment, ExperimentResults, MeasurementFile, User


def _unique(tag: str) -> str:
    return f"{tag}-{uuid.uuid4().hex[:8]}"


@pytest.fixture()
def legacy_data(db: Session) -> tuple[uuid.UUID, dict[str, uuid.UUID]]:
    """Insert a result with legacy name-based records:
    - f_unique  → device_name matching exactly one group
    - f_ambig   → device_name matching two same-named groups
    - f_missing → device_name matching no group
    - f_null    → device_name NULL (no legacy association)
    """
    owner = db.exec(select(User)).first()
    assert owner is not None
    name_unique = _unique("DEV-A")
    name_ambig = _unique("DEV-B")
    name_missing = _unique("DEV-C")

    exp = Experiment(name=_unique("legacy"), owner_id=owner.id)
    db.add(exp)
    db.flush()
    result = ExperimentResults(experiment_id=exp.id, owner_id=owner.id)
    db.add(result)
    db.flush()

    g1 = DeviceGroup(name=name_unique, results_id=result.id)
    g2 = DeviceGroup(name=name_ambig, results_id=result.id)
    g3 = DeviceGroup(name=name_ambig, results_id=result.id)
    db.add_all([g1, g2, g3])
    db.flush()

    f_unique = MeasurementFile(
        filename="a.txt", file_type="JV", device_name=name_unique, results_id=result.id
    )
    f_ambig = MeasurementFile(
        filename="b.txt", file_type="JV", device_name=name_ambig, results_id=result.id
    )
    f_missing = MeasurementFile(
        filename="c.txt", file_type="JV", device_name=name_missing, results_id=result.id
    )
    f_null = MeasurementFile(
        filename="d.txt", file_type="JV", device_name=None, results_id=result.id
    )
    db.add_all([f_unique, f_ambig, f_missing, f_null])
    db.commit()

    return result.id, {
        "unique": f_unique.id,
        "ambig": f_ambig.id,
        "missing": f_missing.id,
        "null": f_null.id,
        "g1": g1.id,
    }


def test_backfill_classifies_legacy_records(
    db: Session, legacy_data: tuple[uuid.UUID, dict[str, uuid.UUID]]
) -> None:
    result_id, ids = legacy_data
    with engine.begin() as conn:
        backfill_device_group_ids(conn)

    files = db.exec(
        select(MeasurementFile).where(MeasurementFile.results_id == result_id)
    ).all()
    by_id = {f.id: f for f in files}

    # Unique → assigned to the single matching group; ambiguous, missing and
    # null all remain explicitly unassigned (never fabricated).
    assert by_id[ids["unique"]].device_group_id == ids["g1"]
    assert by_id[ids["ambig"]].device_group_id is None
    assert by_id[ids["missing"]].device_group_id is None
    assert by_id[ids["null"]].device_group_id is None


def _isolated_db_url(db_name: str) -> str:
    return (
        f"postgresql+psycopg://{settings.POSTGRES_USER}:{settings.POSTGRES_PASSWORD}"
        f"@{settings.POSTGRES_SERVER}:{settings.POSTGRES_PORT}/{db_name}"
    )


def test_startup_backfill_runs_once_and_respects_unassign(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Startup-level regression: the conservative backfill runs only the first
    time the column appears. After an intentional unassign, a second startup
    must NOT silently re-assign the measurement."""
    import app.core.db as db_module

    db_name = "app_migration_test"
    admin_url = _isolated_db_url("postgres")
    admin = sa_create_engine(admin_url, isolation_level="AUTOCOMMIT")
    with admin.connect() as conn:
        conn.execute(text(f"DROP DATABASE IF EXISTS {db_name}"))
        conn.execute(text(f"CREATE DATABASE {db_name}"))

    temp_engine = create_engine(_isolated_db_url(db_name))
    monkeypatch.setattr(db_module, "engine", temp_engine)

    try:
        # Fresh schema (the model already carries the column).
        SQLModel.metadata.create_all(temp_engine)

        # Legacy records: one group + one matching measurement, written with the
        # column still present but NULL (the pre-migration association is
        # name-based, not id-based).
        with Session(temp_engine) as session:
            user = User(email="migration-legacy@example.com")
            session.add(user)
            session.flush()
            exp = Experiment(name="legacy", owner_id=user.id)
            session.add(exp)
            session.flush()
            result = ExperimentResults(experiment_id=exp.id, owner_id=user.id)
            session.add(result)
            session.flush()
            group = DeviceGroup(name="DEV-LEGACY", results_id=result.id)
            session.add(group)
            session.flush()
            mf = MeasurementFile(
                filename="a.txt",
                file_type="JV",
                device_name="DEV-LEGACY",
                results_id=result.id,
            )
            session.add(mf)
            session.commit()
            group_id = group.id
            file_id = mf.id

        # Now drop the column to simulate a legacy database created before
        # RESULTS-INTEGRITY-01 (the rows survive, the column is gone).
        with temp_engine.begin() as conn:
            conn.execute(
                text("ALTER TABLE measurementfile DROP COLUMN device_group_id")
            )

        # First startup: column re-added and the one-time backfill runs.
        with Session(temp_engine) as session:
            init_db(session)
        with Session(temp_engine) as session:
            assert session.get(MeasurementFile, file_id).device_group_id == group_id

        # Intentionally unassign the measurement.
        with Session(temp_engine) as session:
            mf = session.get(MeasurementFile, file_id)
            mf.device_group_id = None
            session.add(mf)
            session.commit()

        # Second startup: the column already exists, so the backfill must NOT
        # run again and the intentional unassignment survives.
        with Session(temp_engine) as session:
            init_db(session)
        with Session(temp_engine) as session:
            assert session.get(MeasurementFile, file_id).device_group_id is None
    finally:
        temp_engine.dispose()
        with admin.connect() as conn:
            conn.execute(text(f"DROP DATABASE IF EXISTS {db_name}"))
        admin.dispose()


def test_backfill_never_crosses_results(
    db: Session, legacy_data: tuple[uuid.UUID, dict[str, uuid.UUID]]
) -> None:
    """A device name that matches a group in a *different* result must not be
    matched (membership is scoped to the same ExperimentResults)."""
    _result_id, ids = legacy_data
    owner = db.exec(select(User)).first()
    assert owner is not None
    # The orphan file f_missing has device_name DEV-C; create a second result
    # with a group named DEV-C — it must stay unassigned in the first result.
    f_missing = db.get(MeasurementFile, ids["missing"])
    assert f_missing is not None
    name = f_missing.device_name

    exp2 = Experiment(name=_unique("other"), owner_id=owner.id)
    db.add(exp2)
    db.flush()
    result2 = ExperimentResults(experiment_id=exp2.id, owner_id=owner.id)
    db.add(result2)
    db.flush()
    g_other = DeviceGroup(name=name, results_id=result2.id)
    db.add(g_other)
    db.commit()

    with engine.begin() as conn:
        backfill_device_group_ids(conn)

    f_missing = db.get(MeasurementFile, ids["missing"])
    assert f_missing is not None
    assert f_missing.device_group_id is None
