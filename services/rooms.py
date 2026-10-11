from fastapi import WebSocket

# the live sockets can't go in redis; this is why the app runs as a single uvicorn worker
rooms: dict[str, list[WebSocket]] = {}  # room id -> the (max 2) sockets in it


async def send_safe(ws: WebSocket, text: str):
    # the other peer may be disconnecting right now; that must not kill this connection
    try:
        await ws.send_text(text)
    except Exception:
        pass
