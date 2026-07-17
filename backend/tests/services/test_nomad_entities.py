"""The material / solution ELN entities emitted alongside the sample archives.

Each app material and solution used by an experiment becomes its own NOMAD entry
(`PlainsMaterial` / `PlainsSolution`), and the deposition steps reference them.
These tests exercise the emission and the reference wiring end to end through
`create_nomad_metadata_yaml`, against the same fake-session harness the metadata
generation tests use.
"""

import datetime
import uuid

from app.services.nomad import create_nomad_metadata_yaml
from tests.services.test_nomad_metadata_generation import (
    _FakeSession,
    _orm_material,
    _orm_solution,
)

MATERIAL_MDEF = (
    'nomad_perovskite_solar_cell_sample_plains.schema_packages.chemicals.PlainsMaterial'
)
SOLUTION_MDEF = (
    'nomad_perovskite_solar_cell_sample_plains.schema_packages.chemicals.PlainsSolution'
)


def _experiment(experiment_id, owner_id, name):
    from types import SimpleNamespace

    return SimpleNamespace(
        id=uuid.UUID(experiment_id),
        owner_id=owner_id,
        name=name,
        description="",
        architecture="n-i-p",
        frontend_data=None,
    )


def _run(experiment_snapshot, process_snapshot, materials, solutions):
    experiment_id = experiment_snapshot["id"]
    owner_id = uuid.uuid4()
    experiment = _experiment(experiment_id, owner_id, experiment_snapshot["name"])
    session = _FakeSession(
        [
            experiment,
            [_orm_material(m) for m in materials],
            [_orm_solution(s) for s in solutions],
        ]
    )
    return create_nomad_metadata_yaml(
        experiment_id=experiment_id,
        user_name="Tester",
        session=session,
        experiment_snapshot=experiment_snapshot,
        process_snapshot=process_snapshot,
    )


def _find(archives, suffix):
    return {name: body for name, body in archives.items() if name.endswith(suffix)}


def _by_mdef(archives, mdef):
    return {
        name: body
        for name, body in archives.items()
        if body["data"].get("m_def") == mdef
    }


def _deposition_steps(archives):
    for name, body in archives.items():
        if name.endswith("_deposition.archive.yaml"):
            return body["data"]["steps"]
    return []


