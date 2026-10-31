import time

from config import BASE
from core.server import app
from fastapi.responses import FileResponse

STARTED = time.time()


@app.get("/")
def index():
    return FileResponse(BASE / "static" / "index.html")


@app.get("/healthz")
def healthz():
    # for the host's health check; doesn't touch Redis, so checks don't use up a hosted Redis quota.
    # uptime shows whether a dropped connection came from the host replacing the server
    return {"ok": True, "uptime": int(time.time() - STARTED)}


@app.get("/sw.js")
def service_worker():
    # served from root so the worker's scope covers /dl/
    return FileResponse(BASE / "static" / "sw.js", media_type="text/javascript")
