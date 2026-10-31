import json

from fastapi import WebSocket

# live sockets can't go in redis, so the app runs as a single worker
rooms: dict[str, list[WebSocket]] = {}

# sent by each page every minute so free hosts don't sleep while a code waits; not relayed
KEEPALIVE = '{"type":"keepalive"}'


async def send_safe(ws: WebSocket, text: str):
    try:
        await ws.send_text(text)
    except Exception:
        pass


async def end(ws: WebSocket, code: int):
    # some proxies (Render's) drop the close frame, so the code also goes out as an ordinary message first
    await send_safe(ws, json.dumps({"type": "closed", "code": code}))
    try:
        await ws.close(code=code)
    except Exception:
        pass
