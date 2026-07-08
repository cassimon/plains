from fastapi import APIRouter

from app.api.routes import (
    analyses,
    experiments,
    login,
    materials,
    nomad,
    plane_folders,
    planes,
    private,
    processes,
    results,
    solutions,
    state,
    users,
    utils,
)
from app.core.config import settings

api_router = APIRouter()
api_router.include_router(login.router)
api_router.include_router(users.router)
api_router.include_router(utils.router)
api_router.include_router(materials.router)
api_router.include_router(solutions.router)
api_router.include_router(processes.router)
api_router.include_router(experiments.router)
api_router.include_router(results.router)
api_router.include_router(analyses.router)
api_router.include_router(planes.router)
api_router.include_router(plane_folders.router)
api_router.include_router(state.router)
api_router.include_router(nomad.router)


if settings.ENVIRONMENT == "local":
    api_router.include_router(private.router)
