"""
NOMAD Service Tests

These tests verify the NOMAD integration works correctly.
Tests can be run independently and are clearly labeled.

Test Categories:
    a) test_api_addresses_* - Offline mock tests verifying API addresses and commands
    b) test_auth_token_* - Tests for retrieving auth tokens from TEST API
    c) test_archive_upload_* - Tests for archive upload with clear URL logging
    d) test_full_cycle_* - Full upload cycle tests

Run specific test categories:
    pytest tests/services/test_nomad.py -k "api_addresses" -v  # (a) Offline mocks
    pytest tests/services/test_nomad.py -k "auth_token" -v     # (b) Auth token tests
    pytest tests/services/test_nomad.py -k "archive_upload" -v # (c) Archive upload tests
    pytest tests/services/test_nomad.py -k "full_cycle" -v     # (d) Full cycle tests

Run all tests:
    pytest tests/services/test_nomad.py -v

IMPORTANT: Tests verify the TEST deployment URL is used:
    https://nomad-lab.eu/prod/v1/test/api/v1
"""

import json
import os
import tempfile
import zipfile
from pathlib import Path
from unittest.mock import MagicMock, patch, Mock
from datetime import datetime, timezone

import pytest

# ═══════════════════════════════════════════════════════════════════════════════
# Test Constants
# ═══════════════════════════════════════════════════════════════════════════════

# These are the EXPECTED URLs for the TEST deployment
EXPECTED_TEST_BASE_URL = "https://nomad-lab.eu/prod/v1/test/api/v1"
EXPECTED_TEST_AUTH_URL = "https://nomad-lab.eu/prod/v1/test/api/v1/auth/token"
EXPECTED_TEST_UPLOAD_URL = "https://nomad-lab.eu/prod/v1/test/api/v1/uploads"

# Production URLs (for comparison - should NOT be used by default)


# Test credentials (only used for mock tests)
TEST_USERNAME = "test_user@example.com"
TEST_PASSWORD = "test_password_123"


# ═══════════════════════════════════════════════════════════════════════════════
# TEST GROUP A: API Addresses and Commands (Offline/Mock Tests)
# ═══════════════════════════════════════════════════════════════════════════════

