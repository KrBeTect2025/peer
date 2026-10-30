from config import BASE
from core.server import app
from fastapi.responses import FileResponse


@app.get("/")
def index():
    return FileResponse(BASE / "static" / "index.html")


@app.get("/healthz")
def healthz():
    # for the host's health check; doesn't touch Redis, so checks don't use up a hosted Redis quota
    return {"ok": True}


@app.get("/sw.js")
def service_worker():
    # served from root so the worker's scope covers /dl/
    return FileResponse(BASE / "static" / "sw.js", media_type="text/javascript")
