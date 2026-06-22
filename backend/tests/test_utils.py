"""Tests for app.utils helper functions."""
from datetime import timedelta
from unittest.mock import patch

import pytest

from app.core.config import settings
from app.utils import generate_password_reset_token, verify_password_reset_token


def test_generate_and_verify_password_reset_token():
    email = "user@example.com"
    token = generate_password_reset_token(email)
    assert isinstance(token, str)
    result = verify_password_reset_token(token)
    assert result == email


def test_verify_password_reset_token_invalid():
    result = verify_password_reset_token("not.a.valid.token")
    assert result is None


def test_verify_password_reset_token_expired():
    with patch("app.utils.timedelta") as mock_td:
        mock_td.return_value = timedelta(hours=-1)
        token = generate_password_reset_token("expired@example.com")
    result = verify_password_reset_token(token)
    assert result is None
