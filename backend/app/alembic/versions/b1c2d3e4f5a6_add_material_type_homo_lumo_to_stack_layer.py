"""Add material_type, homo_ev, lumo_ev to process_generated_stack_layer

Revision ID: b1c2d3e4f5a6
Revises: 651e3c027178
Create Date: 2026-07-03 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "b1c2d3e4f5a6"
down_revision = "651e3c027178"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column(
        "process_generated_stack_layer",
        sa.Column(
            "material_type",
            sa.String(length=100),
            nullable=False,
            server_default="",
        ),
    )
    op.add_column(
        "process_generated_stack_layer",
        sa.Column(
            "homo_ev",
            sa.String(length=50),
            nullable=False,
            server_default="",
        ),
    )
    op.add_column(
        "process_generated_stack_layer",
        sa.Column(
            "lumo_ev",
            sa.String(length=50),
            nullable=False,
            server_default="",
        ),
    )


def downgrade():
    op.drop_column("process_generated_stack_layer", "lumo_ev")
    op.drop_column("process_generated_stack_layer", "homo_ev")
    op.drop_column("process_generated_stack_layer", "material_type")
