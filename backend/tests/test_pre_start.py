"""Tests for tests_pre_start and backend_pre_start modules."""
from unittest.mock import MagicMock, patch


def test_tests_pre_start_main_runs():
    from app.tests_pre_start import main
    with patch("app.tests_pre_start.engine"):
        main()


def test_backend_pre_start_main_runs():
    from app.backend_pre_start import main
    with patch("app.backend_pre_start.engine"):
        main()
