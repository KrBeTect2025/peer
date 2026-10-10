# How this P2P file share works

This file walks through every piece of the project. It starts with the ideas, then goes through the server, the browser code, and the STUN/TURN server, and ends with LAN vs internet behavior and a troubleshooting table.

```
app/
  main.py              FastAPI: serves the page, hands out ICE config, relays signaling messages
  static/index.html    the page (Send box, Receive box, progress bar)
  static/app.js        all the WebRTC + file transfer logic in the browser
  Dockerfile           how the FastAPI app is packaged into a container
  docker-compose.yml   runs two containers: "web" (FastAPI) and "coturn" (STUN + TURN)
  .env                 your IPs and TURN password (not committed)
  certs/               self-signed HTTPS certificate (not committed)
```

---

## 1. The big picture

WebRTC lets two browsers send data **directly to each other**. The file does not go through the FastAPI server. But before the browsers can connect, they have to exchange some setup information, and WebRTC deliberately doesn't say how you do that. That exchange is called **signaling**, and it's the only job of our FastAPI server.

The 6-digit code is just the name of a signaling room (`file-<code>`). Whoever has the code ends up in the same room as the sender, and the two browsers connect.

| Term | What it is | Where it lives in this project |
|---|---|---|
| **Signaling** | Passing setup messages between the two browsers before they're connected | WebSocket `/ws/{room}` in `main.py` |
| **SDP** (offer / answer) | A text blob describing "here's what I want to open, and my encryption keys". One side sends an **offer**, the other replies with an **answer** | `createOffer()` / `createAnswer()` in `app.js` |
| **ICE candidate** | One possible network address where a browser can be reached (IP + port + type) | `onicecandidate` / `addIceCandidate()` |
| **STUN** | A server that tells a browser "this is what your public IP:port looks like from outside". Only used during setup | coturn on port 3478 + Google's public STUN |
| **TURN** | A server that **relays** the (still encrypted) data when a direct connection is impossible. It uses bandwidth and is the fallback | coturn, ports 3478 + 49160-49400 |
| **DataChannel** | A peer-to-peer pipe for arbitrary data, reliable and ordered by default | `createDataChannel("file")` |

### The full sequence

```
 Sender                            FastAPI server             Receiver
 ──────                            ──────────────             ────────
 picks file, code = 123456
 GET /config  ───────────────────▶ iceServers
 WS connect /ws/file-123456 ─────▶ room = [S]
                                   iceServers ◀───────────── GET /config
                                   room = [S, R] ◀────────── WS connect /ws/file-123456
 ◀──────── {"type":"ready"} ────── (only to whoever was first)
 createPeer, createDataChannel
 createOffer → setLocalDescription
 {"type":"offer"} ───────────────▶ forward ────────────────▶ createPeer
                                                             setRemoteDescription(offer)
                                                             createAnswer → setLocalDescription
 setRemoteDescription(answer) ◀── forward ◀───────────────── {"type":"answer"}
 {"type":"candidate"} x N ───────▶ forward ────────────────▶ addIceCandidate
 addIceCandidate ◀─────────────── forward ◀───────────────── {"type":"candidate"} x N

 ════════════ ICE checks: direct (host/srflx) or via TURN (relay) ════════════
 {name,size,type} ═══════════════════════════════════════════▶ (DataChannel)
 64 KB chunk, 64 KB chunk, ... ══════════════════════════════▶ collect, progress bar
                  ◀══════════════════════════════════════════ "done"
 close connection, keep waiting on the code                   save file, leave room
```

---

## 2. Server: `main.py`

### Imports and config

```python
BASE = Path(__file__).parent
load_dotenv(BASE / ".env")

TURN_HOST = os.getenv("TURN_HOST", "127.0.0.1")
TURN_USER = os.getenv("TURN_USER", "webrtc")
TURN_PASS = os.getenv("TURN_PASS", "webrtc")
```
- `BASE` is the folder `main.py` lives in. All file paths are built from it, so the server works no matter which directory you start it from.
- `load_dotenv` reads `.env` into environment variables. The same `.env` is also read by `docker compose`, so the server and coturn always agree on the user and password.

### App and static files

