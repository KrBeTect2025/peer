from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from config import BASE

app = FastAPI()
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")
