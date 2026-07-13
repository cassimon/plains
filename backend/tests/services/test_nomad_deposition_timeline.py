"""DepositionRoutine timeline: step start_time, duration and the routine's end.

A step's `duration` is the time until the *next* step starts; the last step runs
until the end of the experiment. The times themselves come from the Experiments
page's Processing table, whose cells live under `stage:{i}` while every substrate
follows the same alternatives and under `stage:{i}:stack:{key}` from the first
stage where they diverge (see frontend/src/lib/processingTimes.ts).
"""

import uuid
from types import SimpleNamespace

from app.services.nomad import create_nomad_metadata_yaml


class _FakeResult:
    def __init__(self, value):
        self._value = value

    def first(self):
        return self._value

    def all(self):
        return self._value


class _FakeSession:
    def __init__(self, values):
        self._values = iter(values)

    def exec(self, _statement):
        return _FakeResult(next(self._values))


def _session(experiment):
    return _FakeSession([experiment, [], []])


def _step(step_id: str, name: str, **params):
    step: dict = {"id": step_id, "name": name, "stepCategory": "wet_deposition"}
    for key, value in params.items():
        step[key] = {"value": value, "mode": "constant"}
    return step


def _process(stages):
    return {"id": "proc-1", "name": "P", "stages": stages, "generatedStacks": []}


def _experiment_orm(experiment_id):
    return SimpleNamespace(
        id=uuid.UUID(experiment_id),
        owner_id=uuid.uuid4(),
        process_id=None,
        name="E",
        description="",
        architecture="n-i-p",
        substrate_material="Glass",
        devices_per_substrate=1,
        device_area=0.09,
    )


def _steps_of(archives):
    deposition = next(k for k in archives if k.endswith("_deposition.archive.yaml"))
    return archives[deposition]["data"], archives[deposition]["data"]["steps"]


def test_duration_is_the_gap_to_the_next_step_and_last_step_runs_until_experiment_end():
    experiment_id = str(uuid.uuid4())
    process_snapshot = _process(
        [
            {"index": 0, "alternatives": [_step("s0", "Clean")]},
            {
                "index": 1,
                "alternatives": [_step("s1", "Perovskite", annealingTime="30")],
            },
            {"index": 2, "alternatives": [_step("s2", "Evaporation")]},
        ]
    )
    experiment_snapshot = {
        "id": experiment_id,
        "name": "E",
        "architecture": "n-i-p",
        "substrateMaterial": "Glass",
        "devicesPerSubstrate": 1,
        "deviceArea": 0.09,
        "date": "2026-05-19T10:00",
        "processingTimes": {
            "stage:0": "2026-05-19T10:00",
            "stage:1": "2026-05-19T11:30",
            "stage:2": "2026-05-19T12:30",
            # The "end of experiment" cell — one past the last stage.
            "stage:3": "2026-05-19T16:30",
        },
        "substrates": [{"id": "sub-1", "name": "sub-1"}],
    }

    archives = create_nomad_metadata_yaml(
        experiment_id=experiment_id,
        user_name="Tester",
        session=_session(_experiment_orm(experiment_id)),
        experiment_snapshot=experiment_snapshot,
        process_snapshot=process_snapshot,
    )

    routine, steps = _steps_of(archives)
    assert [s["start_time"] for s in steps] == [
        "2026-05-19T10:00:00",
        "2026-05-19T11:30:00",
        "2026-05-19T12:30:00",
    ]
    # 10:00→11:30 = 90 min, 11:30→12:30 = 60 min, 12:30→end 16:30 = 240 min.
    assert [s["duration"] for s in steps] == [90.0, 60.0, 240.0]

    # The step's own annealing time is a separate quantity and must not be
    # confused with how long the step occupied the routine.
    assert steps[1]["annealing_time"] == 30.0
    assert steps[1]["duration"] == 60.0

    # A Process is positioned by `datetime` (its start) and `end_time`; it has
    # no `start_time` quantity, so writing one would be silently dropped.
    assert routine["datetime"] == "2026-05-19T10:00:00"
    assert routine["end_time"] == "2026-05-19T16:30:00"
    assert "start_time" not in routine

    # The canonical ELN workflow field, not the schema's old custom `timestamp`.
    assert "timestamp" not in steps[0]


