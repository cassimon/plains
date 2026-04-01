from collections.abc import Generator
from typing import Annotated

import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import OAuth2PasswordBearer
from jwt.exceptions import InvalidTokenError
from pydantic import ValidationError
from sqlmodel import Session, select

from app.core import security
from app.core.config import settings
from app.core.db import engine
from app.models import TokenPayload, User

reusable_oauth2 = OAuth2PasswordBearer(
    tokenUrl=f"{settings.API_V1_STR}/login/access-token"
)


def get_db() -> Generator[Session, None, None]:
    with Session(engine) as session:
        yield session


SessionDep = Annotated[Session, Depends(get_db)]
TokenDep = Annotated[str, Depends(reusable_oauth2)]


def _get_current_user_standalone(session: Session, token: str) -> User:
    """Validate a planes-issued HS256 JWT and return the local user."""
    try:
        payload = jwt.decode(
            token, settings.SECRET_KEY, algorithms=[security.ALGORITHM]
        )
        token_data = TokenPayload(**payload)
    except (InvalidTokenError, ValidationError):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Could not validate credentials",
        )
    user = session.get(User, token_data.sub)
    if not user:
        raise HTTPException(status_code=404, detail="User not found")
    if not user.is_active:
        raise HTTPException(status_code=400, detail="Inactive user")
    return user


def _get_current_user_nomad(session: Session, token: str) -> User:
    """
    Validate a NOMAD Keycloak RS256 JWT and return (or auto-provision)
    the corresponding local user.
    """
    from app.core.nomad_auth import decode_nomad_token, extract_user_info

    try:
        payload = decode_nomad_token(token)
    except Exception:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Could not validate NOMAD credentials",
        )

    info = extract_user_info(payload)
    keycloak_sub = info["keycloak_sub"]
    if not keycloak_sub:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Token missing subject claim",
        )

    # Look up existing user by email (stable across Keycloak re-provisions)
    email = info.get("email", "")
    user = session.exec(select(User).where(User.email == email)).first()

    if user is None:
        # Auto-provision a local shadow user for this NOMAD identity
        user = User(
            email=email,
            full_name=info.get("full_name", ""),
            hashed_password="!nomad-keycloak-managed",  # not usable for local login
            is_active=True,
            is_superuser=False,
        )
        session.add(user)
        session.commit()
        session.refresh(user)

    if not user.is_active:
        raise HTTPException(status_code=400, detail="Inactive user")

    return user


def get_current_user(session: SessionDep, token: TokenDep) -> User:
    if settings.AUTH_MODE == "nomad":
        return _get_current_user_nomad(session, token)
    return _get_current_user_standalone(session, token)


CurrentUser = Annotated[User, Depends(get_current_user)]


def get_current_active_superuser(current_user: CurrentUser) -> User:
    if not current_user.is_superuser:
        raise HTTPException(
            status_code=403, detail="The user doesn't have enough privileges"
        )
    return current_user
