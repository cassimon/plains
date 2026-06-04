# Implementation Plan: Path-Based Routing at `domain.com/plains/`

## Overview

The current stack uses Traefik with subdomain routing (`api.domain.com`, `dashboard.domain.com`, etc.). This plan switches to path-prefix routing (`domain.com/plains/`) for deployment behind an existing nginx reverse proxy.

**Target URL mapping:**

| Service  | Before                          | After                          |
|----------|---------------------------------|--------------------------------|
| Frontend | `https://dashboard.domain.com/` | `https://domain.com/plains/`   |
| Backend  | `https://api.domain.com/api/v1` | `https://domain.com/plains/api/v1` |
| Chatbot  | `https://chatbot.domain.com/`   | `https://domain.com/plains/chatbot/` |
| Adminer  | `https://adminer.domain.com/`   | *(internal only, see note)*    |

**Architecture after change:**

```
Internet → nginx (TLS) → Traefik (HTTP only, internal port) → services
```

The existing nginx terminates TLS and proxies `/plains/` to the stack's Traefik. Traefik applies `PathPrefix` rules and strips the `/plains` prefix before forwarding to each service.

---

## 1. `frontend/Dockerfile`

Add `VITE_BASE_PATH` and `VITE_RASA_SERVER_URL` as accepted build args alongside the existing `VITE_API_URL`:

```dockerfile
ARG VITE_API_URL
ARG VITE_RASA_SERVER_URL
ARG VITE_BASE_PATH
```

These are automatically picked up by Vite from the build environment.

---

## 2. `vite.config.ts`

Make the Vite asset base path configurable via an env variable so it defaults to `/` for local dev and uses `/plains/` in production builds:

```ts
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/',
  // ... rest unchanged
})
```

All bundled JS/CSS assets will be referenced from `/plains/assets/...` in production, which Traefik's strip-prefix middleware routes correctly.

---

## 3. `frontend/src/main.tsx`

Add a `basepath` to the TanStack Router so route matching is relative to `/plains`:

```ts
const router = createRouter({ routeTree, basepath: import.meta.env.BASE_URL })
```

`import.meta.env.BASE_URL` is set by Vite automatically from the `base` config option (`/plains/` in production, `/` locally). This avoids hardcoding the path.

---

## 4. `backend/app/core/config.py`

Add a `ROOT_PATH` setting so the FastAPI `root_path` is configurable per environment:

```python
ROOT_PATH: str = ""  # e.g. "/plains" for path-prefix deployments
```

---

## 5. `backend/app/main.py`

Pass `root_path` to FastAPI. This ensures the interactive docs (`/docs`) and OpenAPI redirect URLs include the full public path:

```python
app = FastAPI(
    title=settings.PROJECT_NAME,
    openapi_url=f"{settings.API_V1_STR}/openapi.json",
    generate_unique_id_function=custom_generate_unique_id,
    root_path=settings.ROOT_PATH,
)
```

---

## 6. `compose.yml` – Traefik labels

Replace all subdomain `Host()` routing with `Host() && PathPrefix()` routing, add strip-prefix middlewares, and remove TLS/certresolver labels (nginx handles TLS now).

### Shared strip middleware (define once, reuse)
Defined in the backend service labels (Traefik picks it up from any service):
```yaml
- traefik.http.middlewares.${STACK_NAME}-plains-strip.stripprefix.prefixes=/plains
```

### Backend labels
```yaml
- traefik.enable=true
- traefik.docker.network=traefik-public
- traefik.constraint-label=traefik-public
- traefik.http.services.${STACK_NAME}-backend.loadbalancer.server.port=8000
# Single HTTP router (nginx handles HTTPS)
- traefik.http.routers.${STACK_NAME}-backend.rule=Host(`${DOMAIN}`) && PathPrefix(`/plains/api`)
- traefik.http.routers.${STACK_NAME}-backend.entrypoints=http
- traefik.http.routers.${STACK_NAME}-backend.middlewares=${STACK_NAME}-plains-strip
```

### Frontend labels + build args
```yaml
build:
  args:
    - VITE_API_URL=https://${DOMAIN}/plains
    - VITE_RASA_SERVER_URL=https://${DOMAIN}/plains/chatbot
    - VITE_BASE_PATH=/plains/

labels:
  - traefik.enable=true
  - traefik.docker.network=traefik-public
  - traefik.constraint-label=traefik-public
  - traefik.http.services.${STACK_NAME}-frontend.loadbalancer.server.port=80
  - traefik.http.routers.${STACK_NAME}-frontend.rule=Host(`${DOMAIN}`) && PathPrefix(`/plains`)
  - traefik.http.routers.${STACK_NAME}-frontend.entrypoints=http
  - traefik.http.routers.${STACK_NAME}-frontend.middlewares=${STACK_NAME}-plains-strip
```

**Why strip prefix works for the frontend:** After stripping `/plains`, nginx receives `/` and `/assets/...`. Vite built the app with `base=/plains/`, so the HTML references `/plains/assets/app.js`. The browser requests `domain.com/plains/assets/app.js` → Traefik strips `/plains` → nginx serves `/assets/app.js` from disk. ✓

