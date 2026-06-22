# Plains — Deploy Security Checklist

> Follow every item below before exposing Plains to the public internet.
> Items are ordered **Critical → High → Medium → Low**.
> Some items were already fixed as part of the security hardening commit on branch `claude_cleanup`; those are marked **✅ Fixed**.

---

## CRITICAL

### C-1 — `.env` was tracked by git; secrets committed in plain text
**Finding:** The `.env` file was committed to the repository with placeholder secrets
(`SECRET_KEY=changethis`, `POSTGRES_PASSWORD=changethis`, `FIRST_SUPERUSER_PASSWORD=changethis`).
These values appear in the git history.

**✅ Fixed:** `.env` and `.env.*` are now in `.gitignore` and the file was removed from git tracking
(`git rm --cached .env`). A `.env.example` template was added.

**Remaining action required:**
```bash
# Rotate all secrets immediately — assume the old values are compromised.
# Generate a new SECRET_KEY:
python -c "import secrets; print(secrets.token_urlsafe(32))"

# Set in your deployment environment (CI secrets, vault, or an untracked .env):
SECRET_KEY=<new-random-value>
POSTGRES_PASSWORD=<strong-unique-password>
FIRST_SUPERUSER_PASSWORD=<strong-unique-password>

# If you have existing git history with the old .env, purge it:
git filter-repo --path .env --invert-paths   # or BFG Repo Cleaner
# Then force-push and rotate all credentials that appeared in the file.
```

---

### C-2 — HTTP-only Traefik routers (no TLS) for app services
**Finding:** All app service routers in `compose.yml` use `entrypoints=http` only.
The `https-redirect` middleware exists in `compose.traefik.yml` but is **not wired** to any app router.
Data (including Bearer tokens) travels in cleartext over the network.

**Action required:**

Add HTTPS routers and redirect rules for every app service in `compose.yml`:

```yaml
# Backend example — repeat pattern for frontend and adminer:
- traefik.http.routers.${STACK_NAME}-backend-https.rule=Host(`${DOMAIN}`) && PathPrefix(`/plains/api`)
- traefik.http.routers.${STACK_NAME}-backend-https.entrypoints=https
- traefik.http.routers.${STACK_NAME}-backend-https.tls=true
- traefik.http.routers.${STACK_NAME}-backend-https.tls.certresolver=le
- traefik.http.routers.${STACK_NAME}-backend-https.middlewares=${STACK_NAME}-plains-strip
# Redirect the plain HTTP router to HTTPS:
- traefik.http.routers.${STACK_NAME}-backend.middlewares=https-redirect
```

Also add HSTS to Traefik's entry-point configuration:
```yaml
command:
  - --entrypoints.https.http.tls=true
  - --entrypoints.https.http.redirections.entrypoint.to=https
  - --entrypoints.http.http.redirections.entrypoint.to=https
  - --entrypoints.http.http.redirections.entrypoint.scheme=https
```

---

### C-3 — Adminer exposed publicly without authentication
**Finding:** Adminer (full database admin UI) is configured under `Host(DOMAIN) && PathPrefix(/plains/adminer)`
on the HTTP entrypoint with **no auth middleware**. Anyone with the URL has unrestricted database access.

**Action required — choose one:**

**Option A (recommended): Disable Adminer for production**
Remove the Adminer service entirely from `compose.yml` for production deployments. Use a
local port-forward or a separate internal-only stack for database admin.

**Option B: Add HTTP Basic Auth**
```yaml
labels:
  - traefik.http.middlewares.${STACK_NAME}-adminer-auth.basicauth.users=${ADMINER_USER}:${ADMINER_HASHED_PASSWORD}
  - traefik.http.routers.${STACK_NAME}-adminer.middlewares=${STACK_NAME}-adminer-strip,${STACK_NAME}-adminer-auth
```
Generate the password hash: `htpasswd -nb admin <strong-password>`

---

### C-4 — Open user registration enabled by default
**Finding:** `USERS_OPEN_REGISTRATION: bool = True` in `config.py`. On a public server anyone
can call `POST /api/v1/users/signup` and create an account.

