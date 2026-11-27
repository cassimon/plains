# Plains

Plains is a lab-management application for perovskite solar-cell research. It records the
full experiment workflow — materials, solutions, fabrication processes, experiments and
measurement results — and prepares research data for deposition in
[NOMAD](https://nomad-lab.eu/).

## What it does

- **Organize work on a canvas.** Planes and collections hold processes, experiments and
  results in a shareable visual layout.
- **Plan fabrication as processes.** Define solution chemistry, substrate preparation and
  wet-deposition steps (with alternative steps), then generate experiments from them.
- **Ingest measurement data.** Drop individual instrument files, extracted directories, or
  ZIP archives; Plains parses forward/reverse JV scans, groups them by device, and keeps the
  original files for provenance.
- **Review and correct results.** Inspect JV metrics and curves, correct or exclude
  measurements with a traceable history, and view descriptive statistics, group comparisons,
  correlation and hysteresis analysis.
- **Prepare for NOMAD.** Build a NOMAD archive locally, preview its YAML metadata, and upload
  it — with a mock mode for isolated testing and a durable upload log for real deployments.
- **Export locally.** Download one experiment's accepted dataset as a self-contained ZIP
  (measurements, raw curves, correction history, manifest and unchanged originals).

## Quick start

```bash
# Copy and fill the environment file (SECRET_KEY, POSTGRES_PASSWORD, FIRST_SUPERUSER_PASSWORD)
cp .env.example .env

# Start the stack
docker compose up -d --wait
```

| Service | URL |
|---|---|
| Frontend | http://localhost:5173 |
| Backend API | http://localhost:8000 |
| Swagger UI | http://localhost:8000/docs |
| Adminer (database) | http://localhost:8080 |
| Mailcatcher | http://localhost:1080 |
| Traefik UI | http://localhost:8090 |

## Documentation

| Document | Contents |
|---|---|
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | System architecture, repository structure, entry points, data model and relationships. |
| [docs/SCIENTIFIC.md](docs/SCIENTIFIC.md) | Scientific data flow: designed and imported workflows, ZIP parsing, measurement identity, provenance, corrections, JV metrics and analysis formulas, local export. |
| [docs/NOMAD.md](docs/NOMAD.md) | NOMAD preparation, prerequisites, upload behavior, and genuine compatibility limitations. |
| [docs/OPERATIONS.md](docs/OPERATIONS.md) | Development, Docker configuration, test isolation, backup and restore, and extension guidance. |
| [docs/USER_GUIDE.md](docs/USER_GUIDE.md) | User-facing guide to the application. |
| [docs/UI_GUIDELINES.md](docs/UI_GUIDELINES.md) | Frontend UI architecture and conventions for developers. |
| [docs/nomad-upload-debugging.md](docs/nomad-upload-debugging.md) | How to debug NOMAD uploads (admin log, statuses, archive retention). |
| [AGENTS.md](AGENTS.md) | Repository conventions, non-regression and data-safety policy for coding agents. |

## Technology

FastAPI (Python) + React (TypeScript) + PostgreSQL, deployed with Docker Compose. The frontend
generates its API client from the backend OpenAPI schema. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

## Attribution

Plains is built on the
[Full Stack FastAPI Template](https://github.com/fastapi/full-stack-fastapi-template)
by Sebastián Ramírez. Licensed under the MIT License — see [LICENSE](LICENSE).
