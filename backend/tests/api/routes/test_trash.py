import uuid
from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session, select

from app import crud
from app.core.config import settings
from app.models import ProcessCreate, TrashEntry, User, UserCreate
from tests.utils.utils import random_email, random_lower_string

API = settings.API_V1_STR
TRASH = f"{API}/trash"


def _create_process(client: TestClient, headers: dict) -> dict:
    r = client.post(
        f"{API}/processes/",
        json={"name": random_lower_string(), "skip_chemistry": True},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _create_experiment(client: TestClient, headers: dict, process_id: str) -> dict:
    r = client.post(
        f"{API}/experiments/",
        json={"name": random_lower_string(), "process_id": process_id},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _create_result(
    client: TestClient, headers: dict, experiment_id: str, **kwargs
) -> dict:
    r = client.post(
        f"{API}/results/?experiment_id={experiment_id}",
        json={"notes": random_lower_string(), **kwargs},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _create_plane(client: TestClient, headers: dict) -> dict:
    r = client.post(
        f"{API}/planes/",
        json={"name": random_lower_string()},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _create_collection(client: TestClient, headers: dict, plane_id: str) -> dict:
    cid = str(uuid.uuid4())
    r = client.put(
        f"{API}/planes/{plane_id}/collections",
        json=[{"id": cid, "i": 0, "j": 0, "name": random_lower_string()}],
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return next(c for c in r.json() if c["id"] == cid)


def _bulk(client: TestClient, headers: dict) -> dict:
    r = client.get(f"{API}/state/bulk", headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def _trash(client: TestClient, headers: dict, etype: str, eid: str) -> dict:
    r = client.post(
        f"{TRASH}/",
        json={"entity_type": etype, "entity_id": eid},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


def _restore(client: TestClient, headers: dict, etype: str, eid: str) -> dict:
    r = client.post(
        f"{TRASH}/restore",
        json={"entity_type": etype, "entity_id": eid},
        headers=headers,
    )
    assert r.status_code == 200, r.text
    return r.json()


class TestTrashAuth:
    def test_list_requires_auth(self, client: TestClient) -> None:
        assert client.get(f"{TRASH}/").status_code == 401

    def test_trash_requires_auth(self, client: TestClient) -> None:
        r = client.post(
            f"{TRASH}/",
            json={"entity_type": "process", "entity_id": str(uuid.uuid4())},
        )
        assert r.status_code == 401

    def test_rejects_unknown_type(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        r = client.post(
            f"{TRASH}/",
            json={"entity_type": "banana", "entity_id": str(uuid.uuid4())},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 422


class TestTrashHidesFromBulk:
    def test_soft_delete_hides_process(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        proc = _create_process(client, normal_user_token_headers)
        assert any(
            p["id"] == proc["id"]
            for p in _bulk(client, normal_user_token_headers)["processes"]
        )
        _trash(client, normal_user_token_headers, "process", proc["id"])
        assert not any(
            p["id"] == proc["id"]
            for p in _bulk(client, normal_user_token_headers)["processes"]
        )

    def test_appears_in_trash_list(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        proc = _create_process(client, normal_user_token_headers)
        _trash(client, normal_user_token_headers, "process", proc["id"])
        listing = client.get(f"{TRASH}/", headers=normal_user_token_headers).json()
        ids = {e["entity_id"] for e in listing["data"]}
        assert proc["id"] in ids


class TestCascades:
    def test_delete_process_cascades_to_experiment(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        proc = _create_process(client, normal_user_token_headers)
        exp = _create_experiment(client, normal_user_token_headers, proc["id"])
        _trash(client, normal_user_token_headers, "process", proc["id"])
        bulk = _bulk(client, normal_user_token_headers)
        assert not any(p["id"] == proc["id"] for p in bulk["processes"])
        assert not any(e["id"] == exp["id"] for e in bulk["experiments"])

    def test_restore_result_reinstates_ancestors(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        proc = _create_process(client, normal_user_token_headers)
        exp = _create_experiment(client, normal_user_token_headers, proc["id"])
        res = _create_result(client, normal_user_token_headers, exp["id"])
        # Trash the process → cascades down to experiment + result.
        _trash(client, normal_user_token_headers, "process", proc["id"])
        bulk = _bulk(client, normal_user_token_headers)
        assert not any(r["id"] == res["id"] for r in bulk["results"])
        # Restore the result → up-closure brings experiment + process back.
        _restore(client, normal_user_token_headers, "result", res["id"])
        bulk = _bulk(client, normal_user_token_headers)
        assert any(p["id"] == proc["id"] for p in bulk["processes"])
        assert any(e["id"] == exp["id"] for e in bulk["experiments"])
        assert any(r["id"] == res["id"] for r in bulk["results"])


class TestFinishedUploadProtection:
    def test_finished_upload_not_trashed_by_cascade(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        proc = _create_process(client, normal_user_token_headers)
        exp = _create_experiment(client, normal_user_token_headers, proc["id"])
        # A result that already completed a NOMAD upload.
        res = _create_result(
            client,
            normal_user_token_headers,
            exp["id"],
            nomad_upload_id="UP123",
            nomad_upload_status="SUCCESS",
        )
        _trash(client, normal_user_token_headers, "process", proc["id"])
        listing = client.get(f"{TRASH}/", headers=normal_user_token_headers).json()
        trashed_ids = {e["entity_id"] for e in listing["data"]}
        assert res["id"] not in trashed_ids  # finished upload survives


class TestPurgeAndEmpty:
    def test_purge_removes_entity(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        proc = _create_process(client, normal_user_token_headers)
        _trash(client, normal_user_token_headers, "process", proc["id"])
        r = client.post(
            f"{TRASH}/process/{proc['id']}/purge",
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200, r.text
        # Gone for good.
        got = client.get(
            f"{API}/processes/{proc['id']}", headers=normal_user_token_headers
        )
        assert got.status_code == 404
        listing = client.get(f"{TRASH}/", headers=normal_user_token_headers).json()
        assert proc["id"] not in {e["entity_id"] for e in listing["data"]}

    def test_empty_clears_trash(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        p1 = _create_process(client, normal_user_token_headers)
        p2 = _create_process(client, normal_user_token_headers)
        _trash(client, normal_user_token_headers, "process", p1["id"])
        _trash(client, normal_user_token_headers, "process", p2["id"])
        r = client.post(f"{TRASH}/empty", headers=normal_user_token_headers)
        assert r.status_code == 200, r.text
        listing = client.get(f"{TRASH}/", headers=normal_user_token_headers).json()
        assert listing["count"] == 0


class TestPlaneCascade:
    def test_trash_plane_cascades_to_members_and_collections(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        h = normal_user_token_headers
        plane = _create_plane(client, h)
        collection = _create_collection(client, h, plane["id"])
        # A process placed on the plane + collection.
        r = client.post(
            f"{API}/processes/",
            json={
                "name": random_lower_string(),
                "skip_chemistry": True,
                "plane_id": plane["id"],
                "collection_id": collection["id"],
            },
            headers=h,
        )
        assert r.status_code == 200, r.text
        proc = r.json()

        _trash(client, h, "plane", plane["id"])

        bulk = _bulk(client, h)
        assert not any(p["id"] == plane["id"] for p in bulk["planes"])
        assert not any(p["id"] == proc["id"] for p in bulk["processes"])
        # Collection is cascade-trashed and filtered out of every plane payload.
        all_collections = [c for p in bulk["planes"] for c in p["collections"]]
        assert collection["id"] not in {c["id"] for c in all_collections}

        # It is all restorable together by restoring the plane.
        _restore(client, h, "plane", plane["id"])
        # Restoring the deletion root revives its whole batch at once — the plane
        # and every member/collection trashed with it come back together.
        bulk = _bulk(client, h)
        assert any(p["id"] == plane["id"] for p in bulk["planes"])
        assert any(p["id"] == proc["id"] for p in bulk["processes"])
        listing = client.get(f"{TRASH}/", headers=h).json()
        assert listing["count"] == 0

    def test_original_plane_recorded(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        h = normal_user_token_headers
        plane = _create_plane(client, h)
        r = client.post(
            f"{API}/processes/",
            json={
                "name": random_lower_string(),
                "skip_chemistry": True,
                "plane_id": plane["id"],
            },
            headers=h,
        )
        proc = r.json()
        _trash(client, h, "process", proc["id"])
        listing = client.get(f"{TRASH}/", headers=h).json()
        entry = next(e for e in listing["data"] if e["entity_id"] == proc["id"])
        assert entry["original_plane_id"] == plane["id"]


class TestCollectionCascade:
    def test_trash_collection_cascades_to_members(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        h = normal_user_token_headers
        plane = _create_plane(client, h)
        collection = _create_collection(client, h, plane["id"])
        r = client.post(
            f"{API}/processes/",
            json={
                "name": random_lower_string(),
                "skip_chemistry": True,
                "plane_id": plane["id"],
                "collection_id": collection["id"],
            },
            headers=h,
        )
        proc = r.json()
        _trash(client, h, "collection", collection["id"])
        bulk = _bulk(client, h)
        # The plane survives; the collection and its member process do not.
        assert any(p["id"] == plane["id"] for p in bulk["planes"])
        assert not any(p["id"] == proc["id"] for p in bulk["processes"])


class TestListRouteFiltering:
    def test_trashed_process_absent_from_list_route(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        h = normal_user_token_headers
        proc = _create_process(client, h)
        before = client.get(f"{API}/processes/", headers=h).json()
        assert any(p["id"] == proc["id"] for p in before["data"])
        _trash(client, h, "process", proc["id"])
        after = client.get(f"{API}/processes/", headers=h).json()
        assert not any(p["id"] == proc["id"] for p in after["data"])


class TestIdempotency:
    def test_retrash_is_noop(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        h = normal_user_token_headers
        proc = _create_process(client, h)
        _trash(client, h, "process", proc["id"])
        _trash(client, h, "process", proc["id"])  # second call must not duplicate
        listing = client.get(f"{TRASH}/", headers=h).json()
        matches = [e for e in listing["data"] if e["entity_id"] == proc["id"]]
        assert len(matches) == 1  # no duplicate trash row


class TestRootListingAndSummary:
    def test_only_root_listed_with_summary(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        h = normal_user_token_headers
        proc = _create_process(client, h)
        exp = _create_experiment(client, h, proc["id"])
        _create_result(client, h, exp["id"])
        _create_result(client, h, exp["id"])
        exp2 = _create_experiment(client, h, proc["id"])  # noqa: F841 (extra child)
        _trash(client, h, "process", proc["id"])

        listing = client.get(f"{TRASH}/", headers=h).json()
        # The deleted root (the process) is listed with a content summary.
        root = next(e for e in listing["data"] if e["entity_id"] == proc["id"])
        assert root["entity_type"] == "process"
        assert root["child_count"] == 4  # 2 experiments + 2 results
        assert root["child_counts"] == {"experiment": 2, "result": 2}
        assert "experiments" in root["summary"]
        assert "results" in root["summary"]
        # This deletion's descendants are not separate top-level rows.
        listed_ids = {e["entity_id"] for e in listing["data"]}
        assert exp["id"] not in listed_ids

    def test_list_sorted_by_category(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        h = normal_user_token_headers
        proc = _create_process(client, h)
        plane = _create_plane(client, h)
        _trash(client, h, "process", proc["id"])
        _trash(client, h, "plane", plane["id"])
        listing = client.get(f"{TRASH}/", headers=h).json()
        types = [e["entity_type"] for e in listing["data"]]
        # process sorts before plane in the category order.
        assert types.index("process") < types.index("plane")

    def test_restore_reattaches_nulled_placement(
        self, client: TestClient, normal_user_token_headers: dict, db: Session
    ) -> None:
        """After trash, a save nulls the member's collection_id (SET NULL when the
        collection is replaced). Restore must re-point it at its original home."""
        from app.models import Process

        h = normal_user_token_headers
        plane = _create_plane(client, h)
        collection = _create_collection(client, h, plane["id"])
        r = client.post(
            f"{API}/processes/",
            json={
                "name": random_lower_string(),
                "skip_chemistry": True,
                "plane_id": plane["id"],
                "collection_id": collection["id"],
            },
            headers=h,
        )
        proc = r.json()
        _trash(client, h, "process", proc["id"])
        # Simulate the destructive collections-replace nulling the member FK.
        db_proc = db.get(Process, uuid.UUID(proc["id"]))
        assert db_proc is not None
        db_proc.collection_id = None
        db_proc.plane_id = None
        db.add(db_proc)
        db.commit()

        restored = _restore(client, h, "process", proc["id"])["restored"]
        item = next(i for i in restored if i["entity_id"] == proc["id"])
        assert item["collection_id"] == collection["id"]
        assert item["plane_id"] == plane["id"]
        assert item["needs_placement"] is False

    def test_restore_needs_placement_when_plane_gone(
        self, client: TestClient, normal_user_token_headers: dict, db: Session
    ) -> None:
        from app.models import Process

        h = normal_user_token_headers
        plane = _create_plane(client, h)
        r = client.post(
            f"{API}/processes/",
            json={
                "name": random_lower_string(),
                "skip_chemistry": True,
                "plane_id": plane["id"],
            },
            headers=h,
        )
        proc = r.json()
        _trash(client, h, "process", proc["id"])
        # Original plane hard-deleted → nowhere to put the restored item.
        db_plane_proc = db.get(Process, uuid.UUID(proc["id"]))
        assert db_plane_proc is not None
        db_plane_proc.plane_id = None
        db.add(db_plane_proc)
        from app.models import Plane as PlaneModel

        db.delete(db.get(PlaneModel, uuid.UUID(plane["id"])))
        db.commit()
        restored = _restore(client, h, "process", proc["id"])["restored"]
        item = next(i for i in restored if i["entity_id"] == proc["id"])
        assert item["needs_placement"] is True

    def test_restore_returns_placement(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        h = normal_user_token_headers
        plane = _create_plane(client, h)
        collection = _create_collection(client, h, plane["id"])
        r = client.post(
            f"{API}/processes/",
            json={
                "name": random_lower_string(),
                "skip_chemistry": True,
                "plane_id": plane["id"],
                "collection_id": collection["id"],
            },
            headers=h,
        )
        proc = r.json()
        _trash(client, h, "process", proc["id"])
        restored = _restore(client, h, "process", proc["id"])["restored"]
        item = next(i for i in restored if i["entity_id"] == proc["id"])
        assert item["plane_id"] == plane["id"]
        assert item["collection_id"] == collection["id"]
        assert item["original_plane_id"] == plane["id"]
        assert item["original_collection_id"] == collection["id"]


class TestTTLSweep:
    def test_expired_entries_are_swept(
        self, client: TestClient, normal_user_token_headers: dict, db: Session
    ) -> None:
        h = normal_user_token_headers
        proc = _create_process(client, h)
        _trash(client, h, "process", proc["id"])
        # Age the trash row well past the TTL.
        entry = db.exec(
            select(TrashEntry).where(TrashEntry.entity_id == uuid.UUID(proc["id"]))
        ).first()
        assert entry is not None
        entry.deleted_at = datetime.now(timezone.utc) - timedelta(
            days=settings.TRASH_TTL_DAYS + 5
        )
        db.add(entry)
        db.commit()
        # GET /trash/ runs the sweep → the entity and its trash row are gone.
        listing = client.get(f"{TRASH}/", headers=h).json()
        assert proc["id"] not in {e["entity_id"] for e in listing["data"]}
        assert client.get(f"{API}/processes/{proc['id']}", headers=h).status_code == 404


@pytest.fixture(scope="module")
def victim(db: Session) -> User:
    """An unrelated user, owner of items the attacker (normal_user) will hunt.

    The victim is never authenticated (mirrors test_idor.py) — this sidesteps
    the email whitelist that would otherwise block a second real login.
    """
    return crud.create_user(
        session=db,
        user_create=UserCreate(email=random_email(), password="VictimPass1!"),
    )


class TestOwnershipIsolation:
    """The attacker is ``normal_user_token_headers``; the victim owns the rows."""

    def test_cannot_trash_another_users_item(
        self,
        client: TestClient,
        normal_user_token_headers: dict,
        db: Session,
        victim: User,
    ) -> None:
        victim_proc = crud.create_process(
            session=db,
            process_in=ProcessCreate(name=random_lower_string()),
            owner_id=victim.id,
        )
        r = client.post(
            f"{TRASH}/",
            json={"entity_type": "process", "entity_id": str(victim_proc.id)},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403
        # No trash row was created for it.
        assert (
            db.exec(
                select(TrashEntry).where(TrashEntry.entity_id == victim_proc.id)
            ).first()
            is None
        )

    def test_trash_list_is_owner_scoped(
        self,
        client: TestClient,
        normal_user_token_headers: dict,
        db: Session,
        victim: User,
    ) -> None:
        victim_proc = crud.create_process(
            session=db,
            process_in=ProcessCreate(name=random_lower_string()),
            owner_id=victim.id,
        )
        db.add(
            TrashEntry(
                owner_id=victim.id,
                entity_type="process",
                entity_id=victim_proc.id,
                name="victim proc",
            )
        )
        db.commit()
        attacker_list = client.get(
            f"{TRASH}/", headers=normal_user_token_headers
        ).json()
        assert str(victim_proc.id) not in {
            e["entity_id"] for e in attacker_list["data"]
        }

    def test_cannot_purge_another_users_item(
        self,
        client: TestClient,
        normal_user_token_headers: dict,
        db: Session,
        victim: User,
    ) -> None:
        victim_proc = crud.create_process(
            session=db,
            process_in=ProcessCreate(name=random_lower_string()),
            owner_id=victim.id,
        )
        r = client.post(
            f"{TRASH}/process/{victim_proc.id}/purge",
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403
        # Still there.
        assert db.get(type(victim_proc), victim_proc.id) is not None


# ── Round-trip equality (the acceptance gate for server-atomic restore) ───────

# Keys whose value legitimately changes between two otherwise-identical
# snapshots (bookkeeping, not user-visible state).
_VOLATILE_KEYS = {"updated_at"}


def _normalise(value: object) -> object:
    """Canonical form of a /state/bulk payload: volatile keys dropped, every
    list of identified objects sorted, so two snapshots compare by value."""
    if isinstance(value, dict):
        return {
            k: _normalise(v)
            for k, v in sorted(value.items())
            if k not in _VOLATILE_KEYS
        }
    if isinstance(value, list):
        items = [_normalise(v) for v in value]
        if all(isinstance(i, dict) and "id" in i for i in items):
            return sorted(items, key=lambda i: str(i["id"]))  # type: ignore[index]
        return items
    return value


def _restore_to(
    client: TestClient,
    headers: dict,
    etype: str,
    eid: str,
    destination_plane_id: str | None = None,
) -> dict:
    body: dict = {"entity_type": etype, "entity_id": eid}
    if destination_plane_id is not None:
        body["destination_plane_id"] = destination_plane_id
    r = client.post(f"{TRASH}/restore", json=body, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def _collection_ids(client: TestClient, headers: dict) -> set[str]:
    """Every collection id visible to the user, across all planes."""
    return {c["id"] for p in _bulk(client, headers)["planes"] for c in p["collections"]}


def _place(client: TestClient, headers: dict, path: str, body: dict) -> dict:
    r = client.post(f"{API}/{path}", json=body, headers=headers)
    assert r.status_code == 200, r.text
    return r.json()


def _branch(client: TestClient, headers: dict) -> dict:
    """A full dependency branch: plane → collection → process → experiment → result."""
    plane = _create_plane(client, headers)
    collection = _create_collection(client, headers, plane["id"])
    placement = {"plane_id": plane["id"], "collection_id": collection["id"]}
    proc = _place(
        client,
        headers,
        "processes/",
        {"name": random_lower_string(), "skip_chemistry": True, **placement},
    )
    exp = _place(
        client,
        headers,
        "experiments/",
        {"name": random_lower_string(), "process_id": proc["id"], **placement},
    )
    res = _place(
        client,
        headers,
        f"results/?experiment_id={exp['id']}",
        {"notes": random_lower_string(), **placement},
    )
    return {
        "plane": plane,
        "collection": collection,
        "process": proc,
        "experiment": exp,
        "result": res,
    }


class TestRestoreRoundTripEquality:
    """Delete → restore must return /state/bulk to *exactly* its former value.

    This pins the server-atomic guarantee: a plain reload renders the restored
    dependency branch, with no client-side placement writes.
    """

    @pytest.mark.parametrize(
        "root", ["result", "experiment", "process", "collection", "plane"]
    )
    def test_bulk_snapshot_is_unchanged(
        self, client: TestClient, normal_user_token_headers: dict, root: str
    ) -> None:
        h = normal_user_token_headers
        branch = _branch(client, h)
        before = _normalise(_bulk(client, h))

        _trash(client, h, root, branch[root]["id"])
        assert _normalise(_bulk(client, h)) != before  # the delete really happened

        _restore(client, h, root, branch[root]["id"])
        assert _normalise(_bulk(client, h)) == before

    def test_restore_survives_a_stale_canvas_save(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        """The F1/F2 trap: a client save carrying the pre-restore canvas must not
        unplace what the server just restored."""
        h = normal_user_token_headers
        branch = _branch(client, h)
        plane, coll = branch["plane"], branch["collection"]
        before = _normalise(_bulk(client, h))

        _trash(client, h, "process", branch["process"]["id"])
        _restore(client, h, "process", branch["process"]["id"])

        # A stale canvas save: the collection is unchanged, the restored members
        # are absent from the body (the client had dropped them at delete time).
        r = client.put(
            f"{API}/planes/{plane['id']}/collections",
            json=[
                {"id": coll["id"], "i": coll["i"], "j": coll["j"], "name": coll["name"]}
            ],
            headers=h,
        )
        assert r.status_code == 200, r.text

        assert _normalise(_bulk(client, h)) == before


class TestRestorePlacementLadder:
    def test_collection_gone_lands_in_restored_bucket_on_original_plane(
        self, client: TestClient, normal_user_token_headers: dict, db: Session
    ) -> None:
        """Plane alive, collection gone → server creates "Restored: <root>" on it.

        The item comes back visible (attached to a collection) — not a floating
        row with a bare plane_id that the canvas cannot render.
        """
        from app.models import DataCollection

        h = normal_user_token_headers
        branch = _branch(client, h)
        proc = branch["process"]
        _trash(client, h, "process", proc["id"])
        # The user then deletes the collection outright (hard delete).
        db.delete(db.get(DataCollection, uuid.UUID(branch["collection"]["id"])))
        db.commit()

        restored = _restore(client, h, "process", proc["id"])["restored"]
        item = next(i for i in restored if i["entity_id"] == proc["id"])
        assert item["needs_placement"] is False
        assert item["plane_id"] == branch["plane"]["id"]
        assert item["collection_id"] is not None
        assert item["position_fixup"] is True

        bulk = _bulk(client, h)
        plane = next(p for p in bulk["planes"] if p["id"] == branch["plane"]["id"])
        bucket = next(
            c for c in plane["collections"] if c["id"] == item["collection_id"]
        )
        assert bucket["name"].startswith("Restored: ")
        # One bucket for the whole batch — not one per restored entity.
        assert len({i["collection_id"] for i in restored if i["collection_id"]}) == 1

    def test_destination_plane_rehomes_the_collection_row(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        """Original plane gone → the *same* collection (id, name, members) moves
        to the destination plane, rather than its members being dumped loose."""
        h = normal_user_token_headers
        branch = _branch(client, h)
        other = _create_plane(client, h)

        _trash(client, h, "collection", branch["collection"]["id"])
        _trash(client, h, "plane", branch["plane"]["id"])

        restored = _restore_to(
            client, h, "collection", branch["collection"]["id"], other["id"]
        )["restored"]
        item = next(i for i in restored if i["entity_id"] == branch["collection"]["id"])
        assert item["plane_id"] == other["id"]

        bulk = _bulk(client, h)
        dest = next(p for p in bulk["planes"] if p["id"] == other["id"])
        moved = next(
            c for c in dest["collections"] if c["id"] == branch["collection"]["id"]
        )
        assert moved["name"] == branch["collection"]["name"]  # identity preserved
        # Members came with it.
        proc = next(p for p in bulk["processes"] if p["id"] == branch["process"]["id"])
        assert proc["collection_id"] == branch["collection"]["id"]
        assert proc["plane_id"] == other["id"]

    def test_no_destination_leaves_item_unplaced(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        h = normal_user_token_headers
        branch = _branch(client, h)
        _trash(client, h, "process", branch["process"]["id"])
        _trash(client, h, "plane", branch["plane"]["id"])

        restored = _restore(client, h, "process", branch["process"]["id"])["restored"]
        item = next(i for i in restored if i["entity_id"] == branch["process"]["id"])
        assert item["needs_placement"] is True
        assert item["plane_id"] is None
        # The row itself is alive and visible again, just unplaced.
        bulk = _bulk(client, h)
        assert any(p["id"] == branch["process"]["id"] for p in bulk["processes"])

    def test_destination_plane_places_loose_entity(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        h = normal_user_token_headers
        branch = _branch(client, h)
        other = _create_plane(client, h)
        _trash(client, h, "process", branch["process"]["id"])
        _trash(client, h, "plane", branch["plane"]["id"])

        restored = _restore_to(
            client, h, "process", branch["process"]["id"], other["id"]
        )["restored"]
        item = next(i for i in restored if i["entity_id"] == branch["process"]["id"])
        assert item["needs_placement"] is False
        assert item["plane_id"] == other["id"]
        assert item["position_fixup"] is True

        bulk = _bulk(client, h)
        dest = next(p for p in bulk["planes"] if p["id"] == other["id"])
        assert any(c["id"] == item["collection_id"] for c in dest["collections"])

    def test_unplaced_entity_stays_unplaced(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        """A process that never sat on a canvas must not gain a placement."""
        h = normal_user_token_headers
        proc = _create_process(client, h)  # no plane_id / collection_id
        before = _collection_ids(client, h)
        _trash(client, h, "process", proc["id"])
        restored = _restore(client, h, "process", proc["id"])["restored"]
        item = next(i for i in restored if i["entity_id"] == proc["id"])
        assert item["needs_placement"] is False
        assert item["plane_id"] is None
        assert item["collection_id"] is None
        # No stray "Restored: …" collection was invented for it.
        assert _collection_ids(client, h) == before


class TestTrashReturnsCascadedBatch:
    def test_post_trash_returns_every_cascaded_id(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        """The client prunes exactly these ids from its local arrays/selections."""
        h = normal_user_token_headers
        proc = _create_process(client, h)
        exp = _create_experiment(client, h, proc["id"])
        res = _create_result(client, h, exp["id"])

        body = _trash(client, h, "process", proc["id"])
        trashed = {(t["entity_type"], t["entity_id"]) for t in body["trashed"]}
        assert trashed == {
            ("process", proc["id"]),
            ("experiment", exp["id"]),
            ("result", res["id"]),
        }

    def test_batch_is_reported_even_when_already_trashed(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> None:
        h = normal_user_token_headers
        proc = _create_process(client, h)
        exp = _create_experiment(client, h, proc["id"])
        _trash(client, h, "process", proc["id"])
        again = _trash(client, h, "process", proc["id"])
        ids = {t["entity_id"] for t in again["trashed"]}
        assert ids == {proc["id"], exp["id"]}  # closure, not just new rows