def test_lab_solution_and_materials_emit_linked_eln_entities():
    experiment_id = str(uuid.uuid4())

    materials = [
        {
            "id": "mat-sub",
            "name": "FTO glass",
            "type": "substrate",
            "stateAtRt": "solid",
        },
        {
            "id": "mat-pbi2",
            "name": "PbI2",
            "type": "salt",
            "category": "lead salt",
            "stateAtRt": "solid",
            "casNumber": "13462-72-8",
            "pubchemCid": "24956",
            "molecularWeight": 461.0,
            "density": 6.16,
            "supplier": "TCI",
            "supplierNumber": "L0279",
            "inventoryLabel": "INV-PBI2",
            "purity": "99.99%",
            "notes": "moisture sensitive",
        },
        {
            "id": "mat-dmf",
            "name": "DMF",
            "type": "solvent",
            "stateAtRt": "liquid",
            "supplier": "Sigma",
        },
    ]
    solutions = [
        {
            "id": "sol-stock",
            "name": "PbI2 stock",
            "creationTime": datetime.datetime(2026, 3, 1, 9, 30),
            "handling": "Prepared in glovebox",
            "storage": "N2 fridge",
            "notes": "keep cold",
            "components": [
                {"materialId": "mat-pbi2", "amount": "1.4", "unit": "mol"},
            ],
        },
        {
            "id": "sol-main",
            "name": "Perovskite ink",
            "components": [
                {"materialId": "mat-dmf", "amount": "1.0", "unit": "ml"},
                {"solutionId": "sol-stock", "amount": "0.5", "unit": "ml"},
            ],
        },
    ]

    process_snapshot = {
        "id": "process-1",
        "stages": [
            {
                "index": 0,
                "alternatives": [
                    {
                        "id": "step-pvk",
                        "name": "Perovskite spin",
                        "stepCategory": "wet_deposition",
                        "solutionId": "sol-main",
                        "depositionMethod": {"value": "Spin coating", "mode": "constant"},
                    }
                ],
            }
        ],
        "generatedStacks": [
            {
                "combination": 1,
                "layers": [
                    {
                        "id": "step-pvk",
                        "name": "Perovskite",
                        "isSubstrate": False,
                        "layerType": "absorber",
                        "thicknessNm": "550",
                    }
                ],
            }
        ],
        "deletedStackCombinations": [],
    }
    experiment_snapshot = {
        "id": experiment_id,
        "name": "Ink experiment",
        "description": "",
        "architecture": "n-i-p",
        "substrateMaterial": "substrate: Glass/FTO",
        "devicesPerSubstrate": 1,
        "deviceArea": 0.09,
        "substrates": [
            {"id": "sub-1", "name": "sub-1", "substrateMaterialId": "mat-sub"}
        ],
    }

    archives = _run(experiment_snapshot, process_snapshot, materials, solutions)

    # ── The material entity ──────────────────────────────────────────────────
    material_entries = _by_mdef(archives, MATERIAL_MDEF)
    pbi2 = next(
        body["data"] for body in material_entries.values() if body["data"]["name"] == "PbI2"
    )
    assert pbi2["lab_id"] == "INV-PBI2"  # inventory label, not the UUID
    assert pbi2["cas_number"] == "13462-72-8"
    assert pbi2["molecular_mass"] == 461.0
    assert pbi2["density"] == 6.16
    assert pbi2["state_of_matter"] == "Solid"
    assert pbi2["material_category"] == "lead salt"
    assert pbi2["description"] == "moisture sensitive"
    assert pbi2["substance"]["pub_chem_cid"] == 24956
    assert pbi2["substance"]["load_data"] is False  # never re-fetched during processing
    assert pbi2["product_info"] == {"supplier": "TCI", "product_number": "L0279"}

    # ── The stock solution: a solute with the mol amount, linked to its material ─
    solution_entries = _by_mdef(archives, SOLUTION_MDEF)
    stock_name, stock = next(
        (name, body["data"])
        for name, body in solution_entries.items()
        if body["data"]["name"] == "PbI2 stock"
    )
    assert stock["lab_id"] == "sol-stock"
    assert stock["datetime"] == "2026-03-01T09:30:00"
    assert stock["handling"] == "Prepared in glovebox"
    assert stock["storage"] == [{"storage_condition": "N2 fridge"}]
    assert stock["description"] == "keep cold"
    (solute,) = stock["solute"]
    assert solute["name"] == "PbI2"
    assert solute["amount_mol"] == 1.4  # unit "mol" -> amount_mol
    pbi2_name = next(
        name for name, body in material_entries.items() if body["data"]["name"] == "PbI2"
    )
    assert solute["chemical"].endswith(f"{pbi2_name}#/data")

    # ── The main solution: solvent by volume + a stock sub-solution ──────────
    main = next(
        body["data"]
        for body in solution_entries.values()
        if body["data"]["name"] == "Perovskite ink"
    )
    (solvent,) = main["solvent"]
    assert solvent["name"] == "DMF"
    assert solvent["chemical_volume"] == 1.0  # unit "ml" -> chemical_volume
    (other,) = main["other_solution"]
    assert other["solution"].endswith(f"{stock_name}#/data")  # -> the stock entry
    assert other["solution_volume"] == 0.5

    # ── The step points at the main solution entity ──────────────────────────
    main_name = next(
        name
        for name, body in solution_entries.items()
        if body["data"]["name"] == "Perovskite ink"
    )
    steps = _deposition_steps(archives)
    (deposited,) = [s for s in steps if s.get("material")]
    assert deposited["material"]["solution_reference"].endswith(f"{main_name}#/data")
    # And the layer it produced was recorded on the step.
    assert deposited["layer_name"] == "Perovskite"
    assert deposited["layer_thickness"] == 550.0


