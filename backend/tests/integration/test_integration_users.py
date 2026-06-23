"""Integration tests for user management endpoints."""

import pytest
import httpx


def test_superuser_can_list_users(superuser_client: httpx.Client) -> None:
    r = superuser_client.get("/api/v1/users/")
    assert r.status_code == 200
    data = r.json()
    assert "data" in data
    assert isinstance(data["data"], list)
    assert len(data["data"]) >= 1


def test_normal_user_cannot_list_users(test_user_client: httpx.Client) -> None:
    r = test_user_client.get("/api/v1/users/")
    assert r.status_code == 403


def test_user_cannot_read_other_user(
    superuser_client: httpx.Client,
    test_user_client: httpx.Client,
    test_user_id: str,
) -> None:
    # superuser creates a second user
    r = superuser_client.post(
        "/api/v1/users/",
        json={
            "email": f"other-{__import__('uuid').uuid4()}@test.plains",
            "password": "OtherPass1!",
            "full_name": "Other User",
            "is_active": True,
            "is_superuser": False,
        },
    )
    assert r.status_code == 200
    other_id = r.json()["id"]

    try:
        r2 = test_user_client.get(f"/api/v1/users/{other_id}")
        assert r2.status_code in (403, 404)
    finally:
        superuser_client.delete(f"/api/v1/users/{other_id}")


def test_delete_user_cascades_resources(
    superuser_client: httpx.Client,
) -> None:
    import uuid as uuid_module

    # Create a throwaway user
    email = f"cascade-{uuid_module.uuid4()}@test.plains"
    r = superuser_client.post(
        "/api/v1/users/",
        json={
            "email": email,
            "password": "CascadePass1!",
            "full_name": "Cascade User",
            "is_active": True,
            "is_superuser": False,
        },
    )
    assert r.status_code == 200
    user_id = r.json()["id"]

    # Log in as that user and create a material
    token_r = superuser_client.post(
        "/api/v1/login/access-token",
        data={"username": email, "password": "CascadePass1!"},
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    assert token_r.status_code == 200
    token = token_r.json()["access_token"]
    user_client = httpx.Client(
        base_url=superuser_client.base_url,
        headers={"Authorization": f"Bearer {token}"},
        timeout=30,
    )
    mat_r = user_client.post(
        "/api/v1/materials/",
        json={"name": "CascadeMat", "category": "chemical_compound"},
    )
    assert mat_r.status_code == 200
    mat_id = mat_r.json()["id"]

    # Delete the user
    del_r = superuser_client.delete(f"/api/v1/users/{user_id}")
    assert del_r.status_code == 200

    # Material should be gone (404)
    check_r = superuser_client.get(f"/api/v1/materials/{mat_id}")
    assert check_r.status_code == 404
