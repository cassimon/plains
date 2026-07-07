# Task 2: Security Hardening for Web Exposure

## Rule
Do NOT change application functionality. Fix security issues only.

## Objective
Audit the full stack (FastAPI backend, React frontend, Docker Compose, config) for security weaknesses and produce a single actionable checklist that, when completed, makes the application safe to deploy on a public-facing server.

## What to Audit

### Backend (FastAPI / Python)

1. **CORS** (`backend/app/main.py`)
   - Check `allow_origins` — must not be `["*"]` in production.
   - Ensure `allow_credentials=True` is only set when origins are explicitly whitelisted.

2. **Secret management** (`backend/app/core/config.py`, `.env` files)
   - Confirm `SECRET_KEY` / `JWT_SECRET` are loaded from env, never hardcoded.
   - Check for any secrets committed to the repo (`git log -S <pattern>`).
   - Verify `.env` is in `.gitignore`.
   - Check NOMAD auth file path handling (`../sensitive config/.nomad_auth`).

3. **Authentication & authorisation** (`backend/app/api/deps.py`, `core/security.py`)
   - JWT algorithm: must be `HS256` or `RS256`, never `none`.
   - Token expiry: confirm `ACCESS_TOKEN_EXPIRE_MINUTES` is set to a reasonable value (≤60 min).
   - Confirm every non-public route requires a valid token.
   - Check for IDOR: do resource endpoints verify that the requesting user owns the resource?

4. **SQL injection** (`backend/app/crud.py`)
   - Verify all queries go through SQLModel/SQLAlchemy ORM — no raw string interpolation.

5. **File upload** (if any routes accept file uploads)
   - Validate MIME type and file extension server-side.
   - Store uploads outside the web root.

6. **Dependency vulnerabilities**
   - Run `uv pip audit` (or `pip-audit`) on `backend/`.
   - Note any CVEs that need patching.

7. **Error handling**
   - Confirm Sentry DSN is loaded from env.
   - Confirm unhandled exceptions return a generic 500 (no stack traces leaked to client).

8. **Rate limiting**
   - Check if login / password-reset endpoints are rate-limited.
   - Recommend adding `slowapi` if missing.

9. **HTTP headers**
   - Recommend adding `SecurityHeadersMiddleware` or equivalent:
     `Strict-Transport-Security`, `X-Content-Type-Options`, `X-Frame-Options`, `Content-Security-Policy`.

### Frontend (React / Vite)

10. **Keycloak / Auth config**
    - Confirm Keycloak realm and client IDs are not hardcoded with production values in source.
    - Confirm tokens are stored in memory, not `localStorage`.

11. **Content Security Policy**
    - The Vite build should inject a `<meta http-equiv="Content-Security-Policy">` or it should be set at the reverse-proxy level.

12. **Sensitive data in bundles**
    - Run `grep -r 'password\|secret\|token\|key' frontend/src/` and review hits.

13. **Dependency vulnerabilities**
    - Run `bun audit` from `frontend/`.

### Infrastructure (Docker Compose / Traefik)

14. **Exposed ports**
    - In `compose.yml`, check which ports are bound to `0.0.0.0` vs `127.0.0.1`.
    - Adminer, Mailcatcher, Traefik UI should NOT be exposed on a public server.

15. **Database**
    - PostgreSQL must not be exposed on a public port.
    - Confirm `POSTGRES_PASSWORD` is loaded from env.

16. **TLS**
    - Confirm Traefik is configured to obtain Let's Encrypt certificates for the public domain.
    - HTTP → HTTPS redirect must be enforced.

17. **Container users**
    - Confirm backend/frontend containers do not run as root.

18. **Docker secrets / env files**
    - `.env` files must not be copied into the image with `COPY`.

## Output Format

Produce a file called **`DEPLOY_SECURITY_CHECKLIST.md`** at the repo root with:
- A checklist (GitHub-flavoured `- [ ]` items).
- For each item: current finding, risk level (Critical / High / Medium / Low), and exact fix with code or config snippet.
- Ordered by risk level (Critical first).

## Acceptance Criteria
- `DEPLOY_SECURITY_CHECKLIST.md` exists at repo root.
- Every Critical and High item has a concrete fix instruction.
- No functionality has changed.
- `bash backend/scripts/lint.sh` and `bun run lint` still pass.

---

## Addendum — Access-Control Hardening (2026-07-07)

Three additional hardening specs, added per maintainer request. Unlike the audit
above (which produced a checklist), these are *implemented* with enforcing code
and exploit-style tests.

### S1 — Email whitelist of pre-authorised NOMAD accounts
- **Requirement:** Only pre-authorised accounts may access the app.
- **Design:** `ALLOWED_EMAILS` setting (comma-separated, `app/core/config.py`).
  Empty ⇒ whitelist disabled (legacy: all authenticated accounts allowed).
  Non-empty ⇒ deny-by-default; only listed emails (case-insensitive) accepted.
  `FIRST_SUPERUSER` is always implicitly allowed (no lock-out).
- **Enforcement choke points:**
  - `app/api/deps.py::get_current_user` — both the local-JWT (HS256) path and the
    NOMAD OAuth (RS256) path, for existing **and** auto-provisioned users. A valid,
    correctly-signed token for a non-whitelisted account is rejected with 403 and
    no local account is created.
  - `POST /users/signup`, `POST /users/` (superuser create), and the local-only
    `POST /private/users/` all reject non-whitelisted emails with 403.
- **Tests:** `tests/api/routes/test_email_whitelist.py` (config, both auth paths,
  auto-provisioning block, revocation of an existing user, all registration routes).

### S2 — Endpoint audit against unauthorised data access / file abuse
- **Requirement:** Every backend endpoint must resist unauthorised reads/writes
  and malicious file upload/download.
- **Findings & actions:**
  - All resource routers (`materials`, `solutions`, `experiments`, `results`,
    `processes`, `analyses`, `planes`) already scope list/count queries by
    `owner_id` and gate get/update/delete on ownership (superuser-exempt). Confirmed
    by tests.
  - **Fixed IDOR:** `POST /results/?experiment_id=…` created results bound to an
    arbitrary experiment without ownership check — an attacker could graft results
    onto another user's experiment. Now verifies experiment ownership (403 otherwise).
  - NOMAD file routes (`app/api/routes/nomad.py`) validate archive paths against
    `TEMP_UPLOAD_DIR` (path-traversal safe) and gate upload authorisation via
    `_require_nomad_upload_authorized`. No change required.
- **Tests:** `tests/api/routes/test_idor.py`,
  `tests/integration/test_integration_security.py`.

### S3 — No user may access another user's data (unless shared)
- **Requirement:** Strict per-user data isolation; the only cross-user visibility
  is an explicit `PlaneShare`.
- **Verification:** Exploit tests take a malicious authenticated user and attempt
  read / update / delete / list-enumeration / bulk-state leakage across every
  resource type owned by an unrelated victim — all must return 403 or exclude the
  victim's rows. Plane sharing verified owner-only (`share`, `sticky-notes`, etc.).
- **Tests:** `tests/api/routes/test_idor.py::TestListEndpointsDoNotLeak`,
  `::TestCrossUserPlaneSharing`, and the live-stack
  `tests/integration/test_integration_security.py` (two independent normal users).

### Acceptance Criteria (addendum)
- `ALLOWED_EMAILS` documented in `.env.example`; disabled by default (backward compat).
- Non-whitelisted account rejected at every auth/registration entry point (403).
- Cross-user IDOR blocked on all resource routers incl. results-injection.
- New exploit tests pass; existing unit + integration suites still green.
