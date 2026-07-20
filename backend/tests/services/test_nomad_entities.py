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
    "nomad_perovskite_solar_cell_sample_plains.schema_packages.chemicals.PlainsMaterial"
)
SOLUTION_MDEF = (
    "nomad_perovskite_solar_cell_sample_plains.schema_packages.chemicals.PlainsSolution"
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
        # These snapshot-driven tests carry no process row, so the exporter has
        # nothing to back-fill materialized material/solution links from.
        process_id=None,
        chemicals_prep=None,
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
        body["data"]
        for body in material_entries.values()
        if body["data"]["name"] == "PbI2"
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
        name
        for name, body in material_entries.items()
        if body["data"]["name"] == "PbI2"
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
    (deposited,) = [s for s in steps if s.get("solution")]
    assert deposited["solution"].endswith(f"{main_name}#/data")
    # And the layer it produced was recorded on the step.
    assert deposited["layer_name"] == "Perovskite"
    assert deposited["layer_thickness"] == 550.0


def test_commercial_recipe_is_a_material_and_mixed_recipe_is_a_solution():
    experiment_id = str(uuid.uuid4())

    materials = [
        {
            "id": "mat-sub",
            "name": "FTO glass",
            "type": "substrate",
            "stateAtRt": "solid",
        },
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
                        "depositionMethod": {
                            "value": "Spin coating",
                            "mode": "constant",
                        },
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
                        "depositionMethod": {
                            "value": "Spin coating",
                            "mode": "constant",
                        },
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
    assert htl_step["solution"].endswith(f"{htl_name}#/data")
    buy_name = next(
        name
        for name, body in material_entries.items()
        if body["data"]["name"] == "Clevios P VP AI 4083"
    )
    buy_step = next(s for s in steps if s.get("name") == "PEDOT spin")
    assert buy_step["chemical"].endswith(f"{buy_name}#/data")


def test_step_quenching_links_the_antisolvent_solution_entity():
    experiment_id = str(uuid.uuid4())

    materials = [
        {
            "id": "mat-sub",
            "name": "FTO glass",
            "type": "substrate",
            "stateAtRt": "solid",
        },
        {
            "id": "mat-cb",
            "name": "Chlorobenzene",
            "type": "solvent",
            "stateAtRt": "liquid",
        },
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
                        "depositionMethod": {
                            "value": "Spin coating",
                            "mode": "constant",
                        },
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
    assert antisolvent["media_solution"].endswith(f"{as_name}#/data")
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
                    {
                        "name": "PbI2",
                        "pubchemCid": "24956",
                        "amount": "461",
                        "unit": "mg",
                    },
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
                        "depositionMethod": {
                            "value": "Spin coating",
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


# ─────────────────────────────────────────────────────────────────────────────
# The other half of the round trip: exporting from materialized inventory rows.
#
# The tests above drive the exporter from GUI snapshots, which is the path an
# experiment takes before its chemicals have been materialized. These drive it
# from the database instead — `materialize_experiment_chemicals` writes the
# inventory rows, and the exporter reads them back with no snapshot at all.
# ─────────────────────────────────────────────────────────────────────────────


def _entity_references(archives: dict) -> list[str]:
    """Every `../upload/raw/....archive.yaml#/data` reference in the archives."""
    found: list[str] = []

    def walk(node: object) -> None:
        if isinstance(node, dict):
            for value in node.values():
                walk(value)
        elif isinstance(node, list):
            for item in node:
                walk(item)
        elif isinstance(node, str) and node.startswith("../upload/raw/"):
            if node.endswith(".archive.yaml#/data"):
                found.append(node)

    walk(archives)
    return found


def _export(db, experiment):
    from app.services.chemicals_materialization import materialize_experiment_chemicals

    materialize_experiment_chemicals(db, experiment)
    return create_nomad_metadata_yaml(
        experiment_id=str(experiment.id),
        user_name="Tester",
        session=db,
    )


def test_materialized_chemicals_become_material_entities(db, experiment):
    archives = _export(db, experiment)

    materials = _by_mdef(archives, MATERIAL_MDEF)
    by_lab_id = {body["data"]["lab_id"]: body["data"] for body in materials.values()}

    # Every labelled chemical the process uses, and nothing invented for the
    # unlabelled one. Before the chemicals were materialized this was empty.
    assert "INV-DMF" in by_lab_id
    assert "INV-PBI2" in by_lab_id
    assert not [d for d in by_lab_id.values() if d["name"] == "PC61BM"]

    dmf = by_lab_id["INV-DMF"]
    assert dmf["name"] == "N,N-Dimethylformamide"
    assert dmf["purity"] == "99.8%"
    assert dmf["molecular_mass"] == 73.09
    assert dmf["density"] == 0.944
    assert dmf["substance"]["pub_chem_cid"] == 6228
    assert dmf["substance"]["load_data"] is False
    assert dmf["product_info"] == {"supplier": "Sigma", "product_number": "227056"}

    # A mixture has no CID of its own, so its constituents are listed instead.
    pedot = by_lab_id["INV-PEDOT"]
    assert [s["pub_chem_cid"] for s in pedot["component_substances"]] == [61503, 62717]


def test_materialized_batch_is_an_identifiable_solution_entity(db, experiment):
    archives = _export(db, experiment)

    solutions = _by_mdef(archives, SOLUTION_MDEF)
    pvk = next(
        body["data"] for body in solutions.values() if body["data"]["name"] == "PVK"
    )

    # The vial label, not an opaque row id — this is what makes the entry
    # findable in NOMAD.
    assert pvk["lab_id"] == "PVK_2026-07-19"
    assert pvk["datetime"].startswith("2026-07-19T14:30")
    assert pvk["handling"] == "Stir at 60 C\n\nFilter with 0.45 um PTFE"
    assert pvk["properties"]["final_volume"] == 2.0

    # Amounts are the batch the user actually mixed (2 mL of a 1 mL recipe).
    dmf_row = next(r for r in pvk["solvent"] if r["name"] == "N,N-Dimethylformamide")
    assert dmf_row["chemical_volume"] == 1.6
    (solute_row,) = pvk["solute"]
    assert solute_row["chemical_mass"] == 922.0
    # 922 mg of a 461 g/mol solute in 2 mL is 1 mol/l — a strength, not just an
    # amount. `baseclasses` derives none of this itself.
    assert solute_row["concentration_mass"] == 461.0
    assert solute_row["concentration_mol"] == 0.001

    # `components` is what NOMAD's composition overview reads; the solvent /
    # solute rows alone leave it blank.
    component_names = [c["substance_name"] for c in pvk["components"]]
    assert "Lead(II) iodide" in component_names
    assert all(c["m_def"].endswith("PureSubstanceComponent") for c in pvk["components"])


def test_solution_rows_reference_the_material_entities(db, experiment):
    archives = _export(db, experiment)

    materials = _by_mdef(archives, MATERIAL_MDEF)
    solutions = _by_mdef(archives, SOLUTION_MDEF)
    dmf_file = next(
        name for name, body in materials.items() if body["data"]["lab_id"] == "INV-DMF"
    )
    pvk = next(
        body["data"] for body in solutions.values() if body["data"]["name"] == "PVK"
    )

    dmf_row = next(r for r in pvk["solvent"] if r["name"] == "N,N-Dimethylformamide")
    assert dmf_row["chemical"].endswith(f"{dmf_file}#/data")
    # The inline identity is kept alongside the link, so the row still reads
    # correctly if the reference cannot be resolved.
    assert dmf_row["chemical_2"]["pub_chem_cid"] == 6228


def test_deposition_steps_reference_entities_instead_of_summarizing_them(
    db, experiment
):
    archives = _export(db, experiment)

    solutions = _by_mdef(archives, SOLUTION_MDEF)
    pvk_file = next(
        name for name, body in solutions.items() if body["data"]["name"] == "PVK"
    )
    steps = _deposition_steps(archives)

    pvk_step = next(s for s in steps if s.get("solution", "").find(pvk_file) != -1)
    assert pvk_step["solution"].endswith(f"{pvk_file}#/data")
    assert pvk_step["solution_concentration"] == 1.0

    # The `DepositedMaterial` summary section is gone for good.
    assert not any("material" in step for step in steps)

    # The antisolvent was free text ("Chlorobenzene"); the chemicals step gave
    # it a lab ID, so the quench links to that chemical entry.
    quench_step = next(s for s in steps if s.get("quenching"))
    antisolvent = quench_step["quenching"]["antisolvent"]
    materials = _by_mdef(archives, MATERIAL_MDEF)
    cb_file = next(
        name for name, body in materials.items() if body["data"]["lab_id"] == "INV-CB"
    )
    assert antisolvent["media_chemical"].endswith(f"{cb_file}#/data")


def test_every_entity_reference_resolves_to_an_emitted_archive(db, experiment):
    """A reference to a file that was never written is a broken NOMAD entry."""
    archives = _export(db, experiment)

    references = _entity_references(archives)
    assert references, "expected the export to link at least one entity"
    for reference in references:
        filename = reference[len("../upload/raw/") : -len("#/data")]
        assert filename in archives, f"dangling reference: {reference}"


# ── PubChem enrichment: identity on the entities, and the crash it prevents ──
#
# The export writes substance sections with `load_data: False`, which makes
# `baseclasses` skip its own PubChem fetch entirely. Everything a substance
# section carries therefore has to come from our cached enrichment, and a
# section without `molecular_formula` is not merely poorer — NOMAD's
# `CompositeSystem.normalize` calls `Formula(...)` on it unguarded, raising
# `TypeError` and taking the whole entry's normalization down with it.


def _substance_sections(node: object) -> list[dict]:
    """Every `pure_substance` section anywhere in the archives."""
    found: list[dict] = []

    def walk(value: object) -> None:
        if isinstance(value, dict):
            substance = value.get("pure_substance")
            if isinstance(substance, dict):
                found.append(substance)
            for child in value.values():
                walk(child)
        elif isinstance(value, list):
            for item in value:
                walk(item)

    walk(node)
    return found


def test_enriched_material_carries_its_full_identity(db, experiment):
    """The reported symptom: a material entry showed almost nothing."""
    archives = _export(db, experiment)

    materials = _by_mdef(archives, MATERIAL_MDEF)
    dmf = next(
        body["data"]
        for body in materials.values()
        if body["data"]["lab_id"] == "INV-DMF"
    )

    # On the entity itself, so the ELN overview is populated.
    assert dmf["molecular_formula"] == "C3H7NO"
    assert dmf["smile"] == "CN(C)C=O"
    assert dmf["inchi"].startswith("InChI=1S/C3H7NO")
    assert dmf["inchi_key"] == "STUB-6228"

    # And on the substance subsection, which additionally has iupac_name.
    assert dmf["substance"]["molecular_formula"] == "C3H7NO"
    assert dmf["substance"]["iupac_name"] == "stub-iupac-6228"
    assert dmf["substance"]["load_data"] is False


def test_solution_components_carry_a_formula_when_one_is_known(db, experiment):
    archives = _export(db, experiment)

    solutions = _by_mdef(archives, SOLUTION_MDEF)
    pvk = next(
        body["data"] for body in solutions.values() if body["data"]["name"] == "PVK"
    )

    pbi2 = next(c for c in pvk["components"] if c["substance_name"] == "Lead(II) iodide")
    assert pbi2["pure_substance"]["molecular_formula"] == "I2Pb"


def test_component_without_a_formula_emits_no_substance_section(db, experiment):
    """The regression test for the normalization crash.

    DMSO has no stubbed PubChem record, so it never gets a formula. The
    component must still be emitted — the solution keeps its full ingredient
    list — but with no `pure_substance` at all, because attaching a formula-less
    one is exactly what killed every PlainsSolution entry.
    """
    archives = _export(db, experiment)

    solutions = _by_mdef(archives, SOLUTION_MDEF)
    pvk = next(
        body["data"] for body in solutions.values() if body["data"]["name"] == "PVK"
    )

    dmso = next(
        c for c in pvk["components"] if c["substance_name"] == "Dimethyl sulfoxide"
    )
    assert "pure_substance" not in dmso
    # Still a full component, so the ingredient is not lost from the entry.
    assert dmso["name"] == "Dimethyl sulfoxide"

    # ...while its resolvable neighbours are unaffected.
    dmf = next(
        c for c in pvk["components"] if c["substance_name"] == "N,N-Dimethylformamide"
    )
    assert dmf["pure_substance"]["molecular_formula"] == "C3H7NO"


def test_no_substance_section_anywhere_lacks_a_molecular_formula(db, experiment):
    """The invariant, checked across every archive the export writes.

    Asserted globally rather than per-builder so that a new emission site cannot
    quietly reintroduce the crash.
    """
    archives = _export(db, experiment)

    sections = _substance_sections(archives)
    assert sections, "expected at least one substance section to check"
    offenders = [s for s in sections if not s.get("molecular_formula")]
    assert offenders == [], (
        "a pure_substance without molecular_formula makes NOMAD's "
        f"CompositeSystem.normalize raise on Formula(None): {offenders}"
    )
