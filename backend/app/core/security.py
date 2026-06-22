from datetime import datetime, timedelta, timezone
from typing import Any

import jwt
from fastapi import HTTPException
from jwt import PyJWKClient
from pwdlib import PasswordHash
from pwdlib.hashers.argon2 import Argon2Hasher
from pwdlib.hashers.bcrypt import BcryptHasher

from app.core.config import settings

password_hash = PasswordHash(
    (
        Argon2Hasher(),
        BcryptHasher(),
    )
)

ALGORITHM = "HS256"

# Module-level JWKS client — PyJWKClient handles key caching and rotation internally.
# Instantiated lazily on first use so it doesn't fire on import (before settings load).
_jwks_client: PyJWKClient | None = None


def _get_jwks_client() -> PyJWKClient:
    global _jwks_client
    if _jwks_client is None:
        _jwks_client = PyJWKClient(
            f"{settings.NOMAD_KEYCLOAK_REALM_URL}/protocol/openid-connect/certs",
            cache_keys=True,
        )
    return _jwks_client


def create_access_token(subject: str | Any, expires_delta: timedelta) -> str:
    expire = datetime.now(timezone.utc) + expires_delta
    to_encode = {"exp": expire, "sub": str(subject)}
    encoded_jwt = jwt.encode(to_encode, settings.SECRET_KEY, algorithm=ALGORITHM)
    return encoded_jwt


def verify_password(
    plain_password: str, hashed_password: str
) -> tuple[bool, str | None]:
    return password_hash.verify_and_update(plain_password, hashed_password)


def get_password_hash(password: str) -> str:
    return password_hash.hash(password)


def verify_nomad_token(token: str) -> dict[str, Any]:
    """
    Verify a Keycloak RS256 JWT against the central NOMAD JWKS endpoint and
    return the decoded claims.  Raises HTTP 401 on any verification failure.
    """
    import logging

    logger = logging.getLogger(__name__)

    logger.info("[Auth] verify_nomad_token called")
    logger.info(f"[Auth] NOMAD_OAUTH_ENABLED: {settings.NOMAD_OAUTH_ENABLED}")

    if not settings.NOMAD_OAUTH_ENABLED:
        logger.error("[Auth] NOMAD OAuth is not enabled")
        raise HTTPException(
            status_code=400,
            detail="NOMAD OAuth is not enabled",
        )

    issuer = settings.NOMAD_KEYCLOAK_REALM_URL
    logger.info(f"[Auth] Expected issuer: {issuer}")
    logger.info(f"[Auth] JWKS URL: {issuer}/protocol/openid-connect/certs")
    logger.info(f"[Auth] Audience verification: {settings.NOMAD_OAUTH_VERIFY_AUDIENCE}")

    try:
        jwks_client = _get_jwks_client()
        logger.info("[Auth] JWKS client initialized")

        signing_key = jwks_client.get_signing_key_from_jwt(token)
        logger.info("[Auth] Signing key retrieved from JWT")

        decode_kwargs: dict[str, Any] = {
            "algorithms": ["RS256"],
            "issuer": issuer,
        }
        if settings.NOMAD_OAUTH_VERIFY_AUDIENCE:
            audience = settings.NOMAD_OAUTH_AUDIENCE or settings.NOMAD_OAUTH_CLIENT_ID
            decode_kwargs["audience"] = audience
            logger.info(f"[Auth] Will verify audience: {audience}")
        else:
            decode_kwargs["options"] = {"verify_aud": False}
            logger.info("[Auth] Audience verification disabled")

        claims = jwt.decode(token, signing_key.key, **decode_kwargs)
        logger.info(f"[Auth] Token verified successfully, subject: {claims.get('sub')}")
        return claims
    except jwt.InvalidTokenError as e:
        logger.error(f"[Auth] Invalid token error: {str(e)}")
        raise HTTPException(
            status_code=401,
            detail=f"Invalid NOMAD token: {str(e)}",
        )
    except Exception as e:
        logger.error(f"[Auth] Token verification failed: {str(e)}", exc_info=True)
        raise HTTPException(
            status_code=401,
            detail=f"Token verification failed: {str(e)}",
        )
