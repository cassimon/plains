"""Tests for NOMAD quenching parameter generation with new schema."""

from types import SimpleNamespace
import uuid

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


def _orm_material(d):
    """Convert the camelCase material dict used by these tests into an
    ORM-shaped object matching what create_nomad_metadata_yaml reads from
    the normalised lab_material table."""
    from types import SimpleNamespace

    return SimpleNamespace(
        id=d["id"],
        name=d.get("name"),
        type=d.get("type"),
        cas_number=d.get("casNumber"),
        pubchem_cid=d.get("pubchemCid"),
        molecular_weight=d.get("molecularWeight"),
        density=d.get("density"),
        supplier=d.get("supplier"),
        supplier_number=d.get("supplierNumber"),
        purity=d.get("purity"),
        state_at_rt=d.get("stateAtRt"),
        height_mm=d.get("heightMm"),
    )


def _orm_solution(d):
    """Same as _orm_material, for lab_solution rows with components."""
    from types import SimpleNamespace

    return SimpleNamespace(
        id=d["id"],
        name=d.get("name"),
        type=d.get("type"),
        components=[
            SimpleNamespace(
                material_id=c.get("materialId"),
                solution_ref_id=c.get("solutionId"),
                amount=c.get("amount"),
                unit=c.get("unit"),
            )
            for c in d.get("components") or []
        ],
    )


