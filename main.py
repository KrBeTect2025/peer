import asyncio
import json
import os
import time
import urllib.request
from pathlib import Path

import redis.asyncio as redis
from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

BASE = Path(__file__).parent
load_dotenv(BASE / ".env")

# Metered TURN credentials URL (with ?apiKey=...): the relay for when the browsers can't connect directly
METERED_TURN_URL = os.getenv("METERED_TURN_URL")
metered_cache: tuple[float, list] = (0.0, [])  # (fetched at, iceServers)

app = FastAPI()
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")

# redis holds each code's state: "active" while its sender is connected (max CODE_TTL),
# then "expired" for another CODE_TTL, so a stale code reads as expired and a typo as wrong
db = redis.from_url(os.getenv("REDIS_URL", "redis://localhost:6379/0"), decode_responses=True)
CODE_TTL = int(os.getenv("CODE_TTL", "3600"))  # a code lives 1 hour at most

# the live sockets can't go in redis; this is why the app runs as a single uvicorn worker
rooms: dict[str, list[WebSocket]] = {}  # room id -> the (max 2) sockets in it


async def send_safe(ws: WebSocket, text: str):
    # the other peer may be disconnecting right now; that must not kill this connection
    try:
        await ws.send_text(text)
    except Exception:
        pass


@app.get("/")
def index():
    return FileResponse(BASE / "static" / "index.html")


@app.get("/sw.js")
def service_worker():
    # served from the root, not /static/, so the worker's scope is the whole site (it answers /dl/... requests)
    return FileResponse(BASE / "static" / "sw.js", media_type="text/javascript")


def metered_ice_servers(url: str):
    # the Metered API takes seconds to answer; its credentials don't change per request, so reuse them for an hour
    global metered_cache
    fetched_at, servers = metered_cache
    if not servers or time.time() - fetched_at > 3600:
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                servers = json.load(resp)
            metered_cache = (time.time(), servers)
        except Exception:
            if not servers:
                raise
            metered_cache = (time.time() - 3600 + 60, servers)  # keep the old credentials, retry in a minute
    return servers


@app.get("/config")
def config():
    # ICE servers handed to the browser, so the API key stays on the server
    if METERED_TURN_URL:
        # Metered returns a ready-made iceServers list with STUN + TURN credentials
        try:
            return {"iceServers": metered_ice_servers(METERED_TURN_URL)}
        except Exception as err:
            print("Metered TURN failed, falling back to STUN only:", err)
    # STUN only: direct connections still work, browsers behind strict NAT won't connect
    return {"iceServers": [{"urls": "stun:stun.l.google.com:19302"}]}


@app.websocket("/ws/{room_id}")
async def signaling(websocket: WebSocket, room_id: str, role: str = ""):
    await websocket.accept()
    key = f"code:{room_id}"

    # a code (room) is live only while its sender is connected: the sender creates it, receivers can only join it
    try:
        if role == "send":
            # NX: a code that is active or recently expired is never handed out again.
            # +60s so the key outlives the sender's timeout below and can't be re-taken before it's marked expired
            if not await db.set(key, "active", ex=CODE_TTL + 60, nx=True):
                await websocket.close(code=4409)  # code taken: the sender picks another one
                return
            peers = rooms[room_id] = []
        else:
            state = await db.get(key)
            if state is None:
                await websocket.close(code=4404)  # no such code
                return
            if state != "active" or room_id not in rooms:  # not in rooms: active key left over from a server restart
                await websocket.close(code=4410)  # code expired
                return
            peers = rooms[room_id]
    except redis.RedisError as err:
        print("redis error:", err)
        await websocket.close(code=1011)
        return

    if len(peers) >= 2:
        await websocket.send_text(json.dumps({"type": "full"}))
        await websocket.close(code=1008)
        return

    peers.append(websocket)
    print(f"room {room_id}: {len(peers)} peer(s)")
    if role == "send":
        await send_safe(websocket, json.dumps({"type": "created"}))  # the code exists now: the page may show it

    # second person arrived: tell the first one to start the call (only one side offers)
    if len(peers) == 2:
        await send_safe(peers[0], json.dumps({"type": "ready"}))

    async def relay():
        while True:
            text = await websocket.receive_text()
            for peer in peers:
                if peer is not websocket:
                    await send_safe(peer, text)  # forward offer/answer/candidate as-is

    async def expire():
        # the code's hour is up: from now on it reads as expired, so no new receiver can join,
        # but a receiver already connected (maybe mid-transfer) may finish before the sender is cut off
        while len(peers) > 1:
            try:
                # keep the expired mark alive meanwhile, so no new sender can claim this code
                await db.set(key, "expired", ex=CODE_TTL)
            except redis.RedisError as err:
                print("redis error:", err)
            try:
                async with asyncio.timeout(5):  # re-check every 5 s whether the receiver has left
                    await relay()
            except TimeoutError:
                pass
        try:
            await websocket.close(code=4410)
        except Exception:
            pass

    reason = "left"
    try:
        if role == "send":
            try:
                async with asyncio.timeout(CODE_TTL):
                    await relay()
            except TimeoutError:
                reason = "expired"
                await expire()
        else:
            await relay()  # until the receiver disconnects
    except WebSocketDisconnect:
        pass
    finally:
        peers.remove(websocket)
        # sender gone = code expires at once, even if a receiver is still connected
        if rooms.get(room_id) is peers and (role == "send" or not peers):
            del rooms[room_id]
        if role == "send":
            try:
                await db.set(key, "expired", ex=CODE_TTL)
            except redis.RedisError as err:
                print("redis error:", err)  # the active key still dies on its own TTL
        for peer in peers:
            await send_safe(peer, json.dumps({"type": "bye", "reason": reason}))
        print(f"room {room_id}: {len(peers)} peer(s)")