def test_commercial_recipe_is_a_material_and_mixed_recipe_is_a_solution():
    experiment_id = str(uuid.uuid4())

    materials = [
        {"id": "mat-sub", "name": "FTO glass", "type": "substrate", "stateAtRt": "solid"},
    ]

    process_snapshot = {
        "id": "process-1",
        "solutionRecipes": [
            {
                "id": "recipe-htl",
                "name": "Spiro cocktail",
                "isCommercial": False,
                "totalSolventVolumeMl": 1.0,
                "solvents": [
                    {"name": "Chlorobenzene", "pubchemCid": "7964", "volumeRatio": 1.0}
                ],
                "solutes": [
                    {"name": "Spiro-OMeTAD", "amount": "72.3", "unit": "mg"},
                ],
                "addedSolutions": [{"recipeId": "recipe-dopant", "volumeMl": 0.02}],
            },
            {
                "id": "recipe-dopant",
                "name": "Li-TFSI stock",
                "isCommercial": False,
                "totalSolventVolumeMl": 1.0,
                "solvents": [
                    {"name": "Acetonitrile", "pubchemCid": "6342", "volumeRatio": 1.0}
                ],
                "solutes": [{"name": "Li-TFSI", "amount": "520", "unit": "mg"}],
                "addedSolutions": [],
            },
            {
                "id": "recipe-buy",
                "name": "PEDOT internal",
                "isCommercial": True,
                "commercialName": "Clevios P VP AI 4083",
                "supplierNumber": "HTL-4083",
                "solvents": [],
                "solutes": [],
                "addedSolutions": [],
            },
        ],
        "stages": [
            {
                "index": 0,
                "alternatives": [
                    {
                        "id": "step-htl",
                        "name": "HTL spin",
                        "stepCategory": "wet_deposition",
                        "chemRecipeId": "recipe-htl",
                        "depositionMethod": {"value": "Spin coating", "mode": "constant"},
                    }
                ],
            },
            {
                "index": 1,
                "alternatives": [
                    {
                        "id": "step-buy",
                        "name": "PEDOT spin",
                        "stepCategory": "wet_deposition",
                        "chemRecipeId": "recipe-buy",
                        "depositionMethod": {"value": "Spin coating", "mode": "constant"},
                    }
                ],
            },
        ],
        "generatedStacks": [],
        "deletedStackCombinations": [],
    }
    experiment_snapshot = {
        "id": experiment_id,
        "name": "Recipe experiment",
        "description": "",
        "architecture": "n-i-p",
        "substrateMaterial": "substrate: Glass/FTO",
        "devicesPerSubstrate": 1,
        "deviceArea": 0.09,
        "substrates": [
            {"id": "sub-1", "name": "sub-1", "substrateMaterialId": "mat-sub"}
        ],
    }

    archives = _run(experiment_snapshot, process_snapshot, materials, [])

    solution_entries = _by_mdef(archives, SOLUTION_MDEF)
    material_entries = _by_mdef(archives, MATERIAL_MDEF)

    # The mixed recipe is a solution, with an inline-PubChem solvent and solute and
    # the dopant stock mixed in as a sub-solution.
    htl = next(
        (name, body["data"])
        for name, body in solution_entries.items()
        if body["data"]["name"] == "Spiro cocktail"
    )
    htl_name, htl_data = htl
    (solvent,) = htl_data["solvent"]
    assert solvent["chemical_2"]["pub_chem_cid"] == 7964
    assert solvent["chemical_2"]["load_data"] is False
    (solute,) = htl_data["solute"]
    assert solute["name"] == "Spiro-OMeTAD"
    assert solute["chemical_mass"] == 72.3
    dopant_name = next(
        name
        for name, body in solution_entries.items()
        if body["data"]["name"] == "Li-TFSI stock"
    )
    (other,) = htl_data["other_solution"]
    assert other["solution"].endswith(f"{dopant_name}#/data")
    assert other["solution_volume"] == 0.02

    # The commercial recipe is a bought product -> a material, not a solution.
    buy = next(
        body["data"]
        for body in material_entries.values()
        if body["data"]["name"] == "Clevios P VP AI 4083"
    )
    assert buy["product_info"]["product_number"] == "HTL-4083"
    assert not any(
        body["data"]["name"] == "PEDOT internal" for body in solution_entries.values()
    )

    # Steps link to the right kind of reference.
    steps = _deposition_steps(archives)
    htl_step = next(s for s in steps if s.get("name") == "HTL spin")
    assert htl_step["material"]["solution_reference"].endswith(f"{htl_name}#/data")
    buy_name = next(
        name
        for name, body in material_entries.items()
        if body["data"]["name"] == "Clevios P VP AI 4083"
    )
    buy_step = next(s for s in steps if s.get("name") == "PEDOT spin")
    assert buy_step["material"]["material_reference"].endswith(f"{buy_name}#/data")


