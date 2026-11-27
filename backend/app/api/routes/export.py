"""Local scientific export — a single ZIP for an owned experiment.

Produces a self-contained, reviewable archive of the *accepted* scientific
dataset plus its durable provenance: effective (corrected) measurements, raw
curve points, correction history, a manifest of units/provenance/exclusions, and
the unchanged original source files. Excluded observations are documented in the
manifest but never appear in the accepted measurement/curve tables.
"""

import csv
import io
import json
import uuid
import zipfile
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException
from fastapi.responses import Response
from sqlmodel import select

from app.api.deps import CurrentUser, SessionDep
from app.models import (
    Experiment,
    ExperimentResults,
    ImportedSourceFile,
    MeasurementCorrection,
)
from app.services import source_store

router = APIRouter(prefix="/export", tags=["export"])

# JV metric → unit. Non-JV records do not carry these quantities (their `value`
# column is left blank and never labelled as PCE).
UNITS = {
    "voc": "Voc (V)",
    "jsc": "Jsc (mA/cm²)",
    "ff": "FF (%)",
    "vmpp": "Vmpp (V)",
    "jmpp": "Jmpp (mA/cm²)",
    "pmpp": "Pmpp (mW/cm²)",
    "rs": "Rs (Ω)",
    "rsh": "Rsh (Ω)",
}

MEASUREMENT_HEADER = [
    "id",
    "device_name",
    "file_name",
    "file_type",
    "direction",
    "value",
    "voc_v",
    "jsc_ma_cm2",
    "ff_percent",
    "vmpp_v",
    "jmpp_ma_cm2",
    "pmpp_mw_cm2",
    "rs_ohm",
    "rsh_ohm",
    "illumination_mw_cm2",
    "source_file_id",
    "source_record_locator",
]

_JV = "JV"


def _owned_experiment(
    session: SessionDep, current_user: CurrentUser, experiment_id: uuid.UUID
) -> Experiment:
    experiment = session.get(Experiment, experiment_id)
    if not experiment:
        raise HTTPException(status_code=404, detail="Experiment not found")
    if not current_user.is_superuser and experiment.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return experiment


def _safe_arcname(name: str, used: set[str], fallback: str) -> str:
    """A collision-free, traversal-safe basename for a stored source file."""
    base = (name or "").replace("\\", "/").rstrip("/").split("/")[-1]
    base = "".join(c for c in base if c not in ('"', "\x00") and ord(c) >= 32)
    if not base:
        base = fallback
    candidate = base
    n = 1
    while candidate in used:
        stem, _, ext = base.rpartition(".")
        candidate = f"{stem or base}_{n}.{ext}" if ext else f"{base}_{n}"
        n += 1
    used.add(candidate)
    return f"originals/{candidate}"


def _csv_text(header: list[str], rows: list[list[Any]]) -> str:
    buf = io.StringIO()
    writer = csv.writer(buf)
    writer.writerow(header)
    for row in rows:
        writer.writerow(["" if v is None else v for v in row])
    return buf.getvalue()


