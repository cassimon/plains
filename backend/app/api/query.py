"""Shared query helpers for owner-scoping and trash exclusion.

`visible()` is the single injection point that guarantees (a) non-superusers only
see their own rows and (b) soft-deleted (trashed) rows never leak into any list.
Adopt it in list/bulk endpoints instead of hand-writing the `owner_id` filter, so
the two concerns live in one place rather than being duplicated per route.
"""

import uuid
from typing import Any

from sqlmodel import Session, col, select

from app.models import TrashEntry, User


def trashed_ids(session: Session, user: User, entity_type: str) -> set[uuid.UUID]:
    """Ids of the given entity_type currently in the user's trash."""
    rows = session.exec(
        select(TrashEntry.entity_id).where(
            TrashEntry.owner_id == user.id,
            TrashEntry.entity_type == entity_type,
        )
    ).all()
    return set(rows)


def visible(
    statement: Any,
    model: Any,
    user: User,
    *,
    entity_type: str,
) -> Any:
    """Scope a SELECT to the owner (unless superuser) AND exclude trashed rows.

    The trash exclusion is expressed as a correlated subquery so it composes
    with any additional `.where()`/joins the caller adds.
    """
    if not user.is_superuser:
        statement = statement.where(model.owner_id == user.id)
    sub = select(TrashEntry.entity_id).where(
        TrashEntry.owner_id == user.id,
        TrashEntry.entity_type == entity_type,
    )
    return statement.where(col(model.id).not_in(sub))
