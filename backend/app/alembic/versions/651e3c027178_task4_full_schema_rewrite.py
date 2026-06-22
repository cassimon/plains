"""task4_full_schema_rewrite

Drops the legacy domain tables and recreates the fully normalised Task 4
schema. NO DATA MIGRATION: existing domain data is discarded (the new schema
starts empty). The shared ``user`` table is preserved (NOMAD profile columns
are added); ``userstate``, ``plane`` and ``planeshare`` are dropped and
recreated from current metadata.

Revision ID: 651e3c027178
Revises: a7b3c8d9e2f1
Create Date: 2026-06-22

"""
from alembic import op
from sqlmodel import SQLModel

import app.models  # noqa: F401  (ensures all tables are registered on metadata)

revision = "651e3c027178"
down_revision = "a7b3c8d9e2f1"
branch_labels = None
depends_on = None


# Legacy tables that are fully removed / recreated. Order matters for FK drops.
_LEGACY_TABLES = [
    "canvaselement",
    "experimentlayer",
    "substrate",
    "measurementfile",
    "devicegroup",
    "experimentresults",
    "experiment",
    "solutioncomponent",
    "solution",
    "material",
    "item",
    "planeshare",
    "plane",
    "userstate",
]

# Newly created tables (everything except the preserved ``user`` table).
_NEW_TABLES = [
    "plane",
    "planeshare",
    "sticky_note",
    "text_field",
    "data_collection",
    "lab_material",
    "lab_solution",
    "solutioncomponent",
    "process",
    "process_inline_substrate",
    "process_substrate_dimension",
    "process_solution_recipe",
    "recipe_solvent",
    "recipe_solute",
    "recipe_added_solution",
    "process_step",
    "process_generated_stack",
    "process_generated_stack_layer",
    "experiment",
    "lab_substrate",
    "experiment_material",
    "experiment_solution",
    "experimentresults",
    "measurementfile",
    "devicegroup",
    "analysis",
    "analysis_ref",
    "userstate",
]


def upgrade() -> None:
    # 1. Drop all legacy domain tables (CASCADE clears dependent FKs).
    for table in _LEGACY_TABLES:
        op.execute(f'DROP TABLE IF EXISTS "{table}" CASCADE')

    # 2. Extend the preserved ``user`` table with NOMAD profile columns.
    import sqlalchemy as sa

    cols = {c["name"] for c in sa.inspect(op.get_bind()).get_columns("user")}
    if "nomad_name" not in cols:
        op.add_column("user", sa.Column("nomad_name", sa.String(), nullable=True))
    if "nomad_email" not in cols:
        op.add_column("user", sa.Column("nomad_email", sa.String(), nullable=True))

    # 3. Create the full new schema from current metadata.
    bind = op.get_bind()
    tables = [
        SQLModel.metadata.tables[name]
        for name in _NEW_TABLES
        if name in SQLModel.metadata.tables
    ]
    SQLModel.metadata.create_all(bind, tables=tables)


def downgrade() -> None:
    bind = op.get_bind()
    tables = [
        SQLModel.metadata.tables[name]
        for name in reversed(_NEW_TABLES)
        if name in SQLModel.metadata.tables
    ]
    SQLModel.metadata.drop_all(bind, tables=tables)
    op.drop_column("user", "nomad_email")
    op.drop_column("user", "nomad_name")