def test_diverged_substrates_read_their_own_stack_timings():
    """Times after the divergence live under `stage:{i}:stack:{key}` — reading
    only `stage:{i}` used to lose them entirely."""
    experiment_id = str(uuid.uuid4())
    process_snapshot = _process(
        [
            {"index": 0, "alternatives": [_step("s0", "Clean")]},
            {
                "index": 1,
                "alternatives": [_step("a", "Spin"), _step("b", "Blade")],
            },
        ]
    )
    stack_a, stack_b = "s0|a", "s0|b"
    experiment_snapshot = {
        "id": experiment_id,
        "name": "E",
        "architecture": "n-i-p",
        "substrateMaterial": "Glass",
        "devicesPerSubstrate": 1,
        "deviceArea": 0.09,
        "date": "2026-05-19T09:00",
        "processingTimes": {
            "stage:0": "2026-05-19T09:00",  # shared prefix
            f"stage:1:stack:{stack_a}": "2026-05-19T10:00",
            f"stage:1:stack:{stack_b}": "2026-05-19T11:00",
            f"stage:2:stack:{stack_a}": "2026-05-19T12:00",  # end of experiment
            f"stage:2:stack:{stack_b}": "2026-05-19T14:00",
        },
        "substrates": [
            {
                "id": "sub-a",
                "name": "sub-a",
                "parameterValues": {"stageSelection:0": "s0", "stageSelection:1": "a"},
            },
            {
                "id": "sub-b",
                "name": "sub-b",
                "parameterValues": {"stageSelection:0": "s0", "stageSelection:1": "b"},
            },
        ],
    }

    archives = create_nomad_metadata_yaml(
        experiment_id=experiment_id,
        user_name="Tester",
        session=_session(_experiment_orm(experiment_id)),
        experiment_snapshot=experiment_snapshot,
        process_snapshot=process_snapshot,
    )

    routine_a = archives["sub-a_deposition.archive.yaml"]["data"]
    routine_b = archives["sub-b_deposition.archive.yaml"]["data"]

    # Shared first stage, own second stage, own end.
    assert [s["start_time"] for s in routine_a["steps"]] == [
        "2026-05-19T09:00:00",
        "2026-05-19T10:00:00",
    ]
    assert [s["duration"] for s in routine_a["steps"]] == [60.0, 120.0]
    assert routine_a["end_time"] == "2026-05-19T12:00:00"

    assert [s["start_time"] for s in routine_b["steps"]] == [
        "2026-05-19T09:00:00",
        "2026-05-19T11:00:00",
    ]
    assert [s["duration"] for s in routine_b["steps"]] == [120.0, 180.0]
    assert routine_b["end_time"] == "2026-05-19T14:00:00"


def test_as_above_cell_follows_the_row_it_points_at():
    experiment_id = str(uuid.uuid4())
    process_snapshot = _process(
        [
            {"index": 0, "alternatives": [_step("s0", "Clean")]},
            {"index": 1, "alternatives": [_step("a", "Spin"), _step("b", "Blade")]},
        ]
    )
    stack_a, stack_b = "s0|a", "s0|b"
    experiment_snapshot = {
        "id": experiment_id,
        "name": "E",
        "architecture": "n-i-p",
        "substrateMaterial": "Glass",
        "devicesPerSubstrate": 1,
        "deviceArea": 0.09,
        "processingTimes": {
            "stage:0": "2026-05-19T09:00",
            f"stage:1:stack:{stack_a}": "2026-05-19T10:00",
            # Row B says "as above" → it takes row A's time for this stage.
            f"asAbove:stage:1:stack:{stack_b}": "true",
            f"stage:2:stack:{stack_a}": "2026-05-19T12:00",
            f"asAbove:stage:2:stack:{stack_b}": "true",
        },
        "substrates": [
            {
                "id": "sub-a",
                "name": "sub-a",
                "parameterValues": {"stageSelection:0": "s0", "stageSelection:1": "a"},
            },
            {
                "id": "sub-b",
                "name": "sub-b",
                "parameterValues": {"stageSelection:0": "s0", "stageSelection:1": "b"},
            },
        ],
    }

    archives = create_nomad_metadata_yaml(
        experiment_id=experiment_id,
        user_name="Tester",
        session=_session(_experiment_orm(experiment_id)),
        experiment_snapshot=experiment_snapshot,
        process_snapshot=process_snapshot,
    )

    routine_b = archives["sub-b_deposition.archive.yaml"]["data"]
    assert [s["start_time"] for s in routine_b["steps"]] == [
        "2026-05-19T09:00:00",
        "2026-05-19T10:00:00",
    ]
    assert routine_b["end_time"] == "2026-05-19T12:00:00"


