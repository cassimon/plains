"""Experiment start/end carry a time of day

The Experiments page derives an experiment's start and end from the Processing
table's step times (the first step's start, and the new "end of experiment"
cell). Those times have a time of day, and the NOMAD DepositionStep durations are
measured against them -- the last step's duration is the time from its start
until the end of the experiment -- so a DATE cannot hold them.

Widening DATE -> TIMESTAMP is lossless: existing dates become midnight of the
same day.

Revision ID: d4e7b1c93f26
Revises: f3a9c1d24b7e
Create Date: 2026-07-13

"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "d4e7b1c93f26"
down_revision = "f3a9c1d24b7e"
branch_labels = None
depends_on = None


def upgrade():
    op.alter_column(
        "experiment",
        "date",
        existing_type=sa.Date(),
        type_=sa.DateTime(),
        existing_nullable=True,
        postgresql_using="date::timestamp",
    )
    op.alter_column(
        "experiment",
        "end_date",
        existing_type=sa.Date(),
        type_=sa.DateTime(),
        existing_nullable=True,
        postgresql_using="end_date::timestamp",
    )


def downgrade():
    # Narrowing back to DATE drops the time of day.
    op.alter_column(
        "experiment",
        "end_date",
        existing_type=sa.DateTime(),
        type_=sa.Date(),
        existing_nullable=True,
        postgresql_using="end_date::date",
    )
    op.alter_column(
        "experiment",
        "date",
        existing_type=sa.DateTime(),
        type_=sa.Date(),
        existing_nullable=True,
        postgresql_using="date::date",
    )
