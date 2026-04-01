"""
NOMAD Keycloak authentication adapter.

When AUTH_MODE=nomad, the planes backend validates bearer tokens issued by
NOMAD's Keycloak instance instead of using its own JWT auth.  This module
fetches Keycloak's public RSA key and decodes incoming tokens accordingly.
"""

import time
from typing import Any

import jwt
from jwt import PyJWKClient

from app.core.config import settings

# Module-level cache for the Keycloak JWKS client
_jwks_client: PyJWKClient | None = None
_jwks_client_created_at: float = 0
_JWKS_CACHE_TTL = 3600  # seconds


def _get_jwks_client() -> PyJWKClient:
    """Return a cached PyJWKClient pointing at the Keycloak realm's JWKS endpoint."""
    global _jwks_client, _jwks_client_created_at

    now = time.time()
    if _jwks_client is None or (now - _jwks_client_created_at) > _JWKS_CACHE_TTL:
        jwks_url = (
            f"{settings.NOMAD_KEYCLOAK_URL.rstrip('/')}"
            f"/realms/{settings.NOMAD_KEYCLOAK_REALM}"
            f"/protocol/openid-connect/certs"
        )
        _jwks_client = PyJWKClient(jwks_url)
        _jwks_client_created_at = now

    return _jwks_client


def decode_nomad_token(token: str) -> dict[str, Any]:
    """
    Validate and decode a Keycloak-issued JWT.

    Returns the decoded payload dict on success.
    Raises ``jwt.InvalidTokenError`` (or subclasses) on failure.
    """
    client = _get_jwks_client()
    signing_key = client.get_signing_key_from_jwt(token)

    payload = jwt.decode(
        token,
        signing_key.key,
        algorithms=["RS256"],
        audience=settings.NOMAD_KEYCLOAK_CLIENT_ID,
        options={"verify_exp": True, "verify_aud": True},
    )
    return payload


def extract_user_info(payload: dict[str, Any]) -> dict[str, Any]:
    """
    Map Keycloak JWT claims to a user-info dict compatible with the planes
    user model.

    Keycloak tokens contain (among others):
      - sub            – unique user ID
      - email          – email address
      - preferred_username
      - given_name / family_name
    """
    return {
        "keycloak_sub": payload.get("sub"),
        "email": payload.get("email", ""),
        "full_name": " ".join(
            filter(
                None,
                [payload.get("given_name"), payload.get("family_name")],
            )
        ),
        "preferred_username": payload.get("preferred_username", ""),
    }
