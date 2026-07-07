# Debugging NOMAD Uploads

Every NOMAD upload is logged, and any upload that doesn't succeed keeps its file
archive for **one week** so it can be re-examined. Admins get a central log;
uploaders see the failure reason on the Results page.

## Quick reference

| I want to… | Do this |
|---|---|
| See why *my* upload failed | Open the experiment's **Results** page → NOMAD panel shows status + error. |
| See *all* uploads and outcomes | Superuser → **Admin** → **NOMAD Uploads** tab. |
| Get the exact files that failed | Click **Archive** on the failed row (available for 1 week). |
| Retry | Fix the data, re-run the upload from Results. |

## Statuses

| Status | Meaning | Archive kept? |
|---|---|---|
| `PENDING` | Accepted, still processing (or not yet polled). | Yes |
| `SUCCESS` | Processed OK. | No (purged) |
| `FAILED` | NOMAD reported a processing failure. | Yes |
| `NOT_FOUND` | Upload was deleted on NOMAD. | Yes |
| `ERROR` | Never reached NOMAD (auth/connection/bad archive). | Yes, if one was built |

The verdict isn't known at upload time — NOMAD returns `PENDING` first. The
**Results-page poll** (every 5 s while open) refreshes the status and updates the
log row. On `SUCCESS` the stash is deleted; on failure it's kept with NOMAD's
error notes, capped at one week (`NOMAD_STASH_MAX_AGE_S`).

## Admin log (NOMAD Uploads tab)

Newest-first table of every attempt: **User** (email) · **Experiment** ·
**Status** (colour-coded) · **Uploaded** · **Detail** (NOMAD's error/status,
hover for full text) · **Archive** (download the exact zip sent to NOMAD; shown
only while still stashed).

## Debugging workflow

1. Find the row (Admin → NOMAD Uploads).
2. Read **Detail** — NOMAD's own message. Common causes: schema/parser errors in
   `*.archive.yaml`, a missing mainfile (referenced file not in the zip), or
   auth/connection (`ERROR`).
3. **Download the archive** to inspect exactly what was sent:
   ```bash
   unzip failed_upload.zip -d ./inspect
   # every ../upload/raw/<name> referenced in a .archive.yaml must exist in the zip:
   grep -R "\.\./upload/raw/" ./inspect/*.archive.yaml
   ```
4. Fix the source data in the app and re-run the upload.

## API (superuser)

- `GET /api/v1/nomad/upload-log?skip&limit` → `{ data: [...], count }`. Each row
  includes `status`, `error_message`, full `errors`/`warnings`, `entries_count`/
  `processing_failed`, `archive_available`, `archive_expires_at`.
- `GET /api/v1/nomad/upload-log/{log_id}/archive` → the zip (`404` if purged/expired).

## Operations

- Stash: `NOMAD_STASH_DIR` (default `/var/lib/plains/nomad_stash`), on the
  `nomad-stash` Docker volume (survives restarts).
- Retention: `NOMAD_STASH_MAX_AGE_S` (default 7 days); swept opportunistically on
  NOMAD endpoint activity — no cron.
- Table `nomad_upload_log`; apply with `alembic upgrade head`.
- Code: routes in `app/api/routes/nomad.py`, helpers in `app/services/nomad.py`
  + `app/crud.py`; admin UI in `frontend/src/routes/_layout/admin.tsx` +
  `components/Admin/nomadUploadColumns.tsx`.

## FAQ

- **Stuck on `PENDING`** — nobody has polled it. Open that experiment's Results
  page (it polls and resolves), or wait for the TTL sweep.
- **Archive button missing** — retention expired or volume cleared; the row stays
  as history but the file is gone. Re-run to capture a fresh archive.
- **No row for a reported failure** — pure client-side/validation errors never
  reach the endpoint; check `docker compose logs backend`.
- **All `ERROR`** — upload never reached NOMAD; verify config via
  `POST /api/v1/nomad/auth/test`.
