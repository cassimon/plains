import logging
from collections.abc import Generator
from typing import Annotated

from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlmodel import Session, select

from app.core import security
from app.core.db import engine
from app.models import User

logger = logging.getLogger(__name__)

# HTTPBearer extracts the token from the "Authorization: Bearer <token>" header.
# auto_error=False lets us return a clean 401 instead of a 403 when the header
# is absent.
_http_bearer = HTTPBearer(auto_error=False)


def get_db() -> Generator[Session, None, None]:
    with Session(engine) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_db)]


def _require_token(
    credentials: Annotated[HTTPAuthorizationCredentials | None, Depends(_http_bearer)],
) -> str:
    logger.info("[Auth] _require_token called")
    logger.info(f"[Auth] Credentials present: {credentials is not None}")

    if not credentials or not credentials.credentials:
        logger.error("[Auth] No credentials in Authorization header")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated",
            headers={"WWW-Authenticate": "Bearer"},
        )

    logger.info("[Auth] Token extracted from Authorization header")
    return credentials.credentials


TokenDep = Annotated[str, Depends(_require_token)]


def get_current_user(session: SessionDep, token: TokenDep) -> User:
    """Verify the NOMAD Keycloak Bearer token and return the matching user.

    On first login the user record is created automatically from the JWT claims.
    The token is verified against the NOMAD JWKS endpoint (RS256, issuer check).
    """
    logger.info("[Auth] get_current_user called, token received")

    claims = security.verify_nomad_token(token)
    nomad_sub = claims.get("sub")
    logger.info(f"[Auth] Token verified, nomad_sub: {nomad_sub}")

    if not nomad_sub:
        logger.error("[Auth] Token missing subject claim")
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid token: missing subject claim",
        )

    user = session.exec(select(User).where(User.nomad_sub == nomad_sub)).first()
    if not user:
        email = claims.get("email")
        name = claims.get("name")
        logger.info(f"[Auth] Creating new user: {email}")
        user = User(
            email=email,
            full_name=name,
            nomad_sub=nomad_sub,
            is_active=True,
            is_superuser=False,
        )
        session.add(user)
        session.commit()
        session.refresh(user)
        logger.info(f"[Auth] Auto-created user from NOMAD token: {email}")
    else:
        logger.info(f"[Auth] Found existing user: {user.email}")

    if not user.is_active:
        logger.error(f"[Auth] User is inactive: {user.email}")
        raise HTTPException(status_code=400, detail="Inactive user")

    logger.info(f"[Auth] Returning user: {user.email}")
    return user


CurrentUser = Annotated[User, Depends(get_current_user)]


def get_current_active_superuser(current_user: CurrentUser) -> User:
    if not current_user.is_superuser:
        raise HTTPException(
            status_code=403, detail="The user doesn't have enough privileges"
        )
    return current_user
