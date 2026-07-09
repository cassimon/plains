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
        attacker_list = client.get(f"{TRASH}/", headers=normal_user_token_headers).json()
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
