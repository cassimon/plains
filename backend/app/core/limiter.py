"""Shared rate limiter instance.

Defined in its own module (rather than in ``app.main``) so route modules can
import it without creating a circular import with ``app.main``, which imports
the API router that pulls in those route modules.
"""

from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
