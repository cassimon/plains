# Plains — Safe Deploy Checklist

A short, current checklist for exposing Plains to the public internet. Most of the
one-off hardening from the original audit is now **enforced in code**; what remains is
mostly deployment configuration you set per environment.

Verify everything mechanically with:

```bash
python security_audit.py              # default: VERY concise — one line when healthy,
                                      #   detail only on a critical issue (failed REQUIRED
                                      #   check or a *shipped* dependency vuln). exit != 0 on problems.
python security_audit.py --check      # fast deploy-readiness gate (config only, no dep scans);
                                      #   lists every check with PASS/FAIL.
python security_audit.py --verbose    # full audit: every dep + version, all external URLs /
                                      #   HTTP call sites, full pip/bun vuln scans, and every check.
```

The default run reads secrets from both `.env` **and** the process environment, so a
deployment that injects secrets as env vars is verified too (it can no longer pass by
having no `.env` file). Build-time-only dependency advisories (e.g. in the OpenAPI client
generator) are reported as a non-blocking note; only vulns that reach the shipped bundle
count as critical.

---

## Already enforced in code — no action needed

These were fixed in the hardening work and are guarded by `security_audit.py --check`
(so a regression shows up as a failed check, not a silent hole):

- `.env` is untracked and gitignored; `.env.example` is the committed template.
- Local JWT lifetime is 60 min (`ACCESS_TOKEN_EXPIRE_MINUTES`); NOMAD/Keycloak tokens are short-lived.
- NOMAD `archive_path` validation uses `Path.is_relative_to` (no prefix-bypass traversal).
- CORS is restricted to specific methods/headers (no `"*"`).
- Security headers set on both nginx (`frontend/nginx.conf`) and API (`SecurityHeadersMiddleware`).
- Auth rate limiting via `slowapi` on **both** the login (10/min) and signup (5/min) routes.
- Config validators **refuse to boot** in `staging`/`production` when a secret is **empty or a
  placeholder** (not just the literal `changethis`), when `SECRET_KEY` is shorter than 32 chars,
  or when `NOMAD_OAUTH_ENABLED` is false. (Local/dev only warns, so an empty dev password is fine.)

---

## Required before going live

Set these in your **untracked** `.env` (or inject as secrets). Every line maps to a
`--check` item.

- [ ] `ENVIRONMENT=production` (or `staging`) — turns on the strict config validators + HSTS.
- [ ] `SECRET_KEY` — random, ≥32 chars. Generate: `python -c "import secrets; print(secrets.token_urlsafe(32))"`.
- [ ] `POSTGRES_PASSWORD` — strong, unique (default is empty; must be set).
- [ ] `FIRST_SUPERUSER_PASSWORD` — strong, unique.
- [ ] `USERS_OPEN_REGISTRATION=False` — otherwise anyone can `POST /users/signup`.
- [ ] `ALLOWED_EMAILS="a@lab.eu,b@lab.eu"` — access whitelist. Empty = **any** authenticated
      NOMAD account gets in. Set it for a private lab deployment.
- [ ] `NOMAD_OAUTH_ENABLED=true` — required in staging/production (local login is unsafe on a shared host).
- [ ] `BACKEND_CORS_ORIGINS` / `FRONTEND_HOST` — set to your real HTTPS origin, not localhost, not `*`.
- [ ] `DOMAIN=your.domain` and `ROOT_PATH=/plains` (matching your reverse proxy).
- [ ] **Host nginx** `client_max_body_size` raised (e.g. `512m`). The default 1 MB makes
      NOMAD file staging fail with `413 Request Entity Too Large`. See the sample block in
      `compose.prod.yml`; the local test proxy (`nginx-localproxy.conf`) already sets it.

If any secret is still at `changethis` in a prod `ENVIRONMENT`, the backend **will not start** —
that is intentional.

---

## Deploy commands

The production topology binds backend/frontend/adminer to **localhost only**
(`compose.prod.yml`); an external nginx/Traefik on the host terminates TLS and proxies
`/plains/...` to them. See the sample server block in `compose.prod.yml`.