class TestApiAddresses:
    """
    Test Group A: Verify API addresses and commands are correctly constructed.
    
    These tests run OFFLINE with mocked HTTP responses.
    They verify the correct URLs are constructed and used.
    """

    def test_api_addresses_verify_test_url_in_config(self):
        """
        A.1: Verify the configured NOMAD URL is the TEST deployment.
        
        This test ensures we're using the TEST deployment, not production.
        """
        from app.core.config import settings
        
        print("\n" + "=" * 70)
        print("TEST A.1: Verify NOMAD URL Configuration")
        print("=" * 70)
        print(f"Configured NOMAD_URL: {settings.NOMAD_URL}")
        print(f"Expected TEST URL:    {EXPECTED_TEST_BASE_URL}")
        print("-" * 70)
        
        # Check that /test/ is in the URL
        assert "/test/" in settings.NOMAD_URL, (
            f"CRITICAL: NOMAD_URL does not contain '/test/'!\n"
            f"Configured: {settings.NOMAD_URL}\n"
            f"This would upload to PRODUCTION! Use: {EXPECTED_TEST_BASE_URL}"
        )
        
        # Verify it matches expected test URL
        assert settings.NOMAD_URL == EXPECTED_TEST_BASE_URL, (
            f"NOMAD_URL mismatch.\n"
            f"Configured: {settings.NOMAD_URL}\n"
            f"Expected:   {EXPECTED_TEST_BASE_URL}"
        )
        
        print("✓ NOMAD_URL correctly points to TEST deployment")
        print("=" * 70)

    def test_api_addresses_auth_url_construction(self):
        """
        A.2: Verify authentication URL is correctly constructed from base URL.
        
        The auth URL should be: {base_url}/auth/token
        """
        from app.core.config import settings
        
        print("\n" + "=" * 70)
        print("TEST A.2: Verify Auth URL Construction")
        print("=" * 70)
        
        # Simulate the URL construction as done in nomad.py
        base_url = settings.NOMAD_URL
        constructed_auth_url = base_url.replace("/api/v1", "/api/v1/auth/token")
        
        print(f"Base URL:            {base_url}")
        print(f"Constructed Auth URL: {constructed_auth_url}")
        print(f"Expected Auth URL:   {EXPECTED_TEST_AUTH_URL}")
        print("-" * 70)
        
        assert constructed_auth_url == EXPECTED_TEST_AUTH_URL, (
            f"Auth URL mismatch.\n"
            f"Constructed: {constructed_auth_url}\n"
            f"Expected:    {EXPECTED_TEST_AUTH_URL}"
        )
        
        print("✓ Auth URL correctly constructed for TEST deployment")
        print("=" * 70)

    def test_api_addresses_upload_url_construction(self):
        """
        A.3: Verify upload URL is correctly constructed.
        
        The upload URL should be: {base_url}/uploads
        """
        from app.core.config import settings
        
        print("\n" + "=" * 70)
        print("TEST A.3: Verify Upload URL Construction")
        print("=" * 70)
        
        base_url = settings.NOMAD_URL
        constructed_upload_url = f"{base_url}/uploads"
        
        print(f"Base URL:              {base_url}")
        print(f"Constructed Upload URL: {constructed_upload_url}")
        print(f"Expected Upload URL:   {EXPECTED_TEST_UPLOAD_URL}")
        print("-" * 70)
        
        assert constructed_upload_url == EXPECTED_TEST_UPLOAD_URL, (
            f"Upload URL mismatch.\n"
            f"Constructed: {constructed_upload_url}\n"
            f"Expected:    {EXPECTED_TEST_UPLOAD_URL}"
        )
        
        print("✓ Upload URL correctly constructed for TEST deployment")
        print("=" * 70)

    @patch("httpx.Client")
    def test_api_addresses_mock_auth_request(self, mock_client_class):
        """
        A.4: Mock test verifying the correct auth request is made.
        
        This test mocks HTTP and verifies the request parameters.
        NO actual network calls are made.
        """
        from app.services.nomad import get_nomad_token
        
        print("\n" + "=" * 70)
        print("TEST A.4: Mock Auth Request Verification (OFFLINE)")
        print("=" * 70)
        
        # Configure mock
        mock_client = MagicMock()
        mock_client_class.return_value.__enter__ = MagicMock(return_value=mock_client)
        mock_client_class.return_value.__exit__ = MagicMock(return_value=False)
        
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"access_token": "mock_token_12345"}
        mock_client.post.return_value = mock_response
        
        # Capture what URL and data are sent
        captured_calls = []
        def capture_post(url, **kwargs):
            captured_calls.append({"url": url, "kwargs": kwargs})
            return mock_response
        mock_client.post.side_effect = capture_post
        
        # Override settings for test
        with patch("app.services.nomad.settings") as mock_settings:
            mock_settings.NOMAD_URL = EXPECTED_TEST_BASE_URL
            mock_settings.NOMAD_USERNAME = TEST_USERNAME
            mock_settings.NOMAD_PASSWORD = TEST_PASSWORD
            mock_settings.NOMAD_MOCK_MODE = False
            
            print("Mock Configuration:")
            print(f"  NOMAD_URL:      {mock_settings.NOMAD_URL}")
            print(f"  NOMAD_USERNAME: {mock_settings.NOMAD_USERNAME}")
            print("-" * 70)
            
            token = get_nomad_token()
        
        # Verify the captured request
        assert len(captured_calls) == 1, "Expected exactly one HTTP call"
        call = captured_calls[0]
        
        print("Captured HTTP Request:")
        print(f"  URL:    {call['url']}")
        print(f"  Method: POST")
        print(f"  Data:   {call['kwargs'].get('data', {})}")
        print(f"  Headers: {call['kwargs'].get('headers', {})}")
        print("-" * 70)
        
        # Verify URL is the TEST auth URL
        assert call["url"] == EXPECTED_TEST_AUTH_URL, (
            f"Auth request went to wrong URL!\n"
            f"Actual:   {call['url']}\n"
            f"Expected: {EXPECTED_TEST_AUTH_URL}"
        )
        
        # Verify OAuth2 password grant format
        request_data = call["kwargs"].get("data", {})
        assert request_data.get("grant_type") == "password"
        assert request_data.get("username") == TEST_USERNAME
        assert request_data.get("password") == TEST_PASSWORD
        
        print("✓ Auth request correctly formatted for TEST deployment")
        print(f"✓ Received mock token: {token}")
        print("=" * 70)

    @patch("httpx.Client")
    def test_api_addresses_mock_upload_request(self, mock_client_class):
        """
        A.5: Mock test verifying the correct upload request is made.
        
        This test mocks HTTP and verifies upload parameters.
        NO actual network calls are made.
        """
        from app.services.nomad import upload_to_nomad, create_secure_zip
        
        print("\n" + "=" * 70)
        print("TEST A.5: Mock Upload Request Verification (OFFLINE)")
        print("=" * 70)
        
        # Create a test zip file
        test_files = [("test_file.txt", b"Test content for NOMAD upload")]
        zip_path = create_secure_zip(test_files, archive_name="test_upload.zip")
        
        print(f"Created test archive: {zip_path}")
        print(f"Archive size: {zip_path.stat().st_size} bytes")
        
        # Configure mock
        mock_client = MagicMock()
        mock_client_class.return_value.__enter__ = MagicMock(return_value=mock_client)
        mock_client_class.return_value.__exit__ = MagicMock(return_value=False)
        
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {
            "upload_id": "test_upload_id_12345",
            "upload_create_time": "2026-04-10T12:00:00Z",
            "process_status": "processing",
            "entries": [{"entry_id": "test_entry_id_1"}]
        }
        mock_client.post.return_value = mock_response
        
        # Capture what URL and data are sent
        captured_calls = []
        def capture_post(url, **kwargs):
            captured_calls.append({"url": url, "kwargs": kwargs})
            return mock_response
        mock_client.post.side_effect = capture_post
        
        # Override settings for test
        with patch("app.services.nomad.settings") as mock_settings:
            mock_settings.NOMAD_URL = EXPECTED_TEST_BASE_URL
            mock_settings.NOMAD_MOCK_MODE = False
            
            print(f"Using NOMAD_URL: {mock_settings.NOMAD_URL}")
            print("-" * 70)
            
            result = upload_to_nomad(
                zip_path=zip_path,
                token="mock_auth_token",
                upload_name="Test Upload"
            )
        
        # Clean up
        zip_path.unlink()
        
        # Verify the captured request
        assert len(captured_calls) == 1, "Expected exactly one HTTP call"
        call = captured_calls[0]
        
        print("Captured HTTP Request:")
        print(f"  URL:    {call['url']}")
        print(f"  Method: POST")
        print(f"  Files:  {list(call['kwargs'].get('files', {}).keys())}")
        print(f"  Params: {call['kwargs'].get('params', {})}")
        print(f"  Auth Header Present: {'Authorization' in call['kwargs'].get('headers', {})}")
        print("-" * 70)
        
        # Verify URL is the TEST upload URL
        assert call["url"] == EXPECTED_TEST_UPLOAD_URL, (
            f"Upload request went to wrong URL!\n"
            f"Actual:   {call['url']}\n"
            f"Expected: {EXPECTED_TEST_UPLOAD_URL}"
        )
        
        # Verify auth header is present
        headers = call["kwargs"].get("headers", {})
        assert "Authorization" in headers
        assert headers["Authorization"] == "Bearer mock_auth_token"
        
        print("Mock Response:")
        print(f"  upload_id: {result.get('upload_id')}")
        print(f"  entry_ids: {result.get('entry_ids')}")
        print(f"  status:    {result.get('processing_status')}")
        print("-" * 70)
        
        print("✓ Upload request correctly formatted for TEST deployment")
        print("=" * 70)

    def test_api_addresses_status_url_construction(self):
        """
        A.6: Verify status check URL is correctly constructed.
        """
        from app.core.config import settings
        
        print("\n" + "=" * 70)
        print("TEST A.6: Verify Status Check URL Construction")
        print("=" * 70)
        
        test_upload_id = "test_upload_id_12345"
        base_url = settings.NOMAD_URL
        constructed_status_url = f"{base_url}/uploads/{test_upload_id}"
        expected_status_url = f"{EXPECTED_TEST_BASE_URL}/uploads/{test_upload_id}"
        
        print(f"Base URL:               {base_url}")
        print(f"Upload ID:              {test_upload_id}")
        print(f"Constructed Status URL: {constructed_status_url}")
        print(f"Expected Status URL:    {expected_status_url}")
        print("-" * 70)
        
        assert constructed_status_url == expected_status_url, (
            f"Status URL mismatch.\n"
            f"Constructed: {constructed_status_url}\n"
            f"Expected:    {expected_status_url}"
        )
        
        print("✓ Status URL correctly constructed for TEST deployment")
        print("=" * 70)