**Action required:**
```bash
# In .env for production:
USERS_OPEN_REGISTRATION=False
```
Or in `core/config.py` change the default to `False`:
```python
USERS_OPEN_REGISTRATION: bool = False
```

---

## HIGH

### H-1 — Token expiry of 8 days is excessive
**Finding:** `ACCESS_TOKEN_EXPIRE_MINUTES = 60 * 24 * 8` meant a stolen token was valid for 8 days.
App uses Keycloak tokens (short-lived by Keycloak policy) but the local fallback JWT was long-lived.

**✅ Fixed:** Default changed to `60` minutes in `core/config.py`.
Override in `.env` if needed: `ACCESS_TOKEN_EXPIRE_MINUTES=60`.

---

### H-2 — Path traversal bypass in NOMAD archive path validation
**Finding:** Four places in `api/routes/nomad.py` validated that an `archive_path` was inside
`TEMP_UPLOAD_DIR` using:
```python
if not str(candidate).startswith(str(allowed_root)):
```
A path like `/tmp/plains_nomad_uploads_evil/x.zip` would pass this check because it starts with
`/tmp/plains_nomad_uploads` (missing the trailing separator). An attacker with a valid session could
read or delete arbitrary files that happen to share the prefix.

**✅ Fixed:** All four occurrences replaced with:
```python
if not candidate.is_relative_to(allowed_root):
```

---

### H-3 — `verify_password` called with `None` for Keycloak-only users (crash / auth bypass)
**Finding:** `PATCH /api/v1/users/me/password` called `verify_password(plain, user.hashed_password)`
but `hashed_password` is `Optional[str]` for users who signed up via NOMAD OAuth (no local password set).
This caused an unhandled exception in the password hasher, which Sentry would catch but could leak
a stack trace or trigger unexpected behaviour.

**✅ Fixed:** `api/routes/users.py` now returns HTTP 400 with a clear message before calling
`verify_password` when `hashed_password` is `None`.

---

### H-4 — JWT error details leaked to API clients
**Finding:** `core/security.py` returned the raw `str(e)` from `jwt.InvalidTokenError` to clients:
```python
detail=f"Invalid NOMAD token: {str(e)}"
```
This could disclose internal token structure, algorithm details, or library version strings that
help an attacker craft bypass attempts.

**✅ Fixed:** Both exception handlers now return generic messages (`"Invalid or expired token"`,
`"Token verification failed"`) and log the error class name at WARNING/ERROR level internally.

---

### H-5 — No security headers on nginx or FastAPI responses
**Finding:** The nginx `nginx.conf` had no security headers at all. No `X-Frame-Options`,
`X-Content-Type-Options`, `Content-Security-Policy`, `Referrer-Policy`, or `Strict-Transport-Security`.

**✅ Fixed:**
- `frontend/nginx.conf` now sets `X-Content-Type-Options`, `X-Frame-Options`, `X-XSS-Protection`,
  `Referrer-Policy`, and a starter `Content-Security-Policy`.
- `backend/app/main.py` has a `SecurityHeadersMiddleware` that sets the same headers on API responses,
  plus `Strict-Transport-Security` in staging/production environments.

**Remaining action (CSP tuning):** The default CSP uses `'unsafe-inline'` for scripts and styles
to avoid breaking existing bundled code. Before go-live, audit the actual script/style sources and
tighten the CSP:
```
Content-Security-Policy: default-src 'self';
  script-src 'self';
  style-src 'self';
  connect-src 'self' https://nomad-lab.eu;
  img-src 'self' data:;
  font-src 'self' data:;
  frame-ancestors 'none';
```
Run `bunx playwright test` against the tightened CSP and fix any violations before deploying.

---

### H-6 — CORS allows all methods and headers
**Finding:** `allow_methods=["*"]` and `allow_headers=["*"]` in the CORS middleware permits
cross-origin requests with any HTTP method (including `DELETE`, `PATCH`) and any header.