def test_inconsistent_times_leave_duration_unset_rather_than_negative():
    experiment_id = str(uuid.uuid4())
    process_snapshot = _process(
        [
            {"index": 0, "alternatives": [_step("s0", "Clean")]},
            {"index": 1, "alternatives": [_step("s1", "Spin")]},
        ]
    )
    experiment_snapshot = {
        "id": experiment_id,
        "name": "E",
        "architecture": "n-i-p",
        "substrateMaterial": "Glass",
        "devicesPerSubstrate": 1,
        "deviceArea": 0.09,
        "processingTimes": {
            "stage:0": "2026-05-19T12:00",
            "stage:1": "2026-05-19T10:00",  # earlier than the step before it
            "stage:2": "2026-05-19T09:00",  # end before the start
        },
        "substrates": [{"id": "sub-1", "name": "sub-1"}],
    }

    archives = create_nomad_metadata_yaml(
        experiment_id=experiment_id,
        user_name="Tester",
        session=_session(_experiment_orm(experiment_id)),
        experiment_snapshot=experiment_snapshot,
        process_snapshot=process_snapshot,
    )

    _routine, steps = _steps_of(archives)
    assert all("duration" not in step for step in steps)
    assert [s["start_time"] for s in steps] == [
        "2026-05-19T12:00:00",
        "2026-05-19T10:00:00",
    ]


def test_each_process_path_carries_its_own_end_and_the_experiment_takes_the_latest():
    """Diverged paths finish at different times: each DepositionRoutine ends at
    its own path's end cell, and a path whose end cell was left empty falls back
    to the experiment's end — which the GUI derives as the latest of them all."""
    experiment_id = str(uuid.uuid4())
    process_snapshot = _process(
        [
            {"index": 0, "alternatives": [_step("s0", "Clean")]},
            {
                "index": 1,
                "alternatives": [
                    _step("a", "Spin"),
                    _step("b", "Blade"),
                    _step("c", "Slot-die"),
                ],
            },
        ]
    )
    experiment_snapshot = {
        "id": experiment_id,
        "name": "E",
        "architecture": "n-i-p",
        "substrateMaterial": "Glass",
        "devicesPerSubstrate": 1,
        "deviceArea": 0.09,
        # The GUI derives this as max(end cells) = 15:00 (path C's).
        "endDate": "2026-05-19T15:00",
        "processingTimes": {
            "stage:0": "2026-05-19T09:00",
            "stage:1:stack:s0|a": "2026-05-19T10:00",
            "stage:1:stack:s0|b": "2026-05-19T10:30",
            "stage:1:stack:s0|c": "2026-05-19T11:00",
            "stage:2:stack:s0|a": "2026-05-19T12:00",
            "stage:2:stack:s0|b": "2026-05-19T13:30",
            # Path C's end cell is missing → falls back to the experiment's end.
        },
        "substrates": [
            {
                "id": f"sub-{sel}",
                "name": f"sub-{sel}",
                "parameterValues": {
                    "stageSelection:0": "s0",
                    "stageSelection:1": sel,
                },
            }
            for sel in ("a", "b", "c")
        ],
    }

    archives = create_nomad_metadata_yaml(
        experiment_id=experiment_id,
        user_name="Tester",
        session=_session(_experiment_orm(experiment_id)),
        experiment_snapshot=experiment_snapshot,
        process_snapshot=process_snapshot,
    )

    ends = {
        sel: archives[f"sub-{sel}_deposition.archive.yaml"]["data"]["end_time"]
        for sel in ("a", "b", "c")
    }
    assert ends["a"] == "2026-05-19T12:00:00"
    assert ends["b"] == "2026-05-19T13:30:00"
    assert ends["c"] == "2026-05-19T15:00:00"  # the experiment's end

    # Each path's last step runs until *its own* end, not the experiment's.
    last_durations = {
        sel: archives[f"sub-{sel}_deposition.archive.yaml"]["data"]["steps"][-1][
            "duration"
        ]
        for sel in ("a", "b", "c")
    }
    assert last_durations["a"] == 120.0  # 10:00 → 12:00
    assert last_durations["b"] == 180.0  # 10:30 → 13:30
    assert last_durations["c"] == 240.0  # 11:00 → 15:00


