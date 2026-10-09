from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse

app = FastAPI()

room: dict[str, list[WebSocket]] = {}  # create an empty dict for rooms


@app.get("/")
def index():
    return FileResponse("index.html")


@app.websocket("/ws/{room_id}")
async def signaling(websocket: WebSocket, room_id: str):
    await websocket.accept()

    if room_id not in room:
        room[room_id] = []

    if len(room[room_id]) >= 2:
        await websocket.close(code=1008)
        return
    room[room_id].append(websocket)
    print("room", room_id, "has", len(room[room_id]), "people")

    try:
        while True:
            text = await websocket.receive_text()
            for peer in room[room_id]:
                if peer is not websocket:
                    await peer.send_text(text)

    except WebSocketDisconnect:
        pass

    finally:
        room[room_id].remove(websocket)
        if not room[room_id]:
            del room[room_id]
