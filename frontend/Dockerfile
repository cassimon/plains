# Stage 0, "build-stage", based on Bun, to build and compile the frontend
FROM oven/bun:1 AS build-stage

WORKDIR /app

COPY package.json bun.lock /app/
# bun patchedDependencies (e.g. the @mantine/core ScrollArea ref fix) must be
# present before `bun install` or the install fails.
COPY patches /app/patches

COPY frontend/package.json /app/frontend/

WORKDIR /app/frontend

RUN bun install

COPY ./frontend /app/frontend
ARG VITE_API_URL
ARG VITE_BASE_PATH
ARG VITE_ENABLE_TEST_AUTH
ENV VITE_API_URL=${VITE_API_URL}
ENV VITE_BASE_PATH=${VITE_BASE_PATH}
ENV VITE_ENABLE_TEST_AUTH=${VITE_ENABLE_TEST_AUTH}

RUN bun run build


# Production runtime: non-root nginx. `nginxinc/nginx-unprivileged` runs as
# UID 101 and therefore cannot bind ports <1024, so it serves on 8080 (its
# default). Selected only by compose.prod.yml via `target: runtime-unprivileged`;
# keep the host port mapping there in sync (127.0.0.1:9000:8080). This stage is
# NOT last, so it is skipped unless explicitly targeted.
FROM nginxinc/nginx-unprivileged:1 AS runtime-unprivileged
# Root only for the build-time file ops; the base image's final USER (101) is
# restored below so the running container is non-root.
USER root
COPY --from=build-stage /app/frontend/dist/ /usr/share/nginx/html
COPY ./frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY ./frontend/nginx-backend-not-found.conf /etc/nginx/extra-conf.d/backend-not-found.conf
# Non-root can't bind 80 — serve on 8080 to match the unprivileged image.
RUN sed -i 's/listen 80;/listen 8080;/' /etc/nginx/conf.d/default.conf
USER 101


# Stage 1 (default/last), based on Nginx, ready for production with Nginx.
# Runs as root (master) on :80 — used by the dev stack and the Traefik model,
# matching the upstream template. compose.prod.yml overrides to the non-root
# stage above.
FROM nginx:1 AS runtime

COPY --from=build-stage /app/frontend/dist/ /usr/share/nginx/html

COPY ./frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY ./frontend/nginx-backend-not-found.conf /etc/nginx/extra-conf.d/backend-not-found.conf
