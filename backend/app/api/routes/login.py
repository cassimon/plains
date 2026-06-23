from datetime import timedelta
from typing import Annotated, Any

from fastapi import APIRouter, Depends, HTTPException
from fastapi.security import OAuth2PasswordRequestForm
from pydantic import BaseModel
from sqlmodel import Session, select

from app import crud
from app.api.deps import SessionDep
from app.core import security
from app.core.config import settings

router = APIRouter(tags=["login"])


class AuthConfig(BaseModel):
    keycloak_url: str
    keycloak_realm: str
    keycloak_client_id: str


class Token(BaseModel):
    access_token: str
    token_type: str


@router.post("/login/access-token", response_model=Token)
def login_access_token(
    session: SessionDep,
    form_data: Annotated[OAuth2PasswordRequestForm, Depends()],
) -> Any:
    """Local username/password login — only available when NOMAD_OAUTH_ENABLED=false."""
    if settings.NOMAD_OAUTH_ENABLED:
        raise HTTPException(
            status_code=400,
            detail="Local login disabled; use NOMAD OAuth",
        )
    from app.models import User

    user = session.exec(
        select(User).where(User.email == form_data.username)
    ).first()
    if not user or not user.hashed_password:
        raise HTTPException(status_code=400, detail="Incorrect email or password")
    ok, new_hash = security.verify_password(form_data.password, user.hashed_password)
    if not ok:
        raise HTTPException(status_code=400, detail="Incorrect email or password")
    if not user.is_active:
        raise HTTPException(status_code=400, detail="Inactive user")
    if new_hash:
        user.hashed_password = new_hash
        session.add(user)
        session.commit()
    expire = timedelta(minutes=settings.ACCESS_TOKEN_EXPIRE_MINUTES)
    token = security.create_access_token(user.email, expire)
    return Token(access_token=token, token_type="bearer")


@router.get("/auth/config")
def auth_config() -> AuthConfig:
    """Return Keycloak configuration for the frontend keycloak-js client."""
    if not settings.NOMAD_OAUTH_ENABLED:
        raise HTTPException(
            status_code=400,
            detail="NOMAD OAuth is not enabled",
        )
    parts = settings.NOMAD_KEYCLOAK_REALM_URL.rsplit("/realms/", 1)
    keycloak_url = parts[0]
    keycloak_realm = parts[1] if len(parts) > 1 else ""
    return AuthConfig(
        keycloak_url=keycloak_url,
        keycloak_realm=keycloak_realm,
        keycloak_client_id=settings.NOMAD_OAUTH_CLIENT_ID,
    )