def test_gas_quenching_parameters():
    """Test that gas quenching parameters are correctly extracted into the gas subsection."""
    owner_id = uuid.uuid4()
    experiment_id = str(uuid.uuid4())

    experiment = SimpleNamespace(
        id=uuid.UUID(experiment_id),
        owner_id=owner_id,
        name="Gas quenching test",
        description="Testing gas quenching extraction",
        architecture="n-i-p",
        frontend_data=None,
    )

    materials = [
        {
            "id": "mat-substrate",
            "name": "FTO glass",
            "type": "substrate",
            "stateAtRt": "solid",
            "supplier": "Pilkington",
            "heightMm": "1.1",
        },
        {
            "id": "mat-perovskite",
            "name": "MAPbI3",
            "type": "perovskite",
            "stateAtRt": "solid",
        },
    ]

    user_state = SimpleNamespace(
        data={
            "materials": materials,
            "solutions": [],
            "processes": [],
        }
    )

    process_snapshot = {
        "id": "process-1",
        "substrateDimensionsById": {
            "mat-substrate": {
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
                        "id": "step-perovskite",
                        "name": "Perovskite deposition",
                        "stepCategory": "wet_deposition",
                        "materialId": "mat-perovskite",
                        "depositionMethod": {
                            "value": "Spin coating",
                            "mode": "constant",
                        },
                        "dryingMethod": {
                            "value": "type=Gas|gasType=N2|pressure=100000|flowRate=10|height=2.5|nozzleWidth=5|nozzleForm=round",
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
                "pixelAreaCm2": "0.09",
                "layers": [
                    {
                        "id": "substrate-layer",
                        "name": "substrate: Glass/FTO",
                        "isSubstrate": True,
                    },
                    {
                        "id": "step-perovskite",
                        "name": "MAPbI3",
                        "isSubstrate": False,
                        "layerType": "absorber",
                        "thicknessNm": "450",
                        "bandgapEv": "1.55",
                        "perovskiteA": "MA",
                        "perovskiteB": "Pb",
                        "perovskiteX": "I",
                    },
                ],
            }
        ],
    }

    experiment_snapshot = {
        "name": "Gas quenching test",
        "description": "Testing gas quenching",
        "architecture": "n-i-p",
        "substrateMaterial": "Glass/FTO",
        "processId": "process-1",
        "substrates": [{"id": "sub-1", "name": "Substrate 1"}],
        "devicesPerSubstrate": 4,
        "deviceArea": 0.09,
    }

    session = _FakeSession(
        [
            experiment,
            [_orm_material(m) for m in user_state.data["materials"]],
            [_orm_solution(s) for s in user_state.data["solutions"]],
        ]
    )

    # Generate metadata
    result = create_nomad_metadata_yaml(
        experiment_id=experiment_id,
        user_name="Test User",
        session=session,
        experiment_snapshot=experiment_snapshot,
        process_snapshot=process_snapshot,
    )

    # Find a sample archive
    sample_archives = [k for k in result.keys() if "sample.archive.yaml" in k]
    assert len(sample_archives) > 0, "No sample archives generated"

    sample_data = result[sample_archives[0]]["data"]

    # Check that perovskite_deposition exists
    assert "perovskite_deposition" in sample_data, "No perovskite_deposition section"

    perovskite_deposition = sample_data["perovskite_deposition"]

    # Check that quenching_parameters exists
    assert "quenching_parameters" in perovskite_deposition, (
        "No quenching_parameters section"
    )

    quenching_params = perovskite_deposition["quenching_parameters"]

    # Check that gas subsection exists
    assert "gas" in quenching_params, "No gas quenching parameters"

    gas_params = quenching_params["gas"]

    # Verify gas parameters
    assert gas_params["gas_type"] == "N2", (
        f"Expected gas_type=N2, got {gas_params.get('gas_type')}"
    )
    assert gas_params["pressure"] == 100000, (
        f"Expected pressure=100000, got {gas_params.get('pressure')}"
    )
    assert gas_params["flow_rate"] == 10, (
        f"Expected flow_rate=10, got {gas_params.get('flow_rate')}"
    )
    assert gas_params["height"] == 2.5, (
        f"Expected height=2.5, got {gas_params.get('height')}"
    )
    assert gas_params["nozzle_width"] == 5, (
        f"Expected nozzle_width=5, got {gas_params.get('nozzle_width')}"
    )
    assert gas_params["nozzle_form"] == "round", (
        f"Expected nozzle_form=round, got {gas_params.get('nozzle_form')}"
    )


def test_antisolvent_quenching_parameters():
    """Test that antisolvent quenching parameters are correctly extracted into the antisolvent subsection."""
    owner_id = uuid.uuid4()
    experiment_id = str(uuid.uuid4())

    experiment = SimpleNamespace(
        id=uuid.UUID(experiment_id),
        owner_id=owner_id,
        name="Antisolvent quenching test",
        description="Testing antisolvent quenching extraction",
        architecture="n-i-p",
        frontend_data=None,
    )

    materials = [
        {
            "id": "mat-substrate",
            "name": "FTO glass",
            "type": "substrate",
            "stateAtRt": "solid",
            "heightMm": "1.1",
        },
        {
            "id": "mat-perovskite",
            "name": "MAPbI3",
            "type": "perovskite",
            "stateAtRt": "solid",
        },
    ]

    user_state = SimpleNamespace(
        data={
            "materials": materials,
            "solutions": [],
            "processes": [],
        }
    )

    process_snapshot = {
        "id": "process-1",
        "substrateDimensionsById": {},
        "stages": [
            {
                "index": 0,
                "alternatives": [
                    {
                        "id": "step-perovskite",
                        "name": "Perovskite deposition",
                        "stepCategory": "wet_deposition",
                        "materialId": "mat-perovskite",
                        "depositionMethod": {
                            "value": "Spin coating",
                            "mode": "constant",
                        },
                        "dryingMethod": {
                            "value": "type=Antisolvent|media=Material:mat-chlorobenzene|depositionMethod=drip|flowRate=50|height=10|volume=100",
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
                        "name": "substrate: Glass/FTO",
                        "isSubstrate": True,
                    },
                    {
                        "id": "step-perovskite",
                        "name": "MAPbI3",
                        "layerType": "absorber",
                        "thicknessNm": "450",
                        "perovskiteA": "MA",
                        "perovskiteB": "Pb",
                        "perovskiteX": "I",
                    },
                ],
            }
        ],
    }

    experiment_snapshot = {
        "name": "Antisolvent quenching test",
        "architecture": "n-i-p",
        "substrateMaterial": "Glass/FTO",
        "processId": "process-1",
        "substrates": [{"id": "sub-1", "name": "Substrate 1"}],
    }

    session = _FakeSession(
        [
            experiment,
            [_orm_material(m) for m in user_state.data["materials"]],
            [_orm_solution(s) for s in user_state.data["solutions"]],
        ]
    )

    result = create_nomad_metadata_yaml(
        experiment_id=experiment_id,
        user_name="Test User",
        session=session,
        experiment_snapshot=experiment_snapshot,
        process_snapshot=process_snapshot,
    )

    sample_archives = [k for k in result.keys() if "sample.archive.yaml" in k]
    assert len(sample_archives) > 0

    sample_data = result[sample_archives[0]]["data"]
    quenching_params = sample_data["perovskite_deposition"]["quenching_parameters"]

    assert "antisolvent" in quenching_params, "No antisolvent quenching parameters"

    antisolvent_params = quenching_params["antisolvent"]

    assert "media" in antisolvent_params
    assert antisolvent_params["deposition_method"] == "drip"
    assert antisolvent_params["flow_rate"] == 50
    assert antisolvent_params["height"] == 10
    assert antisolvent_params["volume"] == 100


def test_vacuum_quenching_parameters():
    """Test that vacuum quenching parameters are correctly extracted into the vacuum subsection."""
    owner_id = uuid.uuid4()
    experiment_id = str(uuid.uuid4())

    experiment = SimpleNamespace(
        id=uuid.UUID(experiment_id),
        owner_id=owner_id,
        name="Vacuum quenching test",
        description="Testing vacuum quenching extraction",
        architecture="n-i-p",
        frontend_data=None,
    )

    materials = [
        {
            "id": "mat-perovskite",
            "name": "MAPbI3",
            "type": "perovskite",
            "stateAtRt": "solid",
        },
    ]

    user_state = SimpleNamespace(
        data={
            "materials": materials,
            "solutions": [],
            "processes": [],
        }
    )

    process_snapshot = {
        "id": "process-1",
        "substrateDimensionsById": {},
        "stages": [
            {
                "index": 0,
                "alternatives": [
                    {
                        "id": "step-perovskite",
                        "name": "Perovskite deposition",
                        "stepCategory": "wet_deposition",
                        "materialId": "mat-perovskite",
                        "depositionMethod": {
                            "value": "Spin coating",
                            "mode": "constant",
                        },
                        "dryingMethod": {
                            "value": "type=Vacuum|height=5|baseArea=20|pumpModel=EdwardsPump|deadVolume=0.001|evacuationTime=30",
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
                        "name": "substrate: Glass/FTO",
                        "isSubstrate": True,
                    },
                    {
                        "id": "step-perovskite",
                        "name": "MAPbI3",
                        "layerType": "absorber",
                        "thicknessNm": "450",
                        "perovskiteA": "MA",
                        "perovskiteB": "Pb",
                        "perovskiteX": "I",
                    },
                ],
            }
        ],
    }

    experiment_snapshot = {
        "name": "Vacuum quenching test",
        "architecture": "n-i-p",
        "substrateMaterial": "Glass/FTO",
        "processId": "process-1",
        "substrates": [{"id": "sub-1", "name": "Substrate 1"}],
    }

    session = _FakeSession(
        [
            experiment,
            [_orm_material(m) for m in user_state.data["materials"]],
            [_orm_solution(s) for s in user_state.data["solutions"]],
        ]
    )

    result = create_nomad_metadata_yaml(
        experiment_id=experiment_id,
        user_name="Test User",
        session=session,
        experiment_snapshot=experiment_snapshot,
        process_snapshot=process_snapshot,
    )

    sample_archives = [k for k in result.keys() if "sample.archive.yaml" in k]
    assert len(sample_archives) > 0

    sample_data = result[sample_archives[0]]["data"]
    quenching_params = sample_data["perovskite_deposition"]["quenching_parameters"]

    assert "vacuum" in quenching_params, "No vacuum quenching parameters"

    vacuum_params = quenching_params["vacuum"]

    assert vacuum_params["height"] == 5
    assert vacuum_params["base_area"] == 20
    assert vacuum_params["pump_model"] == "EdwardsPump"
    assert vacuum_params["dead_volume"] == 0.001
    assert vacuum_params["evacuation_time"] == 30


def test_antisolvent_quenching_with_units_and_media_reference():
    """Test antisolvent quenching with units (frontend format) and material reference."""
    owner_id = uuid.uuid4()
    experiment_id = str(uuid.uuid4())
    material_id = "b5fc5eb1-0923-4aca-b39e-8f7f6123c4a3"

    experiment = SimpleNamespace(
        id=uuid.UUID(experiment_id),
        owner_id=owner_id,
        name="Antisolvent quenching with units test",
        description="Testing antisolvent with units",
        architecture="n-i-p",
        frontend_data=None,
    )

    materials = [
        {
            "id": "mat-substrate",
            "name": "FTO glass",
            "type": "substrate",
            "stateAtRt": "solid",
            "supplier": "Pilkington",
            "heightMm": "1.1",
        },
        {
            "id": "mat-perovskite",
            "name": "MAPbI3",
            "type": "perovskite",
            "stateAtRt": "solid",
        },
        {
            "id": material_id,
            "name": "Chlorobenzene",
            "type": "solvent",
            "stateAtRt": "liquid",
            "supplier": "Sigma-Aldrich",
            "purity": "99.8%",
        },
    ]

    user_state = SimpleNamespace(
        data={
            "materials": materials,
            "solutions": [],
            "processes": [],
        }
    )

    # Frontend format with units and material reference
    quenching_string = f"type=Antisolvent|media=material:{material_id}|depositionMethod=drip|flowRate=100 ul/s|height=10 mm|volume=200 mL"

    process_snapshot = {
        "id": "process-1",
        "substrateDimensionsById": {
            "mat-substrate": {
                "lengthCm": "2",
                "widthCm": "2",
            }
        },
        "stages": [
            {
                "index": 0,
                "alternatives": [
                    {
                        "id": "step-perovskite",
                        "name": "Perovskite deposition",
                        "stepCategory": "wet_deposition",
                        "materialId": "mat-perovskite",
                        "depositionMethod": {
                            "value": "Spin coating",
                            "mode": "constant",
                        },
                        "dryingMethod": {
                            "value": quenching_string,
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
                "pixelAreaCm2": "0.09",
                "layers": [
                    {
                        "id": "substrate-layer",
                        "name": "substrate: Glass/FTO",
                        "isSubstrate": True,
                    },
                    {
                        "id": "step-perovskite",
                        "name": "MAPbI3",
                        "isSubstrate": False,
                        "layerType": "absorber",
                        "thicknessNm": "450",
                        "bandgapEv": "1.55",
                        "perovskiteA": "MA",
                        "perovskiteB": "Pb",
                        "perovskiteX": "I",
                    },
                ],
            }
        ],
    }

    experiment_snapshot = {
        "name": "Antisolvent quenching test",
        "description": "Testing antisolvent with units",
        "architecture": "n-i-p",
        "substrateMaterial": "Glass/FTO",
        "processId": "process-1",
        "substrates": [{"id": "sub-1", "name": "Substrate 1"}],
        "devicesPerSubstrate": 4,
        "deviceArea": 0.09,
    }

    session = _FakeSession(
        [
            experiment,
            [_orm_material(m) for m in user_state.data["materials"]],
            [_orm_solution(s) for s in user_state.data["solutions"]],
        ]
    )

    result = create_nomad_metadata_yaml(
        experiment_id=experiment_id,
        user_name="Test User",
        session=session,
        experiment_snapshot=experiment_snapshot,
        process_snapshot=process_snapshot,
    )

    sample_archives = [k for k in result.keys() if "sample.archive.yaml" in k]
    assert len(sample_archives) > 0

    sample_data = result[sample_archives[0]]["data"]
    quenching_params = sample_data["perovskite_deposition"]["quenching_parameters"]

    assert "antisolvent" in quenching_params, "No antisolvent quenching parameters"

    antisolvent_params = quenching_params["antisolvent"]

    # Media should be resolved to material name, not the ID
    assert antisolvent_params["media"] == "Chlorobenzene", (
        f"Expected 'Chlorobenzene', got {antisolvent_params['media']}"
    )
    assert antisolvent_params["deposition_method"] == "drip"
    # Values are converted into the unit the NOMAD quantity declares, since a
    # bare number in the archive YAML is read *in that unit*.
    assert antisolvent_params["flow_rate"] == 100.0  # "100 ul/s" → microliter/second
    assert antisolvent_params["height"] == 10.0  # "10 mm"     → millimeter
    assert antisolvent_params["volume"] == 200_000.0  # "200 mL"    → microliter
