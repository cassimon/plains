"""Unit tests for the PubChem PUG-REST client.

No test here may touch the network: every request is served by a stubbed
transport. The client's contract is that it *never raises* — a dead PubChem must
not be able to stop a user saving a material or block a NOMAD upload — so most
of these tests are about failure modes returning `None` quietly.
"""

import json

import httpx
import pytest

from app.services import pubchem
from app.services.pubchem import fetch_compound, search_cid_by_name

# Lead(II) bromide, the compound from the original bug report.
CID_PBBR2 = 24831

_PROPERTY_PAYLOAD = {
    "PropertyTable": {
        "Properties": [
            {
                "CID": CID_PBBR2,
                "MolecularFormula": "Br2Pb",
                "MolecularWeight": "367.0",
                "IUPACName": "dibromolead",
                "CanonicalSMILES": "[Pb](Br)Br",
                "InChI": "InChI=1S/2BrH.Pb/h2*1H;/q;;+2/p-2",
                "InChIKey": "ZASWJUOMEGBQCQ-UHFFFAOYSA-L",
                "MonoisotopicMass": "365.8",
            }
        ]
    }
}

_SYNONYM_PAYLOAD = {
    "InformationList": {
        "Information": [
            {
                "CID": CID_PBBR2,
                # The CAS number is buried among the synonyms — PubChem exposes
                # it nowhere else — so the client has to pattern-match it out.
                "Synonym": ["Lead(II) bromide", "lead dibromide", "10031-22-8"],
            }
        ]
    }
}

_TITLE_PAYLOAD = {"PropertyTable": {"Properties": [{"CID": CID_PBBR2, "Title": "Lead(II) bromide"}]}}


def _install(monkeypatch, handler):
    """Route every client request through `handler` instead of the network."""

    def _get(url, timeout=None, follow_redirects=None):
        return handler(str(url))

    monkeypatch.setattr(httpx, "get", _get)


def _response(status: int, payload=None, *, body: str | None = None) -> httpx.Response:
    content = body if body is not None else json.dumps(payload or {})
    return httpx.Response(
        status_code=status,
        content=content.encode(),
        headers={"content-type": "application/json"},
        request=httpx.Request("GET", "https://pubchem.test/"),
    )


def _happy_handler(url: str) -> httpx.Response:
    if "/synonyms/" in url:
        return _response(200, _SYNONYM_PAYLOAD)
    if "/property/Title/" in url:
        return _response(200, _TITLE_PAYLOAD)
    return _response(200, _PROPERTY_PAYLOAD)


def test_fetch_compound_maps_every_field(monkeypatch):
    _install(monkeypatch, _happy_handler)

    compound = fetch_compound(CID_PBBR2)

    assert compound is not None
    assert compound.cid == CID_PBBR2
    assert compound.molecular_formula == "Br2Pb"
    assert compound.molecular_weight == pytest.approx(367.0)
    assert compound.iupac_name == "dibromolead"
    assert compound.smiles == "[Pb](Br)Br"
    assert compound.inchi_key == "ZASWJUOMEGBQCQ-UHFFFAOYSA-L"
    assert compound.monoisotopic_mass == pytest.approx(365.8)
    assert compound.name == "Lead(II) bromide"
    # Picked out of the synonym list by shape, not by position.
    assert compound.cas_number == "10031-22-8"


def test_cas_is_none_when_no_synonym_looks_like_one(monkeypatch):
    payload = {
        "InformationList": {
            "Information": [{"Synonym": ["Lead(II) bromide", "not-a-cas", "1-2-3-4"]}]
        }
    }

    def handler(url: str) -> httpx.Response:
        if "/synonyms/" in url:
            return _response(200, payload)
        if "/property/Title/" in url:
            return _response(200, _TITLE_PAYLOAD)
        return _response(200, _PROPERTY_PAYLOAD)

    _install(monkeypatch, handler)
    compound = fetch_compound(CID_PBBR2)

    assert compound is not None
    assert compound.cas_number is None
    # A missing CAS must not discard an otherwise good record.
    assert compound.molecular_formula == "Br2Pb"


def test_synonym_failure_does_not_lose_the_properties(monkeypatch):
    """The three requests degrade independently."""

    def handler(url: str) -> httpx.Response:
        if "/synonyms/" in url or "/property/Title/" in url:
            return _response(500)
        return _response(200, _PROPERTY_PAYLOAD)

    _install(monkeypatch, handler)
    compound = fetch_compound(CID_PBBR2)

    assert compound is not None
    assert compound.molecular_formula == "Br2Pb"
    assert compound.cas_number is None
    assert compound.name is None


@pytest.mark.parametrize(
    "handler",
    [
        pytest.param(lambda url: _response(404), id="not-found"),
        pytest.param(lambda url: _response(503), id="unavailable"),
        pytest.param(
            lambda url: _response(200, body='{"PropertyTable": {"Prop'), id="truncated-json"
        ),
        pytest.param(lambda url: _response(200, {"PropertyTable": {"Properties": []}}), id="empty"),
        pytest.param(lambda url: _response(200, {"Fault": {"Code": "PUGREST.NotFound"}}), id="fault"),
    ],
)
def test_fetch_compound_returns_none_on_failure(monkeypatch, handler):
    _install(monkeypatch, handler)
    assert fetch_compound(CID_PBBR2) is None


def test_fetch_compound_survives_a_network_error(monkeypatch):
    def handler(url: str):
        raise httpx.ConnectError("no route to host")

    _install(monkeypatch, handler)
    assert fetch_compound(CID_PBBR2) is None


@pytest.mark.parametrize("cid", [0, -1])
def test_fetch_compound_rejects_nonsense_cids(monkeypatch, cid):
    def handler(url: str):
        raise AssertionError("must not issue a request for an invalid CID")

    _install(monkeypatch, handler)
    assert fetch_compound(cid) is None


def test_search_cid_by_name(monkeypatch):
    _install(
        monkeypatch,
        lambda url: _response(200, {"IdentifierList": {"CID": [CID_PBBR2, 999]}}),
    )
    assert search_cid_by_name("Lead(II) bromide") == CID_PBBR2


def test_search_cid_by_name_url_encodes_the_query(monkeypatch):
    """Names carry slashes, brackets and spaces; unencoded they break the path."""
    seen: list[str] = []

    def handler(url: str) -> httpx.Response:
        seen.append(url)
        return _response(200, {"IdentifierList": {"CID": [1]}})

    _install(monkeypatch, handler)
    search_cid_by_name("PEDOT:PSS / water")

    assert len(seen) == 1
    assert "PEDOT%3APSS%20%2F%20water" in seen[0]
    assert seen[0].endswith("/cids/JSON")


@pytest.mark.parametrize(
    "handler",
    [
        pytest.param(lambda url: _response(404), id="not-found"),
        pytest.param(lambda url: _response(200, {"IdentifierList": {"CID": []}}), id="no-hits"),
        pytest.param(lambda url: _response(200, {"IdentifierList": {}}), id="malformed"),
    ],
)
def test_search_cid_by_name_returns_none_on_failure(monkeypatch, handler):
    _install(monkeypatch, handler)
    assert search_cid_by_name("nonexistent compound") is None


def test_search_cid_by_name_skips_blank_queries(monkeypatch):
    def handler(url: str):
        raise AssertionError("must not issue a request for a blank name")

    _install(monkeypatch, handler)
    assert search_cid_by_name("   ") is None


def test_module_targets_the_real_pubchem_host():
    """Guards against a stub base URL being committed."""
    assert pubchem.PUBCHEM_BASE == "https://pubchem.ncbi.nlm.nih.gov/rest/pug"
