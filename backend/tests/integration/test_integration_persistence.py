"""Integration: the snapshot-sync contract the frontend HttpBackend depends on.

Every other integration test seeds data with server-generated IDs and exercises
one endpoint at a time. None of them reproduced what the GUI actually does on
save: POST entities with *client-generated* UUIDs, bulk-replace their nested
children, express DataCollection membership via the ``collection_id`` FK, and
then read everything back through ``GET /state/bulk``. That gap let a broken
frontend save path (a bulk ``PUT /state/`` the backend now rejects with 422)
ship green. These tests lock the contract down end to end.
"""

import uuid

import httpx

from .conftest import API_V1


def _uuid() -> str:
    return str(uuid.uuid4())


class TestClientProvidedIds:
    def test_process_honours_client_id(self, user_headers):
        cid = _uuid()
        r = httpx.post(
            f"{API_V1}/processes/",
            json={"id": cid, "name": "client-id-process"},
            headers=user_headers,
        )
        assert r.status_code == 200, r.text
        assert r.json()["id"] == cid, "backend must persist the client-supplied id"

        # Readable at exactly that id (cross-references depend on this).
        got = httpx.get(f"{API_V1}/processes/{cid}", headers=user_headers)
        assert got.status_code == 200
        httpx.delete(f"{API_V1}/processes/{cid}", headers=user_headers)

    def test_process_without_id_still_works(self, user_headers):
        r = httpx.post(
            f"{API_V1}/processes/",
            json={"name": "server-id-process"},
            headers=user_headers,
        )
        assert r.status_code == 200, r.text
        assert r.json()["id"]
        httpx.delete(f"{API_V1}/processes/{r.json()['id']}", headers=user_headers)


class TestProcessGraphRoundTrip:
    def test_recipes_and_steps_replace_and_reload(self, user_headers):
        pid = _uuid()
        rid = _uuid()
        sid = _uuid()
        assert (
            httpx.post(
                f"{API_V1}/processes/",
                json={"id": pid, "name": "graph-process"},
                headers=user_headers,
            ).status_code
            == 200
        )

        # Bulk-replace recipes (with a solute) exactly as the GUI does on save.
        rr = httpx.put(
            f"{API_V1}/processes/{pid}/recipes/",
            json=[
                {
                    "id": rid,
                    "name": "recipe A",
                    "total_solvent_volume_ml": "1",
                    "solutes": [{"name": "PbI2", "amount": "10", "unit": "mg"}],
                }
            ],
            headers=user_headers,
        )
        assert rr.status_code == 200, rr.text
        assert rr.json()[0]["id"] == rid

        # Steps reference the recipe by its client id.
        sr = httpx.put(
            f"{API_V1}/processes/{pid}/steps/",
            json=[
                {
                    "id": sid,
                    "stage_index": 0,
                    "step_index": 0,
                    "name": "spin coat",
                    "step_category": "wet_deposition",
                    "chem_recipe_id": rid,
                    "substrate_temp_value": "25",
                    "substrate_temp_mode": "constant",
                }
            ],
            headers=user_headers,
        )
        assert sr.status_code == 200, sr.text

        # Read back the fully-nested process.
        proc = httpx.get(f"{API_V1}/processes/{pid}", headers=user_headers).json()
        assert len(proc["recipes"]) == 1
        assert proc["recipes"][0]["solutes"][0]["name"] == "PbI2"
        assert len(proc["steps"]) == 1
        assert proc["steps"][0]["chem_recipe_id"] == rid
        assert proc["steps"][0]["substrate_temp_value"] == "25"

        # Replacing again with an empty list clears the children (delete path).
        assert (
            httpx.put(
                f"{API_V1}/processes/{pid}/steps/", json=[], headers=user_headers
            ).status_code
            == 200
        )
        proc = httpx.get(f"{API_V1}/processes/{pid}", headers=user_headers).json()
        assert proc["steps"] == []

        httpx.delete(f"{API_V1}/processes/{pid}", headers=user_headers)


class TestCollectionMembershipViaBulk:
    def test_collection_membership_round_trips_through_bulk(self, user_headers):
        """The user's exact repro: a Process placed in a plane's Data Collection
        must survive a reload. Membership lives on process.collection_id."""
        plane_id = _uuid()
        collection_id = _uuid()
        process_id = _uuid()

        # 1. Plane.
        assert (
            httpx.post(
                f"{API_V1}/planes/",
                json={"id": plane_id, "name": "Plane 1"},
                headers=user_headers,
            ).status_code
            == 200
        )
        # 2. Collection on the plane (bulk replace).
        cr = httpx.put(
            f"{API_V1}/planes/{plane_id}/collections",
            json=[{"id": collection_id, "i": 0, "j": 0, "name": "Data Collection"}],
            headers=user_headers,
        )
        assert cr.status_code == 200, cr.text
        assert cr.json()[0]["id"] == collection_id

        # 3. Process pointing at the collection (membership FK) and plane.
        assert (
            httpx.post(
                f"{API_V1}/processes/",
                json={
                    "id": process_id,
                    "name": "New Process",
                    "plane_id": plane_id,
                    "collection_id": collection_id,
                },
                headers=user_headers,
            ).status_code
            == 200
        )

        # 4. Reload exactly like the GUI does on next login.
        bulk = httpx.get(f"{API_V1}/state/bulk", headers=user_headers).json()
        proc = next((p for p in bulk["processes"] if p["id"] == process_id), None)
        assert proc is not None, "process vanished from bulk state"
        assert proc["collection_id"] == collection_id, "membership was lost"
        plane = next((p for p in bulk["planes"] if p["id"] == plane_id), None)
        assert plane is not None
        assert any(c["id"] == collection_id for c in plane["collections"])

        httpx.delete(f"{API_V1}/processes/{process_id}", headers=user_headers)
        httpx.delete(f"{API_V1}/planes/{plane_id}", headers=user_headers)


class TestLegacyStateContractRejected:
    def test_bulk_put_state_snapshot_is_rejected(self, user_headers):
        """The old frontend save (PUT /state/ {data: snapshot}) must 422 — this
        is the error the user hit; the fix moved persistence to per-entity REST."""
        r = httpx.put(
            f"{API_V1}/state/",
            json={"data": {"processes": [], "planes": []}},
            headers=user_headers,
        )
        assert r.status_code == 422
