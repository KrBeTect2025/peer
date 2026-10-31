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