def test_a_recipe_step_carries_its_chemistry():
    """A step whose chemistry is a process *recipe* (`chemRecipeId` — the modern
    path; materialId/solutionId are legacy) must still export its solvents,
    compounds and concentration."""
    experiment_id = str(uuid.uuid4())
    spin = _step(
        "s-pero",
        "Perovskite",
        depositionMethod="Spin coating",
        solutionVolume="80",
    )
    spin["chemRecipeId"] = "rec-1"
    process_snapshot = _process([{"index": 0, "alternatives": [spin]}])
    process_snapshot["solutionRecipes"] = [
        {
            "id": "rec-1",
            "name": "Perovskite precursor",
            "supplierNumber": "AB-1",
            "totalSolventVolumeMl": "1",
            "solvents": [
                {"name": "DMF", "volumeRatio": 4, "molarMass": 73.09},
                {"name": "DMSO", "volumeRatio": 1, "molarMass": 78.13},
            ],
            "solutes": [
                {"name": "PbI2", "amount": "461.01", "unit": "mg", "molarMass": 461.01},
            ],
            "addedSolutions": [],
        }
    ]
    process_snapshot["generatedStacks"] = [
        {
            "combination": 1,
            "layers": [
                {"id": "sub", "name": "Glass", "isSubstrate": True, "layerType": ""},
                {
                    "id": "s-pero",
                    "name": "Perovskite",
                    "layerType": "absorber",
                    "perovskiteA": "MA",
                    "perovskiteB": "Pb",
                    "perovskiteX": "I3",
                },
            ],
        }
    ]

    experiment_snapshot = {
        "id": experiment_id,
        "name": "E",
        "architecture": "n-i-p",
        "substrateMaterial": "Glass",
        "devicesPerSubstrate": 1,
        "deviceArea": 0.09,
        "processingTimes": {
            "stage:0": "2026-05-19T10:00",
            "stage:1": "2026-05-19T12:00",
        },
        "substrates": [{"id": "sub-1", "name": "sub-1"}],
    }

    archives = create_nomad_metadata_yaml(
        experiment_id=experiment_id,
        user_name="Tester",
        session=_session(_experiment_orm(experiment_id)),
        experiment_snapshot=experiment_snapshot,
        process_snapshot=process_snapshot,
    )

    _routine, steps = _steps_of(archives)
    material = steps[0]["material"]
    assert material["name"] == "Perovskite precursor"
    assert material["supplier"] == "AB-1"
    # 461.01 mg / 461.01 g/mol = 1 mmol in 1 mL → 1.0 mol/l
    assert material["concentration"] == 1.0

    # ...and the perovskite-database sections see the same chemistry.
    sample = next(v["data"] for k, v in archives.items() if "_sample." in k)
    deposition = sample["perovskite_deposition"]
    assert deposition["solvents"] == "DMF; DMSO"
    assert deposition["reaction_solutions_compounds"] == "PbI2"
    # 461.01 mg in 1 mL of solvent → 461.01 mg/ml
    assert "461.01" in deposition["reaction_solutions_concentrations"]
    # DMF:DMSO = 4:1 of 1 mL → 0.8 mL : 0.2 mL
    assert deposition["solvents_mixing_ratios"] == "0.8; 0.2"


def test_solution_volume_is_converted_from_the_guis_microlitres_to_millilitres():
    experiment_id = str(uuid.uuid4())
    process_snapshot = _process(
        [
            {
                "index": 0,
                "alternatives": [
                    _step(
                        "s0",
                        "Spin",
                        solutionVolume="50",
                        depositionMethod="Spin coating",
                    )
                ],
            }
        ]
    )
    experiment_snapshot = {
        "id": experiment_id,
        "name": "E",
        "architecture": "n-i-p",
        "substrateMaterial": "Glass",
        "devicesPerSubstrate": 1,
        "deviceArea": 0.09,
        "processingTimes": {"stage:0": "2026-05-19T10:00"},
        "substrates": [{"id": "sub-1", "name": "sub-1"}],
    }

    archives = create_nomad_metadata_yaml(
        experiment_id=experiment_id,
        user_name="Tester",
        session=_session(_experiment_orm(experiment_id)),
        experiment_snapshot=experiment_snapshot,
        process_snapshot=process_snapshot,
    )

    _routine, steps = _steps_of(archives)
    # The GUI collects µL; the NOMAD quantity is millilitre.
    assert steps[0]["solution_volume"] == 0.05
    # The method goes in its own field, not only into the step's name.
    assert steps[0]["deposition_method"] == "Spin coating"
    assert steps[0]["name"] == "Spin"
