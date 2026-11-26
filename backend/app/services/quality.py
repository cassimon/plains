"""Deterministic scientific quality checks for JV measurement records.

Pure, side-effect-free functions. Findings are advisory: they help a researcher
notice questionable measurements but never auto-exclude anything. Ranges beyond
a *typical* perovskite cell are contextual warnings, not physical invalidity —
the only "invalid" findings are numerical non-finiteness and physically
impossible values (negative open-circuit voltage, fill factor outside 0–100%,
negative efficiency).
"""

import math

# Contextual (typical perovskite) ranges — warnings only, never exclusions.
# LabFlow's ranges are consulted critically: these are NOT universal validity
# limits and must not auto-exclude a measurement.
_VOC_MAX_TYPICAL = 2.0  # V
_JSC_MAX_TYPICAL = 50.0  # mA/cm² (absolute)
_FF_MAX_TYPICAL = 90.0  # %
_PCE_MAX_TYPICAL = 40.0  # %


def _finite(v: float | None) -> bool:
    return v is not None and math.isfinite(v)


def quality_findings(m: dict) -> list[dict]:
    """Return deterministic findings for a single measurement.

    ``m`` is a plain dict with at least ``file_type`` and the JV metrics
    ``voc``, ``jsc``, ``ff`` and ``value`` (PCE). Non-JV records produce no
    findings (JV-specific rules are never applied to other types).
    """
    file_type = (m.get("file_type") or "").upper()
    if file_type != "JV":
        return []

    findings: list[dict] = []

    def add(severity: str, metric: str, message: str, value) -> None:
        findings.append(
            {"severity": severity, "metric": metric, "message": message, "value": value}
        )

    voc = m.get("voc")
    jsc = m.get("jsc")
    ff = m.get("ff")
    pce = m.get("value")

    # Missing information (never treated as zero).
    for metric, value in (("Voc", voc), ("Jsc", jsc), ("FF", ff), ("PCE", pce)):
        if value is None:
            add("missing", metric, f"{metric} is missing", None)

    # Non-finite values are numerically invalid, whatever the context.
    for metric, value in (("Voc", voc), ("Jsc", jsc), ("FF", ff), ("PCE", pce)):
        if value is not None and not math.isfinite(value):
            add("invalid", metric, f"{metric} is non-finite", value)

    # Physically impossible values.
    if _finite(voc) and voc < 0:
        add("invalid", "Voc", "Negative open-circuit voltage", voc)
    if _finite(ff) and (ff < 0 or ff > 100):
        add("invalid", "FF", "Fill factor outside 0–100%", ff)
    if _finite(pce) and pce < 0:
        add("invalid", "PCE", "Negative efficiency", pce)

    # Contextual warnings (typical perovskite range) — advisory only.
    if _finite(voc) and voc > _VOC_MAX_TYPICAL:
        add("warning", "Voc", f"Voc above typical range (> {_VOC_MAX_TYPICAL} V)", voc)
    if _finite(jsc) and jsc < 0:
        add("warning", "Jsc", "Negative Jsc — check sign convention", jsc)
    if _finite(jsc) and abs(jsc) > _JSC_MAX_TYPICAL:
        add(
            "warning",
            "Jsc",
            f"|Jsc| above typical range (> {_JSC_MAX_TYPICAL} mA/cm²)",
            jsc,
        )
    if _finite(ff) and ff > _FF_MAX_TYPICAL:
        add("warning", "FF", f"FF above typical range (> {_FF_MAX_TYPICAL}%)", ff)
    if _finite(pce) and pce > _PCE_MAX_TYPICAL:
        add("warning", "PCE", f"PCE above typical range (> {_PCE_MAX_TYPICAL}%)", pce)

    return findings


def summary(findings_by_measurement: list[list[dict]]) -> dict:
    """Aggregate per-measurement findings into a compact summary."""
    total = 0
    by_severity: dict[str, int] = {}
    for findings in findings_by_measurement:
        for f in findings:
            total += 1
            by_severity[f["severity"]] = by_severity.get(f["severity"], 0) + 1
    return {"total": total, "by_severity": by_severity}
