from config import BASE
from core.server import app
from fastapi.responses import FileResponse


@app.get("/")
def index():
    return FileResponse(BASE / "static" / "index.html")


@app.get("/sw.js")
def service_worker():
    # served from the root, not /static/, so the worker's scope is the whole site (it answers /dl/... requests)
    return FileResponse(BASE / "static" / "sw.js", media_type="text/javascript")
