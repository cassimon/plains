import uuid
from typing import Any

from fastapi import APIRouter, HTTPException
from sqlmodel import col, func, select

from app import crud
from app.api.deps import CurrentUser, SessionDep
from app.models import (
    Process,
    ProcessCreate,
    ProcessesPublic,
    ProcessGeneratedStack,
    ProcessGeneratedStackCreate,
    ProcessGeneratedStackLayer,
    ProcessGeneratedStackPublic,
    ProcessPublic,
    ProcessSolutionRecipe,
    ProcessSolutionRecipeCreate,
    ProcessSolutionRecipePublic,
    ProcessStep,
    ProcessStepCreate,
    ProcessStepPublic,
    ProcessUpdate,
    RecipeAddedSolution,
    RecipeSolute,
    RecipeSolvent,
)

router = APIRouter(prefix="/processes", tags=["processes"])


@router.get("/", response_model=ProcessesPublic)
def read_processes(
    session: SessionDep, current_user: CurrentUser, skip: int = 0, limit: int = 100
) -> Any:
    """Retrieve processes."""
    base = select(Process)
    count_base = select(func.count()).select_from(Process)
    if not current_user.is_superuser:
        base = base.where(Process.owner_id == current_user.id)
        count_base = count_base.where(Process.owner_id == current_user.id)
    count = session.exec(count_base).one()
    statement = base.order_by(col(Process.created_at).desc()).offset(skip).limit(limit)
    items = session.exec(statement).all()
    return ProcessesPublic(data=items, count=count)


@router.get("/{id}", response_model=ProcessPublic)
def read_process(session: SessionDep, current_user: CurrentUser, id: uuid.UUID) -> Any:
    """Get process by ID."""
    process = session.get(Process, id)
    if not process:
        raise HTTPException(status_code=404, detail="Process not found")
    if not current_user.is_superuser and process.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return process


@router.post("/", response_model=ProcessPublic)
def create_process(
    *, session: SessionDep, current_user: CurrentUser, process_in: ProcessCreate
) -> Any:
    """Create new process."""
    return crud.create_process(
        session=session, process_in=process_in, owner_id=current_user.id
    )


@router.put("/{id}", response_model=ProcessPublic)
def update_process(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    process_in: ProcessUpdate,
) -> Any:
    """Update process."""
    process = session.get(Process, id)
    if not process:
        raise HTTPException(status_code=404, detail="Process not found")
    if not current_user.is_superuser and process.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return crud.update_process(
        session=session, db_process=process, process_in=process_in
    )