# ═══════════════════════════════════════════════════════════════════════════════
# TEST GROUP B: Auth Token Retrieval from TEST API
# ═══════════════════════════════════════════════════════════════════════════════

class TestAuthToken:
    """
    Test Group B: Auth token retrieval tests.
    
    These tests verify authentication works correctly.
    They clearly show the TEST API is being used.
    """

    def test_auth_token_url_verification(self):
        """
        B.1: Verify the auth token URL points to TEST deployment.
        """
        from app.core.config import settings
        
        print("\n" + "=" * 70)
        print("TEST B.1: Auth Token URL Verification")
        print("=" * 70)
        
        auth_url = settings.NOMAD_URL.replace("/api/v1", "/api/v1/auth/token")
        
        print(f"Configured Auth URL: {auth_url}")
        print(f"Contains '/test/':   {'/test/' in auth_url}")
        print("-" * 70)
        
        assert "/test/" in auth_url, (
            f"CRITICAL: Auth URL does not point to TEST deployment!\n"
            f"URL: {auth_url}\n"
            f"This would authenticate against PRODUCTION!"
        )
        
        print("✓ Auth URL correctly points to TEST deployment")
        print("=" * 70)

    def test_auth_token_credentials_required(self):
        """
        B.2: Verify that missing credentials raise appropriate error.
        """
        from app.services.nomad import get_nomad_token, NomadAuthError
        
        print("\n" + "=" * 70)
        print("TEST B.2: Auth Token Requires Credentials")
        print("=" * 70)
        
        with patch("app.services.nomad.settings") as mock_settings:
            mock_settings.NOMAD_URL = EXPECTED_TEST_BASE_URL
            mock_settings.NOMAD_USERNAME = None
            mock_settings.NOMAD_PASSWORD = None
            
            print("Testing with no credentials...")
            print(f"  NOMAD_USERNAME: {mock_settings.NOMAD_USERNAME}")
            print(f"  NOMAD_PASSWORD: {mock_settings.NOMAD_PASSWORD}")
            print("-" * 70)
            
            with pytest.raises(NomadAuthError) as exc_info:
                get_nomad_token()
            
            print(f"Raised NomadAuthError: {exc_info.value}")
            assert "credentials not configured" in str(exc_info.value).lower()
            
        print("✓ Missing credentials correctly raises NomadAuthError")
        print("=" * 70)

    @patch("httpx.Client")
    def test_auth_token_mock_success(self, mock_client_class):
        """
        B.3: Mock successful auth token retrieval from TEST API.
        
        Clearly shows the token is from the TEST API.
        """
        from app.services.nomad import get_nomad_token
        
        print("\n" + "=" * 70)
        print("TEST B.3: Mock Successful Auth Token Retrieval")
        print("=" * 70)
        
        # Configure mock
        mock_client = MagicMock()
        mock_client_class.return_value.__enter__ = MagicMock(return_value=mock_client)
        mock_client_class.return_value.__exit__ = MagicMock(return_value=False)
        
        mock_token = "test_api_token_from_nomad_test_deployment"
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = {"access_token": mock_token}
        
        request_info = {}
        def capture_post(url, **kwargs):
            request_info["url"] = url
            request_info["data"] = kwargs.get("data", {})
            return mock_response
        mock_client.post.side_effect = capture_post
        
        with patch("app.services.nomad.settings") as mock_settings:
            mock_settings.NOMAD_URL = EXPECTED_TEST_BASE_URL
            mock_settings.NOMAD_USERNAME = TEST_USERNAME
            mock_settings.NOMAD_PASSWORD = TEST_PASSWORD
            mock_settings.NOMAD_MOCK_MODE = False
            
            print("Request Details:")
            print(f"  Target URL: {EXPECTED_TEST_AUTH_URL}")
            print(f"  Username:   {TEST_USERNAME}")
            print("-" * 70)
            
            token = get_nomad_token()
        
        print("Response Details:")
        print(f"  Actual URL Used:  {request_info.get('url')}")
        print(f"  Token Retrieved:  {token}")
        print(f"  Token from TEST:  {'/test/' in request_info.get('url', '')}")
        print("-" * 70)
        
        assert request_info["url"] == EXPECTED_TEST_AUTH_URL
        assert token == mock_token
        assert "/test/" in request_info["url"]
        
        print("✓ Successfully retrieved mock token from TEST API")
        print("=" * 70)

    @patch("httpx.Client")
    def test_auth_token_mock_failure(self, mock_client_class):
        """
        B.4: Mock failed auth token retrieval.
        """
        from app.services.nomad import get_nomad_token, NomadAuthError
        
        print("\n" + "=" * 70)
        print("TEST B.4: Mock Failed Auth Token Retrieval")
        print("=" * 70)
        
        # Configure mock for failure
        mock_client = MagicMock()
        mock_client_class.return_value.__enter__ = MagicMock(return_value=mock_client)
        mock_client_class.return_value.__exit__ = MagicMock(return_value=False)
        
        mock_response = MagicMock()
        mock_response.status_code = 401
        mock_response.text = "Invalid credentials"
        mock_client.post.return_value = mock_response
        
        with patch("app.services.nomad.settings") as mock_settings:
            mock_settings.NOMAD_URL = EXPECTED_TEST_BASE_URL
            mock_settings.NOMAD_USERNAME = "wrong_user"
            mock_settings.NOMAD_PASSWORD = "wrong_password"
            mock_settings.NOMAD_MOCK_MODE = False
            
            print("Testing with invalid credentials...")
            print(f"  URL: {EXPECTED_TEST_AUTH_URL}")
            print("-" * 70)
            
            with pytest.raises(NomadAuthError) as exc_info:
                get_nomad_token()
            
            print(f"Raised NomadAuthError: {exc_info.value}")
            
        print("✓ Invalid credentials correctly raises NomadAuthError")
        print("=" * 70)


