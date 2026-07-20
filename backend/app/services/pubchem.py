"""A thin, best-effort PubChem PUG-REST client.

The app's chemical identities are resolved once here and then cached on
`lab_material` (see `pubchem_enrichment.py`), so that NOMAD processing can stay
fully offline: the exported substance sections carry `load_data: False`, which
makes `baseclasses` skip its own PubChem fetch. That choice makes *us*
responsible for supplying `molecular_formula` and friends.

Contract, relied upon by every caller: **nothing in this module raises.** A dead
or slow PubChem must never stop a user saving a material or block a NOMAD
upload; every failure path returns `None` and logs a warning.
"""

import logging
import re
from dataclasses import dataclass
from typing import Any
from urllib.parse import quote

import httpx

logger = logging.getLogger(__name__)

PUBCHEM_BASE = "https://pubchem.ncbi.nlm.nih.gov/rest/pug"

# The property names are PUG-REST's own spelling, and the response echoes them
# back as the JSON keys we read below.
_PROPERTIES = (
    "MolecularFormula",
    "MolecularWeight",
    "IUPACName",
    "CanonicalSMILES",
    "InChI",
    "InChIKey",
    "MonoisotopicMass",
)

# PubChem does not expose CAS numbers as a property -- they only appear among the
# synonyms, so we pick the first synonym shaped like one.
_CAS_RE = re.compile(r"^\d{2,7}-\d{2}-\d$")

DEFAULT_TIMEOUT = 10.0


@dataclass(frozen=True)
class PubChemCompound:
    """The subset of a PubChem record that the NOMAD schemas can carry."""

    cid: int
    molecular_formula: str | None = None
    molecular_weight: float | None = None
    iupac_name: str | None = None
    smiles: str | None = None
    inchi: str | None = None
    inchi_key: str | None = None
    monoisotopic_mass: float | None = None
    cas_number: str | None = None
    name: str | None = None


def _clean_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value).strip()
    return text or None


def _clean_float(value: Any) -> float | None:
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _get_json(url: str, timeout: float) -> Any | None:
    """GET and decode JSON, converting every failure into `None`."""
    try:
        response = httpx.get(url, timeout=timeout, follow_redirects=True)
        response.raise_for_status()
        return response.json()
    except Exception as exc:  # noqa: BLE001 - deliberately total; see module docstring
        logger.warning("PubChem request failed (%s): %s", url, exc)
        return None


def _fetch_cas_number(cid: int, timeout: float) -> str | None:
    payload = _get_json(f"{PUBCHEM_BASE}/compound/cid/{cid}/synonyms/JSON", timeout)
    if not isinstance(payload, dict):
        return None
    try:
        synonyms = payload["InformationList"]["Information"][0]["Synonym"]
    except (KeyError, IndexError, TypeError):
        return None
    if not isinstance(synonyms, list):
        return None
    for synonym in synonyms:
        text = _clean_str(synonym)
        if text and _CAS_RE.match(text):
            return text
    return None


def _fetch_title(cid: int, timeout: float) -> str | None:
    payload = _get_json(
        f"{PUBCHEM_BASE}/compound/cid/{cid}/property/Title/JSON", timeout
    )
    properties = _first_property_row(payload)
    if properties is None:
        return None
    return _clean_str(properties.get("Title"))


def _first_property_row(payload: Any) -> dict[str, Any] | None:
    """Unwrap PUG-REST's `PropertyTable.Properties[0]`, tolerating any shape."""
    if not isinstance(payload, dict):
        return None
    try:
        row = payload["PropertyTable"]["Properties"][0]
    except (KeyError, IndexError, TypeError):
        return None
    return row if isinstance(row, dict) else None


def fetch_compound(
    cid: int, *, timeout: float = DEFAULT_TIMEOUT
) -> PubChemCompound | None:
    """Fetch one compound by CID, or `None` if it cannot be resolved.

    Three requests: the bulk property table, the synonym list (for CAS) and the
    title (PubChem's canonical display name). Only the first is required -- the
    other two degrade to `None` independently, since a missing CAS is no reason
    to discard a good formula.
    """
    if cid is None or cid <= 0:
        return None

    payload = _get_json(
        f"{PUBCHEM_BASE}/compound/cid/{cid}/property/{','.join(_PROPERTIES)}/JSON",
        timeout,
    )
    properties = _first_property_row(payload)
    if properties is None:
        logger.warning("PubChem returned no usable properties for CID %s", cid)
        return None

    return PubChemCompound(
        cid=cid,
        molecular_formula=_clean_str(properties.get("MolecularFormula")),
        molecular_weight=_clean_float(properties.get("MolecularWeight")),
        iupac_name=_clean_str(properties.get("IUPACName")),
        smiles=_clean_str(properties.get("CanonicalSMILES")),
        inchi=_clean_str(properties.get("InChI")),
        inchi_key=_clean_str(properties.get("InChIKey")),
        monoisotopic_mass=_clean_float(properties.get("MonoisotopicMass")),
        cas_number=_fetch_cas_number(cid, timeout),
        name=_fetch_title(cid, timeout),
    )


def search_cid_by_name(name: str, *, timeout: float = DEFAULT_TIMEOUT) -> int | None:
    """Resolve a chemical name to a CID. Used only when none was recorded.

    PubChem name lookup is fuzzy and can return several hits; we take the first,
    which is its own relevance ranking. A wrong guess here is why enrichment
    never overwrites a value the user typed themselves.
    """
    query = _clean_str(name)
    if not query:
        return None
    payload = _get_json(
        f"{PUBCHEM_BASE}/compound/name/{quote(query, safe='')}/cids/JSON",
        timeout,
    )
    if not isinstance(payload, dict):
        return None
    try:
        cids = payload["IdentifierList"]["CID"]
    except (KeyError, TypeError):
        return None
    if not isinstance(cids, list) or not cids:
        return None
    try:
        cid = int(cids[0])
    except (TypeError, ValueError):
        return None
    return cid if cid > 0 else None
