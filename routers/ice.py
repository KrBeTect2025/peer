from config import METERED_TURN_URL
from core.server import app
from services.turn import metered_ice_servers


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
    return {
        "iceServers": [
            {
                "urls": [
                    "stun:stun.l.google.com:19302",
                    "stun:stun1.l.google.com:19302",
                    "stun:stun.cloudflare.com:3478",
                ]
            }
        ]
    }