# ═══════════════════════════════════════════════════════════════════════════════
# TEST GROUP C: Archive Upload Tests
# ═══════════════════════════════════════════════════════════════════════════════

class TestArchiveUpload:
    """
    Test Group C: Archive upload tests.
    
    These tests verify archive creation and upload with clear URL logging.
    """

    def test_archive_upload_secure_zip_creation(self):
        """
        C.1: Test secure ZIP archive creation.
        """
        from app.services.nomad import create_secure_zip
        
        print("\n" + "=" * 70)
        print("TEST C.1: Secure ZIP Archive Creation")
        print("=" * 70)
        
        # Test files with potentially dangerous names
        test_files = [
            ("normal_file.txt", b"Normal content"),
            ("../../../etc/passwd", b"Attempted path traversal"),
            ("file with spaces.txt", b"Spaces in name"),
            ("UPPERCASE.TXT", b"Uppercase extension"),
        ]
        
        print("Input files:")
        for name, content in test_files:
            print(f"  - {name} ({len(content)} bytes)")
        print("-" * 70)
        
        zip_path = create_secure_zip(test_files, archive_name="security_test.zip")
        
        print(f"Created archive: {zip_path}")
        print(f"Archive size: {zip_path.stat().st_size} bytes")
        
        # Verify archive contents
        with zipfile.ZipFile(zip_path, 'r') as zf:
            names = zf.namelist()
            print(f"Archive contents ({len(names)} files):")
            for name in names:
                print(f"  - {name}")
        
        # Clean up
        zip_path.unlink()
        print("-" * 70)
        
        # Verify no path traversal
        assert all("/" not in name and "\\" not in name for name in names), \
            "Archive contains path separators - possible path traversal!"
        
        print("✓ Secure ZIP archive created without path traversal")
        print("=" * 70)

    def test_archive_upload_metadata_yaml_generation(self):
        """
        C.2: Test NOMAD metadata YAML generation.
        """
        from app.services.nomad import create_nomad_metadata_yaml
        
        print("\n" + "=" * 70)
        print("TEST C.2: NOMAD Metadata YAML Generation")
        print("=" * 70)
        
        yaml_content = create_nomad_metadata_yaml(
            experiment_name="Test Experiment",
            substrates=[
                {"id": "sub1", "name": "Substrate 1"},
                {"id": "sub2", "name": "Substrate 2"},
            ],
            measurement_files=[
                {"fileName": "measurement1.txt", "fileType": "JV", "deviceName": "AI44"},
                {"fileName": "measurement2.txt", "fileType": "IPCE", "deviceName": "AI44"},
            ],
            device_groups=[
                {
                    "deviceName": "AI44",
                    "assignedSubstrateId": "sub1",
                    "files": [{"fileName": "measurement1.txt"}]
                }
            ],
            user_notes="Test notes for NOMAD upload",
        )
        
        print("Generated YAML:")
        print("-" * 70)
        print(yaml_content)
        print("-" * 70)
        
        # Verify required fields
        assert "metadata:" in yaml_content
        assert "Test Experiment" in yaml_content
        assert "entries:" in yaml_content
        assert "measurement1.txt" in yaml_content
        
        print("✓ NOMAD metadata YAML generated correctly")
        print("=" * 70)

    @patch("httpx.Client")
    def test_archive_upload_mock_upload(self, mock_client_class):
        """
        C.3: Mock test for archive upload with detailed URL/response logging.
        """
        from app.services.nomad import upload_to_nomad, create_secure_zip
        
        print("\n" + "=" * 70)
        print("TEST C.3: Mock Archive Upload to TEST API")
        print("=" * 70)
        
        # Create test archive
        test_files = [
            ("test_data.txt", b"JV measurement data\nPCE: 15.5%"),
            ("nomad_metadata.yaml", b"metadata:\n  upload_name: Test\n"),
        ]
        zip_path = create_secure_zip(test_files, archive_name="upload_test.zip")
        
        print(f"Test Archive: {zip_path}")
        print(f"Archive Size: {zip_path.stat().st_size} bytes")
        print("-" * 70)
        
        # Configure mock with detailed response
        mock_client = MagicMock()
        mock_client_class.return_value.__enter__ = MagicMock(return_value=mock_client)
        mock_client_class.return_value.__exit__ = MagicMock(return_value=False)
        
        mock_response_data = {
            "upload_id": "cL6wmaGjTIee_ojyAbVjGA",
            "upload_create_time": "2026-04-10T14:39:18.000Z",
            "process_status": "processing",
            "entries": [
                {
                    "entry_id": "zzMmd8pIhS3GIQiCwKPkIfpB-Br2",
                    "mainfile": "test_data.txt",
                    "parser_name": "parsers/text"
                }
            ]
        }
        
        mock_response = MagicMock()
        mock_response.status_code = 200
        mock_response.json.return_value = mock_response_data
        
        captured_request = {}
        def capture_post(url, **kwargs):
            captured_request["url"] = url
            captured_request["headers"] = kwargs.get("headers", {})
            captured_request["params"] = kwargs.get("params", {})
            captured_request["files"] = kwargs.get("files", {})
            return mock_response
        mock_client.post.side_effect = capture_post
        
        with patch("app.services.nomad.settings") as mock_settings:
            mock_settings.NOMAD_URL = EXPECTED_TEST_BASE_URL
            mock_settings.NOMAD_MOCK_MODE = False
            
            print("Making Upload Request:")
            print(f"  Target URL: {EXPECTED_TEST_UPLOAD_URL}")
            print(f"  Auth Token: Bearer test_token_xxx...")
            print("-" * 70)
            
            result = upload_to_nomad(
                zip_path=zip_path,
                token="test_token_xxx",
                upload_name="Test Upload C.3"
            )
        
        # Clean up
        zip_path.unlink()
        
        # Display captured request
        print("CAPTURED REQUEST:")
        print(f"  URL:           {captured_request['url']}")
        print(f"  Method:        POST")
        print(f"  Authorization: {captured_request['headers'].get('Authorization', 'N/A')[:30]}...")
        print(f"  Upload Name:   {captured_request['params'].get('upload_name', 'N/A')}")
        print(f"  Files:         {list(captured_request['files'].keys())}")
        print("-" * 70)
        
        # Display response
        print("SERVER RESPONSE (Mock):")
        print(f"  Status:        200 OK")
        print(f"  upload_id:     {mock_response_data['upload_id']}")
        print(f"  create_time:   {mock_response_data['upload_create_time']}")
        print(f"  status:        {mock_response_data['process_status']}")
        print(f"  entries:       {len(mock_response_data['entries'])} entry(ies)")
        for entry in mock_response_data["entries"]:
            print(f"    - entry_id: {entry['entry_id']}")
            print(f"      mainfile: {entry['mainfile']}")
        print("-" * 70)
        
        # Verify URL is TEST deployment
        assert captured_request["url"] == EXPECTED_TEST_UPLOAD_URL, (
            f"Upload URL mismatch!\n"
            f"Actual:   {captured_request['url']}\n"
            f"Expected: {EXPECTED_TEST_UPLOAD_URL}"
        )
        assert "/test/" in captured_request["url"]
        
        # Verify result
        assert result["upload_id"] == mock_response_data["upload_id"]
        assert result["entry_ids"] == ["zzMmd8pIhS3GIQiCwKPkIfpB-Br2"]
        
        print("✓ Archive uploaded to TEST API successfully")
        print("=" * 70)


