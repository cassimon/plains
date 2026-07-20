"""Cache PubChem identities onto `lab_material` rows.

Why this exists: the NOMAD export emits substance sections with
`load_data: False`, so `baseclasses` never fetches from PubChem during
processing. Whatever identity data the archive is to carry has to come from our
own database -- above all `molecular_formula`, without which
`CompositeSystem.normalize` fails outright on `Formula(None)`.

Two rules shape everything here:

* **A user-entered value always wins.** `molecular_weight`, `cas_number` and
  `density` are filled only when empty. Name-based CID lookup is fuzzy, so an
  enrichment must never overwrite what somebody typed.
* **Failure is invisible and retryable.** `pubchem_synced_at` is stamped only on
  success, so a row that failed is simply picked up by the next run.
"""

import logging
import time
import uuid
from collections.abc import Sequence

from sqlmodel import Session

from app.core.db import engine
from app.models import LabMaterial, get_datetime_utc
from app.services.pubchem import PubChemCompound, fetch_compound, search_cid_by_name

logger = logging.getLogger(__name__)

# PubChem asks for no more than 5 requests/second. `fetch_compound` makes three
# requests per material, so pause between rows in the batch path.
_BATCH_DELAY_SECONDS = 0.75


def _to_int(value: object) -> int | None:
    try:
        return int(str(value).strip())
    except (TypeError, ValueError):
        return None


def _resolve_cid(material: LabMaterial) -> int | None:
    """The material's own CID, else a name lookup as a fallback."""
    cid = _to_int(material.pubchem_cid)
    if cid is not None and cid > 0:
        return cid
    name = (material.name or "").strip()
    if not name:
        return None
    return search_cid_by_name(name)


def _apply(material: LabMaterial, compound: PubChemCompound) -> None:
    """Copy a fetched record onto the row, never clobbering user input."""
    # Backend-owned columns: nothing else writes these, so always refresh.
    material.molecular_formula = compound.molecular_formula
    material.iupac_name = compound.iupac_name
    material.smiles = compound.smiles
    material.inchi = compound.inchi
    material.inchi_key = compound.inchi_key
    material.pubchem_name = compound.name
    material.monoisotopic_mass = compound.monoisotopic_mass

    # Shared columns: the user may have entered these by hand, so only fill gaps.
    if material.molecular_weight is None and compound.molecular_weight is not None:
        material.molecular_weight = compound.molecular_weight
    if not (material.cas_number or "").strip() and compound.cas_number:
        material.cas_number = compound.cas_number

    material.pubchem_cid = str(compound.cid)
    # Recorded separately from `pubchem_cid`, which the line above overwrites:
    # this is what lets a later edit to the CID be seen as stale data.
    material.pubchem_synced_cid = str(compound.cid)
    material.pubchem_synced_at = get_datetime_utc()


def _is_fresh(material: LabMaterial, cid: int) -> bool:
    """True when the row was already synced from this very CID."""
    if material.pubchem_synced_at is None:
        return False
    return _to_int(material.pubchem_synced_cid) == cid


def enrich_material(
    session: Session, material: LabMaterial, *, force: bool = False
) -> bool:
    """Fetch and cache PubChem data for one material. Returns True if it changed.

    Does not commit -- the caller decides the transaction boundary.
    """
    cid = _resolve_cid(material)
    if cid is None:
        logger.debug(
            "No PubChem CID for material %s (%r); skipping", material.id, material.name
        )
        return False

    if not force and _is_fresh(material, cid):
        return False

    compound = fetch_compound(cid)
    if compound is None:
        # Left unstamped on purpose: the next run retries it.
        logger.warning(
            "PubChem enrichment failed for material %s (CID %s)", material.id, cid
        )
        return False

    _apply(material, compound)
    session.add(material)
    return True


def enrich_materials(
    session: Session,
    materials: Sequence[LabMaterial],
    *,
    force: bool = False,
    delay: float = _BATCH_DELAY_SECONDS,
) -> int:
    """Enrich a batch, rate-limited. Returns how many rows changed.

    Does not commit; the caller does, so a batch lands atomically.
    """
    changed = 0
    for index, material in enumerate(materials):
        if index and delay:
            time.sleep(delay)
        try:
            if enrich_material(session, material, force=force):
                changed += 1
        except Exception:  # noqa: BLE001 - one bad row must not abort the batch
            logger.exception("PubChem enrichment raised for material %s", material.id)
    return changed


def enrich_material_by_id(material_id: uuid.UUID, *, force: bool = False) -> None:
    """Background-task entry point: enrich one material in its own session.

    It must open its own `Session` rather than take the request's: `get_db`
    closes that one as soon as the response is returned, and this runs after.
    Nothing upstream can handle a failure here, so nothing is allowed to escape.
    """
    try:
        with Session(engine) as session:
            material = session.get(LabMaterial, material_id)
            if material is None:
                return
            if enrich_material(session, material, force=force):
                session.commit()
    except Exception:  # noqa: BLE001 - background task; nothing can handle this
        logger.exception("Background PubChem enrichment failed for %s", material_id)
