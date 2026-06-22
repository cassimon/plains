import uuid

from fastapi.testclient import TestClient

from app.core.config import settings
from tests.utils.utils import random_lower_string

BASE = f"{settings.API_V1_STR}/analyses"


def create_analysis(client: TestClient, headers: dict, **kwargs) -> dict:
    payload = {"name": random_lower_string(), **kwargs}
    r = client.post(f"{BASE}/", json=payload, headers=headers)
    assert r.status_code == 200
    return r.json()


class TestAnalysesAuth:
    def test_list_requires_auth(self, client: TestClient) -> None:
        assert client.get(f"{BASE}/").status_code == 401

    def test_create_requires_auth(self, client: TestClient) -> None:
        assert client.post(f"{BASE}/", json={"name": "x"}).status_code == 401

    def test_get_requires_auth(self, client: TestClient) -> None:
        assert client.get(f"{BASE}/{uuid.uuid4()}").status_code == 401


class TestAnalysesCRUD:
    def test_create_analysis_with_refs(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        ref_entity = uuid.uuid4()
        name = random_lower_string()
        r = client.post(
            f"{BASE}/",
            json={
                "name": name,
                "is_meta": True,
                "refs": [{"kind": "experiment", "entity_id": str(ref_entity)}],
            },
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        data = r.json()
        assert data["name"] == name
        assert data["is_meta"] is True
        assert len(data["refs"]) == 1
        assert data["refs"][0]["kind"] == "experiment"
        assert data["refs"][0]["entity_id"] == str(ref_entity)

    def test_create_missing_name(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(f"{BASE}/", json={}, headers=normal_user_token_headers)
        assert r.status_code == 422

    def test_get_analysis(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        a = create_analysis(client, normal_user_token_headers)
        r = client.get(f"{BASE}/{a['id']}", headers=normal_user_token_headers)
        assert r.status_code == 200
        assert r.json()["id"] == a["id"]

    def test_get_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.get(f"{BASE}/{uuid.uuid4()}", headers=normal_user_token_headers)
        assert r.status_code == 404

    def test_update_analysis(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        a = create_analysis(client, normal_user_token_headers)
        new_name = random_lower_string()
        r = client.put(
            f"{BASE}/{a['id']}",
            json={"name": new_name},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 200
        assert r.json()["name"] == new_name

    def test_weak_ref_survives_entity_deletion(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        # Create a real process, ref it, delete the process; analysis ref persists.
        proc = client.post(
            f"{settings.API_V1_STR}/processes/",
            json={"name": "P"},
            headers=normal_user_token_headers,
        ).json()
        a = create_analysis(
            client,
            normal_user_token_headers,
            refs=[{"kind": "process", "entity_id": proc["id"]}],
        )
        client.delete(
            f"{settings.API_V1_STR}/processes/{proc['id']}",
            headers=normal_user_token_headers,
        )
        r = client.get(f"{BASE}/{a['id']}", headers=normal_user_token_headers)
        assert r.status_code == 200
        assert len(r.json()["refs"]) == 1
        assert r.json()["refs"][0]["entity_id"] == proc["id"]

    def test_delete_analysis_cascades_refs(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        a = create_analysis(
            client,
            normal_user_token_headers,
            refs=[{"kind": "result", "entity_id": str(uuid.uuid4())}],
        )
        r = client.delete(f"{BASE}/{a['id']}", headers=normal_user_token_headers)
        assert r.status_code == 200
        g = client.get(f"{BASE}/{a['id']}", headers=normal_user_token_headers)
        assert g.status_code == 404

    def test_delete_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.delete(f"{BASE}/{uuid.uuid4()}", headers=normal_user_token_headers)
        assert r.status_code == 404


class TestAnalysesIDOR:
    def test_get_other_user_forbidden(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        a = create_analysis(client, superuser_token_headers)
        r = client.get(f"{BASE}/{a['id']}", headers=normal_user_token_headers)
        assert r.status_code == 403

    def test_delete_other_user_forbidden(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        a = create_analysis(client, superuser_token_headers)
        r = client.delete(f"{BASE}/{a['id']}", headers=normal_user_token_headers)
        assert r.status_code == 403


class TestAnalysesExtra:
    def test_list_as_normal_and_superuser(
        self,
        client: TestClient,
        normal_user_token_headers: dict[str, str],
        superuser_token_headers: dict[str, str],
    ) -> None:
        create_analysis(client, normal_user_token_headers)
        r = client.get(f"{BASE}/", headers=normal_user_token_headers)
        assert r.status_code == 200
        assert r.json()["count"] >= 1
        r2 = client.get(f"{BASE}/", headers=superuser_token_headers)
        assert r2.status_code == 200
        assert r2.json()["count"] >= 1

    def test_update_not_found(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.put(
            f"{BASE}/{uuid.uuid4()}",
            json={"name": "x"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 404

    def test_update_other_user_forbidden(
        self,
        client: TestClient,
        superuser_token_headers: dict[str, str],
        normal_user_token_headers: dict[str, str],
    ) -> None:
        a = create_analysis(client, superuser_token_headers)
        r = client.put(
            f"{BASE}/{a['id']}",
            json={"name": "x"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403
