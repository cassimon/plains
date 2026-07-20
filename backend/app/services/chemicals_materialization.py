"""Turn an experiment's chemicals-step answers into real inventory rows.

The Experiment "Chemicals" step is where a chemical stops being a name on a
process step and becomes a physical thing on a shelf: the user gives it an
inventory label (its lab-unique ID), a purity, a supplier and a product number,
and for every solution they record the batch they actually mixed — how much,
when, and which vial it went into. Until now all of that lived only in
`Experiment.chemicals_prep` JSONB, so the chemicals had no identity anywhere in
the system: `lab_material` and `lab_solution` stayed empty, and the NOMAD
exporter — which is driven entirely off those tables — emitted no
`PlainsMaterial` entities at all and could not give a solution a meaningful
`lab_id`.

This module closes that gap. It reads the chemicals-step answers plus the
process recipes and get-or-creates the corresponding `LabMaterial` /
`LabSolution` / `SolutionComponent` rows, then points the process steps at
them. Everything downstream (the NOMAD export in particular) then works off
normal inventory rows with no special-casing.

It is **idempotent**: identity is `(owner_id, inventory_label)`, which the
database enforces with a partial unique index, so running it on every upload
re-syncs the inventory with the user's latest edits instead of duplicating it.
"""

import logging
import uuid
from dataclasses import dataclass, field
from datetime import datetime
from typing import Any

from sqlmodel import Session, select

from app.models import (
    Experiment,
    LabMaterial,
    LabSolution,
    ProcessSolutionRecipe,
    ProcessStep,
    SolutionComponent,
)
from app.services.pubchem_enrichment import enrich_materials

logger = logging.getLogger(__name__)


@dataclass
class MaterializationReport:
    """What one materialization run did — returned for logging and tests."""

    materials_created: int = 0
    materials_updated: int = 0
    materials_enriched: int = 0
    solutions_created: int = 0
    solutions_updated: int = 0
    #: Names of chemicals skipped because the user never gave them a lab ID.
    skipped_unlabelled: list[str] = field(default_factory=list)


@dataclass
class _Chemical:
    """One chemical as the Chemicals step knows it, before it has a row."""

    #: Key into `chemicals_prep["materialOverrides"]` — see `_collect_chemicals`.
    override_key: str
    name: str
    pubchem_cid: str | None = None
    component_cids: list[str] | None = None
    molar_mass: float | None = None
    density: float | None = None
    #: "solvent", "solute", or the inline material's own type.
    category: str | None = None


def parse_quenching_pairs(value: str | None) -> dict[str, str]:
    """Split a `type=Antisolvent|media=...|flowRate=...` step string into pairs.

    The same encoding `QuenchingModal` writes and `nomad.py` parses; only the
    key/value split is needed here, not the full NOMAD-shaped structure.
    """
    pairs: dict[str, str] = {}
    if not value:
        return pairs
    for segment in value.split("|"):
        key, sep, val = segment.partition("=")
        if sep:
            pairs[key.strip()] = val.strip()
    return pairs


def _clean(value: Any) -> str | None:
    """Trimmed non-empty string, else None."""
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _to_float(value: Any) -> float | None:
    try:
        result = float(str(value).strip())
    except (TypeError, ValueError):
        return None
    return result


def _parse_datetime(value: Any) -> datetime | None:
    """A `datetime-local` string ("YYYY-MM-DDTHH:mm") as a datetime."""
    text = _clean(value)
    if not text:
        return None
    try:
        return datetime.fromisoformat(text)
    except ValueError:
        return None


