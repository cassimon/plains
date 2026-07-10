import secrets
import warnings
from pathlib import Path
from typing import Annotated, Any, Literal

from pydantic import (
    AnyUrl,
    BeforeValidator,
    EmailStr,
    HttpUrl,
    PostgresDsn,
    computed_field,
    model_validator,
)
from pydantic_settings import BaseSettings, SettingsConfigDict
from typing_extensions import Self


def parse_cors(v: Any) -> list[str] | str:
    if isinstance(v, str) and not v.startswith("["):
        return [i.strip() for i in v.split(",") if i.strip()]
    elif isinstance(v, list | str):
        return v
    raise ValueError(v)


# Default auth file: ../sensitive config/.nomad_auth (one level above project root)
_DEFAULT_NOMAD_AUTH_FILE = str(
    Path(__file__).parents[3].parent / "sensitive config" / ".nomad_auth"
)


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        # Use top level .env file (one level above ./backend/)
        env_file="../.env",
        env_ignore_empty=True,
        extra="ignore",
    )
    API_V1_STR: str = "/api/v1"
    SECRET_KEY: str = secrets.token_urlsafe(32)
    # 60 minutes * 24 hours * 8 days = 8 days
    # 60 minutes for production; override to a longer value only for local dev.
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 60
    FRONTEND_HOST: str = "http://localhost:5173"
    ENVIRONMENT: Literal["local", "dev", "staging", "production"] = "local"

    BACKEND_CORS_ORIGINS: Annotated[
        list[AnyUrl] | str, BeforeValidator(parse_cors)
    ] = []

    @computed_field  # type: ignore[prop-decorator]
    @property
    def all_cors_origins(self) -> list[str]:
        return [str(origin).rstrip("/") for origin in self.BACKEND_CORS_ORIGINS] + [
            self.FRONTEND_HOST
        ]

    PROJECT_NAME: str
    SENTRY_DSN: HttpUrl | None = None
    POSTGRES_SERVER: str
    POSTGRES_PORT: int = 5432
    POSTGRES_USER: str
    POSTGRES_PASSWORD: str = ""
    POSTGRES_DB: str = ""

    @computed_field  # type: ignore[prop-decorator]
    @property
    def SQLALCHEMY_DATABASE_URI(self) -> PostgresDsn:
        return PostgresDsn.build(
            scheme="postgresql+psycopg",
            username=self.POSTGRES_USER,
            password=self.POSTGRES_PASSWORD,
            host=self.POSTGRES_SERVER,
            port=self.POSTGRES_PORT,
            path=self.POSTGRES_DB,
        )

    SMTP_TLS: bool = True
    SMTP_SSL: bool = False
    SMTP_PORT: int = 587
    SMTP_HOST: str | None = None
    SMTP_USER: str | None = None
    SMTP_PASSWORD: str | None = None
    EMAILS_FROM_EMAIL: EmailStr | None = None
    EMAILS_FROM_NAME: str | None = None

    @model_validator(mode="after")
    def _set_default_emails_from(self) -> Self:
        if not self.EMAILS_FROM_NAME:
            self.EMAILS_FROM_NAME = self.PROJECT_NAME
        return self

    EMAIL_RESET_TOKEN_EXPIRE_HOURS: int = 48

    @computed_field  # type: ignore[prop-decorator]
    @property
    def emails_enabled(self) -> bool:
        return bool(self.SMTP_HOST and self.EMAILS_FROM_EMAIL)

    EMAIL_TEST_USER: EmailStr = "test@example.com"
    FIRST_SUPERUSER: EmailStr
    FIRST_SUPERUSER_PASSWORD: str
    USERS_OPEN_REGISTRATION: bool = True

    # Access whitelist ─────────────────────────────────────────────────────────
    # Comma-separated list of pre-authorised account emails (typically the NOMAD
    # accounts allowed to use this deployment). When the list is empty the
    # whitelist is disabled and any authenticated account is accepted (legacy
    # behaviour). When non-empty, ONLY these emails may authenticate, sign up, or
    # be provisioned — every other account is rejected with 403. Matching is
    # case-insensitive. The configured FIRST_SUPERUSER is always implicitly
    # allowed so an operator can never lock themselves out.
    ALLOWED_EMAILS: Annotated[list[str] | str, BeforeValidator(parse_cors)] = []

    @property
    def email_whitelist_enabled(self) -> bool:
        return bool(self.ALLOWED_EMAILS)

    @property
    def _allowed_emails_normalised(self) -> set[str]:
        allowed = {
            str(e).strip().lower() for e in self.ALLOWED_EMAILS if str(e).strip()
        }
        # The bootstrap superuser is always allowed so operators can't lock out.
        allowed.add(str(self.FIRST_SUPERUSER).strip().lower())
        return allowed

    def is_email_allowed(self, email: str | None) -> bool:
        """Return True if ``email`` may access the app.

        Always True when the whitelist is disabled (empty ``ALLOWED_EMAILS``).
        When enabled, only whitelisted emails (case-insensitive) are accepted;
        a missing/empty email is always rejected.
        """
        if not self.email_whitelist_enabled:
            return True
        if not email:
            return False
        return email.strip().lower() in self._allowed_emails_normalised

    ROOT_PATH: str = ""  # e.g. "/plains" for path-prefix deployments

    # NOMAD Configuration
    NOMAD_URL: str = "http://localhost/nomad-oasis/api/v1"
    # NOMAD OAuth / Keycloak Configuration
    NOMAD_KEYCLOAK_REALM_URL: str = (
        "https://nomad-lab.eu/fairdi/keycloak/auth/realms/fairdi_nomad_prod"
    )
    NOMAD_OAUTH_CLIENT_ID: str = "nomad_public"  # Central NOMAD public Keycloak client
    NOMAD_OAUTH_AUDIENCE: str | None = None  # Defaults to client_id when unset
    # nomad_public access tokens have no aud claim — set to true only if your
    # Keycloak client has an audience mapper configured.
    NOMAD_OAUTH_VERIFY_AUDIENCE: bool = False
    NOMAD_OAUTH_ENABLED: bool = False  # Enable NOMAD OAuth login
    # Path to the out-of-repo credentials file (key=value format).
    # Override via the NOMAD_AUTH_FILE env var if needed.
    NOMAD_AUTH_FILE: str = _DEFAULT_NOMAD_AUTH_FILE
    # Populated at startup by _load_nomad_auth_from_file; do not set in .env.
    NOMAD_USERNAME: str | None = None
    NOMAD_PASSWORD: str | None = None
    NOMAD_USE_GLOBAL_AUTH: bool = True
    NOMAD_MOCK_MODE: bool = False
    # Temporary upload archives (.zip) left inactive longer than this are
    # swept on the next NOMAD endpoint activity. Matches the GUI's 30-minute
    # upload-flow inactivity window (UPLOAD_FLOW_INACTIVITY_MS).
    NOMAD_ARCHIVE_MAX_AGE_S: int = 30 * 60
    # Failed / not-yet-succeeded uploads keep their file archive in this stash
    # directory so admins can re-examine or re-upload them. Mounted as a durable
    # named Docker volume (see compose.yml) so the stash survives container
    # recreation. Entries older than NOMAD_STASH_MAX_AGE_S are swept on the next
    # NOMAD endpoint activity (a hard one-week retention cap).
    NOMAD_STASH_DIR: str = "/var/lib/plains/nomad_stash"
    NOMAD_STASH_MAX_AGE_S: int = 7 * 24 * 60 * 60

    # Soft-deleted (trashed) items are permanently swept this many days after
    # deletion, on the next login bootstrap (GET /state/bulk, GET /trash/).
    TRASH_TTL_DAYS: int = 30

    @model_validator(mode="after")
    def _load_nomad_auth_from_file(self) -> Self:
        """Read NOMAD credentials from the auth file unless already supplied."""
        if self.NOMAD_USERNAME and self.NOMAD_PASSWORD:
            return self  # allow direct injection in tests
        auth_path = Path(self.NOMAD_AUTH_FILE)
        if auth_path.is_file():
            creds: dict[str, str] = {}
            for raw in auth_path.read_text(encoding="utf-8").splitlines():
                line = raw.strip()
                if line and not line.startswith("#") and "=" in line:
                    key, _, val = line.partition("=")
                    creds[key.strip().lower()] = val.strip()
            if "username" in creds:
                self.NOMAD_USERNAME = creds["username"]
            if "password" in creds:
                self.NOMAD_PASSWORD = creds["password"]
        return self

    @computed_field  # type: ignore[prop-decorator]
    @property
    def nomad_enabled(self) -> bool:
        """Check if NOMAD is configured with global auth credentials.

        Mock mode counts as enabled: it simulates a reachable NOMAD server so
        the full upload flow (including the GUI's upload button) can run in
        tests and demos without real credentials."""
        if self.NOMAD_MOCK_MODE:
            return True
        return bool(
            self.NOMAD_USE_GLOBAL_AUTH and self.NOMAD_USERNAME and self.NOMAD_PASSWORD
        )

    def _check_default_secret(self, var_name: str, value: str | None) -> None:
        if value == "changethis":
            message = (
                f'The value of {var_name} is "changethis", '
                "for security, please change it, at least for deployments."
            )
            if self.ENVIRONMENT in ("local", "dev"):
                warnings.warn(message, stacklevel=1)
            else:
                raise ValueError(message)

    @model_validator(mode="after")
    def _enforce_non_default_secrets(self) -> Self:
        self._check_default_secret("SECRET_KEY", self.SECRET_KEY)
        self._check_default_secret("POSTGRES_PASSWORD", self.POSTGRES_PASSWORD)
        self._check_default_secret(
            "FIRST_SUPERUSER_PASSWORD", self.FIRST_SUPERUSER_PASSWORD
        )

        return self

    @model_validator(mode="after")
    def _enforce_oauth_in_production(self) -> Self:
        if self.ENVIRONMENT in ("staging", "production"):
            if not self.NOMAD_OAUTH_ENABLED:
                raise ValueError(
                    "NOMAD_OAUTH_ENABLED must be true in staging/production "
                    "(local login is unsafe for shared deployments)"
                )
        return self


settings = Settings()  # type: ignore
