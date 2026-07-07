"""add nomad_upload_log

Central audit log of NOMAD upload attempts plus the failed-archive stash
bookkeeping. Created directly from the current SQLModel metadata so the table
(and all its indexes) matches the ``NomadUploadLog`` model exactly.

Revision ID: f3a9c1d24b7e
Revises: b1c2d3e4f5a6
Create Date: 2026-07-07

"""

from alembic import op
from sqlmodel import SQLModel

import app.models  # noqa: F401  (ensures all tables are registered on metadata)

revision = "f3a9c1d24b7e"
down_revision = "b1c2d3e4f5a6"
branch_labels = None
depends_on = None

_TABLE = "nomad_upload_log"


def upgrade() -> None:
    bind = op.get_bind()
    SQLModel.metadata.create_all(bind, tables=[SQLModel.metadata.tables[_TABLE]])


def downgrade() -> None:
    bind = op.get_bind()
    SQLModel.metadata.drop_all(bind, tables=[SQLModel.metadata.tables[_TABLE]])
