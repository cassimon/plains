from types import SimpleNamespace
import uuid

from app.services.nomad import create_nomad_metadata_yaml


class _FakeResult:
    def __init__(self, value):
        self._value = value

    def first(self):
        return self._value


class _FakeSession:
    def __init__(self, values):
        self._values = iter(values)

    def exec(self, _statement):
        return _FakeResult(next(self._values))


def test_create_nomad_metadata_yaml_uses_solution_components_for_wet_layers():
    owner_id = uuid.uuid4()
    experiment_id = str(uuid.uuid4())

    experiment = SimpleNamespace(
        id=uuid.UUID(experiment_id),
        owner_id=owner_id,
        name="Wet stack experiment",
        description="",
        architecture="n-i-p",
        frontend_data=None,
    )

    materials = [
        {
            "id": "mat-sub",
            "name": "FTO glass",
            "type": "substrate",
            "stateAtRt": "solid",
            "supplier": "Pilkington",
            "supplierNumber": "TEC15",
            "heightMm": "1.1",
        },
        {
            "id": "mat-solvent-dmf",
            "name": "DMF",
            "type": "solvent",
            "stateAtRt": "liquid",
            "supplier": "Sigma",
            "purity": "99.8%",
        },
        {
            "id": "mat-solvent-dmso",
            "name": "DMSO",
            "type": "solvent",
            "stateAtRt": "liquid",
            "supplier": "Alfa",
            "purity": "99.9%",
        },
        {
            "id": "mat-etl",
            "name": "SnO2",
            "type": "etl",
            "stateAtRt": "solid",
            "supplier": "Merck",
            "purity": "99%",
        },
    ]
    solutions = [
        {
            "id": "solution-etl",
            "name": "SnO2 precursor",
            "components": [
                {"id": "comp-1", "materialId": "mat-etl", "amount": "15", "unit": "mg"},
                {
                    "id": "comp-2",
                    "materialId": "mat-solvent-dmf",
                    "amount": "1.0",
                    "unit": "ml",
                },
                {
                    "id": "comp-3",
                    "materialId": "mat-solvent-dmso",
                    "amount": "0.1",
                    "unit": "ml",
                },
            ],
        }
    ]
    user_state = SimpleNamespace(
        data={
            "materials": materials,
            "solutions": solutions,
            "processes": [],
        }
    )
    session = _FakeSession([experiment, user_state])

    process_snapshot = {
        "id": "process-1",
        "substrateDimensionsById": {
            "mat-sub": {
                "lengthCm": "2",
                "widthCm": "2",
                "surfaceRoughnessRmsNm": "12.5",
            }
        },
        "stages": [
            {
                "index": 0,
                "alternatives": [
                    {
                        "id": "step-clean",
                        "name": "Substrate cleaning",
                        "stepCategory": "substrate_preparation",
                        "depositionMethod": {
                            "value": "Soap >> Ultrasonic bath >> UV-Ozone",
                            "mode": "constant",
                        },
                    }
                ],
            },
            {
                "index": 1,
                "alternatives": [
                    {
                        "id": "step-etl",
                        "name": "SnO2 deposition",
                        "stepCategory": "wet_deposition",
                        "materialId": "mat-etl",
                        "solutionId": "solution-etl",
                        "depositionMethod": {
                            "value": "Spin coating",
                            "mode": "constant",
                        },
                        "solutionVolume": {"value": "50", "mode": "constant"},
                    }
                ],
            },
        ],
        "generatedStacks": [
            {
                "combination": 1,
                "layers": [
                    {
                        "id": "substrate-layer",
                        "name": "substrate: Glass/ITO",
                        "isSubstrate": True,
                        "layerType": "",
                        "thicknessNm": "",
                        "bandgapEv": "",
                        "perovskiteA": "",
                        "perovskiteB": "",
                        "perovskiteX": "",
                    },
                    {
                        "id": "step-etl",
                        "name": "SnO2",
                        "isSubstrate": False,
                        "layerType": "ETL",
                        "thicknessNm": "30",
                        "bandgapEv": "",
                        "perovskiteA": "",
                        "perovskiteB": "",
                        "perovskiteX": "",
                    },
                ],
            }
        ],
        "deletedStackCombinations": [],
    }
    experiment_snapshot = {
        "id": experiment_id,
        "name": "Wet stack experiment",
        "description": "",
        "architecture": "n-i-p",
        "substrateMaterial": "substrate: Glass/ITO",
        "devicesPerSubstrate": 1,
        "deviceArea": 0.09,
        "substrates": [
            {"id": "sub-1", "name": "sub-1", "substrateMaterialId": "mat-sub"}
        ],
    }

    archives = create_nomad_metadata_yaml(
        experiment_id=experiment_id,
        user_name="Tester",
        session=session,
        experiment_snapshot=experiment_snapshot,
        process_snapshot=process_snapshot,
    )

    sample_archive = archives["sub-1_dev1_sample.archive.yaml"]["data"]

    assert sample_archive["name"] == "sub-1 device 1"
    assert sample_archive["lab_id"] == "sub-1_dev1"
    assert sample_archive["substrate"]["stack_sequence"] == "Glass | ITO"
    assert sample_archive["substrate"]["area"] == 4.0
    assert sample_archive["substrate"]["thickness"] == 1.1
    assert sample_archive["substrate"]["supplier"] == "Pilkington"
    assert sample_archive["substrate"]["brand_name"] == "TEC15"
    assert sample_archive["substrate"]["surface_roughness_rms"] == 12.5
    assert (
        sample_archive["substrate"]["cleaning_procedure"]
        == "Soap >> Ultrasonic bath >> UV-Ozone"
    )
    assert sample_archive["etl"]["stack_sequence"] == "SnO2"
    assert sample_archive["etl"]["deposition_solvents"] == "DMF; DMSO"
    assert sample_archive["etl"]["deposition_reaction_solutions_compounds"] == "SnO2"
    assert "mg" in sample_archive["etl"]["deposition_reaction_solutions_concentrations"]