**✅ Fixed:** Restricted to the specific methods and headers the API actually uses:
```python
allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
allow_headers=["Authorization", "Content-Type", "Accept"],
```

---

### H-7 — No rate limiting on authentication endpoints
**Finding:** `GET /api/v1/auth/config` and the Keycloak redirect flow have no server-side rate limit.
Although brute-force of the Keycloak-backed tokens is hard, the `/api/v1/users/me/password` endpoint
that accepts a local password is susceptible to brute-force.

**Action required:** Add `slowapi` to the backend:
```bash
uv add slowapi
```
```python
# backend/app/main.py
from slowapi import Limiter, _rate_limit_exceeded_handler
from slowapi.util import get_remote_address
from slowapi.errors import RateLimitExceeded

limiter = Limiter(key_func=get_remote_address)
app.state.limiter = limiter
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)
```
```python
# backend/app/api/routes/users.py — password change endpoint
from app.main import limiter

@router.patch("/me/password", response_model=Message)
@limiter.limit("5/minute")
def update_password_me(request: Request, ...) -> Any:
    ...
```

---

## MEDIUM

### M-1 — Backend container runs as root
**Finding:** `backend/Dockerfile` has no `USER` instruction. The `fastapi` process runs as root inside
the container. A container escape or RCE bug would immediately have root access on the host.

**Action required:** Add a non-root user to the backend Dockerfile:
```dockerfile
# After the final uv sync RUN step:
RUN groupadd -r appuser && useradd -r -g appuser appuser \
    && chown -R appuser:appuser /app
USER appuser
```

---

### M-2 — Frontend nginx container runs as root
**Finding:** `frontend/Dockerfile` uses `nginx:1` without a user override. Nginx master process binds
port 80 and runs as root; worker processes drop privileges, but the master remains root.

**Action required:** Switch to `nginxinc/nginx-unprivileged` which listens on port 8080 as a non-root
user:
```dockerfile
FROM nginxinc/nginx-unprivileged:1 AS runtime
# Change listen port in nginx.conf from 80 to 8080
```
Update `compose.yml`: `loadbalancer.server.port=8080`.

---

### M-3 — `localStorage` token manager active (legacy/fallback path)
**Finding:** `frontend/src/store/backend.ts` contains `createTokenManager` which persists
`AuthTokens` (including `accessToken` and `refreshToken`) to `localStorage` under the key
`plains_auth`. localStorage is readable by any same-origin JavaScript (XSS-accessible).
The Keycloak singleton correctly uses in-memory storage, but the legacy `createTokenManager`
is still exported and could be instantiated by mistake.

**Action required:**
1. Verify `createTokenManager` is not used in any live production path (it should not be, since `HttpBackend` uses `getTokenAsync()` directly from Keycloak).
2. If confirmed unused, delete `createTokenManager` and `AuthTokenManager` from `backend.ts`.
3. If it must stay for a non-Keycloak use case, replace the `localStorage` persistence with
   `sessionStorage` (tab-scoped, cleared on tab close) as a minimum improvement.

---

### M-4 — Verbose auth logging exposes email addresses and PII in logs
**Finding:** `api/deps.py` and `core/security.py` logged user email addresses, NOMAD `sub` claims,
and token presence on every authenticated request at `INFO` level. In a shared log aggregation
system this is a GDPR concern and could aid an attacker who gains log access.

**✅ Fixed:**
- Per-request `logger.info` calls removed from `deps.py` and `security.py`.
- Errors and first-login events still log at `WARNING`/`INFO` with minimal PII.
- Frontend `console.log` calls in `keycloakInstance.ts` still log extensively to the browser console.
  These should be removed or gated behind a `DEBUG` flag for production builds:
  ```ts
  // frontend/src/lib/keycloakInstance.ts — remove or gate all console.log calls:
  if (import.meta.env.DEV) console.log("[Keycloak] ...")
  ```

---

### M-5 — PostgreSQL `POSTGRES_PASSWORD` defaults to empty string
**Finding:** `config.py` has `POSTGRES_PASSWORD: str = ""`. If the env var is missing, the database
connection uses no password. This would succeed on many default PostgreSQL configurations.