def _collect_chemicals(
    steps: list[ProcessStep],
    recipes: list[ProcessSolutionRecipe],
) -> list[_Chemical]:
    """Every chemical the Chemicals step asks the user about.

    Deliberate mirror of `collectChemicals` in
    `frontend/src/routes/-Experiments.chemicals.tsx` — the override keys below
    are how the user's answers are stored, so the three key shapes must match
    that function exactly or every lab ID is silently lost. (Same convention as
    the `processingTimes.ts` mirror in `services/nomad.py`.)

    | key shape                             | source                        |
    |---------------------------------------|-------------------------------|
    | `{step.id}`                           | `step.inline_material`        |
    | `drying:{step.id}`                    | antisolvent quenching media   |
    | `ingredient:{recipe.id}:{ingr.id}`    | recipe solvents, then solutes |
    """
    chemicals: list[_Chemical] = []

    for step in steps:
        inline = step.inline_material
        if isinstance(inline, dict) and _clean(inline.get("name")):
            chemicals.append(
                _Chemical(
                    override_key=str(step.id),
                    name=str(inline["name"]).strip(),
                    pubchem_cid=_clean(inline.get("pubchemCid")),
                    component_cids=inline.get("componentCids") or None,
                    molar_mass=_to_float(inline.get("molarMass")),
                    density=_to_float(inline.get("density")),
                    category=_clean(inline.get("type")),
                )
            )

        pairs = parse_quenching_pairs(step.drying_method_value)
        if pairs.get("type") == "Antisolvent":
            media = pairs.get("media") or pairs.get("material") or ""
            # `recipe:`/`material:`/`solution:` media point at an entity that is
            # materialized through its own path; only free-text media is a
            # chemical of its own here.
            if media and not media.startswith(("recipe:", "material:", "solution:")):
                chemicals.append(
                    _Chemical(
                        override_key=f"drying:{step.id}",
                        name=media,
                        pubchem_cid=_clean(pairs.get("mediaCid")),
                    )
                )

    for recipe in recipes:
        for role, ingredients in (
            ("solvent", recipe.solvents),
            ("solute", recipe.solutes),
        ):
            for ingredient in ingredients:
                chemicals.append(
                    _Chemical(
                        override_key=f"ingredient:{recipe.id}:{ingredient.id}",
                        name=_clean(ingredient.name) or role.capitalize(),
                        pubchem_cid=_clean(ingredient.pubchem_cid),
                        component_cids=ingredient.component_cids or None,
                        molar_mass=ingredient.molar_mass,
                        density=ingredient.density,
                        category=role,
                    )
                )

    return chemicals


def _reachable_recipes(
    steps: list[ProcessStep],
    recipes_by_id: dict[uuid.UUID, ProcessSolutionRecipe],
) -> list[ProcessSolutionRecipe]:
    """The recipes this experiment's steps use, plus stocks mixed into them."""
    pending: list[uuid.UUID] = []
    for step in steps:
        if step.chem_recipe_id:
            pending.append(step.chem_recipe_id)
        pairs = parse_quenching_pairs(step.drying_method_value)
        media = pairs.get("media") or pairs.get("material") or ""
        if media.startswith("recipe:"):
            try:
                pending.append(uuid.UUID(media[len("recipe:") :]))
            except ValueError:
                pass

    seen: set[uuid.UUID] = set()
    reachable: list[ProcessSolutionRecipe] = []
    while pending:
        recipe_id = pending.pop()
        if recipe_id in seen:
            continue
        seen.add(recipe_id)
        recipe = recipes_by_id.get(recipe_id)
        if recipe is None:
            continue
        reachable.append(recipe)
        for added in recipe.added_solutions:
            if added.referenced_recipe_id:
                pending.append(added.referenced_recipe_id)
    return reachable


def _apply(row: Any, values: dict[str, Any]) -> bool:
    """Set each non-empty value on the row; True if anything actually changed.

    Empty incoming values never overwrite what is already stored, so
    re-materializing cannot erase inventory data the user curated by hand.
    """
    changed = False
    for name, value in values.items():
        if value in (None, "", []):
            continue
        if getattr(row, name) != value:
            setattr(row, name, value)
            changed = True
    return changed


