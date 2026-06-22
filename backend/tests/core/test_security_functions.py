"""Unit tests for app.core.security and app.api.deps."""

import pytest
from datetime import timedelta
from unittest.mock import MagicMock, patch

import jwt

from app.core.config import settings


def test_create_access_token_returns_decodable_jwt():
    from app.core.security import create_access_token, ALGORITHM

    token = create_access_token("user@example.com", timedelta(minutes=5))
    assert isinstance(token, str)
    claims = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
    assert claims["sub"] == "user@example.com"
    assert "exp" in claims


def test_create_access_token_custom_subject():
    from app.core.security import create_access_token, ALGORITHM

    token = create_access_token(42, timedelta(hours=1))
    claims = jwt.decode(token, settings.SECRET_KEY, algorithms=[ALGORITHM])
    assert claims["sub"] == "42"


def test_verify_password_correct():
    from app.core.security import verify_password, get_password_hash

    pw = "super_secret_pw"
    hashed = get_password_hash(pw)
    ok, _ = verify_password(pw, hashed)
    assert ok is True


def test_verify_password_wrong():
    from app.core.security import verify_password, get_password_hash

    hashed = get_password_hash("correct_pw")
    ok, _ = verify_password("wrong_pw", hashed)
    assert ok is False


def test_get_password_hash_returns_string():
    from app.core.security import get_password_hash

    h = get_password_hash("mypassword")
    assert isinstance(h, str)
    assert len(h) > 20


def test_verify_nomad_token_raises_400_when_oauth_disabled():
    from fastapi import HTTPException
    from app.core.security import verify_nomad_token

    with patch.object(settings, "NOMAD_OAUTH_ENABLED", False):
        with pytest.raises(HTTPException) as exc_info:
            verify_nomad_token("any.token.here")
    assert exc_info.value.status_code == 400
    assert "not enabled" in exc_info.value.detail.lower()


def test_verify_nomad_token_raises_401_on_invalid_token():
    from fastapi import HTTPException
    from app.core.security import verify_nomad_token

    with (
        patch.object(settings, "NOMAD_OAUTH_ENABLED", True),
        patch("app.core.security._get_jwks_client") as mock_jwks,
    ):
        mock_jwks.return_value.get_signing_key_from_jwt.side_effect = (
            jwt.InvalidTokenError("bad")
        )
        with pytest.raises(HTTPException) as exc_info:
            verify_nomad_token("invalid.jwt.token")
    assert exc_info.value.status_code == 401


def test_verify_nomad_token_raises_401_on_generic_error():
    from fastapi import HTTPException
    from app.core.security import verify_nomad_token

    with (
        patch.object(settings, "NOMAD_OAUTH_ENABLED", True),
        patch("app.core.security._get_jwks_client") as mock_jwks,
    ):
        mock_jwks.return_value.get_signing_key_from_jwt.side_effect = RuntimeError(
            "network error"
        )
        with pytest.raises(HTTPException) as exc_info:
            verify_nomad_token("token.for.error")
    assert exc_info.value.status_code == 401


def test_verify_nomad_token_success_no_audience():
    from app.core.security import verify_nomad_token

    fake_claims = {"sub": "user123", "email": "u@test.com"}
    mock_signing_key = MagicMock()
    mock_signing_key.key = "dummy_key"

    with (
        patch.object(settings, "NOMAD_OAUTH_ENABLED", True),
        patch.object(settings, "NOMAD_OAUTH_VERIFY_AUDIENCE", False),
        patch("app.core.security._get_jwks_client") as mock_jwks,
        patch("app.core.security.jwt.decode") as mock_decode,
    ):
        mock_jwks.return_value.get_signing_key_from_jwt.return_value = mock_signing_key
        mock_decode.return_value = fake_claims
        result = verify_nomad_token("valid.jwt.token")

    assert result == fake_claims
    assert mock_decode.call_args[1]["options"] == {"verify_aud": False}


def test_verify_nomad_token_success_with_audience():
    from app.core.security import verify_nomad_token

    fake_claims = {"sub": "user456"}
    mock_signing_key = MagicMock()
    mock_signing_key.key = "dummy_key"

    with (
        patch.object(settings, "NOMAD_OAUTH_ENABLED", True),
        patch.object(settings, "NOMAD_OAUTH_VERIFY_AUDIENCE", True),
        patch.object(settings, "NOMAD_OAUTH_AUDIENCE", "my-audience"),
        patch("app.core.security._get_jwks_client") as mock_jwks,
        patch("app.core.security.jwt.decode") as mock_decode,
    ):
        mock_jwks.return_value.get_signing_key_from_jwt.return_value = mock_signing_key
        mock_decode.return_value = fake_claims
        result = verify_nomad_token("valid.jwt.token")

    assert result == fake_claims
    assert mock_decode.call_args[1]["audience"] == "my-audience"


def test_get_jwks_client_is_cached():
    from app.core.security import _get_jwks_client
    import app.core.security as sec_module

    original = sec_module._jwks_client
    try:
        sec_module._jwks_client = None
        with patch("app.core.security.PyJWKClient") as mock_cls:
            mock_instance = MagicMock()
            mock_cls.return_value = mock_instance

            client1 = _get_jwks_client()
            client2 = _get_jwks_client()

        assert client1 is client2
        mock_cls.assert_called_once()
    finally:
        sec_module._jwks_client = original
