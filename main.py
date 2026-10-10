import json
import os
from pathlib import Path

from dotenv import load_dotenv
from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

BASE = Path(__file__).parent
load_dotenv(BASE / ".env")

TURN_HOST = os.getenv("TURN_HOST", "127.0.0.1")
TURN_USER = os.getenv("TURN_USER", "webrtc")
TURN_PASS = os.getenv("TURN_PASS", "webrtc")

app = FastAPI()
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")

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


@app.get("/config")
def config():
    # ICE servers handed to the browser, so the JS never hardcodes IPs or passwords
    return {
        "iceServers": [
            {"urls": "stun:stun.l.google.com:19302"},
            {"urls": f"stun:{TURN_HOST}:3478"},
            {
                "urls": [
                    f"turn:{TURN_HOST}:3478?transport=udp",
                    f"turn:{TURN_HOST}:3478?transport=tcp",
                ],
                "username": TURN_USER,
                "credential": TURN_PASS,
            },
        ]
    }


@app.websocket("/ws/{room_id}")
async def signaling(websocket: WebSocket, room_id: str):
    await websocket.accept()
    peers = rooms.setdefault(room_id, [])

    if len(peers) >= 2:
        await websocket.send_text(json.dumps({"type": "full"}))
        await websocket.close(code=1008)
        return

    peers.append(websocket)
    print(f"room {room_id}: {len(peers)} peer(s)")

    # second person arrived: tell the first one to start the call (only one side offers)
    if len(peers) == 2:
        await send_safe(peers[0], json.dumps({"type": "ready"}))

    try:
        while True:
            text = await websocket.receive_text()
            for peer in peers:
                if peer is not websocket:
                    await send_safe(peer, text)  # forward offer/answer/candidate as-is
    except WebSocketDisconnect:
        pass
    finally:
        peers.remove(websocket)
        for peer in peers:
            await send_safe(peer, json.dumps({"type": "bye"}))
        if not peers:
            del rooms[room_id]
        print(f"room {room_id}: {len(peers)} peer(s)")
