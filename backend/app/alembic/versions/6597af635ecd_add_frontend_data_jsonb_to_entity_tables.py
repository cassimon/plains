"""add frontend_data jsonb to entity tables

Revision ID: 6597af635ecd
Revises: 84f12df5257c
Create Date: 2026-04-09 11:19:42.472691

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = '6597af635ecd'
down_revision = '84f12df5257c'
branch_labels = None
depends_on = None


def upgrade():
    for table in ('material', 'solution', 'experiment', 'experimentresults', 'plane', 'canvaselement'):
        op.add_column(table, sa.Column('frontend_data', postgresql.JSONB(astext_type=sa.Text()), nullable=True))


def downgrade():
    for table in ('material', 'solution', 'experiment', 'experimentresults', 'plane', 'canvaselement'):
        op.drop_column(table, 'frontend_data')
