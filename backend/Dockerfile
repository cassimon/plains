FROM python:3.10

ENV PYTHONUNBUFFERED=1

# Install uv
# Ref: https://docs.astral.sh/uv/guides/integration/docker/#installing-uv
COPY --from=ghcr.io/astral-sh/uv:0.9.26 /uv /uvx /bin/

# Compile bytecode
# Ref: https://docs.astral.sh/uv/guides/integration/docker/#compiling-bytecode
ENV UV_COMPILE_BYTECODE=1

# uv Cache
# Ref: https://docs.astral.sh/uv/guides/integration/docker/#caching
ENV UV_LINK_MODE=copy

WORKDIR /app/

# Place executables in the environment at the front of the path
# Ref: https://docs.astral.sh/uv/guides/integration/docker/#using-the-environment
ENV PATH="/app/.venv/bin:$PATH"

# Install dependencies
# Ref: https://docs.astral.sh/uv/guides/integration/docker/#intermediate-layers
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --no-install-workspace --package app

COPY ./backend/scripts /app/backend/scripts

COPY ./backend/pyproject.toml ./backend/alembic.ini /app/backend/

COPY ./backend/app /app/backend/app

# Sync the project
# Ref: https://docs.astral.sh/uv/guides/integration/docker/#intermediate-layers
RUN --mount=type=cache,target=/root/.cache/uv \
    --mount=type=bind,source=uv.lock,target=uv.lock \
    --mount=type=bind,source=pyproject.toml,target=pyproject.toml \
    uv sync --frozen --package app

WORKDIR /app/backend/

# Create an unprivileged user and give it ownership of the writable NOMAD stash
# dir. A freshly-created `nomad-stash` named volume inherits this owner/perms on
# first mount, so the non-root process can write to it. (The temp upload dir
# lives under /tmp, which is world-writable, so it needs no special handling.)
RUN groupadd -r appuser && useradd -r -g appuser appuser \
    && mkdir -p /var/lib/plains/nomad_stash \
    && chown -R appuser:appuser /var/lib/plains

# Run as root by default so the dev stack — which bind-mounts host-owned source
# into /app/backend for hot-reload — keeps write access. Production opts into the
# non-root user via compose.prod.yml: `build.args: { RUN_AS_USER: appuser }`.
ARG RUN_AS_USER=root
USER ${RUN_AS_USER}

CMD ["fastapi", "run", "--workers", "4", "app/main.py"]
