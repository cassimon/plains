# ── Planes – NOMAD-Integrated Mode ───────────────────────────────────
# Use this env file to run planes inside the NOMAD ecosystem, sharing
# Keycloak authentication and being accessible under NOMAD's URL
# structure.  Copy or symlink to `.env` before running the integrated
# docker-compose stack.
# ─────────────────────────────────────────────────────────────────────

# Auth – delegate to NOMAD Keycloak
AUTH_MODE=nomad
NOMAD_KEYCLOAK_URL=http://keycloak:8080/auth
NOMAD_KEYCLOAK_REALM=fairdi_nomad_test
NOMAD_KEYCLOAK_CLIENT_ID=nomad_public
NOMAD_API_URL=http://nomad_app:8000/nomad-oasis/api/v1

# Domain – same host as the NOMAD oasis
DOMAIN=localhost
FRONTEND_HOST=http://localhost/planes
ENVIRONMENT=local

PROJECT_NAME="Planes (NOMAD)"
STACK_NAME=planes-nomad

# Backend – CORS must include the NOMAD host
BACKEND_CORS_ORIGINS="http://localhost,http://localhost:5173,http://localhost:3000,http://localhost/planes"
SECRET_KEY=changethis
# Superuser is still needed for Alembic migrations / first-run seeding
FIRST_SUPERUSER=admin@example.com
FIRST_SUPERUSER_PASSWORD=changethis

# Emails (optional, NOMAD handles its own)
SMTP_HOST=
SMTP_USER=
SMTP_PASSWORD=
EMAILS_FROM_EMAIL=info@example.com
SMTP_TLS=True
SMTP_SSL=False
SMTP_PORT=587

# Planes' own Postgres (separate from NOMAD's Mongo)
POSTGRES_SERVER=planes_db
POSTGRES_PORT=5432
POSTGRES_DB=planes
POSTGRES_USER=postgres
POSTGRES_PASSWORD=changethis

SENTRY_DSN=

# Docker images
DOCKER_IMAGE_BACKEND=planes-backend
DOCKER_IMAGE_FRONTEND=planes-frontend
