import uuid

from fastapi.testclient import TestClient

from app.core.config import settings
from tests.utils.utils import random_lower_string

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
