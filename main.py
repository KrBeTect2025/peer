from core.server import app  # noqa: F401  (uvicorn main:app)
from routers import (
    ice,
    pages,
    signaling,
)  # noqa: F401  (importing registers the routes on app)
