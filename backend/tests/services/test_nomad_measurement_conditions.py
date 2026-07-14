"""The measurement archives must carry the conditions the raw files omit.

The CHOSE instrument exports state the cell area but *never* the illumination
intensity — yet NOMAD's solar cell schema needs it (efficiency is measured
against it). The app supplies both; a file header that states one wins over what
we send (see nomad_chose's build_jv_dict).
"""

import uuid
from types import SimpleNamespace

import pytest

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


def _archives(files, device_area=0.09):
    experiment_id = str(uuid.uuid4())
    experiment_orm = SimpleNamespace(
        id=uuid.UUID(experiment_id),
        owner_id=uuid.uuid4(),
        process_id=None,
        name="E",
        description="",
        architecture="n-i-p",
        substrate_material="Glass",
        devices_per_substrate=1,
        device_area=device_area,
    )
    experiment_snapshot = {
        "id": experiment_id,
        "name": "E",
        "architecture": "n-i-p",
        "substrateMaterial": "Glass",
        "devicesPerSubstrate": 1,
        "deviceArea": device_area,
        "substrates": [{"id": "sub-1", "name": "AI03-1A"}],
    }
    device_groups = [
        {
            "id": "grp-1",
            "deviceName": "AI03-1A device 1",
            "assignedSubstrateId": "sub-1",
            "files": files,
        }
    ]
    return create_nomad_metadata_yaml(
        experiment_id=experiment_id,
        user_name="Tester",
        session=_FakeSession([experiment_orm, [], []]),
        experiment_snapshot=experiment_snapshot,
        process_snapshot={"id": "p", "name": "P", "stages": [], "generatedStacks": []},
        measurement_files=files,
        device_groups=device_groups,
    )


def _measurement(archives, marker):
    for archive in archives.values():
        data = archive.get("data", {})
        if marker in str(data.get("m_def", "")):
            return data
    return None


def _sample_jv(archives):
    return _measurement(archives, "PerovskiteSolarCellSampleArea")["jv"]


def test_jv_archive_carries_area_and_illumination():
    archives = _archives(
        [
            {
                "fileName": "scan.txt",
                "fileType": "Stability (JV)",
                "illuminationIntensity": 100.0,
            }
        ]
    )
    jv = _measurement(archives, "LabJVMeasurement")

    assert jv is not None
    assert jv["active_area"] == pytest.approx(0.09)
    assert jv["intensity"] == pytest.approx(100.0)


def test_a_non_standard_illumination_is_carried_through():
    """A measurement taken at half a sun must not be recorded as 1 sun."""
    archives = _archives(
        [
            {
                "fileName": "scan.txt",
                "fileType": "JV",
                "illuminationIntensity": 50.0,
            }
        ]
    )
    assert _measurement(archives, "LabJVMeasurement")["intensity"] == pytest.approx(
        50.0
    )


def _stability_runs(archives):
    return [
        data
        for data in (a.get("data", {}) for a in archives.values())
        if "LabStabilityMeasurement" in str(data.get("m_def", ""))
    ]


def test_a_stability_run_is_one_measurement_not_two():
    """The instrument exports a stability run as two files -- (Parameters) and
    (Tracking) -- which are two halves of a single MPPTracking measurement: the
    track, and the JV parameters sampled along it.

    One entry per *file* produced two half-empty measurements. baseclasses derives
    the figures of merit (T80/T95) from the track, so the (Parameters) half carried
    no results at all, while the (Tracking) half lost the JV parameters.
    """
    archives = _archives(
        [
            {
                "fileName": "0000_Stability (Parameters)_AI03-1A.txt",
                "fileType": "Stability (Parameters)",
            },
            {
                "fileName": "0000_Stability (Tracking)_AI03-1A.txt",
                "fileType": "Stability (Tracking)",
            },
        ]
    )

    runs = _stability_runs(archives)
    assert len(runs) == 1

    run = runs[0]
    assert run["stability_parameters_file"] == "0000_Stability (Parameters)_AI03-1A.txt"
    assert run["stability_tracking_file"] == "0000_Stability (Tracking)_AI03-1A.txt"


