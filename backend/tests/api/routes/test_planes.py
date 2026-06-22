import uuid

from fastapi.testclient import TestClient
from sqlmodel import Session

from app.core.config import settings
from tests.utils.utils import random_lower_string

BASE = f"{settings.API_V1_STR}/planes"


def create_plane(client: TestClient, headers: dict, name: str | None = None) -> dict:
    payload = {"name": name or random_lower_string()}
    r = client.post(f"{BASE}/", json=payload, headers=headers)
    assert r.status_code == 200
    return r.json()


class TestPlanesAuth:
    def test_list_requires_auth(self, client: TestClient) -> None:
        assert client.get(f"{BASE}/").status_code == 401

    def test_get_requires_auth(self, client: TestClient) -> None:
        assert client.get(f"{BASE}/{uuid.uuid4()}").status_code == 401

    def test_create_requires_auth(self, client: TestClient) -> None:
        assert client.post(f"{BASE}/", json={"name": "x"}).status_code == 401

    def test_update_requires_auth(self, client: TestClient) -> None:
        assert (
            client.put(f"{BASE}/{uuid.uuid4()}", json={"name": "x"}).status_code == 401
        )

    def test_delete_requires_auth(self, client: TestClient) -> None:
        assert client.delete(f"{BASE}/{uuid.uuid4()}").status_code == 401