```python
app = FastAPI()
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")
rooms: dict[str, list[WebSocket]] = {}
```
- Everything in `static/` is served at `/static/...`. That's how the browser loads `/static/app.js`.
- `rooms` maps a room name to the list of WebSockets in it. Live sockets can only live in memory, which is why the server runs as one uvicorn worker (one async process easily handles hundreds of rooms: it only relays a few small handshake messages per transfer). Restarting the server drops every socket, so a sender sees "disconnected from server" and has to pick the file again.
- `db` is Redis. It stores each code's state as `code:<room>`: `active` while the sender is connected (for at most `CODE_TTL`, 1 hour), then `expired` for another hour. That's what lets a receiver tell a mistyped code from one that has run out.

### `send_safe()`

```python
async def send_safe(ws: WebSocket, text: str):
    try:
        await ws.send_text(text)
    except Exception:
        pass
```
Every message the server sends to a browser goes through this. If the *other* person's connection dies at the same moment, `send_text` raises an error. Without the `try`, that error would crash **your** handler and disconnect you. With it, the failed send is ignored, and the dead peer's own handler cleans up after it.

### `GET /` and `GET /config`

`/` returns `static/index.html`. `/config` returns exactly the object the browser passes to `new RTCPeerConnection(...)`:
- `stun:stun.l.google.com:19302` is Google's free public STUN, a backup in case coturn is down.
- `stun:TURN_HOST:3478` is our coturn acting as STUN.
- `turn:TURN_HOST:3478?transport=udp` and `?transport=tcp` are our coturn acting as TURN. UDP is preferred. TCP helps on networks that block UDP.
- `username` / `credential` are the TURN login (TURN needs auth so strangers can't use your bandwidth).

Serving this from the server, instead of hardcoding it in JS, means you change IPs in **one** place (`.env`).

If `METERED_TURN_URL` is set in `.env`, `/config` instead fetches a ready-made list with fresh credentials from Metered's hosted TURN (reachable from anywhere, so it works across networks and CGNAT). The API key stays on the server. If that request fails, it falls back to the coturn list above. Open the page with `?relay=1` to force all traffic through TURN and test the relay.

### `WS /ws/{room_id}`: the signaling relay

- **The sender owns the code.** The sender connects with `?role=send`, which runs `SET code:<room> active NX`: only if no key exists, so a code that's active *or recently expired* is never handed out twice (taken → closed with 4409, and the page picks another code). Then it creates the room.
- A receiver checks Redis: no key → closed with **4404** ("no such code"); `expired` (or `active` but the room is gone after a server restart) → closed with **4410** ("code expired"). Redis down → **1011** ("server error").
- The moment the sender disconnects (new file picked, tab closed), the room is deleted and the key becomes `expired`, so the old code stops working instantly, and a receiver still connected gets `bye`.
- **1-hour limit:** the sender's receive loop runs inside `asyncio.timeout(CODE_TTL)`. When it fires, the server closes the sender with 4410 and sends the receiver `{"type":"bye","reason":"expired"}`. The `active` key lives 60 s longer than that timeout, so it can't vanish (and be grabbed by a new sender) before it's marked `expired`.
- A room holds at most **2** sockets. A third gets `{"type":"full"}` and is closed with code 1008. In the file share, that means "someone is already receiving on this code"; the page shows "code busy, try again in a moment".
- When the second socket arrives, the server sends `ready` **only to the first one**. Exactly one side must create the offer. If both did, the two offers would cross ("glare") and the connection would break.
- Every other message is forwarded unchanged to the other socket. The server never looks inside, which is why it's so small.
- When a socket leaves, the other one gets `bye`, and an empty room is deleted.

The server never receives a single byte of the file. It only sees the room name (the code) and the handshake messages.

---

## 3. The page: `static/index.html`

Two boxes and a progress bar:
- **Send:** `<input type="file">`, the big `#code` display, and a status line.
- **Receive:** a code input (`inputmode="numeric"` brings up the number pad on phones), a **Receive** button, and a status line.
- `<progress id="bar">` is hidden until a transfer starts.

`<link rel="icon" href="data:,">` is an empty icon. Without it, the browser requests `/favicon.ico`, gets a 404, and logs an error in the console. `app.js` is loaded at the end of `<body>` so all elements exist when it runs.

---

## 4. Browser logic: `static/app.js`

### State

```js
let ws;              // WebSocket to the signaling server
let pc;              // RTCPeerConnection to the other browser
let iceServers = []; // STUN/TURN list, fetched from /config
let chain = Promise.resolve();
let file = null;     // sender: the file being shared; receiver: null
let statusEl;        // status line of whichever side (send/receive) is active
```
`file` decides the role: if it's set, this tab is sending; if it's `null`, this tab is receiving. A tab is one or the other at a time.

### Starting: `$("file").onchange` and `$("receive").onclick`

- **Sender:** picking a file calls `leave()` (drops any previous code), stores the file, makes a code with `crypto.getRandomValues` (6 digits, zero-padded), shows it, and calls `join(code)`.
- **Receiver:** checks the input is exactly 6 digits, sets `file = null`, and calls `join(code)`. Enter in the code box does the same as clicking Receive.

With a million possible codes and codes that only live while a tab is open, accidental collisions are very unlikely for personal use.

### `join(code)`

```js
iceServers = (await (await fetch("/config")).json()).iceServers;
const socket = new WebSocket(`${proto}://${location.host}/ws/file-${code}`);
ws = socket;
chain = Promise.resolve();
```
- An HTTPS page must use `wss://`; `location.host` connects back to whatever address you opened the page with, so no IP is hardcoded.
- `socket.onclose` shows "code busy, try again in a moment" for close code 1008, and "disconnected from server" for anything else. The `socket === ws` check means a socket we closed ourselves doesn't trigger it.

### WebSocket messages and `chain`

```js
socket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    chain = chain.then(() => socket === ws && handle(msg)).catch(console.error);
};
```
`handle` is `async`. Without the chain, a `candidate` could be processed while the `offer` before it is still in `await setRemoteDescription(...)`, and `addIceCandidate` would fail. The chain processes messages strictly in arrival order. `socket === ws` skips leftovers from an old socket. A fresh chain on every join means a queue stuck on a closed connection (pending WebRTC promises on a closed `pc` never resolve) can't block the next join.

### `handle(msg)`: the signaling state machine

- **`ready`**: we were in the room first, so we make the offer: `createPeer()`, `setupChannel(pc.createDataChannel("file"))`, `createOffer` → `setLocalDescription`, send the offer. The channel must exist **before** `createOffer`, so the offer includes a data section.
- **`offer`**: `createPeer()`, apply it, create and send an answer.
- **`answer`**: applied only if we're in `have-local-offer`, so a stray duplicate is ignored.
- **`candidate`**: `addIceCandidate` in a `try`, so one unusable address (for example IPv6 on a network without it) doesn't break the connection.
- **`bye`**: the other side left before finishing. A sender closes the connection and keeps waiting on the same code; a receiver shows "sender left" and leaves. If `pc` is already `null` (the transfer finished normally), `bye` is ignored.

**Either side can be first.** Usually the sender is (they get the code before the receiver can type it), but if the receiver types the code first, the receiver makes the offer and creates the channel. That's why `setupChannel` decides what to do by `file`, not by who created the channel.

### `createPeer()`

Closes any old connection, creates `new RTCPeerConnection({ iceServers })`, and wires up:
- `onicecandidate`: every discovered address goes to the peer through the server straight away ("trickle ICE").
- `ondatachannel`: the side that didn't make the offer receives the channel here.
- `onconnectionstatechange`: on `failed`, shows a hint that different networks need a reachable TURN server. The `conn === pc` check ignores state changes from an old connection.

### `setupChannel(ch)`

```js
ch.binaryType = "arraybuffer";
if (!file) return receiveInto(ch);
if (ch.readyState === "open") start(); else ch.onopen = start;
```
Receivers get binary chunks as `ArrayBuffer`s. Senders start sending as soon as the channel is open. On the side that receives the channel through `ondatachannel`, it may already be open, hence the `readyState` check.

### Sending: `sendFile(ch)`

```js
const chunk = Math.min(CHUNK, pc.sctp?.maxMessageSize || CHUNK);
ch.send(JSON.stringify({ name, size, type }));
for (let off = 0; off < file.size; off += chunk) {
    if (ch.bufferedAmount > HIGH_WATER) await bufferedamountlow;
    if (ch.readyState !== "open") return;
    ch.send(await file.slice(off, off + chunk).arrayBuffer());
}
```
1. **First message is a string** with the file's name, size and MIME type. Everything after it is binary.
2. **Chunks are 64 KB**, or smaller if the other browser advertises a lower `maxMessageSize`. One huge `send()` would fail; small chunks also make the progress bar move.
3. **Back-pressure.** `send()` doesn't wait for the network; it queues. Reading a 2 GB file in a tight loop would queue it all in memory and Chrome would close the channel. So when more than `HIGH_WATER` (8 MB) is queued, the loop waits for the `bufferedamountlow` event (fired when the queue drops under 4 MB).
4. `file.slice(...).arrayBuffer()` reads only that piece from disk, so the sender never loads the whole file into memory.
5. If the receiver disappears mid-transfer, the channel stops being `open` and the loop stops.

When the receiver replies `"done"`, the sender closes the connection but **keeps its WebSocket**, so it's still in the room. The receiver then leaves, and the next person who types the code gets the file too.

### Receiving: `receiveInto(ch)`

```js
if (typeof e.data === "string") meta = JSON.parse(e.data);
else { parts.push(e.data); got += e.data.byteLength; }
if (got === meta.size) { save(meta, parts); ch.send("done"); }
```
- The DataChannel is reliable and ordered, so chunks arrive complete and in order. Joining them in arrival order rebuilds the file.
- The status shows bytes received and speed in MB/s.
- When `got` reaches `meta.size`, the file is saved and `"done"` is sent back. An empty file works too: `size` is 0, so the first message already completes it.
- `ch.onclose` fires when the sender closes the connection after `"done"`, or if the sender vanishes. If not everything arrived, it shows "sender disconnected before the file finished". Either way it calls `leave()`.

### `save(meta, parts)`

Builds a `Blob` from the chunks, makes a `blob:` URL, and clicks a hidden `<a download="name">` to start the download. The link stays visible ("save filename") in case the browser blocks the automatic download, which some phones do.

**Limit:** all chunks stay in memory until the Blob is saved, so files are capped at **25 MB** (`MAX_SIZE`). The file never touches the server, so the browsers enforce it: `share()` refuses a bigger file, and the receiver stops and leaves if the announced size is over the cap or more bytes arrive than announced (a modified sender page can't push more). Going past ~1-2 GB would need streaming to disk with `showSaveFilePicker()` (Chrome) or a service worker; the code marks this with a `ponytail:` comment.

### `closePeer()` and `leave()`

- `closePeer()` closes `pc` and sets it to `null`.
- `leave()` also closes the WebSocket (the server then sends `bye` to the other side). `ws` is set to `null` *before* `close()`, so `onclose` sees `socket !== ws` and doesn't report an error.

### Security

DataChannels are always encrypted (DTLS). Even when the data goes through TURN, the relay only sees encrypted packets. Anyone who knows the code while the sender's tab is open can download the file, so treat the code like a password and close the tab when you're done.

---

## 5. Docker: `Dockerfile` + `docker-compose.yml`

`docker compose up -d --build` starts two containers.

### The `web` container (FastAPI)

`Dockerfile`:
```dockerfile
FROM python:3.12-slim                      # small official Python image
WORKDIR /app
ENV PYTHONUNBUFFERED=1                     # print() shows up in `docker logs` immediately
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py .
COPY static ./static                       # the page + app.js are baked into the image
EXPOSE 8000
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000",
     "--ssl-keyfile", "certs/key.pem", "--ssl-certfile", "certs/cert.pem"]
```
- Requirements are copied and installed **before** the code. Docker caches each step, so editing `app.js` doesn't reinstall FastAPI.
- `--host 0.0.0.0` listens on all interfaces. `127.0.0.1` would only accept connections from inside the container.
- `.dockerignore` keeps `certs/`, `.env` and `__pycache__` out of the image, so secrets are never baked in.

In `docker-compose.yml`:
```yaml
web:
  build: .
  ports: ["8000:8000"]
  env_file: .env                 # TURN_HOST / TURN_USER / TURN_PASS for /config
  volumes:
    - ./certs:/app/certs:ro      # the certificate is mounted read-only, not copied in
```
Because static files are baked in, **re-run `docker compose up -d --build` after editing code**.

### The `coturn` container (STUN + TURN)

| Setting | Why |
|---|---|
| `image: coturn/coturn:4.18.0` | The standard open-source STUN/TURN server. **Pinned** to a version: coturn 4.18 removed the `--no-dtls` and `--no-cli` flags, which made an unpinned setup crash on startup |
| `3478:3478/udp` and `/tcp` | The STUN/TURN listening port, on both protocols |
| `49160-49400:49160-49400/udp` | Ports coturn uses to relay data, one per browser that uses the relay: ~120 rooms at once. Not much bigger, because Docker Desktop publishes every port individually |
| `command:` as a YAML list | Each flag is its own list item, so no stray empty arguments sneak in from line breaks |
| `-n` | Don't look for a config file. Everything is set by flags |
| `--lt-cred-mech` + `--user=USER:PASS` | Require a username/password (long-term credentials) |
| `--realm=webrtc.local` | An auth realm name. Any string works, no domain needed |
| `--external-ip=${EXTERNAL_IP}` | **Important.** Inside Docker, coturn only sees its container IP (`172.x`). This tells it which IP to put in relay candidates |
| `--min-port/--max-port` | Must match the published relay range |
| `--fingerprint` | Adds a checksum to STUN messages. Browsers expect it |
| `--no-tls` | No TURN-over-TLS (that would need a cert and a domain). The data is still encrypted by WebRTC end to end |
| `--log-file=stdout` | Logs go to `docker compose logs coturn` |

Note: coturn 4.18 always logs `ERROR CONFIG: Unknown argument:` (with nothing after it) at startup. It's a harmless quirk of the image.

---

## 6. HTTPS / the certificate

The server runs on HTTPS with a self-signed certificate whose `subjectAltName` lists your LAN IP, `127.0.0.1` and `localhost` (the `openssl` command is in the README). Because nobody "trusted" signed it, each device shows a warning once. After you click Proceed, the page and its `wss://` WebSocket work.

If your LAN IP changes (a different Wi-Fi network, or the hotspot hands out a new address), regenerate the cert with the new IP and update `.env`.

---

## 7. LAN vs internet: what actually happens

**Same Wi-Fi or hotspot:** each browser's `host` candidate (its LAN IP) is directly reachable by the other, so ICE picks `host <-> host`. The file never leaves your network. A phone that *is* the hotspot counts as being on the same network as the laptop connected to it.

**Different networks, normal home routers:** host candidates fail. STUN gives each side its public IP:port (`srflx`), and both sides send packets to each other at the same time. Most home NATs let that through ("UDP hole punching"). The transfer is direct.

**Strict NAT / mobile data / CGNAT:** hole punching often fails. Both sides fall back to `relay` candidates, and data goes browser → TURN → browser. For this to work from outside, the TURN server has to be reachable from the internet. Behind CGNAT your own coturn isn't, so you need a hosted TURN server.

Signaling (port 8000) must always be reachable by both browsers. On a LAN it already is. Over the internet you need a router port forward, a tunnel (cloudflared), or a cloud host.

---

## 8. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Page doesn't load on the other device | Windows Firewall is blocking inbound TCP 8000, or the network is set to Public while Docker is only allowed on Public/Private. Add an inbound rule for the ports |
| Receiver stuck on "waiting for sender..." | Wrong code, or the sender's tab was closed or refreshed (the code is gone) |
| "code busy, try again in a moment" | Someone else is receiving on that code right now. Wait for them to finish |
| "connection failed" | ICE found no working route. On a LAN, the firewall is blocking UDP. Across networks, TURN isn't reachable: check `EXTERNAL_IP`, port forwards, or use a hosted TURN server |
| "sender disconnected before the file finished" | The sender's tab closed, slept, or lost network mid-transfer. Phones pause background tabs, so keep the sender's screen on |
| Download doesn't start on a phone | Tap the "save filename" link |
| Large file crashes the receiving tab | Out of memory: the receiver holds the whole file until saving (see `save()`) |
| Status "can't reach server" / "disconnected from server" | The `web` container is down. Check `docker compose ps` and `docker compose logs web` |
| Code changes don't show up | Static files are baked into the image. Run `docker compose up -d --build` and hard-refresh (Ctrl+F5) |
| coturn keeps restarting | A flag isn't supported by that coturn version. Run `docker compose logs coturn` and look for "unrecognized option" |

Useful browser pages: `chrome://webrtc-internals` (Chrome) and `about:webrtc` (Firefox) show every candidate, the selected pair, and DataChannel byte counts.

---

## 9. How it was tested

An automated test drove two headless Chrome tabs against the Docker containers:

| Scenario | What's verified |
|---|---|
| Send a random file | Receiver's file has the same SHA-256 hash as the original |
| Second receiver, same code | Gets the file too, after the first one finished |
| Sender status | Shows "sent ✓" after the receiver confirms |

Not covered yet: real phones, Firefox and Safari, transfers across the internet, and real-world speed (loopback speed on the test machine was limited by its own network stack, not by the app).