def test_two_stability_runs_stay_two_measurements():
    """Only the halves of the *same* run are merged."""
    archives = _archives(
        [
            {
                "fileName": f"{index}_Stability ({half})_AI03-1A.txt",
                "fileType": f"Stability ({half})",
            }
            for index in ("0000", "0001")
            for half in ("Parameters", "Tracking")
        ]
    )

    runs = _stability_runs(archives)
    assert len(runs) == 2
    assert all(
        run["stability_parameters_file"] and run["stability_tracking_file"]
        for run in runs
    )


def test_half_a_stability_run_still_yields_a_measurement():
    """A track exported without its parameters is still a measurement."""
    archives = _archives(
        [{"fileName": "track.txt", "fileType": "Stability (Tracking)"}]
    )

    run = _stability_runs(archives)[0]
    assert run["stability_tracking_file"] == "track.txt"
    assert "stability_parameters_file" not in run


def test_stability_archive_carries_the_conditions_too():
    archives = _archives(
        [
            {
                "fileName": "track.txt",
                "fileType": "Stability (Tracking)",
                "illuminationIntensity": 100.0,
            }
        ]
    )
    stability = _measurement(archives, "LabStabilityMeasurement")

    assert stability["active_area"] == pytest.approx(0.09)
    assert stability["intensity"] == pytest.approx(100.0)


def test_eqe_takes_the_area_but_not_an_intensity():
    """LabEQEMeasurement has an active_area; an `intensity` key would be silently
    dropped by NOMAD, so we must not emit one."""
    archives = _archives(
        [
            {
                "fileName": "ipce.txt",
                "fileType": "IPCE",
                "illuminationIntensity": 100.0,
            }
        ]
    )
    eqe = _measurement(archives, "LabEQEMeasurement")

    assert eqe["active_area"] == pytest.approx(0.09)
    assert "intensity" not in eqe


def test_no_illumination_supplied_means_none_is_stated():
    """We never invent one here: the plugin owns the 1-sun default, so that a file
    header that does state the illumination can still win."""
    archives = _archives([{"fileName": "scan.txt", "fileType": "JV"}])
    assert "intensity" not in _measurement(archives, "LabJVMeasurement")


def test_the_measurement_archive_is_named_after_its_raw_file():
    """nomad_chose skips a raw file when `<raw name>.archive.yaml` sits beside it,
    so that this — the richer entry — is the only entry for the measurement. The
    name is therefore load-bearing: a slug would not be found, and every
    measurement would be parsed twice and counted twice."""
    archives = _archives(
        [{"fileName": "0001_Stability (JV)_AI03-1A.txt", "fileType": "Stability (JV)"}]
    )

    assert "0001_Stability (JV)_AI03-1A.txt.archive.yaml" in archives


def test_the_sample_states_the_fill_factor_as_a_fraction():
    """The database's default_FF is a fraction; the app carries a percent.

    Passing the app's 25.38 straight through made NOMAD read a 2538 % fill
    factor.
    """
    archives = _archives(
        [
            {
                "fileName": "scan.txt",
                "fileType": "JV",
                "value": 3.67,
                "voc": 0.54,
                "jsc": 20.84,
                "ff": 32.61,
            }
        ]
    )
    jv = _sample_jv(archives)

    assert jv["default_FF"] == pytest.approx(0.3261)
    assert jv["default_PCE"] == pytest.approx(3.67)


def test_the_sample_jv_states_the_illumination_it_was_measured_under():
    """A PCE with no illumination beside it cannot be interpreted."""
    files = [{"fileName": "scan.txt", "fileType": "JV", "value": 3.67}]
    # Not supplied → 1 sun, AM 1.5G.
    assert _sample_jv(_archives(files))["light_intensity"] == pytest.approx(100.0)

    files[0]["illuminationIntensity"] = 50.0
    assert _sample_jv(_archives(files))["light_intensity"] == pytest.approx(50.0)