### Chatbot labels
The chatbot needs its own deeper strip prefix (`/plains/chatbot`):
```yaml
- traefik.http.middlewares.${STACK_NAME}-chatbot-strip.stripprefix.prefixes=/plains/chatbot
- traefik.http.services.${STACK_NAME}-chatbot.loadbalancer.server.port=5005
- traefik.http.routers.${STACK_NAME}-chatbot.rule=Host(`${DOMAIN}`) && PathPrefix(`/plains/chatbot`)
- traefik.http.routers.${STACK_NAME}-chatbot.entrypoints=http
- traefik.http.routers.${STACK_NAME}-chatbot.middlewares=${STACK_NAME}-chatbot-strip
```

### Adminer
Remove Traefik labels; access Adminer directly via SSH tunnel or a separate internal-only proxy. Alternatively keep it at a path:
```yaml
- traefik.http.routers.${STACK_NAME}-adminer.rule=Host(`${DOMAIN}`) && PathPrefix(`/plains/adminer`)
- traefik.http.routers.${STACK_NAME}-adminer.entrypoints=http
- traefik.http.middlewares.${STACK_NAME}-adminer-strip.stripprefix.prefixes=/plains/adminer
- traefik.http.routers.${STACK_NAME}-adminer.middlewares=${STACK_NAME}-adminer-strip
```

---

## 7. New `compose.path-proxy.yml` – Stack-internal Traefik for production

The existing `compose.traefik.yml` is for a standalone public Traefik (with TLS). For the path-routing deployment behind nginx, create a minimal stack-internal Traefik:

```yaml
# compose.path-proxy.yml
services:
  proxy:
    image: traefik:3.6
    ports:
      - "8001:80"      # nginx proxies to this port
    restart: always
    command:
      - --providers.docker
      - --providers.docker.constraints=Label(`traefik.constraint-label`, `traefik-public`)
      - --providers.docker.exposedbydefault=false
      - --entrypoints.http.address=:80
      - --accesslog
      - --log
    labels:
      - traefik.enable=true
      - traefik.constraint-label=traefik-public
      # Dummy middleware so existing labels referencing https-redirect don't break
      - traefik.http.middlewares.https-redirect.contenttype.autodetect=false
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock:ro
    networks:
      - traefik-public
      - default

networks:
  traefik-public:
    external: true
```

Deploy with:
```bash
docker compose -f compose.yml -f compose.path-proxy.yml up -d
```

---

## 8. External nginx configuration

Add to the server block for `domain.com` (after the existing TLS setup):

```nginx
location /plains/ {
    proxy_pass         http://127.0.0.1:8001/plains/;
    proxy_http_version 1.1;
    proxy_set_header   Host              $host;
    proxy_set_header   X-Real-IP         $remote_addr;
    proxy_set_header   X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header   X-Forwarded-Proto $scheme;
    proxy_set_header   Upgrade           $http_upgrade;
    proxy_set_header   Connection        "upgrade";  # needed for websockets (chatbot)
    proxy_read_timeout 300s;
}
```

**Note:** `proxy_pass` keeps the `/plains/` prefix so Traefik sees the full path and can apply its routing rules.

---

## 9. `.env` – Updated variables for production

```bash
DOMAIN=domain.com
ENVIRONMENT=production
FRONTEND_HOST=https://domain.com
BACKEND_CORS_ORIGINS=https://domain.com
ROOT_PATH=/plains
```

---

## 10. `compose.override.yml` – Local testing of the new routing

To test path routing locally (access at `http://localhost:81/plains/`), update the frontend section to use the local Traefik proxy and the new paths:

```yaml
frontend:
  restart: "no"
  ports:
    - "5173:80"
  build:
    args:
      - VITE_API_URL=http://localhost:81/plains
      - VITE_RASA_SERVER_URL=http://localhost:81/plains/chatbot
      - VITE_BASE_PATH=/plains/
      - NODE_ENV=development
```

Keep `DOMAIN=localhost` in `.env`. The override's local Traefik (port 81) applies the same path routing rules. Test at `http://localhost:81/plains/`.

> **Note for Playwright tests:** The playwright service uses `VITE_API_URL=http://backend:8000` (direct container access). Leave this unchanged so E2E tests still work without routing through Traefik.

---

## Change Summary

| File | Change |
|------|--------|
| `frontend/Dockerfile` | Add `ARG VITE_RASA_SERVER_URL` and `ARG VITE_BASE_PATH` |
| `vite.config.ts` | Add `base: process.env.VITE_BASE_PATH \|\| '/'` |
| `frontend/src/main.tsx` | Pass `basepath: import.meta.env.BASE_URL` to `createRouter` |
| `backend/app/core/config.py` | Add `ROOT_PATH: str = ""` |
| `backend/app/main.py` | Add `root_path=settings.ROOT_PATH` to `FastAPI(...)` |
| `compose.yml` | Replace subdomain labels with PathPrefix labels; update build args; remove TLS labels |
| `compose.path-proxy.yml` | **New file** — stack-internal Traefik on port 8001, HTTP only |
| `compose.override.yml` | Update frontend build args for local path-routing test |
| External nginx | Add `location /plains/` proxy block |
| `.env` (production) | Update `DOMAIN`, `FRONTEND_HOST`, `BACKEND_CORS_ORIGINS`, add `ROOT_PATH` |
