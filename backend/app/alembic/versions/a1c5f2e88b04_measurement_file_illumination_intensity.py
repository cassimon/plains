"""Add illumination_intensity to measurementfile

The CHOSE instrument exports do not record the illumination, but NOMAD's solar
cell schema needs it — it is what the efficiency is measured against. Stored per
measurement file, alongside voc/jsc/ff.

Revision ID: a1c5f2e88b04
Revises: d4e7b1c93f26
Create Date: 2026-07-13

"""

import sqlalchemy as sa
from alembic import op

revision = "a1c5f2e88b04"
down_revision = "d4e7b1c93f26"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "measurementfile",
        sa.Column("illumination_intensity", sa.Float(), nullable=True),
    )


def downgrade():
    op.drop_column("measurementfile", "illumination_intensity")