```bash
# 0. One-time: create the shared external network compose.yml expects. Without it
#    you get "network traefik-public declared as external, but could not be found".
#    (The dev override auto-creates a project-scoped one; the explicit prod files do not.)
docker network create traefik-public   # idempotent-ish; ignore "already exists"

# 1. Back up the dev DB first if this host also ran the dev stack (see CLAUDE.md).
bash scripts/db-backup.sh

# 2. Bring the stack up (explicit -f files → dev compose.override.yml is NOT loaded).
#    --build bakes the non-root backend image (RUN_AS_USER=appuser); always build
#    with BOTH prod files so the image is the non-root one.
docker compose -f compose.yml -f compose.prod.yml up -d --build

# 3. Apply DB migrations:
docker compose -f compose.yml -f compose.prod.yml exec backend alembic upgrade head

# 4. Tail logs to confirm a clean boot (config validators run at startup):
docker compose -f compose.yml -f compose.prod.yml logs -f backend
```

Only these two `-f` files are the public-facing stack. **Never** add `compose.override.yml`
(dev: hot-reload, exposed ports) to a production `up`, and never run a bare
`docker compose up` on the server — that auto-loads the dev override.

Alternative (Traefik-managed TLS + Let's Encrypt instead of an external nginx):

```bash
docker compose -f compose.yml -f compose.traefik.yml up -d --build
```

To stop **without** destroying data (the DB lives in the `app-db-data` volume):

```bash
docker compose -f compose.yml -f compose.prod.yml down      # NO -v — never pass -v here
```

### Test the production build locally first

The prod stack binds everything to `127.0.0.1` and expects the *host's* nginx to
strip `/plains/` and proxy to it — so on your laptop nothing answers on `:81`. Add
`compose.localproxy.yml` (a localhost-only nginx that mimics the server: strips
`/plains/`, routes `/plains/api/ → backend`, `/plains/ → frontend`, and repoints the
frontend's baked API URL at the local proxy) to test the real prod images end-to-end:

```bash
docker compose -f compose.yml -f compose.prod.yml -f compose.localproxy.yml up -d --build
# then open  http://localhost:81/plains/   (http, not https — nothing terminates TLS locally)
```

This overlay is **local-only**: it is loaded solely when named explicitly, so it never
touches the dev stack (`compose.override.yml`) and never reaches the server — the deploy
command above (`compose.yml` + `compose.prod.yml`) does not include it, and the
`localhost:81` API URL does not leak into the deployed build. **Rebuild on the server**
(the deploy command already uses `--build`) so the real domain is re-baked.

---

## Recommended hardening (still open)

Not blockers for a private, whitelisted lab deployment, but do them for anything
broadly exposed. `--check` reports these as warnings:

- **`.dockerignore`** — done (repo root; excludes `.env`, keys, `.git/`, venvs, `node_modules/`, dumps).
- **Non-root backend** — done for production. `backend/Dockerfile` runs as `appuser` when built with
  the `RUN_AS_USER=appuser` arg, which `compose.prod.yml` sets; dev stays root so bind-mounted source
  stays writable. **Caveat:** on a host that previously ran the backend as root, the existing
  `*_nomad-stash` named volume is root-owned and the non-root process can't write to it. On a fresh
  host it's created owned by `appuser` automatically. To fix an existing one, either recreate it
  (`docker volume rm <project>_nomad-stash` — it only holds retryable NOMAD upload archives) or
  `docker run --rm -v <project>_nomad-stash:/v alpine chown -R 999:999 /v`.
- **Non-root frontend** — done for production. `frontend/Dockerfile` has a `runtime-unprivileged`
  stage (`nginxinc/nginx-unprivileged`, UID 101, listens on 8080 since a non-root process can't bind
  <1024); `compose.prod.yml` selects it via `target: runtime-unprivileged` and maps `9000 → 8080`.
  Dev and the Traefik model keep the root `nginx:1` stage on :80. **Only the `compose.prod.yml`
  (external-nginx) model gets the non-root frontend**; if you deploy via the Traefik path, add the
  target/port there too (and its `loadbalancer.server.port` label must then be 8080).
- **Adminer**: only expose it if you actually need it. `compose.prod.yml` binds it to
  `127.0.0.1:9001`; do not proxy `/plains/adminer` publicly unless it is auth-protected.
- **Tighten CSP**: drop `'unsafe-inline'` from `frontend/nginx.conf` once the bundle allows it,
  then re-run `bunx playwright test`.
- **Dependencies**: `python security_audit.py` runs `pip-audit` + `bun audit`; resolve any
  HIGH/CRITICAL before deploy, and keep `pyjwt`/`cryptography` current.
