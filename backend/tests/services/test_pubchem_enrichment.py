"""DB-level tests for caching PubChem identities onto `lab_material`.

The PubChem client is stubbed throughout — no test may touch the network. What
is under test is the caching policy, which has two rules that matter:

* a value the user typed is never overwritten (name lookup is fuzzy);
* a failed fetch leaves the row retryable rather than marking it done.
"""

import uuid
from collections.abc import Generator

import pytest
from sqlmodel import Session, delete

from app.models import LabMaterial, User
from app.services import pubchem_enrichment
from app.services.pubchem import PubChemCompound
from app.services.pubchem_enrichment import enrich_material, enrich_materials
from tests.utils.user import create_random_user

PBBR2 = PubChemCompound(
    cid=24831,
    molecular_formula="Br2Pb",
    molecular_weight=367.0,
    iupac_name="dibromolead",
    smiles="[Pb](Br)Br",
    inchi="InChI=1S/2BrH.Pb/h2*1H;/q;;+2/p-2",
    inchi_key="ZASWJUOMEGBQCQ-UHFFFAOYSA-L",
    monoisotopic_mass=365.8,
    cas_number="10031-22-8",
    name="Lead(II) bromide",
)


@pytest.fixture(name="owner")
def owner_fixture(db: Session) -> Generator[User, None, None]:
    user = create_random_user(db)
    yield user
    db.rollback()
    db.execute(delete(User).where(User.id == user.id))
    db.commit()
    db.expunge_all()


class _Recorder:
    """Stub client that records the CIDs it was asked for."""

    def __init__(self, result: PubChemCompound | None = PBBR2):
        self.result = result
        self.calls: list[int] = []

    def __call__(self, cid: int, **_: object) -> PubChemCompound | None:
        self.calls.append(cid)
        return self.result


@pytest.fixture(name="fetch")
def fetch_fixture(monkeypatch) -> _Recorder:
    recorder = _Recorder()
    monkeypatch.setattr(pubchem_enrichment, "fetch_compound", recorder)
    # No batch test should ever really sleep.
    monkeypatch.setattr(pubchem_enrichment.time, "sleep", lambda _seconds: None)
    return recorder


def _material(db: Session, owner: User, **kwargs: object) -> LabMaterial:
    material = LabMaterial(
        id=uuid.uuid4(),
        owner_id=owner.id,
        name=str(kwargs.pop("name", "Lead(II) bromide")),
        **kwargs,
    )
    db.add(material)
    db.flush()
    return material


def test_enrichment_fills_every_backend_column(db: Session, owner: User, fetch: _Recorder):
    material = _material(db, owner, pubchem_cid="24831")

    assert enrich_material(db, material) is True

    assert material.molecular_formula == "Br2Pb"
    assert material.iupac_name == "dibromolead"
    assert material.smiles == "[Pb](Br)Br"
    assert material.inchi_key == "ZASWJUOMEGBQCQ-UHFFFAOYSA-L"
    assert material.monoisotopic_mass == pytest.approx(365.8)
    assert material.pubchem_name == "Lead(II) bromide"
    assert material.pubchem_synced_at is not None


def test_gaps_are_filled_but_user_input_is_never_overwritten(
    db: Session, owner: User, fetch: _Recorder
):
    """The whole point of the shared-column rule: the lab's own numbers win."""
    material = _material(
        db,
        owner,
        pubchem_cid="24831",
        molecular_weight=999.0,  # deliberately wrong, but user-entered
        cas_number="00-00-0",
    )

    enrich_material(db, material)

    assert material.molecular_weight == pytest.approx(999.0)
    assert material.cas_number == "00-00-0"
    # ...while the backend-owned columns are still populated.
    assert material.molecular_formula == "Br2Pb"


def test_empty_shared_columns_are_filled(db: Session, owner: User, fetch: _Recorder):
    material = _material(db, owner, pubchem_cid="24831")

    enrich_material(db, material)

    assert material.molecular_weight == pytest.approx(367.0)
    assert material.cas_number == "10031-22-8"


def test_a_failed_fetch_leaves_the_row_retryable(db: Session, owner: User, monkeypatch):
    monkeypatch.setattr(pubchem_enrichment, "fetch_compound", _Recorder(result=None))
    material = _material(db, owner, pubchem_cid="24831")

    assert enrich_material(db, material) is False

    assert material.molecular_formula is None
    # Unstamped on purpose — this is what makes the next run pick it up again.
    assert material.pubchem_synced_at is None


def test_enrichment_is_idempotent(db: Session, owner: User, fetch: _Recorder):
    material = _material(db, owner, pubchem_cid="24831")

    assert enrich_material(db, material) is True
    assert enrich_material(db, material) is False
    assert fetch.calls == [24831], "a synced row must not be re-fetched"

    assert enrich_material(db, material, force=True) is True
    assert fetch.calls == [24831, 24831]


def test_changing_the_cid_invalidates_the_cache(db: Session, owner: User, fetch: _Recorder):
    material = _material(db, owner, pubchem_cid="24831")
    enrich_material(db, material)

    material.pubchem_cid = "6228"
    assert enrich_material(db, material) is True, "a new CID is stale data"
    assert fetch.calls == [24831, 6228]


def test_material_without_cid_falls_back_to_a_name_search(
    db: Session, owner: User, fetch: _Recorder, monkeypatch
):
    monkeypatch.setattr(pubchem_enrichment, "search_cid_by_name", lambda _name: 24831)
    material = _material(db, owner, pubchem_cid=None)

    assert enrich_material(db, material) is True
    assert material.pubchem_cid == "24831"


def test_material_with_no_cid_and_no_name_match_is_skipped(
    db: Session, owner: User, fetch: _Recorder, monkeypatch
):
    monkeypatch.setattr(pubchem_enrichment, "search_cid_by_name", lambda _name: None)
    material = _material(db, owner, pubchem_cid=None)

    assert enrich_material(db, material) is False
    assert fetch.calls == []
    assert material.pubchem_synced_at is None


def test_batch_reports_how_many_changed(
    db: Session, owner: User, fetch: _Recorder, monkeypatch
):
    # Stubbed off explicitly: the CID-less row would otherwise reach the real
    # PubChem name-search endpoint.
    monkeypatch.setattr(pubchem_enrichment, "search_cid_by_name", lambda _name: None)
    materials = [
        _material(db, owner, pubchem_cid="24831", name="a"),
        _material(db, owner, pubchem_cid="6228", name="b"),
        _material(db, owner, pubchem_cid=None, name="c"),
    ]

    assert enrich_materials(db, materials, delay=0) == 2
    assert fetch.calls == [24831, 6228]


def test_one_bad_row_does_not_abort_the_batch(db: Session, owner: User, monkeypatch):
    """A single exploding row must not cost the whole batch its work."""
    good = _material(db, owner, pubchem_cid="24831", name="good")
    bad = _material(db, owner, pubchem_cid="6228", name="bad")

    def flaky(cid: int, **_: object) -> PubChemCompound | None:
        if cid == 6228:
            raise RuntimeError("boom")
        return PBBR2

    monkeypatch.setattr(pubchem_enrichment, "fetch_compound", flaky)
    monkeypatch.setattr(pubchem_enrichment.time, "sleep", lambda _s: None)

    assert enrich_materials(db, [bad, good], delay=0) == 1
    assert good.molecular_formula == "Br2Pb"
    assert bad.molecular_formula is None
