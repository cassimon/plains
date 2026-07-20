"""Materialized chemicals: lab material component_cids, lab solution batch fields

Revision ID: b8da39282770
Revises: a1c5f2e88b04
Create Date: 2026-07-20 11:06:40.758391

"""
from alembic import op
import sqlalchemy as sa
import sqlmodel.sql.sqltypes
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = 'b8da39282770'
down_revision = 'a1c5f2e88b04'
branch_labels = None
depends_on = None


def upgrade():
    # The two unique indexes make "one entity per unique lab ID" an invariant of
    # the data. They will fail loudly on a database that already holds duplicate
    # (owner_id, inventory_label) pairs — dedupe those first if that happens.
    op.add_column('lab_material', sa.Column('component_cids', postgresql.JSONB(astext_type=sa.Text()), nullable=True))
    op.create_index('ix_lab_material_owner_inventory_label', 'lab_material', ['owner_id', 'inventory_label'], unique=True, postgresql_where=sa.text('inventory_label IS NOT NULL'))
    op.add_column('lab_solution', sa.Column('inventory_label', sqlmodel.sql.sqltypes.AutoString(length=255), nullable=True))
    op.add_column('lab_solution', sa.Column('total_volume_ml', sa.Float(), nullable=True))
    op.add_column('lab_solution', sa.Column('source_recipe_id', sa.Uuid(), nullable=True))
    op.create_index('ix_lab_solution_owner_inventory_label', 'lab_solution', ['owner_id', 'inventory_label'], unique=True, postgresql_where=sa.text('inventory_label IS NOT NULL'))
    op.create_index(op.f('ix_lab_solution_source_recipe_id'), 'lab_solution', ['source_recipe_id'], unique=False)
    # A materialized batch joins the recipe's preparation + before-use handling
    # notes, which VARCHAR(255) truncates.
    op.alter_column('lab_solution', 'handling', existing_type=sa.VARCHAR(length=255), type_=sa.VARCHAR(), existing_nullable=True)


def downgrade():
    op.alter_column('lab_solution', 'handling', existing_type=sa.VARCHAR(), type_=sa.VARCHAR(length=255), existing_nullable=True)
    op.drop_index(op.f('ix_lab_solution_source_recipe_id'), table_name='lab_solution')
    op.drop_index('ix_lab_solution_owner_inventory_label', table_name='lab_solution', postgresql_where=sa.text('inventory_label IS NOT NULL'))
    op.drop_column('lab_solution', 'source_recipe_id')
    op.drop_column('lab_solution', 'total_volume_ml')
    op.drop_column('lab_solution', 'inventory_label')
    op.drop_index('ix_lab_material_owner_inventory_label', table_name='lab_material', postgresql_where=sa.text('inventory_label IS NOT NULL'))
    op.drop_column('lab_material', 'component_cids')