**Action required:** Change the default to force an explicit value:
```python
POSTGRES_PASSWORD: str  # no default — must be set in .env
```
Or add a validator that raises an error if empty in non-local environments.

---

### M-6 — Traefik dashboard exposed on public domain (production)
**Finding:** `compose.traefik.yml` exposes the Traefik dashboard at `traefik.DOMAIN` protected only
by HTTP Basic Auth. HTTP Basic Auth over HTTPS is acceptable, but the password should be strong.

**Action required:**
- Ensure `HASHED_PASSWORD` in your deployment environment is generated with bcrypt
  (`htpasswd -nB admin <password>`) not MD5.
- Consider IP-whitelisting the Traefik dashboard in production:
  ```yaml
  - traefik.http.middlewares.admin-ipwhitelist.ipwhitelist.sourcerange=YOUR_OFFICE_IP/32
  - traefik.http.routers.traefik-dashboard-https.middlewares=admin-auth,admin-ipwhitelist
  ```

---

### M-7 — `NOMAD_MOCK_MODE` default: no safeguard against accidental production uploads
**Finding:** `.env` ships with `NOMAD_MOCK_MODE=false`, meaning real NOMAD API calls happen by
default. During initial deployment testing it is easy to accidentally upload real data to NOMAD.

**Action required:** Set `NOMAD_MOCK_MODE=true` in a staging environment until the full upload
workflow has been verified end-to-end. Add a note to the deployment runbook.

---

### M-8 — PyJWT 2.7.0 and cryptography 41.0.7 — outdated dependencies
**Finding:** The installed versions predate the current releases:
- `PyJWT 2.7.0` → current is 2.10.x (patch releases with CVE fixes).
- `cryptography 41.0.7` → current is 44.x (multiple CVEs fixed in 42.x, 43.x, 44.x).

**Action required:**
```bash
cd backend
uv add "pyjwt>=2.10" "cryptography>=44"
uv lock
# Run tests: bash scripts/test.sh
```
Also run `uv pip audit` periodically (or add it to CI) to catch future CVEs:
```yaml
# .github/workflows/security.yml
- run: uv run pip-audit
```

---

## LOW

### L-1 — `console.log` statements in frontend keycloakInstance.ts log auth state
**Finding:** `src/lib/keycloakInstance.ts` has 12+ `console.log` calls that log authentication
state, token refresh events, and redirect URIs on every API call. These are visible to any user
who opens DevTools and could help an attacker understand the auth flow.

**Action required:**
```ts
// Replace all console.log in keycloakInstance.ts with a conditional:
const _log = import.meta.env.DEV
  ? (...args: unknown[]) => console.log(...args)
  : () => {}

_log("[Keycloak] setKeycloak called, authenticated:", kc.authenticated)
```

---

### L-2 — `NOMAD_AUTH_FILE` path contains a space and is outside the repo
**Finding:** The default NOMAD credentials file path is `../sensitive config/.nomad_auth`.
The space in the directory name can cause issues in shell scripts and some tools.

**Action required:** Rename the directory to `sensitive-config` and update `config.py`:
```python
_DEFAULT_NOMAD_AUTH_FILE = str(
    Path(__file__).parents[3].parent / "sensitive-config" / ".nomad_auth"
)
```
Override in `.env` on any system where the path differs:
```
NOMAD_AUTH_FILE=/opt/plains/secrets/.nomad_auth
```

---

### L-3 — Docker socket mounted in Traefik (privileged access)
**Finding:** `compose.traefik.yml` mounts `/var/run/docker.sock` into the Traefik container.
This is a known privilege escalation vector: anyone who can write to the Traefik container can
effectively become root on the host.