@router.delete("/{id}")
def delete_process(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Any:
    """Delete process and all sub-resources."""
    process = session.get(Process, id)
    if not process:
        raise HTTPException(status_code=404, detail="Process not found")
    if not current_user.is_superuser and process.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    session.delete(process)
    session.commit()
    return {"ok": True}


def _owned_process(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Process:
    process = session.get(Process, id)
    if not process:
        raise HTTPException(status_code=404, detail="Process not found")
    if not current_user.is_superuser and process.owner_id != current_user.id:
        raise HTTPException(status_code=403, detail="Not enough permissions")
    return process


# --- Recipes ---


@router.get("/{id}/recipes/")
def read_process_recipes(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Any:
    """List solution recipes for a process."""
    process = _owned_process(session, current_user, id)
    return process.recipes


@router.post("/{id}/recipes/", response_model=ProcessSolutionRecipePublic)
def create_process_recipe(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    recipe_in: ProcessSolutionRecipeCreate,
) -> Any:
    """Add a solution recipe to a process."""
    _owned_process(session, current_user, id)
    recipe_data = recipe_in.model_dump(
        exclude={"solvents", "solutes", "added_solutions"}
    )
    recipe = ProcessSolutionRecipe(**recipe_data, process_id=id)
    session.add(recipe)
    session.flush()
    for s in recipe_in.solvents:
        session.add(RecipeSolvent(**s.model_dump(), recipe_id=recipe.id))
    for s in recipe_in.solutes:
        session.add(RecipeSolute(**s.model_dump(), recipe_id=recipe.id))
    for a in recipe_in.added_solutions:
        session.add(RecipeAddedSolution(**a.model_dump(), recipe_id=recipe.id))
    session.commit()
    session.refresh(recipe)
    return recipe


@router.put("/{id}/recipes/{rid}", response_model=ProcessSolutionRecipePublic)
def update_process_recipe(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    rid: uuid.UUID,
    recipe_in: ProcessSolutionRecipeCreate,
) -> Any:
    """Replace a solution recipe (and its sub-items)."""
    _owned_process(session, current_user, id)
    recipe = session.get(ProcessSolutionRecipe, rid)
    if not recipe or recipe.process_id != id:
        raise HTTPException(status_code=404, detail="Recipe not found")
    # Update scalar fields
    for field, value in recipe_in.model_dump(
        exclude={"solvents", "solutes", "added_solutions"}
    ).items():
        setattr(recipe, field, value)
    # Replace nested items
    for child in list(recipe.solvents):
        session.delete(child)
    for child in list(recipe.solutes):
        session.delete(child)
    for child in list(recipe.added_solutions):
        session.delete(child)
    session.flush()
    for s in recipe_in.solvents:
        session.add(RecipeSolvent(**s.model_dump(), recipe_id=recipe.id))
    for s in recipe_in.solutes:
        session.add(RecipeSolute(**s.model_dump(), recipe_id=recipe.id))
    for a in recipe_in.added_solutions:
        session.add(RecipeAddedSolution(**a.model_dump(), recipe_id=recipe.id))
    session.commit()
    session.refresh(recipe)
    return recipe


@router.delete("/{id}/recipes/{rid}")
def delete_process_recipe(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID, rid: uuid.UUID
) -> Any:
    """Delete a solution recipe."""
    _owned_process(session, current_user, id)
    recipe = session.get(ProcessSolutionRecipe, rid)
    if not recipe or recipe.process_id != id:
        raise HTTPException(status_code=404, detail="Recipe not found")
    session.delete(recipe)
    session.commit()
    return {"ok": True}


# --- Steps ---


@router.get("/{id}/steps/")
def read_process_steps(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Any:
    """List deposition steps for a process."""
    process = _owned_process(session, current_user, id)
    return process.steps


@router.post("/{id}/steps/", response_model=ProcessStepPublic)
def create_process_step(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    step_in: ProcessStepCreate,
) -> Any:
    """Add a deposition step to a process."""
    _owned_process(session, current_user, id)
    step = ProcessStep(**step_in.model_dump(), process_id=id)
    session.add(step)
    session.commit()
    session.refresh(step)
    return step


@router.put("/{id}/steps/{sid}", response_model=ProcessStepPublic)
def update_process_step(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    sid: uuid.UUID,
    step_in: ProcessStepCreate,
) -> Any:
    """Update a deposition step."""
    _owned_process(session, current_user, id)
    step = session.get(ProcessStep, sid)
    if not step or step.process_id != id:
        raise HTTPException(status_code=404, detail="Step not found")
    for field, value in step_in.model_dump().items():
        setattr(step, field, value)
    session.commit()
    session.refresh(step)
    return step


@router.delete("/{id}/steps/{sid}")
def delete_process_step(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID, sid: uuid.UUID
) -> Any:
    """Delete a deposition step."""
    _owned_process(session, current_user, id)
    step = session.get(ProcessStep, sid)
    if not step or step.process_id != id:
        raise HTTPException(status_code=404, detail="Step not found")
    session.delete(step)
    session.commit()
    return {"ok": True}


# --- Stacks ---


@router.get("/{id}/stacks/")
def read_process_stacks(
    session: SessionDep, current_user: CurrentUser, id: uuid.UUID
) -> Any:
    """List generated device stacks for a process."""
    process = _owned_process(session, current_user, id)
    return process.stacks


@router.post("/{id}/stacks/", response_model=ProcessGeneratedStackPublic)
def create_process_stack(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    stack_in: ProcessGeneratedStackCreate,
) -> Any:
    """Add a generated device stack to a process."""
    _owned_process(session, current_user, id)
    stack = ProcessGeneratedStack(
        **stack_in.model_dump(exclude={"layers"}), process_id=id
    )
    session.add(stack)
    session.flush()
    for layer in stack_in.layers:
        session.add(ProcessGeneratedStackLayer(**layer.model_dump(), stack_id=stack.id))
    session.commit()
    session.refresh(stack)
    return stack


@router.put("/{id}/stacks/{stack_id}", response_model=ProcessGeneratedStackPublic)
def update_process_stack(
    *,
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    stack_id: uuid.UUID,
    stack_in: ProcessGeneratedStackCreate,
) -> Any:
    """Replace a generated stack (and its layers)."""
    _owned_process(session, current_user, id)
    stack = session.get(ProcessGeneratedStack, stack_id)
    if not stack or stack.process_id != id:
        raise HTTPException(status_code=404, detail="Stack not found")
    for field, value in stack_in.model_dump(exclude={"layers"}).items():
        setattr(stack, field, value)
    for layer in list(stack.layers):
        session.delete(layer)
    session.flush()
    for layer in stack_in.layers:
        session.add(ProcessGeneratedStackLayer(**layer.model_dump(), stack_id=stack.id))
    session.commit()
    session.refresh(stack)
    return stack


@router.delete("/{id}/stacks/{stack_id}")
def delete_process_stack(
    session: SessionDep,
    current_user: CurrentUser,
    id: uuid.UUID,
    stack_id: uuid.UUID,
) -> Any:
    """Delete a generated stack."""
    _owned_process(session, current_user, id)
    stack = session.get(ProcessGeneratedStack, stack_id)
    if not stack or stack.process_id != id:
        raise HTTPException(status_code=404, detail="Stack not found")
    session.delete(stack)
    session.commit()
    return {"ok": True}
