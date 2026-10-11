# P2P file share

Send a file from one browser to another with a 6-digit code. The file goes browser-to-browser over a
WebRTC DataChannel; the server only relays the handshake and never sees the file.

FastAPI signaling server + plain-JS client + Redis (which codes are active) + a Cloudflare tunnel (the public HTTPS link),
all running in Docker. Metered's hosted STUN/TURN connects the browsers when they can't reach each other directly.
See [EXPLANATION.md](EXPLANATION.md) for how every piece works.

## One-time setup

1. Sign up at metered.ca (free, 20 GB/month, no card) and create a TURN credential.
2. `cp .env.example .env`, then put its credentials URL in `METERED_TURN_URL`.

## Run (Docker Desktop must be running)

```bash
docker compose up -d --build     # starts "web" (FastAPI), "redis" and "tunnel" (Cloudflare)
curl http://127.0.0.1:20241/quicktunnel   # prints the https://xxxx.trycloudflare.com link to share
```

- After that, Docker Desktop's ▶ / ■ on the **app** project starts and stops all three.
- The link changes every time the tunnel container restarts. Get the new one with the `curl` above,
  or in Docker Desktop: **tunnel** container → Logs → look for `trycloudflare.com`.
- `docker compose logs -f web` watches codes being joined.
- After editing `.env` or any code: `docker compose up -d --build` again.

## Using it

1. **Sender:** pick a file (any size). A 6-digit code appears. Keep that tab open.
2. **Receiver:** type the code and press **Receive**. The file appears in the browser's download bar right away
   and fills as it arrives, like any normal download (Chrome, Edge, Firefox). Safari falls back to saving in the
   browser's storage and downloading when complete. Keep both tabs open until it's done: the browser asks before
   closing one mid-transfer.
3. The same code works again for another receiver, one at a time, while the sender's tab is open,
   for 1 hour (a transfer still running at the 1-hour mark finishes). A code the sender is done with reads as
   "expired" (for an hour after); a mistyped one as "no such code".

The receiver writes to disk as the file arrives, so memory stays flat and the only size limit is free disk space
(Safari: the browser's storage quota for the site). Tested with files up to 50 GB; see [tests/REPORT.md](tests/REPORT.md).
Codes expire after 1 hour: nobody new can join after that, but a transfer already running finishes.

### Without Docker (optional)
```bash
pip install -r requirements.txt
docker compose up -d redis
uvicorn main:app --port 8000
```