@router.get("/experiments/{experiment_id}")
def export_experiment_zip(
    session: SessionDep,
    current_user: CurrentUser,
    experiment_id: uuid.UUID,
) -> Response:
    """Download a local scientific ZIP export for an owned experiment."""
    experiment = _owned_experiment(session, current_user, experiment_id)

    results = session.exec(
        select(ExperimentResults).where(
            ExperimentResults.experiment_id == experiment_id,
            ExperimentResults.owner_id == current_user.id,
        )
    ).all()

    measurements: list[Any] = []
    for r in results:
        measurements.extend(r.measurement_files)

    measurement_ids = [m.id for m in measurements]
    corrections = session.exec(
        select(MeasurementCorrection)
        .where(MeasurementCorrection.measurement_id.in_(measurement_ids))
        .order_by(MeasurementCorrection.created_at)
    ).all() if measurement_ids else []

    # All durable originals for the experiment — including retained originals
    # whose measurements were explicitly removed (sources are experiment-scoped).
    sources = session.exec(
        select(ImportedSourceFile)
        .where(ImportedSourceFile.experiment_id == experiment_id)
        .order_by(ImportedSourceFile.created_at)
    ).all()

    if not measurements and not sources:
        raise HTTPException(status_code=404, detail="No measurements to export")

    accepted = [m for m in measurements if m.excluded is not True]
    excluded = [m for m in measurements if m.excluded is True]

    # measurements.csv — effective (corrected) accepted scalar metrics. `value`
    # is populated only for JV records (never labelled as PCE for other types).
    meas_rows: list[list[Any]] = []
    for m in accepted:
        is_jv = (m.file_type or "").upper() == _JV
        meas_rows.append(
            [
                str(m.id),
                m.device_name,
                m.filename,
                m.file_type,
                m.direction,
                m.value if is_jv else None,
                m.voc if is_jv else None,
                m.jsc if is_jv else None,
                m.ff if is_jv else None,
                m.vmpp if is_jv else None,
                m.jmpp if is_jv else None,
                m.pmpp if is_jv else None,
                m.rs if is_jv else None,
                m.rsh if is_jv else None,
                m.illumination_intensity if is_jv else None,
                str(m.source_file_id) if m.source_file_id else None,
                m.source_record_locator,
            ]
        )

    # curves.csv — original curve points for accepted observations, in order.
    curve_rows: list[list[Any]] = []
    for m in accepted:
        for point in m.curve or []:
            curve_rows.append([str(m.id), point.get("v"), point.get("j")])

    # corrections.csv — traceable history, no personal information.
    corr_rows: list[list[Any]] = [
        [
            str(c.measurement_id),
            c.field,
            c.operation,
            c.previous_value,
            c.new_value,
            c.reason,
            c.created_at.isoformat() if c.created_at else None,
        ]
        for c in corrections
    ]

    buf = io.BytesIO()
    used: set[str] = set()
    source_entries: list[dict[str, Any]] = []
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("measurements.csv", _csv_text(MEASUREMENT_HEADER, meas_rows))
        zf.writestr(
            "curves.csv",
            _csv_text(["measurement_id", "voltage_v", "current_density_ma_cm2"], curve_rows),
        )
        zf.writestr(
            "corrections.csv",
            _csv_text(
                [
                    "measurement_id",
                    "field",
                    "operation",
                    "previous_value",
                    "new_value",
                    "reason",
                    "created_at",
                ],
                corr_rows,
            ),
        )
        for s in sources:
            if not source_store.source_exists(str(s.id)):
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"Original source {s.original_filename!r} is missing; "
                        "the export cannot be completed."
                    ),
                )
            data = source_store.read_source(str(s.id))
            if source_store.sha256_hex(data) != s.sha256:
                raise HTTPException(
                    status_code=409,
                    detail=(
                        f"Original source {s.original_filename!r} is corrupted "
                        "(SHA-256 mismatch); the export cannot be completed."
                    ),
                )
            arcname = _safe_arcname(s.original_filename, used, str(s.id))
            zf.writestr(arcname, data)
            source_entries.append(
                {
                    "id": str(s.id),
                    "original_filename": s.original_filename,
                    "archive_member": arcname,
                    "size": s.size,
                    "sha256": s.sha256,
                    "file_type": s.file_type,
                }
            )

    manifest = {
        "experiment_id": str(experiment_id),
        "experiment_name": experiment.name,
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "units": UNITS,
        "note": (
            "JV metric units (voc/jsc/ff/vmpp/jmpp/pmpp/rs/rsh) apply only to JV "
            "records; the `value` column is populated for JV records only."
        ),
        "measurement_count": len(accepted),
        "excluded_count": len(excluded),
        "excluded_measurements": [
            {
                "id": str(m.id),
                "file_name": m.filename,
                "device_name": m.device_name,
            }
            for m in excluded
        ],
        "source_files": source_entries,
        "correction_count": len(corrections),
        "complete": True,
    }
    with zipfile.ZipFile(buf, "a", zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("manifest.json", json.dumps(manifest, indent=2))

    zip_bytes = buf.getvalue()
    filename = f"{experiment.name or 'experiment'}-export.zip"
    ascii_name = filename.encode("ascii", "ignore").decode("ascii") or "export.zip"
    ascii_name = ascii_name.replace('"', "").replace("\\", "_").strip()

    return Response(
        content=zip_bytes,
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{ascii_name}"'},
    )