def test_step_quenching_links_the_antisolvent_solution_entity():
    experiment_id = str(uuid.uuid4())

    materials = [
        {"id": "mat-sub", "name": "FTO glass", "type": "substrate", "stateAtRt": "solid"},
        {"id": "mat-cb", "name": "Chlorobenzene", "type": "solvent", "stateAtRt": "liquid"},
    ]
    solutions = [
        {
            "id": "sol-as",
            "name": "Antisolvent mix",
            "components": [
                {"materialId": "mat-cb", "amount": "1.0", "unit": "ml"},
            ],
        }
    ]

    process_snapshot = {
        "id": "process-1",
        "stages": [
            {
                "index": 0,
                "alternatives": [
                    {
                        "id": "step-pvk",
                        "name": "Perovskite spin",
                        "stepCategory": "wet_deposition",
                        "depositionMethod": {"value": "Spin coating", "mode": "constant"},
                        "dryingMethod": {
                            "value": (
                                "type=Antisolvent|media=solution:sol-as"
                                "|volume=150|timeUntilStart=8"
                            ),
                            "mode": "constant",
                        },
                    }
                ],
            }
        ],
        "generatedStacks": [],
        "deletedStackCombinations": [],
    }
    experiment_snapshot = {
        "id": experiment_id,
        "name": "Quench experiment",
        "description": "",
        "architecture": "n-i-p",
        "substrateMaterial": "substrate: Glass/FTO",
        "devicesPerSubstrate": 1,
        "deviceArea": 0.09,
        "substrates": [
            {"id": "sub-1", "name": "sub-1", "substrateMaterialId": "mat-sub"}
        ],
    }

    archives = _run(experiment_snapshot, process_snapshot, materials, solutions)

    solution_entries = _by_mdef(archives, SOLUTION_MDEF)
    as_name = next(
        name
        for name, body in solution_entries.items()
        if body["data"]["name"] == "Antisolvent mix"
    )

    steps = _deposition_steps(archives)
    quench_step = next(s for s in steps if s.get("quenching"))
    antisolvent = quench_step["quenching"]["antisolvent"]
    assert antisolvent["volume"] == 150.0
    assert antisolvent["media_reference"].endswith(f"{as_name}#/data")
    assert quench_step["quenching"]["time_until_start"] == 8.0


