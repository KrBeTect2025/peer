# WebRTC video + chat (1:1)

FastAPI signaling server + plain-JS client + coturn (STUN/TURN), all running in Docker.
See [EXPLANATION.md](EXPLANATION.md) for how every piece works.

## One-time setup

1. Find your LAN IP: run `ipconfig` and look for the "IPv4 Address" under Wi-Fi/Ethernet.
2. `cp .env.example .env`, then put that IP in `TURN_HOST` and `EXTERNAL_IP`, and pick a `TURN_PASS`.
3. Make the self-signed HTTPS cert (browsers only allow the camera on https or localhost):
   ```bash
   mkdir certs
   MSYS_NO_PATHCONV=1 openssl req -x509 -newkey rsa:2048 -nodes \
     -keyout certs/key.pem -out certs/cert.pem -days 365 -subj "/CN=webrtc" \
     -addext "subjectAltName=IP:<YOUR_LAN_IP>,IP:127.0.0.1,DNS:localhost"
   ```
   (`MSYS_NO_PATHCONV=1` is only needed in Git Bash.)

## Run (Docker Desktop must be running)

```bash
docker compose up -d --build     # starts "web" (FastAPI on :8000) and "coturn" (STUN/TURN on :3478)
docker compose logs -f web       # watch who joins which room
docker compose down              # stop everything
```

- This PC: `https://localhost:8000`
- Other devices on the same Wi-Fi: `https://<YOUR_LAN_IP>:8000`
- Click **Advanced → Proceed** on the certificate warning (the cert is self-signed).
- Both people type the same room name and press **Join**.
- If another device can't load the page, allow Docker Desktop through Windows Firewall on **Private** networks.

After editing `.env` or any code: `docker compose up -d --build` again.

Test TURN: open `https://.../?relay=1` on both sides. The chat should print `route: relay <-> relay`.

### Without Docker (optional)
```bash
pip install -r requirements.txt
uvicorn main:app --host 0.0.0.0 --port 8000 --ssl-keyfile certs/key.pem --ssl-certfile certs/cert.pem
```
(You still need `docker compose up -d coturn` for TURN.)

## Over the internet (no domain)

1. Find your public IP (search "what is my ip").
2. In `.env`, set `TURN_HOST` and `EXTERNAL_IP` to that public IP, then run `docker compose up -d --build`.
3. On your router, port-forward to this PC:
   - `8000/tcp` (website + signaling)
   - `3478/tcp` and `3478/udp` (STUN/TURN)
   - `49160-49200/udp` (TURN relay ports)
4. The remote person opens `https://<PUBLIC_IP>:8000`.

**CGNAT caveat:** if your router's WAN IP is different from the IP that "what is my ip" shows, your ISP uses CGNAT and port forwarding won't work. In that case you need a tunnel for port 8000 (for example `cloudflared tunnel --url https://localhost:8000 --no-tls-verify`) and a hosted TURN server.
