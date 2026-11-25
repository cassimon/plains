"""RESULTS-INTEGRITY-01 — conservative legacy backfill of device_group_id.

Runs the one-time name-based migration against an isolated database and verifies
the unambiguous / ambiguous / unmatched classification.
"""

import uuid

import pytest
from sqlmodel import Session, select

from app.core.db import backfill_device_group_ids, engine
from app.models import DeviceGroup, Experiment, ExperimentResults, MeasurementFile, User


@pytest.fixture()
def legacy_data(db: Session) -> tuple[uuid.UUID, dict[str, uuid.UUID]]:
    """Insert a result with legacy name-based records:
    - f_unique  → device_name "DEV-A" matching exactly one group
    - f_ambig   → device_name "DEV-B" matching two same-named groups
    - f_missing → device_name "DEV-C" matching no group
    - f_null    → device_name NULL (no legacy association)
    """
    owner = db.exec(select(User)).first()
    assert owner is not None
    exp = Experiment(name="legacy", owner_id=owner.id)
    db.add(exp)
    db.flush()
    result = ExperimentResults(experiment_id=exp.id, owner_id=owner.id)
    db.add(result)
    db.flush()

    g1 = DeviceGroup(name="DEV-A", results_id=result.id)
    g2 = DeviceGroup(name="DEV-B", results_id=result.id)
    g3 = DeviceGroup(name="DEV-B", results_id=result.id)
    db.add_all([g1, g2, g3])
    db.flush()

    f_unique = MeasurementFile(
        filename="a.txt", file_type="JV", device_name="DEV-A", results_id=result.id
    )
    f_ambig = MeasurementFile(
        filename="b.txt", file_type="JV", device_name="DEV-B", results_id=result.id
    )
    f_missing = MeasurementFile(
        filename="c.txt", file_type="JV", device_name="DEV-C", results_id=result.id
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
        "g2": g2.id,
        "g3": g3.id,
    }


def test_backfill_classifies_legacy_records(
    db: Session, legacy_data: tuple[uuid.UUID, dict[str, uuid.UUID]]
) -> None:
    result_id, ids = legacy_data
    with engine.begin() as conn:
        unambiguous, ambiguous, unmatched = backfill_device_group_ids(conn)

    # One unambiguous match (DEV-A → g1), one ambiguous (DEV-B → two groups),
    # two unmatched (DEV-C and the NULL device_name).
    assert unambiguous == 1
    assert ambiguous == 1
    assert unmatched == 2

    files = db.exec(
        select(MeasurementFile).where(MeasurementFile.results_id == result_id)
    ).all()
    by_id = {f.id: f for f in files}

    assert by_id[ids["unique"]].device_group_id == ids["g1"]
    assert by_id[ids["ambig"]].device_group_id is None
    assert by_id[ids["missing"]].device_group_id is None
    assert by_id[ids["null"]].device_group_id is None


def test_backfill_never_crosses_results(
    db: Session, legacy_data: tuple[uuid.UUID, dict[str, uuid.UUID]]
) -> None:
    """A device name that matches a group in a *different* result must not be
    matched (membership is scoped to the same ExperimentResults)."""
    _result_id, ids = legacy_data
    owner = db.exec(select(User)).first()
    assert owner is not None
    # Create a second result with a group named "DEV-C" — the orphan file
    # f_missing belongs to the FIRST result and must stay unassigned.
    exp2 = Experiment(name="other", owner_id=owner.id)
    db.add(exp2)
    db.flush()
    result2 = ExperimentResults(experiment_id=exp2.id, owner_id=owner.id)
    db.add(result2)
    db.flush()
    g_other = DeviceGroup(name="DEV-C", results_id=result2.id)
    db.add(g_other)
    db.commit()

    with engine.begin() as conn:
        backfill_device_group_ids(conn)

    f_missing = db.get(MeasurementFile, ids["missing"])
    assert f_missing is not None
    assert f_missing.device_group_id is None


def test_backfill_is_a_one_time_migration(
    db: Session, legacy_data: tuple[uuid.UUID, dict[str, uuid.UUID]]
) -> None:
    """The backfill is a one-time migration, not a permanent fallback. Its
    second run updates nothing (already-assigned rows are skipped), which is
    why ``init_db`` only invokes it the first time the column appears."""
    with engine.begin() as conn:
        first = backfill_device_group_ids(conn)
    with engine.begin() as conn:
        second = backfill_device_group_ids(conn)

    assert first[0] == 1  # unambiguous rows assigned once
    assert second[0] == 0  # nothing left to assign on a re-run
