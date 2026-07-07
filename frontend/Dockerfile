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


# Stage 1, based on Nginx, to have only the compiled app, ready for production with Nginx
FROM nginx:1

COPY --from=build-stage /app/frontend/dist/ /usr/share/nginx/html

COPY ./frontend/nginx.conf /etc/nginx/conf.d/default.conf
COPY ./frontend/nginx-backend-not-found.conf /etc/nginx/extra-conf.d/backend-not-found.conf
