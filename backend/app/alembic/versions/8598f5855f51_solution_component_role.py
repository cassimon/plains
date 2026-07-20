"""Solution component role and relative amount

Materializer-owned composition metadata (see
`app/services/chemicals_materialization.py`). `role` lets the NOMAD exporter
route a component into the solvent/solute/additive/other_solution buckets
without guessing from the material's type; `amount_relative` keeps the
recipe's ratio (solvent volumeRatio / stock share) alongside the batch-scaled
absolute `amount`, so the recipe is reconstructable from the archive alone.

Both nullable — rows the GUI creates directly (outside the materializer) have
no role, and the exporter falls back to its old inference for those.

Revision ID: 8598f5855f51
Revises: c7e3b91a45d2
Create Date: 2026-07-20

"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "8598f5855f51"
down_revision = "c7e3b91a45d2"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "solutioncomponent", sa.Column("role", sa.String(length=20), nullable=True)
    )
    op.add_column(
        "solutioncomponent", sa.Column("amount_relative", sa.Float(), nullable=True)
    )


def downgrade():
    op.drop_column("solutioncomponent", "amount_relative")
    op.drop_column("solutioncomponent", "role")