# ═══════════════════════════════════════════════════════════════════════════════
# TEST GROUP D: Full Upload Cycle Tests
# ═══════════════════════════════════════════════════════════════════════════════

class TestFullCycle:
    """
    Test Group D: Full upload cycle tests.
    
    These tests verify the complete workflow from file creation to upload.
    """

    @patch("httpx.Client")
    def test_full_cycle_mock_complete_workflow(self, mock_client_class):
        """
        D.1: Complete mock workflow: create zip, get token, upload, check status.
        """
        from app.services.nomad import (
            create_secure_zip,
            create_nomad_metadata_yaml,
            get_nomad_token,
            upload_to_nomad,
            get_upload_status,
            cleanup_temp_archive,
        )
        
        print("\n" + "=" * 70)
        print("TEST D.1: Full Upload Cycle (Mock)")
        print("=" * 70)
        
        # Step 1: Create test data
        print("\n[Step 1] Creating test data files...")
        measurement_files = [
            {"fileName": "device_AI44_jv.txt", "fileType": "JV", "deviceName": "AI44"},
            {"fileName": "device_AI44_ipce.txt", "fileType": "IPCE", "deviceName": "AI44"},
        ]
        substrates = [{"id": "sub1", "name": "Substrate AI44"}]
        device_groups = [{
            "deviceName": "AI44",
            "assignedSubstrateId": "sub1",
            "files": measurement_files
        }]
        
        print(f"  - {len(measurement_files)} measurement files")
        print(f"  - {len(substrates)} substrates")
        print(f"  - {len(device_groups)} device groups")
        
        # Step 2: Generate metadata YAML
        print("\n[Step 2] Generating NOMAD metadata...")
        metadata_yaml = create_nomad_metadata_yaml(
            experiment_name="Full Cycle Test Experiment",
            substrates=substrates,
            measurement_files=measurement_files,
            device_groups=device_groups,
            user_notes="Automated test upload",
        )
        print(f"  - Generated {len(metadata_yaml)} bytes of YAML")
        
        # Step 3: Create secure zip
        print("\n[Step 3] Creating secure ZIP archive...")
        test_files = [
            ("device_AI44_jv.txt", b"JV measurement\nVoc: 1.1V\nJsc: 22mA/cm2\nPCE: 18.5%"),
            ("device_AI44_ipce.txt", b"IPCE measurement\nPeak: 85% @ 500nm"),
            ("nomad_metadata.yaml", metadata_yaml.encode()),
        ]
        zip_path = create_secure_zip(test_files, archive_name="full_cycle_test.zip")
        print(f"  - Archive: {zip_path}")
        print(f"  - Size: {zip_path.stat().st_size} bytes")
        
        # Configure mocks
        mock_client = MagicMock()
        mock_client_class.return_value.__enter__ = MagicMock(return_value=mock_client)
        mock_client_class.return_value.__exit__ = MagicMock(return_value=False)
        
        # Mock responses for different endpoints
        call_counter = {"count": 0}
        
        def mock_http_call(url, **kwargs):
            call_counter["count"] += 1
            response = MagicMock()
            
            if "/auth/token" in url:
                response.status_code = 200
                response.json.return_value = {"access_token": "test_token_full_cycle"}
                print(f"\n[HTTP Call {call_counter['count']}] POST {url}")
                print(f"  Response: 200 OK - Token retrieved")
            elif url.endswith("/uploads"):
                response.status_code = 200
                response.json.return_value = {
                    "upload_id": "full_cycle_upload_id",
                    "upload_create_time": datetime.now(timezone.utc).isoformat(),
                    "process_status": "processing",
                    "entries": [{"entry_id": "full_cycle_entry_1"}]
                }
                print(f"\n[HTTP Call {call_counter['count']}] POST {url}")
                print(f"  Response: 200 OK - Upload created")
            elif "/uploads/" in url:
                response.status_code = 200
                response.json.return_value = {
                    "upload_id": "full_cycle_upload_id",
                    "process_status": "success",
                    "entries": [{"entry_id": "full_cycle_entry_1", "process_status": "success"}]
                }
                print(f"\n[HTTP Call {call_counter['count']}] GET {url}")
                print(f"  Response: 200 OK - Status retrieved")
            return response
        
        mock_client.post.side_effect = mock_http_call
        mock_client.get.side_effect = mock_http_call
        
        with patch("app.services.nomad.settings") as mock_settings:
            mock_settings.NOMAD_URL = EXPECTED_TEST_BASE_URL
            mock_settings.NOMAD_USERNAME = TEST_USERNAME
            mock_settings.NOMAD_PASSWORD = TEST_PASSWORD
            mock_settings.NOMAD_MOCK_MODE = False
            
            print("\n" + "-" * 70)
            print("Configuration:")
            print(f"  NOMAD_URL: {mock_settings.NOMAD_URL}")
            print(f"  Using TEST deployment: {'/test/' in mock_settings.NOMAD_URL}")
            print("-" * 70)
            
            # Step 4: Get auth token
            print("\n[Step 4] Authenticating with NOMAD TEST API...")
            token = get_nomad_token()
            print(f"  - Token: {token}")
            
            # Step 5: Upload to NOMAD
            print("\n[Step 5] Uploading to NOMAD TEST API...")
            upload_result = upload_to_nomad(
                zip_path=zip_path,
                token=token,
                upload_name="Full Cycle Test Experiment"
            )
            print(f"  - upload_id: {upload_result['upload_id']}")
            print(f"  - entry_ids: {upload_result['entry_ids']}")
            
            # Step 6: Check status
            print("\n[Step 6] Checking upload status...")
            status = get_upload_status(upload_result["upload_id"], token=token)
            print(f"  - status: {status.get('process_status')}")
            
            # Step 7: Cleanup
            print("\n[Step 7] Cleaning up temporary files...")
            cleanup_temp_archive(zip_path)
            print(f"  - Archive deleted: {not zip_path.exists()}")
        
        print("\n" + "-" * 70)
        print("FULL CYCLE SUMMARY:")
        print(f"  Auth Token Retrieved:  ✓")
        print(f"  Archive Created:       ✓")
        print(f"  Upload Successful:     ✓ ({upload_result['upload_id']})")
        print(f"  Status Check:          ✓ ({status.get('process_status')})")
        print(f"  Cleanup Complete:      ✓")
        print(f"  TEST API Used:         ✓ ({EXPECTED_TEST_BASE_URL})")
        print("-" * 70)
        
        # Assertions
        assert token == "test_token_full_cycle"
        assert upload_result["upload_id"] == "full_cycle_upload_id"
        assert upload_result["entry_ids"] == ["full_cycle_entry_1"]
        assert not zip_path.exists()
        
        print("✓ Full upload cycle completed successfully on TEST API")
        print("=" * 70)

    def test_full_cycle_url_safety_check(self):
        """
        D.2: Verify all URLs in the workflow point to TEST deployment.
        """
        from app.core.config import settings
        
        print("\n" + "=" * 70)
        print("TEST D.2: URL Safety Check")
        print("=" * 70)
        
        base_url = settings.NOMAD_URL
        auth_url = base_url.replace("/api/v1", "/api/v1/auth/token")
        upload_url = f"{base_url}/uploads"
        status_url = f"{base_url}/uploads/{{upload_id}}"
        
        urls_to_check = [
            ("Base URL", base_url),
            ("Auth URL", auth_url),
            ("Upload URL", upload_url),
            ("Status URL", status_url),
        ]
        
        print("URL Verification:")
        print("-" * 70)
        
        all_safe = True
        for name, url in urls_to_check:
            is_test = "/test/" in url
            status = "✓ TEST" if is_test else "✗ PRODUCTION!"
            print(f"  {name:12}: {url}")
            print(f"               {status}")
            if not is_test:
                all_safe = False
        
        print("-" * 70)
        
        if all_safe:
            print("✓ All URLs point to TEST deployment - safe to proceed")
        else:
            print("✗ WARNING: Some URLs point to PRODUCTION!")
        
        assert all_safe, "Not all URLs point to TEST deployment!"
        print("=" * 70)