class TestPlanesCRUD:
    def test_create_plane(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        name = random_lower_string()
        r = client.post(
            f"{BASE}/", json={"name": name}, headers=normal_user_token_headers
        )
        assert r.status_code == 200
        data = r.json()
        assert data["name"] == name
        assert "id" in data
        assert data["sticky_notes"] == []
        assert data["text_fields"] == []
        assert data["collections"] == []
        assert data["shared_with"] == []

    def test_list_planes(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        create_plane(client, normal_user_token_headers)
        r = client.get(f"{BASE}/", headers=normal_user_token_headers)
        assert r.status_code == 200
        data = r.json()
        assert "data" in data
        assert data["count"] >= 1

    def test_get_plane_by_id(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, normal_user_token_headers)
        r = client.get(f"{BASE}/{plane['id']}", headers=normal_user_token_headers)
        assert r.status_code == 200
        assert r.json()["id"] == plane["id"]

    def test_get_plane_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.get(f"{BASE}/{uuid.uuid4()}", headers=normal_user_token_headers)
        assert r.status_code == 404

    def test_update_plane(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, normal_user_token_headers)
        new_name = random_lower_string()
        r = client.put(
            f"{BASE}/{plane['id']}",
            json={"name": new_name},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        assert r.json()["name"] == new_name

    def test_update_plane_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.put(
            f"{BASE}/{uuid.uuid4()}",
            json={"name": "x"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 404

    def test_delete_plane(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, normal_user_token_headers)
        r = client.delete(f"{BASE}/{plane['id']}", headers=normal_user_token_headers)
        assert r.status_code == 200
        assert r.json()["ok"] is True
        assert (
            client.get(
                f"{BASE}/{plane['id']}", headers=normal_user_token_headers
            ).status_code
            == 404
        )

    def test_delete_plane_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.delete(f"{BASE}/{uuid.uuid4()}", headers=normal_user_token_headers)
        assert r.status_code == 404


class TestPlanesIDOR:
    def test_get_unshared_plane_forbidden(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        plane = create_plane(client, superuser_token_headers)
        r = client.get(f"{BASE}/{plane['id']}", headers=normal_user_token_headers)
        assert r.status_code == 403

    def test_update_other_user_plane_forbidden(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        plane = create_plane(client, superuser_token_headers)
        r = client.put(
            f"{BASE}/{plane['id']}",
            json={"name": "hacked"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403

    def test_delete_other_user_plane_forbidden(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        plane = create_plane(client, superuser_token_headers)
        r = client.delete(f"{BASE}/{plane['id']}", headers=normal_user_token_headers)
        assert r.status_code == 403


class TestPlanesSharing:
    def _get_superuser_id(
        self, client: TestClient, superuser_token_headers: dict
    ) -> str:
        """Get the superuser's id by reading one of their planes."""
        plane = create_plane(client, superuser_token_headers)
        return client.get(
            f"{BASE}/{plane['id']}", headers=superuser_token_headers
        ).json()["owner_id"]

    def _get_normaluser_id(
        self, client: TestClient, normal_user_token_headers: dict
    ) -> str:
        plane = create_plane(client, normal_user_token_headers)
        return client.get(
            f"{BASE}/{plane['id']}", headers=normal_user_token_headers
        ).json()["owner_id"]

    def test_owner_can_share_with_other_user(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        plane = create_plane(client, superuser_token_headers)
        target_id = self._get_normaluser_id(client, normal_user_token_headers)
        r = client.post(
            f"{BASE}/{plane['id']}/share",
            json={"user_id": target_id},
            headers=superuser_token_headers,
        )
        assert r.status_code == 200
        shared_ids = [u["id"] for u in r.json()["shared_with"]]
        assert target_id in shared_ids

    def test_shared_user_can_read_plane(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        plane = create_plane(client, superuser_token_headers)
        target_id = self._get_normaluser_id(client, normal_user_token_headers)
        client.post(
            f"{BASE}/{plane['id']}/share",
            json={"user_id": target_id},
            headers=superuser_token_headers,
        )
        r = client.get(f"{BASE}/{plane['id']}", headers=normal_user_token_headers)
        assert r.status_code == 200

    def test_shared_plane_appears_in_shareduser_list(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        plane = create_plane(client, superuser_token_headers)
        target_id = self._get_normaluser_id(client, normal_user_token_headers)
        client.post(
            f"{BASE}/{plane['id']}/share",
            json={"user_id": target_id},
            headers=superuser_token_headers,
        )
        r = client.get(f"{BASE}/", headers=normal_user_token_headers)
        ids = [p["id"] for p in r.json()["data"]]
        assert plane["id"] in ids

    def test_share_plane_with_self_forbidden(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
    ) -> None:
        plane = create_plane(client, superuser_token_headers)
        owner_id = client.get(
            f"{BASE}/{plane['id']}", headers=superuser_token_headers
        ).json()["owner_id"]
        r = client.post(
            f"{BASE}/{plane['id']}/share",
            json={"user_id": owner_id},
            headers=superuser_token_headers,
        )
        assert r.status_code == 400

    def test_share_plane_duplicate_forbidden(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        plane = create_plane(client, superuser_token_headers)
        target_id = self._get_normaluser_id(client, normal_user_token_headers)
        client.post(
            f"{BASE}/{plane['id']}/share",
            json={"user_id": target_id},
            headers=superuser_token_headers,
        )
        r = client.post(
            f"{BASE}/{plane['id']}/share",
            json={"user_id": target_id},
            headers=superuser_token_headers,
        )
        assert r.status_code == 400

    def test_share_plane_user_not_found(
        self, client: TestClient, superuser_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, superuser_token_headers)
        r = client.post(
            f"{BASE}/{plane['id']}/share",
            json={"user_id": str(uuid.uuid4())},
            headers=superuser_token_headers,
        )
        assert r.status_code == 404

    def test_non_owner_cannot_share(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        plane = create_plane(client, superuser_token_headers)
        su_id = self._get_superuser_id(client, superuser_token_headers)
        # normaluser tries to share a superuser-owned plane
        r = client.post(
            f"{BASE}/{plane['id']}/share",
            json={"user_id": su_id},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403

    def test_owner_can_unshare(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        plane = create_plane(client, superuser_token_headers)
        target_id = self._get_normaluser_id(client, normal_user_token_headers)
        client.post(
            f"{BASE}/{plane['id']}/share",
            json={"user_id": target_id},
            headers=superuser_token_headers,
        )
        r = client.delete(
            f"{BASE}/{plane['id']}/share/{target_id}",
            headers=superuser_token_headers,
        )
        assert r.status_code == 200
        assert target_id not in [u["id"] for u in r.json()["shared_with"]]

    def test_unshare_not_found(
        self, client: TestClient, superuser_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, superuser_token_headers)
        r = client.delete(
            f"{BASE}/{plane['id']}/share/{uuid.uuid4()}",
            headers=superuser_token_headers,
        )
        assert r.status_code == 404

    def test_non_owner_cannot_unshare(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        plane = create_plane(client, superuser_token_headers)
        su_id = self._get_superuser_id(client, superuser_token_headers)
        r = client.delete(
            f"{BASE}/{plane['id']}/share/{su_id}",
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403


class TestSearchUsers:
    def test_search_users_short_query_returns_empty(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.get(
            f"{BASE}/search-users/",
            params={"q": "a"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        assert r.json() == []

    def test_search_users_finds_by_email(
        self, client: TestClient, db: Session, normal_user_token_headers: dict[str, str]
    ) -> None:
        from app import crud
        from app.models import UserCreate
        from tests.utils.utils import random_email

        email = random_email()
        crud.create_user(
            session=db,
            user_create=UserCreate(email=email, password=random_lower_string()),
        )
        r = client.get(
            f"{BASE}/search-users/",
            params={"q": email[:10]},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        emails = [u["email"] for u in r.json()]
        assert email in emails

    def test_search_users_requires_auth(self, client: TestClient) -> None:
        r = client.get(f"{BASE}/search-users/", params={"q": "test"})
        assert r.status_code == 401

    def test_search_users_excludes_self(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
    ) -> None:
        from app.core.config import settings as cfg

        r = client.get(
            f"{BASE}/search-users/",
            params={"q": cfg.FIRST_SUPERUSER[:10]},
            headers=superuser_token_headers,
        )
        assert r.status_code == 200
        found_emails = [u["email"] for u in r.json()]
        assert cfg.FIRST_SUPERUSER not in found_emails


class TestStickyNotes:
    def test_create_sticky_note(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, normal_user_token_headers)
        r = client.post(
            f"{BASE}/{plane['id']}/sticky-notes",
            json={"i": 2, "j": 3, "di": 2, "dj": 1, "content": "Hello"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["i"] == 2
        assert data["j"] == 3
        assert data["di"] == 2
        assert data["content"] == "Hello"
        # Appears on the plane
        plane_data = client.get(
            f"{BASE}/{plane['id']}", headers=normal_user_token_headers
        ).json()
        assert len(plane_data["sticky_notes"]) == 1

    def test_create_requires_auth(self, client: TestClient) -> None:
        r = client.post(f"{BASE}/{uuid.uuid4()}/sticky-notes", json={"i": 0, "j": 0})
        assert r.status_code == 401

    def test_create_plane_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(
            f"{BASE}/{uuid.uuid4()}/sticky-notes",
            json={"i": 0, "j": 0},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 404

    def test_create_non_owner_forbidden(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        plane = create_plane(client, superuser_token_headers)
        r = client.post(
            f"{BASE}/{plane['id']}/sticky-notes",
            json={"i": 0, "j": 0},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403

    def test_update_sticky_note(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, normal_user_token_headers)
        nid = client.post(
            f"{BASE}/{plane['id']}/sticky-notes",
            json={"i": 0, "j": 0, "content": "orig"},
            headers=normal_user_token_headers,
        ).json()["id"]
        r = client.put(
            f"{BASE}/{plane['id']}/sticky-notes/{nid}",
            json={"i": 1, "j": 1, "content": "updated"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        assert r.json()["content"] == "updated"
        assert r.json()["i"] == 1

    def test_update_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, normal_user_token_headers)
        r = client.put(
            f"{BASE}/{plane['id']}/sticky-notes/{uuid.uuid4()}",
            json={"i": 0, "j": 0},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 404

    def test_delete_sticky_note(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, normal_user_token_headers)
        nid = client.post(
            f"{BASE}/{plane['id']}/sticky-notes",
            json={"i": 0, "j": 0},
            headers=normal_user_token_headers,
        ).json()["id"]
        r = client.delete(
            f"{BASE}/{plane['id']}/sticky-notes/{nid}",
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        assert r.json()["ok"] is True

    def test_delete_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, normal_user_token_headers)
        r = client.delete(
            f"{BASE}/{plane['id']}/sticky-notes/{uuid.uuid4()}",
            headers=normal_user_token_headers,
        )
        assert r.status_code == 404


class TestTextFields:
    def test_create_and_delete(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, normal_user_token_headers)
        r = client.post(
            f"{BASE}/{plane['id']}/text-fields",
            json={"i": 1, "j": 1, "content": "label"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        fid = r.json()["id"]
        assert r.json()["content"] == "label"
        upd = client.put(
            f"{BASE}/{plane['id']}/text-fields/{fid}",
            json={"i": 1, "j": 1, "content": "label2"},
            headers=normal_user_token_headers,
        )
        assert upd.json()["content"] == "label2"
        d = client.delete(
            f"{BASE}/{plane['id']}/text-fields/{fid}",
            headers=normal_user_token_headers,
        )
        assert d.status_code == 200

    def test_update_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, normal_user_token_headers)
        r = client.put(
            f"{BASE}/{plane['id']}/text-fields/{uuid.uuid4()}",
            json={"i": 0, "j": 0},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 404


class TestCollections:
    def test_create_collection_is_1x1(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, normal_user_token_headers)
        r = client.post(
            f"{BASE}/{plane['id']}/collections",
            json={"i": 4, "j": 5, "name": "Batch A"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["name"] == "Batch A"
        assert data["i"] == 4
        assert data["j"] == 5
        # No di/dj fields — collection is always 1x1
        assert "di" not in data
        assert "dj" not in data

    def test_collection_membership_via_process(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, normal_user_token_headers)
        coll = client.post(
            f"{BASE}/{plane['id']}/collections",
            json={"i": 0, "j": 0, "name": "C"},
            headers=normal_user_token_headers,
        ).json()
        proc = client.post(
            f"{settings.API_V1_STR}/processes/",
            json={"name": "P", "collection_id": coll["id"]},
            headers=normal_user_token_headers,
        )
        assert proc.status_code == 200
        assert proc.json()["collection_id"] == coll["id"]
        # Clearing membership
        upd = client.put(
            f"{settings.API_V1_STR}/processes/{proc.json()['id']}",
            json={"name": "P", "collection_id": None},
            headers=normal_user_token_headers,
        )
        assert upd.json()["collection_id"] is None

    def test_update_and_delete(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, normal_user_token_headers)
        cid = client.post(
            f"{BASE}/{plane['id']}/collections",
            json={"i": 0, "j": 0, "name": "C"},
            headers=normal_user_token_headers,
        ).json()["id"]
        upd = client.put(
            f"{BASE}/{plane['id']}/collections/{cid}",
            json={"i": 0, "j": 0, "name": "C2"},
            headers=normal_user_token_headers,
        )
        assert upd.json()["name"] == "C2"
        d = client.delete(
            f"{BASE}/{plane['id']}/collections/{cid}",
            headers=normal_user_token_headers,
        )
        assert d.status_code == 200

    def test_delete_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, normal_user_token_headers)
        r = client.delete(
            f"{BASE}/{plane['id']}/collections/{uuid.uuid4()}",
            headers=normal_user_token_headers,
        )
        assert r.status_code == 404
