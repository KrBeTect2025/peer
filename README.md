# P2P file share

Send a file from one browser to another with a 6-digit code. The file goes browser-to-browser over a
WebRTC DataChannel; the server only relays the handshake and never sees the file.

FastAPI signaling server + plain-JS client + Redis (which codes are active) + coturn (STUN/TURN), all running in Docker.
See [EXPLANATION.md](EXPLANATION.md) for how every piece works.

## One-time setup

1. Find your LAN IP: run `ipconfig` and look for the "IPv4 Address" under Wi-Fi/Ethernet.
2. `cp .env.example .env`, then put that IP in `TURN_HOST` and `EXTERNAL_IP`, and pick a `TURN_PASS`.
3. Make the self-signed HTTPS cert (the server runs on HTTPS):
   ```bash
   mkdir certs
   MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes \
     -keyout certs/key.pem -out certs/cert.pem -days 365 -subj "/CN=webrtc" \
     -addext "subjectAltName=IP:<YOUR_LAN_IP>,IP:127.0.0.1,DNS:localhost"
   ```
   (`MSYS_NO_PATHCONV=1` is only needed in Git Bash.)

## Run (Docker Desktop must be running)

```bash
docker compose up -d --build     # starts "web" (FastAPI on :8000), "redis" and "coturn" (STUN/TURN on :3478)
docker compose logs -f web       # watch codes being joined
docker compose down              # stop everything
```

- This PC: `https://localhost:8000`
- Other devices on the same Wi-Fi/hotspot: `https://<YOUR_LAN_IP>:8000`
- Click **Advanced → Proceed** on the certificate warning (the cert is self-signed).
- If another device can't load the page, allow inbound TCP 8000 (and UDP 3478, 49160-49400 for TURN) in Windows Firewall.

After editing `.env` or any code: `docker compose up -d --build` again.

## Using it

1. **Sender:** pick a file (max 25 MB). A 6-digit code appears. Keep that tab open.
2. **Receiver:** type the code and press **Receive**. The download starts when the transfer finishes
   (a "save" link stays on the page if the browser blocks the automatic download).
3. The same code works again for another receiver, one at a time, while the sender's tab is open,
   for 1 hour at most. A code the sender is done with reads as "expired" (for an hour after); a mistyped one as "no such code".

The receiver holds the whole file in memory until it is saved, which is why files are capped at 25 MB (`MAX_SIZE` in `static/app.js`).

### Without Docker (optional)
```bash
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem
```
(You still need `docker compose up -d redis coturn`.)

## Over the internet with Cloudflare (works behind CGNAT)

1. **Page:** start a quick tunnel and share the printed `https://xxxx.trycloudflare.com` link (changes on every restart):
   ```bash
   cloudflared tunnel --url https://localhost:8000 --no-tls-verify
   ```
2. **Relay for the file data:** sign up at metered.ca (free, 20 GB/month, no card), create a TURN credential,
   and put its credentials URL in `.env` as `METERED_TURN_URL=https://<app>.metered.live/api/v1/turn/credentials?apiKey=<key>`,
   then `docker compose up -d --build --force-recreate`.
   `/config` then hands out Metered TURN credentials; transfers still go direct when the networks allow it.

## Over the internet with port forwarding (no CGNAT)

1. Find your public IP (search "what is my ip").
2. In `.env`, set `TURN_HOST` and `EXTERNAL_IP` to that public IP, then run `docker compose up -d --build`.
3. On your router, port-forward to this PC:
   - `8000/tcp` (website + signaling)
   - `3478/tcp` and `3478/udp` (STUN/TURN)
   - `49160-49400/udp` (TURN relay ports)
4. Both people open `https://<PUBLIC_IP>:8000`.

**CGNAT caveat:** if your router's WAN IP is different from the IP that "what is my ip" shows (common on
mobile hotspots and Jio), your ISP uses CGNAT and port forwarding won't work. In that case you need a tunnel
for port 8000 (for example `cloudflared tunnel --url https://localhost:8000 --no-tls-verify`) and a hosted TURN server.
