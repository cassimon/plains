"""Tests for app.initial_data module."""

from unittest.mock import MagicMock, patch


def test_initial_data_main_runs():
    with (
        patch("app.initial_data.Session") as mock_session_cls,
        patch("app.initial_data.init_db") as mock_init_db,
    ):
        mock_session = MagicMock()
        mock_session_cls.return_value.__enter__ = MagicMock(return_value=mock_session)
        mock_session_cls.return_value.__exit__ = MagicMock(return_value=False)

        from app.initial_data import main

        main()

        mock_init_db.assert_called_once()
