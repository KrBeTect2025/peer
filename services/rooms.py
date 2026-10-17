from fastapi import WebSocket

# live sockets can't go in redis, so the app runs as a single worker
rooms: dict[str, list[WebSocket]] = {}


async def send_safe(ws: WebSocket, text: str):
    try:
        await ws.send_text(text)
    except Exception:
        pass