def test_create_nomad_metadata_yaml_formats_perovskite_ions_and_coefficients():
    owner_id = uuid.uuid4()
    experiment_id = str(uuid.uuid4())

    experiment = SimpleNamespace(
        id=uuid.UUID(experiment_id),
        owner_id=owner_id,
        name="Perovskite formatting experiment",
        description="",
        architecture="n-i-p",
        frontend_data=None,
    )

    user_state = SimpleNamespace(
        data={"materials": [], "solutions": [], "processes": []}
    )
    session = _FakeSession([experiment, user_state])

    process_snapshot = {
        "id": "process-2",
        "stages": [
            {
                "index": 0,
                "alternatives": [
                    {
                        "id": "step-absorber",
                        "name": "Perovskite deposition",
                        "stepCategory": "wet_deposition",
                        "depositionMethod": {
                            "value": "Spin coating",
                            "mode": "constant",
                        },
                    }
                ],
            }
        ],
        "generatedStacks": [
            {
                "combination": 1,
                "layers": [
                    {
                        "id": "substrate-layer",
                        "name": "Glass/ITO",
                        "isSubstrate": True,
                        "layerType": "",
                        "thicknessNm": "",
                        "bandgapEv": "",
                        "perovskiteA": "",
                        "perovskiteB": "",
                        "perovskiteX": "",
                    },
                    {
                        "id": "step-absorber",
                        "name": "Perovskite",
                        "isSubstrate": False,
                        "layerType": "absorber",
                        "thicknessNm": "500",
                        "bandgapEv": "1.58",
                        "perovskiteA": "Cs0.1FA0.9",
                        "perovskiteB": "Sn0.2Pb0.8",
                        "perovskiteX": "I0.75Br0.25",
                    },
                ],
            }
        ],
        "deletedStackCombinations": [],
    }
    experiment_snapshot = {
        "id": experiment_id,
        "name": "Perovskite formatting experiment",
        "description": "",
        "architecture": "n-i-p",
        "substrateMaterial": "Glass/ITO",
        "devicesPerSubstrate": 1,
        "deviceArea": 0.09,
        "substrates": [{"id": "sub-1", "name": "sub-1"}],
    }

    archives = create_nomad_metadata_yaml(
        experiment_id=experiment_id,
        user_name="Tester",
        session=session,
        experiment_snapshot=experiment_snapshot,
        process_snapshot=process_snapshot,
    )

    sample_archive = archives["sub-1_dev1_sample.archive.yaml"]["data"]
    perovskite = sample_archive["perovskite"]

    assert perovskite["dimension_3D"] is True
    assert perovskite["dimension_list_of_layers"] == "3.0"
    assert perovskite["composition_perovskite_ABC3_structure"] is True
    assert perovskite["composition_a_ions"] == "Cs; FA"
    assert perovskite["composition_a_ions_coefficients"] == "0.1; 0.9"
    assert perovskite["composition_b_ions"] == "Sn; Pb"
    assert perovskite["composition_b_ions_coefficients"] == "0.2; 0.8"
    assert perovskite["composition_c_ions"] == "I; Br"
    assert perovskite["composition_c_ions_coefficients"] == "0.75; 0.25"


