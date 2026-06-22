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
        assert client.put(f"{BASE}/{uuid.uuid4()}", json={"name": "x"}).status_code == 401

    def test_delete_requires_auth(self, client: TestClient) -> None:
        assert client.delete(f"{BASE}/{uuid.uuid4()}").status_code == 401


class TestPlanesCRUD:
    def test_create_plane(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        name = random_lower_string()
        r = client.post(f"{BASE}/", json={"name": name}, headers=normal_user_token_headers)
        assert r.status_code == 200
        data = r.json()
        assert data["name"] == name
        assert "id" in data
        assert data["elements"] == []
        assert data["shared_with"] == []

    def test_create_plane_with_elements(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        payload = {
            "name": random_lower_string(),
            "elements": [
                {"element_type": "text", "x": 10, "y": 20, "width": 100, "height": 50, "content": "Hello"}
            ],
        }
        r = client.post(f"{BASE}/", json=payload, headers=normal_user_token_headers)
        assert r.status_code == 200
        data = r.json()
        assert len(data["elements"]) == 1
        assert data["elements"][0]["content"] == "Hello"

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
            f"{BASE}/{uuid.uuid4()}", json={"name": "x"}, headers=normal_user_token_headers
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
            client.get(f"{BASE}/{plane['id']}", headers=normal_user_token_headers).status_code
            == 404
        )

    def test_delete_plane_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.delete(f"{BASE}/{uuid.uuid4()}", headers=normal_user_token_headers)
        assert r.status_code == 404


class TestPlanesIDOR:
    def test_get_unshared_plane_forbidden(
        self, client: TestClient, superuser_token_headers: dict[str, str], normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, superuser_token_headers)
        r = client.get(f"{BASE}/{plane['id']}", headers=normal_user_token_headers)
        assert r.status_code == 403

    def test_update_other_user_plane_forbidden(
        self, client: TestClient, superuser_token_headers: dict[str, str], normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, superuser_token_headers)
        r = client.put(f"{BASE}/{plane['id']}", json={"name": "hacked"}, headers=normal_user_token_headers)
        assert r.status_code == 403

    def test_delete_other_user_plane_forbidden(
        self, client: TestClient, superuser_token_headers: dict[str, str], normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, superuser_token_headers)
        r = client.delete(f"{BASE}/{plane['id']}", headers=normal_user_token_headers)
        assert r.status_code == 403


class TestPlanesSharing:
    def _get_superuser_id(self, client: TestClient, superuser_token_headers: dict) -> str:
        """Get the superuser's id by reading one of their planes."""
        plane = create_plane(client, superuser_token_headers)
        return client.get(f"{BASE}/{plane['id']}", headers=superuser_token_headers).json()["owner_id"]

    def _get_normaluser_id(self, client: TestClient, normal_user_token_headers: dict) -> str:
        plane = create_plane(client, normal_user_token_headers)
        return client.get(f"{BASE}/{plane['id']}", headers=normal_user_token_headers).json()["owner_id"]

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
        owner_id = client.get(f"{BASE}/{plane['id']}", headers=superuser_token_headers).json()["owner_id"]
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
        r = client.get(f"{BASE}/search-users/", params={"q": "a"}, headers=normal_user_token_headers)
        assert r.status_code == 200
        assert r.json() == []

    def test_search_users_finds_by_email(
        self, client: TestClient, db: Session, normal_user_token_headers: dict[str, str]
    ) -> None:
        from app import crud
        from app.models import UserCreate
        from tests.utils.utils import random_email
        email = random_email()
        crud.create_user(session=db, user_create=UserCreate(email=email, password=random_lower_string()))
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


class TestCanvasElements:
    def test_add_element_to_plane(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, normal_user_token_headers)
        r = client.post(
            f"{BASE}/{plane['id']}/elements",
            json={"element_type": "text", "content": "Hello", "x": 0, "y": 0, "width": 100, "height": 50},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["element_type"] == "text"
        assert data["content"] == "Hello"

    def test_add_element_plane_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(
            f"{BASE}/{uuid.uuid4()}/elements",
            json={"element_type": "text", "x": 0, "y": 0, "width": 100, "height": 50},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 404

    def test_add_element_non_owner_forbidden(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        plane = create_plane(client, superuser_token_headers)
        r = client.post(
            f"{BASE}/{plane['id']}/elements",
            json={"element_type": "text", "x": 0, "y": 0, "width": 100, "height": 50},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403

    def test_update_element(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, normal_user_token_headers)
        el_r = client.post(
            f"{BASE}/{plane['id']}/elements",
            json={"element_type": "text", "content": "orig", "x": 0, "y": 0, "width": 100, "height": 50},
            headers=normal_user_token_headers,
        )
        el_id = el_r.json()["id"]
        r = client.put(
            f"{BASE}/{plane['id']}/elements/{el_id}",
            json={"element_type": "text", "content": "updated", "x": 5, "y": 5, "width": 200, "height": 80},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        assert r.json()["content"] == "updated"

    def test_update_element_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, normal_user_token_headers)
        r = client.put(
            f"{BASE}/{plane['id']}/elements/{uuid.uuid4()}",
            json={"element_type": "text", "x": 0, "y": 0, "width": 100, "height": 50},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 404

    def test_delete_element(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, normal_user_token_headers)
        el_r = client.post(
            f"{BASE}/{plane['id']}/elements",
            json={"element_type": "text", "x": 0, "y": 0, "width": 100, "height": 50},
            headers=normal_user_token_headers,
        )
        el_id = el_r.json()["id"]
        r = client.delete(
            f"{BASE}/{plane['id']}/elements/{el_id}",
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        assert r.json()["ok"] is True

    def test_delete_element_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        plane = create_plane(client, normal_user_token_headers)
        r = client.delete(
            f"{BASE}/{plane['id']}/elements/{uuid.uuid4()}",
            headers=normal_user_token_headers,
        )
        assert r.status_code == 404

    def test_shared_user_can_delete_element(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        """Shared users can delete elements (delete_element uses _has_plane_access)."""
        plane = create_plane(client, superuser_token_headers)
        nu_plane = create_plane(client, normal_user_token_headers)
        nu_id = client.get(f"{BASE}/{nu_plane['id']}", headers=normal_user_token_headers).json()["owner_id"]

        # Share superuser's plane with normaluser
        client.post(
            f"{BASE}/{plane['id']}/share",
            json={"user_id": nu_id},
            headers=superuser_token_headers,
        )
        el_r = client.post(
            f"{BASE}/{plane['id']}/elements",
            json={"element_type": "text", "x": 0, "y": 0, "width": 100, "height": 50},
            headers=superuser_token_headers,
        )
        el_id = el_r.json()["id"]
        r = client.delete(
            f"{BASE}/{plane['id']}/elements/{el_id}",
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