def test_recipe_ingredients_match_inventory_materials_by_cid_and_name():
    """The modern flow: steps reference a chem recipe only, and the recipe's
    ingredients carry PubChem CIDs / names — no LabMaterial foreign keys. The
    inventory must still be emitted (matched by CID first, then name), the
    solution rows must reference the matched material entries, and the recipe's
    handling / type / solvent ratios must survive into the solution entry."""
    experiment_id = str(uuid.uuid4())

    materials = [
        {
            "id": "mat-sub",
            "name": "FTO glass",
            "type": "substrate",
            "stateAtRt": "solid",
            "inventoryLabel": "INV-FTO",
        },
        {
            "id": "mat-pbi2",
            "name": "Lead iodide",  # name differs from the recipe's — CID matches
            "type": "salt",
            "stateAtRt": "solid",
            "pubchemCid": "24956",
            "inventoryLabel": "INV-PBI2",
            "supplier": "TCI",
        },
        {
            "id": "mat-dmf",
            "name": "DMF",  # no CID — matched case-insensitively by name
            "type": "solvent",
            "stateAtRt": "liquid",
            "inventoryLabel": "INV-DMF",
        },
    ]

    process_snapshot = {
        "id": "process-1",
        "solutionRecipes": [
            {
                "id": "recipe-pvk",
                "name": "Perovskite ink",
                "type": "perovskite",
                "handlingPreparation": "Stir overnight at 60C",
                "handlingBeforeUse": "Filter with 0.2um PTFE",
                "totalSolventVolumeMl": 1.0,
                "solvents": [
                    {"name": "dmf", "volumeRatio": 4.0},
                    {"name": "DMSO", "pubchemCid": "679", "volumeRatio": 1.0},
                ],
                "solutes": [
                    {"name": "PbI2", "pubchemCid": "24956", "amount": "461", "unit": "mg"},
                ],
                "addedSolutions": [],
            },
        ],
        "stages": [
            {
                "index": 0,
                "alternatives": [
                    {
                        "id": "step-pvk",
                        "name": "Perovskite spin",
                        "stepCategory": "wet_deposition",
                        "chemRecipeId": "recipe-pvk",
                        "depositionMethod": {"value": "Spin coating", "mode": "constant"},
                    }
                ],
            }
        ],
        "generatedStacks": [],
        "deletedStackCombinations": [],
    }
    experiment_snapshot = {
        "id": experiment_id,
        "name": "Inventory match experiment",
        "description": "",
        "architecture": "n-i-p",
        "substrateMaterial": "substrate: Glass/FTO",
        "devicesPerSubstrate": 1,
        "deviceArea": 0.09,
        "substrates": [
            {"id": "sub-1", "name": "sub-1", "substrateMaterialId": "mat-sub"}
        ],
    }

    archives = _run(experiment_snapshot, process_snapshot, materials, [])

    material_entries = _by_mdef(archives, MATERIAL_MDEF)
    solution_entries = _by_mdef(archives, SOLUTION_MDEF)

    # Matched inventory materials become entities carrying the inventory label.
    by_name = {
        body["data"]["name"]: (name, body["data"])
        for name, body in material_entries.items()
    }
    pbi2_name, pbi2 = by_name["Lead iodide"]  # matched via CID despite the name
    assert pbi2["lab_id"] == "INV-PBI2"
    dmf_name, dmf = by_name["DMF"]  # matched by case-insensitive name
    assert dmf["lab_id"] == "INV-DMF"
    # The substrate's inventory material is emitted too.
    assert by_name["FTO glass"][1]["lab_id"] == "INV-FTO"
    # DMSO matches nothing in the inventory -> no entity for it.
    assert "DMSO" not in by_name

    (ink,) = (body["data"] for body in solution_entries.values())
    assert ink["name"] == "Perovskite ink"
    assert ink["description"] == "perovskite"
    assert ink["handling"] == "Stir overnight at 60C\n\nFilter with 0.2um PTFE"
    assert ink["solvent_ratio"] == "4:1"

    dmf_row = next(r for r in ink["solvent"] if r["name"] == "dmf")
    assert dmf_row["chemical"].endswith(f"{dmf_name}#/data")
    assert dmf_row["amount_relative"] == 4.0
    dmso_row = next(r for r in ink["solvent"] if r["name"] == "DMSO")
    assert "chemical" not in dmso_row  # unmatched: inline identity only
    assert dmso_row["chemical_2"]["pub_chem_cid"] == 679

    (solute_row,) = ink["solute"]
    assert solute_row["chemical"].endswith(f"{pbi2_name}#/data")
    assert solute_row["chemical_mass"] == 461.0
