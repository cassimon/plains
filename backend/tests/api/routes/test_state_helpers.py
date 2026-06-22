"""Unit tests for state.py private helpers."""
import uuid
from datetime import datetime, timezone

import pytest

from app.api.routes.state import _safe_datetime, _safe_float, _uuid_or_gen


def test_uuid_or_gen_valid():
    raw = str(uuid.uuid4())
    result = _uuid_or_gen(raw)
    assert result == uuid.UUID(raw)


def test_uuid_or_gen_invalid():
    result = _uuid_or_gen("not-a-uuid")
    assert isinstance(result, uuid.UUID)


def test_uuid_or_gen_none():
    result = _uuid_or_gen(None)
    assert isinstance(result, uuid.UUID)


def test_uuid_or_gen_empty():
    result = _uuid_or_gen("")
    assert isinstance(result, uuid.UUID)


def test_safe_float_valid():
    assert _safe_float("3.14") == pytest.approx(3.14)


def test_safe_float_int():
    assert _safe_float(42) == 42.0


def test_safe_float_invalid():
    assert _safe_float("oops") == 0.0


def test_safe_float_none():
    assert _safe_float(None) == 0.0


def test_safe_float_custom_default():
    assert _safe_float("bad", default=-1.0) == -1.0


def test_safe_datetime_none():
    assert _safe_datetime(None) is None


def test_safe_datetime_empty_string():
    assert _safe_datetime("") is None


def test_safe_datetime_whitespace():
    assert _safe_datetime("   ") is None


def test_safe_datetime_iso_string():
    result = _safe_datetime("2024-01-15T12:00:00")
    assert isinstance(result, datetime)
    assert result.year == 2024


def test_safe_datetime_z_suffix():
    result = _safe_datetime("2024-01-15T12:00:00Z")
    assert isinstance(result, datetime)
    assert result.tzinfo is not None


def test_safe_datetime_datetime_passthrough():
    dt = datetime(2024, 6, 1, tzinfo=timezone.utc)
    assert _safe_datetime(dt) is dt


def test_safe_datetime_invalid_string():
    assert _safe_datetime("not-a-date") is None


def test_safe_datetime_non_string_non_datetime():
    # e.g. integer — falls through to final return None
    assert _safe_datetime(12345) is None
