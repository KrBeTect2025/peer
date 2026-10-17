import asyncio
import json

import redis.asyncio as redis
from core.server import app
from db.client import CODE_TTL, db
from fastapi import WebSocket, WebSocketDisconnect
from services.rooms import rooms, send_safe


@app.websocket("/ws/{room_id}")
async def signaling(websocket: WebSocket, room_id: str, role: str = ""):
    await websocket.accept()
    key = f"code:{room_id}"

    try:
        if role == "send":
            # NX + 60s: a recently used code is never handed out again
            if not await db.set(key, "active", ex=CODE_TTL + 60, nx=True):
                await websocket.close(code=4409)
                return
            peers = rooms[room_id] = []
        else:
            state = await db.get(key)
            if state is None:
                await websocket.close(code=4404)
                return
            if state != "active" or room_id not in rooms:
                await websocket.close(code=4410)
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
        await send_safe(websocket, json.dumps({"type": "created"}))

    if len(peers) == 2:
        await send_safe(peers[0], json.dumps({"type": "ready"}))

    async def relay():
        while True:
            text = await websocket.receive_text()
            for peer in peers:
                if peer is not websocket:
                    await send_safe(peer, text)

    async def expire():
        # time's up: no new receivers, but a connected one may finish
        while len(peers) > 1:
            try:
                await db.set(key, "expired", ex=CODE_TTL)
            except redis.RedisError as err:
                print("redis error:", err)
            try:
                async with asyncio.timeout(5):
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
            await relay()
    except WebSocketDisconnect:
        pass
    finally:
        peers.remove(websocket)
        if rooms.get(room_id) is peers and (role == "send" or not peers):
            del rooms[room_id]
        if role == "send":
            try:
                await db.set(key, "expired", ex=CODE_TTL)
            except redis.RedisError as err:
                print("redis error:", err)
        for peer in peers:
            await send_safe(peer, json.dumps({"type": "bye", "reason": reason}))
        print(f"room {room_id}: {len(peers)} peer(s)")