# ═══════════════════════════════════════════════════════════════════════════════
# TEST GROUP E: Mock Mode Tests (NOMAD_MOCK_MODE=true)
# ═══════════════════════════════════════════════════════════════════════════════

class TestMockMode:
    """
    Test Group E: Verify NOMAD_MOCK_MODE prevents all real HTTP calls.
    
    When NOMAD_MOCK_MODE=true every function that would normally
    hit the network returns a safe fake response and logs what it
    *would* have done.  These tests assert that httpx.Client is
    NEVER instantiated while mock mode is active.
    """

    def _mock_settings(self, **overrides):
        """Return a mock settings object with NOMAD_MOCK_MODE=True."""
        s = MagicMock()
        s.NOMAD_URL = EXPECTED_TEST_BASE_URL
        s.NOMAD_USERNAME = TEST_USERNAME
        s.NOMAD_PASSWORD = TEST_PASSWORD
        s.NOMAD_MOCK_MODE = True
        for k, v in overrides.items():
            setattr(s, k, v)
        return s

    @patch("httpx.Client", side_effect=AssertionError("httpx.Client must NOT be called in mock mode"))
    def test_mock_mode_get_token(self, _forbidden_client):
        """
        E.1: get_nomad_token returns fake token, httpx never called.
        """
        from app.services.nomad import get_nomad_token

        print("\n" + "=" * 70)
        print("TEST E.1: Mock Mode — get_nomad_token")
        print("=" * 70)

        with patch("app.services.nomad.settings", self._mock_settings()):
            token = get_nomad_token()

        print(f"  Returned token: {token}")
        assert token == "MOCK_TOKEN_no_real_request_was_made"
        print("✓ No HTTP call made — mock token returned")
        print("=" * 70)

    @patch("httpx.Client", side_effect=AssertionError("httpx.Client must NOT be called in mock mode"))
    def test_mock_mode_upload(self, _forbidden_client):
        """
        E.2: upload_to_nomad returns fake result, httpx never called.
        """
        from app.services.nomad import upload_to_nomad, create_secure_zip

        print("\n" + "=" * 70)
        print("TEST E.2: Mock Mode — upload_to_nomad")
        print("=" * 70)

        zip_path = create_secure_zip(
            [("dummy.txt", b"hello")], archive_name="mock_test.zip"
        )

        with patch("app.services.nomad.settings", self._mock_settings()):
            result = upload_to_nomad(zip_path=zip_path, token="unused")

        zip_path.unlink(missing_ok=True)

        print(f"  upload_id:         {result['upload_id']}")
        print(f"  processing_status: {result['processing_status']}")
        assert result["upload_id"].startswith("MOCK_")
        assert result["processing_status"] == "mock"
        print("✓ No HTTP call made — mock upload result returned")
        print("=" * 70)

    @patch("httpx.Client", side_effect=AssertionError("httpx.Client must NOT be called in mock mode"))
    def test_mock_mode_get_status(self, _forbidden_client):
        """
        E.3: get_upload_status returns fake status, httpx never called.
        """
        from app.services.nomad import get_upload_status

        print("\n" + "=" * 70)
        print("TEST E.3: Mock Mode — get_upload_status")
        print("=" * 70)

        with patch("app.services.nomad.settings", self._mock_settings()):
            status = get_upload_status("fake_id", token="unused")

        print(f"  process_status: {status['process_status']}")
        assert status["process_status"] == "mock_success"
        print("✓ No HTTP call made — mock status returned")
        print("=" * 70)

    @patch("httpx.Client", side_effect=AssertionError("httpx.Client must NOT be called in mock mode"))
    def test_mock_mode_delete(self, _forbidden_client):
        """
        E.4: delete_upload returns True, httpx never called.
        """
        from app.services.nomad import delete_upload

        print("\n" + "=" * 70)
        print("TEST E.4: Mock Mode — delete_upload")
        print("=" * 70)

        with patch("app.services.nomad.settings", self._mock_settings()):
            ok = delete_upload("fake_id", token="unused")

        assert ok is True
        print("✓ No HTTP call made — mock delete returned True")
        print("=" * 70)

    @patch("httpx.Client", side_effect=AssertionError("httpx.Client must NOT be called in mock mode"))
    def test_mock_mode_full_cycle(self, _forbidden_client):
        """
        E.5: Full cycle (token → upload → status → delete) with mock mode.
        No httpx.Client is ever instantiated.
        """
        from app.services.nomad import (
            create_secure_zip,
            create_nomad_metadata_yaml,
            get_nomad_token,
            upload_to_nomad,
            get_upload_status,
            delete_upload,
            cleanup_temp_archive,
        )

        print("\n" + "=" * 70)
        print("TEST E.5: Mock Mode — Full Cycle")
        print("=" * 70)

        mock_s = self._mock_settings()

        # These two are purely local — no guard needed
        yaml_content = create_nomad_metadata_yaml(
            experiment_name="Mock Cycle",
            substrates=[],
            measurement_files=[{"fileName": "f.txt", "fileType": "JV"}],
            device_groups=[],
        )
        zip_path = create_secure_zip(
            [("f.txt", b"data"), ("nomad_metadata.yaml", yaml_content.encode())],
            archive_name="mock_cycle.zip",
        )

        with patch("app.services.nomad.settings", mock_s):
            token = get_nomad_token()
            result = upload_to_nomad(zip_path=zip_path, token=token, upload_name="Mock")
            status = get_upload_status(result["upload_id"], token=token)
            deleted = delete_upload(result["upload_id"], token=token)

        cleanup_temp_archive(zip_path)

        print(f"  token:      {token}")
        print(f"  upload_id:  {result['upload_id']}")
        print(f"  status:     {status['process_status']}")
        print(f"  deleted:    {deleted}")
        print(f"  cleaned up: {not zip_path.exists()}")

        assert token == "MOCK_TOKEN_no_real_request_was_made"
        assert result["upload_id"].startswith("MOCK_")
        assert status["process_status"] == "mock_success"
        assert deleted is True
        assert not zip_path.exists()
        print("✓ Full cycle completed — zero HTTP calls made")
        print("=" * 70)


# ═══════════════════════════════════════════════════════════════════════════════
# Utility function to run all tests with verbose output
# ═══════════════════════════════════════════════════════════════════════════════

if __name__ == "__main__":
    import sys
    
    print("\n" + "=" * 70)
    print("NOMAD Integration Test Suite")
    print("=" * 70)
    print("\nAvailable test groups:")
    print("  a) api_addresses  - Offline mock tests for API addresses")
    print("  b) auth_token     - Auth token retrieval tests")
    print("  c) archive_upload - Archive upload tests")
    print("  d) full_cycle     - Full upload cycle tests")
    print("\nRun with:")
    print("  pytest tests/services/test_nomad.py -v")
    print("  pytest tests/services/test_nomad.py -k 'api_addresses' -v")
    print("=" * 70)
    
    # Run pytest
    sys.exit(pytest.main([__file__, "-v", "--tb=short"]))
