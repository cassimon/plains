"""Add handling and creation_time to solution

Revision ID: c2f4a6b8d9e1
Revises: 09c91b6f9157
Create Date: 2026-04-14 00:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "c2f4a6b8d9e1"
down_revision = "09c91b6f9157"
branch_labels = None
depends_on = None


def upgrade():
    op.add_column("solution", sa.Column("handling", sa.String(length=255), nullable=True))
    op.add_column(
        "solution",
        sa.Column("creation_time", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade():
    op.drop_column("solution", "creation_time")
    op.drop_column("solution", "handling")