**Action required:** Use the Traefik Docker socket proxy pattern:
```yaml
# Add a socket proxy service:
socket-proxy:
  image: tecnativa/docker-socket-proxy:latest
  environment:
    CONTAINERS: 1
    NETWORKS: 1
    SERVICES: 1
    TASKS: 1
  volumes:
    - /var/run/docker.sock:/var/run/docker.sock:ro
  networks:
    - socket-proxy-net
```
Then configure Traefik to use `tcp://socket-proxy:2375` instead of the socket mount.

---

### L-4 — NOMAD `archive_path` stored in `sessionStorage`
**Finding:** `Results.page.tsx` stores the server-side temp file path
(`/tmp/plains_nomad_uploads/...`) in `sessionStorage` keyed by experiment ID. While `sessionStorage`
is tab-scoped and not persistent, it is still accessible via XSS.

**Action required:** The path is a server-side artefact. Rather than caching it client-side,
have the server return it directly in subsequent API responses, or include the path in the
upload response and pass it through component state/query cache (e.g. React Query) rather
than `sessionStorage`.

---

### L-5 — `SECRET_KEY` regenerated on every restart when not set in env
**Finding:** `config.py` defaults `SECRET_KEY` to `secrets.token_urlsafe(32)` (a new value each
restart). In production this invalidates all existing JWT sessions on every container restart.

**Action required:** Always set `SECRET_KEY` explicitly in `.env` / CI secrets. The existing
`_check_default_secret` validator will raise an error for `"changethis"` but not for a missing
value — a randomly regenerated key is silently accepted.

```python
# Consider adding a validator that warns if SECRET_KEY looks random/unset in production:
@model_validator(mode="after")
def _warn_random_secret(self) -> Self:
    if self.ENVIRONMENT in ("staging", "production") and len(self.SECRET_KEY) < 32:
        raise ValueError("SECRET_KEY must be explicitly set for production")
    return self
```

---

### L-6 — No `.dockerignore` — build context may include secrets
**Finding:** There is no `.dockerignore` file. Docker sends the entire build context (including
any locally present `.env`, `.nomad_auth`, dev artifacts) to the Docker daemon during `docker compose build`.

**Action required:** Create `.dockerignore` at the repo root:
```
.env
.env.*
*.pem
*.key
secrets/
.git/
backend/.venv/
frontend/node_modules/
backend/.mypy_cache/
htmlcov/
test-results/
```

---

## Deployment Runbook Summary

Before going live, confirm **all** of the following:

- [ ] **C-1** `.env` removed from git; all secrets rotated; `.env.example` committed instead.
- [ ] **C-2** All Traefik routers use HTTPS with Let's Encrypt; HTTP → HTTPS redirect active.
- [ ] **C-3** Adminer disabled or auth-protected and IP-restricted.
- [ ] **C-4** `USERS_OPEN_REGISTRATION=False` in production `.env`.
- [ ] **H-1** `ACCESS_TOKEN_EXPIRE_MINUTES` set to ≤ 60 in production.
- [ ] **H-2** Path traversal fix deployed (`candidate.is_relative_to(allowed_root)`). ✅
- [ ] **H-3** `verify_password` None guard deployed. ✅
- [ ] **H-4** JWT error detail no longer leaks to clients. ✅
- [ ] **H-5** Security headers active on nginx and FastAPI. ✅ (CSP needs tightening.)
- [ ] **H-6** CORS restricted to specific methods/headers. ✅
- [ ] **H-7** Rate limiting added to password-change endpoint.
- [ ] **M-1** Backend container runs as non-root user.
- [ ] **M-2** Frontend container uses `nginx-unprivileged` or equivalent.
- [ ] **M-3** `createTokenManager` / localStorage token path audited or removed.
- [ ] **M-4** Frontend `console.log` gated behind `import.meta.env.DEV`.
- [ ] **M-5** `POSTGRES_PASSWORD` has no empty default; must be set explicitly.
- [ ] **M-8** `cryptography` and `PyJWT` updated to current releases.
- [ ] **L-3** Traefik Docker socket access restricted via socket proxy.
- [ ] **L-6** `.dockerignore` created.
- [ ] **All** Run `uv run pip-audit` and `bun audit` and resolve any HIGH/CRITICAL CVEs before deploy.