def _warn_on_conflict(row: LabMaterial, label: str, values: dict[str, Any]) -> None:
    """Flag two genuinely different chemicals sharing one inventory label.

    A lab ID identifies one substance, so merging descriptions under it is
    correct — but if the CIDs (or names) disagree, the user has reused a label
    for something else, and the merge silently mislabels one of them. Nothing
    can be done about it here without guessing, so say so loudly.
    """
    incoming_cid = values.get("pubchem_cid")
    if incoming_cid and row.pubchem_cid and incoming_cid != row.pubchem_cid:
        logger.warning(
            "Inventory label %r is used by two different chemicals "
            "(%r CID %s and %r CID %s); they were merged into one material. "
            "Give them distinct lab IDs in the Chemicals step.",
            label,
            row.name,
            row.pubchem_cid,
            values.get("name"),
            incoming_cid,
        )


def materialize_experiment_chemicals(
    session: Session, experiment: Experiment
) -> MaterializationReport:
    """Create/refresh the inventory rows behind an experiment's chemicals.

    Safe to call repeatedly: rows are matched on `(owner_id, inventory_label)`.
    """
    report = MaterializationReport()
    if not experiment.process_id:
        return report

    owner_id = experiment.owner_id
    prep: dict[str, Any] = experiment.chemicals_prep or {}
    overrides: dict[str, Any] = prep.get("materialOverrides") or {}
    batches: dict[str, Any] = prep.get("solutionBatches") or {}

    steps = list(
        session.exec(
            select(ProcessStep).where(ProcessStep.process_id == experiment.process_id)
        ).all()
    )
    all_recipes = list(
        session.exec(
            select(ProcessSolutionRecipe).where(
                ProcessSolutionRecipe.process_id == experiment.process_id
            )
        ).all()
    )
    recipes_by_id = {recipe.id: recipe for recipe in all_recipes}
    recipes = _reachable_recipes(steps, recipes_by_id)

    # ── Materials ────────────────────────────────────────────────────────────
    # The same chemical is re-described at every use site (DMF in three recipes
    # is three rows in the UI), so several descriptors legitimately collapse
    # onto one inventory row, keyed by the label the user gave it.
    material_by_label: dict[str, LabMaterial] = {}
    material_by_key: dict[str, LabMaterial] = {}

    def get_or_create_material(label: str, values: dict[str, Any]) -> LabMaterial:
        key = label.casefold()
        row = material_by_label.get(key)
        if row is not None:
            _warn_on_conflict(row, label, values)
            # Seen earlier in this same run: merge the extra description in.
            _apply(row, values)
            return row

        row = session.exec(
            select(LabMaterial).where(
                LabMaterial.owner_id == owner_id,
                LabMaterial.inventory_label == label,
            )
        ).first()
        if row is None:
            row = LabMaterial(
                owner_id=owner_id,
                name=str(values.get("name") or label)[:255],
                inventory_label=label,
            )
            _apply(row, values)
            session.add(row)
            report.materials_created += 1
        else:
            _warn_on_conflict(row, label, values)
            if _apply(row, values):
                report.materials_updated += 1

        material_by_label[key] = row
        return row

    for chemical in _collect_chemicals(steps, recipes):
        override = overrides.get(chemical.override_key) or {}
        label = _clean(override.get("inventoryLabel"))
        if not label:
            # The app requires a lab ID before upload; a missing one means the
            # chemicals step was not completed for this row (or the data is
            # stale). Skip rather than invent an identifier.
            report.skipped_unlabelled.append(chemical.name)
            logger.warning(
                "Chemical %r (key %s) has no inventory label; "
                "no LabMaterial materialized",
                chemical.name,
                chemical.override_key,
            )
            continue

        row = get_or_create_material(
            label[:255],
            {
                "name": chemical.name[:255],
                "type": chemical.category,
                "category": (chemical.category or "")[:50] or None,
                "pubchem_cid": chemical.pubchem_cid,
                "component_cids": chemical.component_cids,
                "molecular_weight": chemical.molar_mass,
                "density": chemical.density,
                "purity": _clean(override.get("purity")),
                "supplier": _clean(override.get("supplier")),
                # The chemicals step's "product ID" is the supplier's catalogue
                # number, which is what `supplier_number` already means.
                "supplier_number": _clean(override.get("productId")),
            },
        )
        material_by_key[chemical.override_key] = row

    # A commercial recipe is a bought product, not something mixed in the lab —
    # the NOMAD exporter makes the same distinction.
    commercial_material_by_recipe: dict[uuid.UUID, LabMaterial] = {}
    for recipe in recipes:
        if not recipe.is_commercial:
            continue
        label = _clean(recipe.supplier_number) or _clean(recipe.name)
        if not label:
            continue
        commercial_material_by_recipe[recipe.id] = get_or_create_material(
            label[:255],
            {
                "name": (
                    _clean(recipe.commercial_name) or _clean(recipe.name) or label
                )[:255],
                "type": _clean(recipe.type),
                "supplier_number": _clean(recipe.supplier_number),
            },
        )

    session.flush()

    # ── Solutions ────────────────────────────────────────────────────────────
    # Two passes: every batch row exists before components are written, so a
    # recipe that mixes in another recipe's stock can reference it.
    solution_by_recipe: dict[uuid.UUID, LabSolution] = {}
    for recipe in recipes:
        if recipe.is_commercial:
            continue
        batch: dict[str, Any] = batches.get(f"recipe:{recipe.id}") or {}
        label = _clean(batch.get("vialLabel"))
        handling = "\n\n".join(
            part
            for part in (
                _clean(recipe.handling_preparation),
                _clean(recipe.handling_before_use),
            )
            if part
        )
        values: dict[str, Any] = {
            "name": (_clean(recipe.name) or "Solution")[:255],
            "type": _clean(recipe.type),
            "handling": handling or None,
            "creation_time": _parse_datetime(batch.get("preparedAt")),
            "total_volume_ml": _to_float(batch.get("totalVolumeMl")),
            "source_recipe_id": recipe.id,
        }
        if batch.get("mode") == "take":
            values["notes"] = "Taken from a batch prepared in another experiment."

        solution_row: LabSolution | None = None
        if label:
            solution_row = session.exec(
                select(LabSolution).where(
                    LabSolution.owner_id == owner_id,
                    LabSolution.inventory_label == label[:255],
                )
            ).first()
        if solution_row is None:
            # Without a vial label a batch has no lab identity, so fall back to
            # the recipe it came from to stay idempotent.
            solution_row = session.exec(
                select(LabSolution).where(
                    LabSolution.owner_id == owner_id,
                    LabSolution.source_recipe_id == recipe.id,
                )
            ).first()
        if solution_row is None:
            solution_row = LabSolution(
                owner_id=owner_id,
                name=values["name"],
                inventory_label=label[:255] if label else None,
                source_recipe_id=recipe.id,
            )
            _apply(solution_row, values)
            session.add(solution_row)
            report.solutions_created += 1
        else:
            if label:
                values["inventory_label"] = label[:255]
            if _apply(solution_row, values):
                report.solutions_updated += 1
        solution_by_recipe[recipe.id] = solution_row

    session.flush()

    for recipe in recipes:
        solution_row = solution_by_recipe.get(recipe.id)
        if solution_row is None:
            continue
        _write_components(
            session,
            solution=solution_row,
            recipe=recipe,
            material_by_key=material_by_key,
            solution_by_recipe=solution_by_recipe,
            commercial_material_by_recipe=commercial_material_by_recipe,
        )

    # ── Point the process steps at what they now deposit ──────────────────────
    for step in steps:
        if step.chem_recipe_id:
            solution = solution_by_recipe.get(step.chem_recipe_id)
            if solution is not None and step.solution_id != solution.id:
                step.solution_id = solution.id
                session.add(step)
            commercial = commercial_material_by_recipe.get(step.chem_recipe_id)
            if commercial is not None and step.material_id != commercial.id:
                step.material_id = commercial.id
                session.add(step)
        inline_material = material_by_key.get(str(step.id))
        if inline_material is not None and step.material_id != inline_material.id:
            step.material_id = inline_material.id
            session.add(step)

    # Cache each material's PubChem identity, so the NOMAD export has a
    # `molecular_formula` to emit. Chemicals that only ever live in
    # `chemicals_prep` JSONB never pass through the materials route, so this is
    # their only chance to be enriched. Already-synced rows are skipped, and a
    # failed fetch is logged and left retryable — never fatal to the upload.
    report.materials_enriched = enrich_materials(
        session, list(material_by_label.values())
    )

    session.commit()
    return report


