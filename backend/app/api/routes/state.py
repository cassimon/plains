import json
import logging
import uuid as _uuid
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from sqlalchemy.orm.attributes import flag_modified
from sqlmodel import select

from app.api.deps import CurrentUser, SessionDep
from app.models import (
    UserState,
    UserStatePublic,
    BulkStateResponse,
    Material,
    Solution,
    SolutionComponent,
    Experiment,
    ExperimentLayer,
    Substrate,
    ExperimentResults,
    MeasurementFile,
    DeviceGroup,
    Plane,
    CanvasElement,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/state", tags=["state"])


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _uuid_or_gen(raw: str | None) -> _uuid.UUID:
    """Parse a UUID string, or generate a new one if invalid/missing."""
    if raw:
        try:
            return _uuid.UUID(raw)
        except (ValueError, AttributeError):
            pass
    return _uuid.uuid4()


def _safe_float(val: Any, default: float = 0.0) -> float:
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


# ---------------------------------------------------------------------------
# GET /state/ — read state from normalised tables
# ---------------------------------------------------------------------------

@router.get("/", response_model=UserStatePublic)
def read_state(session: SessionDep, current_user: CurrentUser) -> Any:
    """Reconstruct the full AppSnapshot from normalised tables."""
    uid = current_user.id

    # --- Materials ---
    materials_db = session.exec(select(Material).where(Material.owner_id == uid)).all()
    materials_out = []
    for m in materials_db:
        if m.frontend_data:
            materials_out.append(m.frontend_data)
        else:
            materials_out.append({
                "id": str(m.id), "type": "", "name": m.name,
                "supplier": m.supplier or "", "supplierNumber": "",
                "casNumber": m.cas_number or "", "pubchemCid": "",
                "inventoryLabel": "", "purity": "",
            })

    # --- Solutions ---
    solutions_db = session.exec(select(Solution).where(Solution.owner_id == uid)).all()
    solutions_out = []
    for s in solutions_db:
        if s.frontend_data:
            solutions_out.append(s.frontend_data)
        else:
            solutions_out.append({
                "id": str(s.id), "name": s.name, "components": [],
            })

    # --- Experiments ---
    experiments_db = session.exec(select(Experiment).where(Experiment.owner_id == uid)).all()
    experiments_out = []
    for e in experiments_db:
        if e.frontend_data:
            experiments_out.append(e.frontend_data)
        else:
            experiments_out.append({
                "id": str(e.id), "name": e.name, "description": e.description or "",
                "date": (e.created_at or datetime.now(timezone.utc)).strftime("%Y-%m-%d"),
                "architecture": "n-i-p", "substrateMaterial": "",
                "substrateWidth": 2.5, "substrateLength": 2.5,
                "numSubstrates": 1, "devicesPerSubstrate": 4,
                "deviceArea": e.active_area_cm2 or 0.09,
                "deviceType": e.device_type or "film",
                "layers": [], "substrates": [], "hasResults": False,
            })

    # --- Results ---
    results_db = session.exec(select(ExperimentResults).where(ExperimentResults.owner_id == uid)).all()
    results_out = []
    for r in results_db:
        if r.frontend_data:
            results_out.append(r.frontend_data)
        else:
            results_out.append({
                "id": str(r.id), "experimentId": str(r.experiment_id),
                "files": [], "deviceGroups": [],
                "groupingStrategy": "search", "matchingStrategy": "fuzzy",
                "updatedAt": (r.created_at or datetime.now(timezone.utc)).isoformat(),
            })

    # --- Planes + Elements ---
    planes_db = session.exec(select(Plane).where(Plane.owner_id == uid)).all()
    planes_out = []
    for p in planes_db:
        if p.frontend_data:
            planes_out.append(p.frontend_data)
        else:
            elems = []
            for el in p.elements:
                if el.frontend_data:
                    elems.append(el.frontend_data)
                else:
                    elems.append({
                        "id": str(el.id), "type": el.element_type or "text",
                        "position": {"x": el.x, "y": el.y},
                        "size": {"x": el.width, "y": el.height},
                        "content": el.content or "", "color": el.color,
                    })
            planes_out.append({"id": str(p.id), "name": p.name, "elements": elems})

    data = {
        "materials": materials_out,
        "solutions": solutions_out,
        "experiments": experiments_out,
        "results": results_out,
        "planes": planes_out,
    }

    logger.info(
        "GET /state/ user=%s — materials=%d solutions=%d experiments=%d "
        "results=%d planes=%d",
        uid, len(materials_out), len(solutions_out), len(experiments_out),
        len(results_out), len(planes_out),
    )

    # Also fetch updated_at from the UserState row (if any)
    us = session.exec(select(UserState).where(UserState.owner_id == uid)).first()
    updated_at = us.updated_at if us else None

    return UserStatePublic(data=data, updated_at=updated_at)


# ---------------------------------------------------------------------------
# PUT /state/ — sync AppSnapshot into normalised tables
# ---------------------------------------------------------------------------

@router.put("/", response_model=UserStatePublic)
def update_state(
    session: SessionDep, current_user: CurrentUser, *, body: UserStatePublic
) -> Any:
    """
    Persist the full AppSnapshot into normalised tables.

    Strategy per entity type: upsert (insert or update) every item in the
    incoming snapshot, then delete any DB rows whose IDs are no longer present.
    """
    uid = current_user.id
    data = body.data or {}

    logger.info(
        "PUT /state/ user=%s — materials=%d solutions=%d experiments=%d "
        "results=%d planes=%d",
        uid,
        len(data.get("materials", [])),
        len(data.get("solutions", [])),
        len(data.get("experiments", [])),
        len(data.get("results", [])),
        len(data.get("planes", [])),
    )

    try:
        return _do_sync(session, uid, data)
    except Exception:
        logger.exception("PUT /state/ user=%s — sync failed", uid)
        session.rollback()
        return JSONResponse(
            status_code=500,
            content={"detail": "State sync failed. Check server logs."},
        )


def _do_sync(session: SessionDep, uid: _uuid.UUID, data: dict) -> UserStatePublic:
    # ------------------------------------------------------------------
    # 1. Materials
    # ------------------------------------------------------------------
    incoming_materials = data.get("materials", [])
    incoming_mat_ids: set[_uuid.UUID] = set()

    existing_mats = {
        m.id: m
        for m in session.exec(select(Material).where(Material.owner_id == uid)).all()
    }

    for m_data in incoming_materials:
        mid = _uuid_or_gen(m_data.get("id"))
        incoming_mat_ids.add(mid)
        if mid in existing_mats:
            mat = existing_mats[mid]
            mat.name = m_data.get("name") or mat.name
            mat.cas_number = m_data.get("casNumber") or m_data.get("cas_number")
            mat.supplier = m_data.get("supplier")
            mat.frontend_data = m_data
            flag_modified(mat, "frontend_data")
            session.add(mat)
        else:
            mat = Material(
                id=mid,
                owner_id=uid,
                name=m_data.get("name", ""),
                cas_number=m_data.get("casNumber") or m_data.get("cas_number"),
                supplier=m_data.get("supplier"),
                frontend_data=m_data,
            )
            session.add(mat)

    # Delete materials no longer in the snapshot
    for old_id in set(existing_mats) - incoming_mat_ids:
        session.delete(existing_mats[old_id])

    # Flush so material rows exist for FK references from solution components
    session.flush()

    # ------------------------------------------------------------------
    # 2. Solutions (with components)
    # ------------------------------------------------------------------
    incoming_solutions = data.get("solutions", [])
    incoming_sol_ids: set[_uuid.UUID] = set()

    existing_sols = {
        s.id: s
        for s in session.exec(select(Solution).where(Solution.owner_id == uid)).all()
    }

    for s_data in incoming_solutions:
        sid = _uuid_or_gen(s_data.get("id"))
        incoming_sol_ids.add(sid)
        if sid in existing_sols:
            sol = existing_sols[sid]
            sol.name = s_data.get("name") or sol.name
            sol.frontend_data = s_data
            flag_modified(sol, "frontend_data")
            session.add(sol)
        else:
            sol = Solution(
                id=sid,
                owner_id=uid,
                name=s_data.get("name", ""),
                frontend_data=s_data,
            )
            session.add(sol)
        session.flush()  # ensure solution row exists for FK
        _sync_solution_components(session, sid, s_data.get("components", []))

    for old_id in set(existing_sols) - incoming_sol_ids:
        session.delete(existing_sols[old_id])

    # ------------------------------------------------------------------
    # 3. Experiments (with layers + substrates)
    # ------------------------------------------------------------------
    incoming_experiments = data.get("experiments", [])
    incoming_exp_ids: set[_uuid.UUID] = set()

    existing_exps = {
        e.id: e
        for e in session.exec(select(Experiment).where(Experiment.owner_id == uid)).all()
    }

    for e_data in incoming_experiments:
        eid = _uuid_or_gen(e_data.get("id"))
        incoming_exp_ids.add(eid)
        if eid in existing_exps:
            exp = existing_exps[eid]
            exp.name = e_data.get("name") or exp.name
            exp.description = e_data.get("description")
            exp.device_type = e_data.get("deviceType") or e_data.get("device_type")
            exp.active_area_cm2 = _safe_float(e_data.get("deviceArea") or e_data.get("active_area_cm2"))
            exp.frontend_data = e_data
            flag_modified(exp, "frontend_data")
            session.add(exp)
        else:
            exp = Experiment(
                id=eid,
                owner_id=uid,
                name=e_data.get("name", ""),
                description=e_data.get("description"),
                device_type=e_data.get("deviceType") or e_data.get("device_type"),
                active_area_cm2=_safe_float(e_data.get("deviceArea") or e_data.get("active_area_cm2")),
                frontend_data=e_data,
            )
            session.add(exp)
        session.flush()  # ensure eid exists for FK
        _sync_experiment_layers(session, eid, e_data.get("layers", []))
        _sync_experiment_substrates(session, eid, e_data.get("substrates", []))

    for old_id in set(existing_exps) - incoming_exp_ids:
        session.delete(existing_exps[old_id])

    # ------------------------------------------------------------------
    # 4. Results
    # ------------------------------------------------------------------
    incoming_results = data.get("results", [])
    incoming_res_ids: set[_uuid.UUID] = set()

    existing_res = {
        r.id: r
        for r in session.exec(select(ExperimentResults).where(ExperimentResults.owner_id == uid)).all()
    }

    for r_data in incoming_results:
        rid = _uuid_or_gen(r_data.get("id"))
        exp_id_str = r_data.get("experimentId") or r_data.get("experiment_id")
        exp_id = _uuid_or_gen(exp_id_str)
        incoming_res_ids.add(rid)
        if rid in existing_res:
            res = existing_res[rid]
            res.experiment_id = exp_id
            res.frontend_data = r_data
            flag_modified(res, "frontend_data")
            session.add(res)
        else:
            res = ExperimentResults(
                id=rid,
                owner_id=uid,
                experiment_id=exp_id,
                frontend_data=r_data,
            )
            session.add(res)

    for old_id in set(existing_res) - incoming_res_ids:
        session.delete(existing_res[old_id])

    # ------------------------------------------------------------------
    # 5. Planes + CanvasElements
    # ------------------------------------------------------------------
    incoming_planes = data.get("planes", [])
    incoming_plane_ids: set[_uuid.UUID] = set()

    existing_planes = {
        p.id: p
        for p in session.exec(select(Plane).where(Plane.owner_id == uid)).all()
    }

    for p_data in incoming_planes:
        pid = _uuid_or_gen(p_data.get("id"))
        incoming_plane_ids.add(pid)
        if pid in existing_planes:
            plane = existing_planes[pid]
            plane.name = p_data.get("name") or plane.name
            plane.frontend_data = p_data
            flag_modified(plane, "frontend_data")
            session.add(plane)
        else:
            plane = Plane(
                id=pid,
                owner_id=uid,
                name=p_data.get("name", "Plane"),
                frontend_data=p_data,
            )
            session.add(plane)
        session.flush()  # ensure pid exists for FK
        _sync_canvas_elements(session, pid, p_data.get("elements", []))

    for old_id in set(existing_planes) - incoming_plane_ids:
        session.delete(existing_planes[old_id])

    # ------------------------------------------------------------------
    # 6. Persist the JSON blob too (backwards-compat + timestamp)
    # ------------------------------------------------------------------
    us = session.exec(select(UserState).where(UserState.owner_id == uid)).first()
    now = datetime.now(timezone.utc)
    if us:
        us.data = data
        us.updated_at = now
        flag_modified(us, "data")
        session.add(us)
    else:
        us = UserState(owner_id=uid, data=data)
        session.add(us)

    session.commit()

    logger.info("PUT /state/ user=%s — sync complete", uid)

    return UserStatePublic(data=data, updated_at=now)


# ---------------------------------------------------------------------------
# Sync helpers for child tables
# ---------------------------------------------------------------------------

def _sync_solution_components(
    session: SessionDep, solution_id: _uuid.UUID, components: list[dict],
) -> None:
    existing = {
        c.id: c
        for c in session.exec(
            select(SolutionComponent).where(SolutionComponent.solution_id == solution_id)
        ).all()
    }
    incoming_ids: set[_uuid.UUID] = set()
    for c_data in components:
        cid = _uuid_or_gen(c_data.get("id"))
        incoming_ids.add(cid)
        mat_id_str = c_data.get("materialId") or c_data.get("material_id")
        if not mat_id_str:
            # No material selected yet — skip normalised row
            continue
        try:
            mat_id = _uuid.UUID(mat_id_str)
        except (ValueError, AttributeError):
            continue
        if cid in existing:
            comp = existing[cid]
            comp.amount = _safe_float(c_data.get("amount"))
            comp.unit = c_data.get("unit", "mg")
            comp.material_id = mat_id
            session.add(comp)
        else:
            comp = SolutionComponent(
                id=cid,
                solution_id=solution_id,
                amount=_safe_float(c_data.get("amount")),
                unit=c_data.get("unit", "mg"),
                material_id=mat_id,
            )
            session.add(comp)
    for old_id in set(existing) - incoming_ids:
        session.delete(existing[old_id])


def _sync_experiment_layers(
    session: SessionDep, experiment_id: _uuid.UUID, layers: list[dict],
) -> None:
    existing = {
        l.id: l
        for l in session.exec(
            select(ExperimentLayer).where(ExperimentLayer.experiment_id == experiment_id)
        ).all()
    }
    incoming_ids: set[_uuid.UUID] = set()
    for l_data in layers:
        lid = _uuid_or_gen(l_data.get("id"))
        incoming_ids.add(lid)
        if lid in existing:
            layer = existing[lid]
            layer.name = l_data.get("name") or layer.name
            session.add(layer)
        else:
            layer = ExperimentLayer(
                id=lid,
                experiment_id=experiment_id,
                name=l_data.get("name", "Layer"),
            )
            session.add(layer)
    for old_id in set(existing) - incoming_ids:
        session.delete(existing[old_id])


def _sync_experiment_substrates(
    session: SessionDep, experiment_id: _uuid.UUID, substrates: list[dict],
) -> None:
    existing = {
        s.id: s
        for s in session.exec(
            select(Substrate).where(Substrate.experiment_id == experiment_id)
        ).all()
    }
    incoming_ids: set[_uuid.UUID] = set()
    for s_data in substrates:
        sid = _uuid_or_gen(s_data.get("id"))
        incoming_ids.add(sid)
        if sid in existing:
            sub = existing[sid]
            sub.name = s_data.get("name") or sub.name
            session.add(sub)
        else:
            sub = Substrate(
                id=sid,
                experiment_id=experiment_id,
                name=s_data.get("name", ""),
            )
            session.add(sub)
    for old_id in set(existing) - incoming_ids:
        session.delete(existing[old_id])


def _sync_canvas_elements(
    session: SessionDep, plane_id: _uuid.UUID, elements: list[dict],
) -> None:
    existing = {
        e.id: e
        for e in session.exec(
            select(CanvasElement).where(CanvasElement.plane_id == plane_id)
        ).all()
    }
    incoming_ids: set[_uuid.UUID] = set()
    for el_data in elements:
        eid = _uuid_or_gen(el_data.get("id"))
        incoming_ids.add(eid)

        # Extract normalised columns
        etype = el_data.get("type", "text")
        pos = el_data.get("position", {})
        size = el_data.get("size", {})
        x = _safe_float(pos.get("x"))
        y = _safe_float(pos.get("y"))
        w = _safe_float(size.get("x", 100))
        h = _safe_float(size.get("y", 50))
        content = el_data.get("content") or el_data.get("name") or ""
        color = el_data.get("color")

        # For lines, store points JSON in content
        if etype == "line":
            content = json.dumps(el_data.get("points", []))

        # For collections, store refs + name as JSON in content
        if etype == "collection":
            content = json.dumps({
                "name": el_data.get("name", ""),
                "refs": el_data.get("refs", []),
            })

        if eid in existing:
            elem = existing[eid]
            elem.element_type = etype
            elem.x = x
            elem.y = y
            elem.width = w
            elem.height = h
            elem.content = content
            elem.color = color
            elem.frontend_data = el_data
            flag_modified(elem, "frontend_data")
            session.add(elem)
        else:
            elem = CanvasElement(
                id=eid,
                plane_id=plane_id,
                element_type=etype,
                x=x, y=y, width=w, height=h,
                content=content,
                color=color,
                frontend_data=el_data,
            )
            session.add(elem)

    for old_id in set(existing) - incoming_ids:
        session.delete(existing[old_id])


# ---------------------------------------------------------------------------
# GET /state/bulk — (legacy) load from normalised tables
# ---------------------------------------------------------------------------

@router.get("/bulk", response_model=BulkStateResponse)
def get_bulk_state(session: SessionDep, current_user: CurrentUser) -> Any:
    """Load all user entities in a single request (legacy format)."""
    uid = current_user.id
    return BulkStateResponse(
        materials=session.exec(select(Material).where(Material.owner_id == uid)).all(),
        solutions=session.exec(select(Solution).where(Solution.owner_id == uid)).all(),
        experiments=session.exec(select(Experiment).where(Experiment.owner_id == uid)).all(),
        results=session.exec(select(ExperimentResults).where(ExperimentResults.owner_id == uid)).all(),
        planes=session.exec(select(Plane).where(Plane.owner_id == uid)).all(),
    )