def test_create_nomad_metadata_yaml_generates_substrate_and_deposition_and_per_pixel_samples():
    owner_id = uuid.uuid4()
    experiment_id = str(uuid.uuid4())

    experiment = SimpleNamespace(
        id=uuid.UUID(experiment_id),
        owner_id=owner_id,
        name="Pixel-mapped experiment",
        description="",
        architecture="n-i-p",
        frontend_data=None,
    )

    user_state = SimpleNamespace(
        data={
            "materials": [
                {
                    "id": "mat-sub",
                    "name": "Glass/ITO",
                    "type": "substrate",
                    "stateAtRt": "solid",
                    "supplier": "Vendor",
                    "supplierNumber": "S-1",
                    "heightMm": "1.0",
                }
            ],
            "solutions": [],
            "processes": [],
        }
    )
    session = _FakeSession([experiment, user_state])

    process_snapshot = {
        "id": "process-pixels",
        "stages": [
            {
                "index": 0,
                "alternatives": [
                    {
                        "id": "step-etl",
                        "name": "ETL deposition",
                        "stepCategory": "wet_deposition",
                        "depositionMethod": {
                            "value": "Spin coating",
                            "mode": "constant",
                        },
                    }
                ],
            }
        ],
        "generatedStacks": [
            {
                "combination": 1,
                "numberOfPixels": "4",
                "pixelAreaCm2": "0.16",
                "layers": [
                    {
                        "id": "substrate-layer",
                        "name": "Glass/ITO",
                        "isSubstrate": True,
                        "layerType": "",
                        "thicknessNm": "",
                        "bandgapEv": "",
                        "perovskiteA": "",
                        "perovskiteB": "",
                        "perovskiteX": "",
                    },
                    {
                        "id": "step-etl",
                        "name": "SnO2",
                        "isSubstrate": False,
                        "layerType": "ETL",
                        "thicknessNm": "30",
                        "bandgapEv": "",
                        "perovskiteA": "",
                        "perovskiteB": "",
                        "perovskiteX": "",
                    },
                ],
            }
        ],
        "deletedStackCombinations": [],
    }

    experiment_snapshot = {
        "id": experiment_id,
        "name": "Pixel-mapped experiment",
        "description": "",
        "architecture": "n-i-p",
        "substrateMaterial": "Glass/ITO",
        "devicesPerSubstrate": 1,
        "deviceArea": 0.09,
        "date": "2026-05-19T10:00",
        "processingTimes": {"stage:0": "2026-05-19T11:00"},
        "substrates": [
            {
                "id": "sub-1",
                "name": "sub-1",
                "substrateMaterialId": "mat-sub",
                "parameterValues": {"stageSelection:0": "step-etl"},
            }
        ],
    }

    device_groups = [
        {
            "id": f"group-{i}",
            "deviceName": f"dev-{i}",
            "assignedSubstrateId": "sub-1",
            "files": [
                {
                    "fileName": f"pixel_{i}.txt",
                    "fileType": "JV",
                    "value": 20.0 + i,
                }
            ],
        }
        for i in range(1, 5)
    ]

    archives = create_nomad_metadata_yaml(
        experiment_id=experiment_id,
        user_name="Tester",
        session=session,
        experiment_snapshot=experiment_snapshot,
        process_snapshot=process_snapshot,
        device_groups=device_groups,
    )

    substrate_file = "sub-1_substrate.archive.yaml"
    deposition_file = "sub-1_deposition.archive.yaml"
    sample_files = [f"sub-1_dev{i}_sample.archive.yaml" for i in range(1, 5)]
    measurement_files = [f"pixel_{i}.archive.yaml" for i in range(1, 5)]

    assert substrate_file in archives
    assert deposition_file in archives
    for sample_file in sample_files:
        assert sample_file in archives
    for meas_file in measurement_files:
        assert meas_file in archives

    assert archives["sub-1_dev1_sample.archive.yaml"]["data"]["name"] == "dev-1"
    assert archives["sub-1_dev1_sample.archive.yaml"]["data"]["lab_id"] == "group-1"
    assert archives["sub-1_dev4_sample.archive.yaml"]["data"]["name"] == "dev-4"
    assert archives["sub-1_dev4_sample.archive.yaml"]["data"]["lab_id"] == "group-4"

    for meas_file in measurement_files:
        meas_data = archives[meas_file]["data"]
        assert "samples" in meas_data
        assert len(meas_data["samples"]) == 1

    deposition_data = archives[deposition_file]["data"]
    assert "samples" in deposition_data
    substrate_ref = f"../upload/raw/{substrate_file}#/data"
    assert deposition_data["samples"][0]["reference"] == substrate_ref
    assert len(deposition_data["steps"]) == 1
    assert deposition_data["steps"][0]["step_type"] == "Wet Deposition"