def _scaled_amounts(
    recipe: ProcessSolutionRecipe, total_volume_ml: float | None
) -> tuple[list[float | None], float]:
    """Solvent volumes (mL) for the batch, and the factor solutes scale by.

    Port of `scaleRecipeQuantities` in
    `frontend/src/routes/-Experiments.chemicals.tsx`: solvents split the batch
    volume by their `volumeRatio` share, solutes scale linearly with how much
    bigger the batch is than the recipe.
    """
    recipe_total = _to_float(recipe.total_solvent_volume_ml) or 0.0
    total = total_volume_ml if (total_volume_ml or 0) > 0 else recipe_total
    ratios = [solvent.volume_ratio or 0.0 for solvent in recipe.solvents]
    ratio_sum = sum(ratios)

    if not total or ratio_sum <= 0:
        volumes: list[float | None] = [None] * len(recipe.solvents)
    else:
        volumes = [round(total * ratio / ratio_sum, 6) for ratio in ratios]

    factor = (total / recipe_total) if (total and recipe_total > 0) else 1.0
    return volumes, factor


def _write_components(
    session: Session,
    *,
    solution: LabSolution,
    recipe: ProcessSolutionRecipe,
    material_by_key: dict[str, LabMaterial],
    solution_by_recipe: dict[uuid.UUID, LabSolution],
    commercial_material_by_recipe: dict[uuid.UUID, LabMaterial],
) -> None:
    """Replace a batch's components with the recipe scaled to its real volume.

    Components are derived data, so they are rebuilt wholesale rather than
    diffed — that keeps re-materialization after a recipe edit correct.
    """
    volumes, factor = _scaled_amounts(recipe, solution.total_volume_ml)

    rows: list[SolutionComponent] = []
    for solvent, volume_ml in zip(recipe.solvents, volumes, strict=False):
        if volume_ml is None:
            continue
        material = material_by_key.get(f"ingredient:{recipe.id}:{solvent.id}")
        rows.append(
            SolutionComponent(
                solution_id=solution.id,
                amount=volume_ml,
                unit="ml",
                material_id=material.id if material else None,
            )
        )

    for solute in recipe.solutes:
        amount = _to_float(solute.amount)
        if amount is None:
            continue
        material = material_by_key.get(f"ingredient:{recipe.id}:{solute.id}")
        rows.append(
            SolutionComponent(
                solution_id=solution.id,
                amount=round(amount * factor, 6),
                unit=solute.unit or "mg",
                material_id=material.id if material else None,
            )
        )

    for added in recipe.added_solutions:
        volume_ml = _to_float(added.volume_ml)
        if volume_ml is None or not added.referenced_recipe_id:
            continue
        referenced = solution_by_recipe.get(added.referenced_recipe_id)
        commercial = commercial_material_by_recipe.get(added.referenced_recipe_id)
        if referenced is None and commercial is None:
            continue
        rows.append(
            SolutionComponent(
                solution_id=solution.id,
                amount=round(volume_ml * factor, 6),
                unit="ml",
                solution_ref_id=referenced.id if referenced else None,
                material_id=commercial.id if commercial else None,
            )
        )

    for existing in list(solution.components):
        session.delete(existing)
    session.flush()
    for row in rows:
        session.add(row)
