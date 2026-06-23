from unittest.mock import patch

from fastapi.testclient import TestClient

from app.core.config import settings


def test_health_check(client: TestClient) -> None:
    r = client.get(f"{settings.API_V1_STR}/utils/health-check/")
    assert r.status_code == 200
    assert r.json() is True


class TestTestEmail:
    BASE = f"{settings.API_V1_STR}/utils/test-email/"

    def test_requires_auth(self, client: TestClient) -> None:
        r = client.post(self.BASE, params={"email_to": "a@b.com"})
        assert r.status_code == 401

    def test_requires_superuser(
        self, client: TestClient, normal_user_token_headers: dict[str, str]
    ) -> None:
        r = client.post(
            self.BASE,
            params={"email_to": "a@b.com"},
            headers=normal_user_token_headers,
        )
        assert r.status_code == 403

    def test_sends_email_as_superuser(
        self, client: TestClient, superuser_token_headers: dict[str, str]
    ) -> None:
        with patch("app.api.routes.utils.send_email") as mock_send:
            r = client.post(
                self.BASE,
                params={"email_to": "recipient@example.com"},
                headers=superuser_token_headers,
            )
        assert r.status_code == 201
        assert r.json()["message"] == "Test email sent"
        mock_send.assert_called_once()
        _, kwargs = mock_send.call_args
        assert "recipient@example.com" in (kwargs.get("email_to") or mock_send.call_args[0][0])

    def test_invalid_email_address(
        self, client: TestClient, superuser_token_headers: dict[str, str]
    ) -> None:
        r = client.post(
            self.BASE,
            params={"email_to": "not-an-email"},
            headers=superuser_token_headers,
        )
        assert r.status_code == 422
