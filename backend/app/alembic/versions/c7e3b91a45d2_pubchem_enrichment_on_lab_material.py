"""PubChem enrichment fields on lab_material

Cached identity data fetched once from PubChem PUG-REST (see
`app/services/pubchem_enrichment.py`). `molecular_formula` is the load-bearing
one: the NOMAD export emits substance sections with `load_data: False`, which
makes `baseclasses` skip its own PubChem fetch, so without a formula from here
NOMAD's `CompositeSystem.normalize` fails on `Formula(None)` and the whole
entry's normalization dies.

All nullable — enrichment is best-effort and must never block saving a material.

Revision ID: c7e3b91a45d2
Revises: b8da39282770
Create Date: 2026-07-20

"""

import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "c7e3b91a45d2"
down_revision = "b8da39282770"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "lab_material", sa.Column("molecular_formula", sa.String(length=255), nullable=True)
    )
    op.add_column("lab_material", sa.Column("iupac_name", sa.Text(), nullable=True))
    op.add_column("lab_material", sa.Column("smiles", sa.Text(), nullable=True))
    op.add_column("lab_material", sa.Column("inchi", sa.Text(), nullable=True))
    op.add_column(
        "lab_material", sa.Column("inchi_key", sa.String(length=255), nullable=True)
    )
    op.add_column(
        "lab_material", sa.Column("pubchem_name", sa.String(length=255), nullable=True)
    )
    op.add_column("lab_material", sa.Column("monoisotopic_mass", sa.Float(), nullable=True))
    op.add_column(
        "lab_material",
        sa.Column("pubchem_synced_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "lab_material", sa.Column("pubchem_synced_cid", sa.String(length=255), nullable=True)
    )


def downgrade():
    op.drop_column("lab_material", "pubchem_synced_cid")
    op.drop_column("lab_material", "pubchem_synced_at")
    op.drop_column("lab_material", "monoisotopic_mass")
    op.drop_column("lab_material", "pubchem_name")
    op.drop_column("lab_material", "inchi_key")
    op.drop_column("lab_material", "inchi")
    op.drop_column("lab_material", "smiles")
    op.drop_column("lab_material", "iupac_name")
    op.drop_column("lab_material", "molecular_formula")
