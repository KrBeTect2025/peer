# How this WebRTC app works

This file walks through every piece of the project. It starts with the ideas, then goes through the server, the browser code, and the STUN/TURN server, and ends with LAN vs internet behavior and a troubleshooting table.

```
app/
  main.py              FastAPI: serves the page, hands out ICE config, relays signaling messages
  static/index.html    the page (videos, buttons, chat box)
  static/app.js        all the WebRTC logic in the browser
  Dockerfile           how the FastAPI app is packaged into a container
  docker-compose.yml   runs two containers: "web" (FastAPI) and "coturn" (STUN + TURN)
  .env                 your IPs and TURN password (not committed)
  certs/               self-signed HTTPS certificate (not committed)
```

---

## 1. The big picture

WebRTC lets two browsers send video, audio and data **directly to each other**. The media does not go through your FastAPI server. But before the browsers can connect, they have to exchange some setup information, and WebRTC deliberately doesn't say how you do that. That exchange is called **signaling**, and it's the only job of our FastAPI server.

| Term | What it is | Where it lives in this project |
|---|---|---|
| **Signaling** | Passing setup messages between the two browsers before they're connected | WebSocket `/ws/{room}` in `main.py` |
| **SDP** (offer / answer) | A text blob describing "here are my codecs, my tracks, my encryption keys". One side sends an **offer**, the other replies with an **answer** | `createOffer()` / `createAnswer()` in `app.js` |
| **ICE candidate** | One possible network address where a browser can be reached (IP + port + type) | `onicecandidate` / `addIceCandidate()` |
| **STUN** | A server that tells a browser "this is what your public IP:port looks like from outside". It's cheap and only used during setup | coturn on port 3478 + Google's public STUN |
| **TURN** | A server that **relays** the media when a direct connection is impossible (strict NATs, firewalls). It uses bandwidth and is the fallback | coturn, ports 3478 + 49160-49200 |
| **DataChannel** | A peer-to-peer pipe for arbitrary data. Here we use it for chat | `createDataChannel("chat")` |

### The full sequence

```
 Browser A (first in room)        FastAPI server             Browser B (second)
 ─────────────────────────        ──────────────             ──────────────────
 GET /config  ───────────────────▶ iceServers
 getUserMedia (camera)
 WS connect /ws/abc123 ──────────▶ room = [A]
                                   iceServers ◀───────────── GET /config
                                                             getUserMedia
                                   room = [A, B] ◀────────── WS connect /ws/abc123
 ◀──────── {"type":"ready"} ────── (only to A)
 createPeer, createDataChannel
 createOffer → setLocalDescription
 {"type":"offer"} ───────────────▶ forward ────────────────▶ createPeer
                                                             setRemoteDescription(offer)
                                                             createAnswer → setLocalDescription
 setRemoteDescription(answer) ◀── forward ◀───────────────── {"type":"answer"}
 {"type":"candidate"} x N ───────▶ forward ────────────────▶ addIceCandidate
 addIceCandidate ◀─────────────── forward ◀───────────────── {"type":"candidate"} x N

 ════════════ ICE checks: direct (host/srflx) or via TURN (relay) ════════════
 ◀═══════════════════ video + audio + chat (encrypted, peer-to-peer) ═════════▶
```

Once the browsers are connected, the WebSocket only carries a `bye` message if someone leaves.

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
- `BASE` is the folder `main.py` lives in. All file paths are built from it, so the server works no matter which directory you start it from. (The old version used `FileResponse("index.html")`, which broke if you ran uvicorn from another folder.)
- `load_dotenv` reads `.env` into environment variables. The same `.env` is also read by `docker compose`, so the server and coturn always agree on the user and password.

### App and static files

```python
app = FastAPI()
app.mount("/static", StaticFiles(directory=BASE / "static"), name="static")
rooms: dict[str, list[WebSocket]] = {}
```
- Everything in `static/` is served at `/static/...`. That's how the browser loads `/static/app.js`.
- `rooms` maps a room name to the list of WebSockets in it. It's plain memory, so restarting the server empties all rooms. That's fine for a small app.

### `send_safe()`

```python
async def send_safe(ws: WebSocket, text: str):
    try:
        await ws.send_text(text)
    except Exception:
        pass
```
Every message the server sends to a browser goes through this. If the *other* person's connection dies at the same moment you send them something, `send_text` raises an error. Without the `try`, that error would crash **your** handler and disconnect you, even though your connection is fine. With it, the failed send is ignored, and the dead peer's own handler cleans up after it.

### `GET /` and `GET /config`

```python
@app.get("/")
def index():
    return FileResponse(BASE / "static" / "index.html")

@app.get("/config")
def config():
    return {"iceServers": [ ...stun..., ...turn... ]}
```
`/config` returns exactly the object the browser passes to `new RTCPeerConnection(...)`:
- `stun:stun.l.google.com:19302` is Google's free public STUN, a backup in case coturn is down.
- `stun:TURN_HOST:3478` is our coturn acting as STUN.
- `turn:TURN_HOST:3478?transport=udp` and `?transport=tcp` are our coturn acting as TURN. UDP is preferred. TCP helps on networks that block UDP.
- `username` / `credential` are the TURN login (TURN needs auth so strangers can't use your bandwidth).

Serving this from the server, instead of hardcoding it in JS, means you change IPs in **one** place (`.env`).

### `WS /ws/{room_id}`: the signaling relay

```python
await websocket.accept()
peers = rooms.setdefault(room_id, [])
```
Accept the connection and get (or create) the room's list.

```python
if len(peers) >= 2:
    await websocket.send_text(json.dumps({"type": "full"}))
    await websocket.close(code=1008)
    return
```
This is a 1:1 app, so a third person gets told `full` and is disconnected (1008 = "policy violation" close code).

```python
peers.append(websocket)
if len(peers) == 2:
    await send_safe(peers[0], json.dumps({"type": "ready"}))
```
**Why tell only the first peer?** Exactly one side must create the offer. If both did, you'd get "glare" (two offers crossing each other), and the connection breaks. The server decides: whoever was waiting in the room is the caller.

```python
while True:
    text = await websocket.receive_text()
    for peer in peers:
        if peer is not websocket:
            await send_safe(peer, text)
```
The server doesn't look inside messages. Whatever one browser sends (offer, answer, candidate), the other browser receives unchanged. That's why the server is so small. All the logic is in the browser.

```python
except WebSocketDisconnect:
    pass
finally:
    peers.remove(websocket)
    for peer in peers:
        await send_safe(peer, json.dumps({"type": "bye"}))
    if not peers:
        del rooms[room_id]
```
When someone leaves (closes the tab, hangs up, loses network), the other person gets `bye`. The room is deleted once empty. `send_safe` covers the case where both people leave at the same moment.

---

## 3. The page: `static/index.html`

```html
<video id="local" autoplay playsinline muted></video>
<video id="remote" autoplay playsinline></video>
```
- `autoplay` starts the video as soon as a stream is attached.
- `playsinline` stops iPhones from forcing the video fullscreen.
- `muted` on **your own** video stops you hearing your own mic, which would cause echo or feedback. It also allows autoplay, because browsers block autoplay with sound. The remote video is **not** muted, so you hear the other person. (Pressing Join counts as a user click, so browsers let it play with sound.)

`<link rel="icon" href="data:,">` is an empty icon. Without it, the browser requests `/favicon.ico`, gets a 404, and logs an error in the console.

The rest is a room box, Join/Hang up buttons, a status `<span>`, a `<pre id="chat">` log, and a message input. `app.js` is loaded at the end of `<body>` so all elements exist when it runs.

---

## 4. Browser logic: `static/app.js`

### State

```js
let ws;            // WebSocket to our FastAPI signaling server
let pc;            // RTCPeerConnection to the other browser
let channel;       // RTCDataChannel used for chat
let localStream;   // our camera + mic
let iceServers = [];
let chain = Promise.resolve();
```
- `pc` (RTCPeerConnection) is the core WebRTC object. One per call.
- `chain` is a promise queue (explained in [WebSocket messages and `chain`](#websocket-messages-and-chain) below).

### Helpers

```js
const $ = (id) => document.getElementById(id);
const status = (t) => ($("status").textContent = t);
const say = (t) => { ...append line to chat, scroll to bottom... };
const send = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
};
const forceRelay = new URLSearchParams(location.search).has("relay");
```
`send` turns a JS object into JSON and puts it on the WebSocket. If you've already hung up (the socket is gone or closing), it silently does nothing instead of throwing. This matters because the browser can still be finding ICE candidates for a moment after you hang up. `forceRelay` is `true` if the URL has `?relay=1`. It's for testing TURN (see `createPeer`).

### `createPeer()`: build the connection

```js
if (pc) pc.close();
const conn = new RTCPeerConnection({
    iceServers,
    iceTransportPolicy: forceRelay ? "relay" : "all",
});
pc = conn;
```
- Closes any old connection first (for example, a peer left and a new one joined).
- `conn` is a local copy that the event handlers below use. The global `pc` can later become `null` (hang up) or a different connection (new peer). Handlers that close over `conn` always talk about *their own* connection.
- `iceServers` comes from `/config`. Without STUN and TURN, the browser only knows its local LAN address, so internet calls fail.
- `iceTransportPolicy: "relay"` makes the browser use **only** TURN candidates. If a call connects in this mode, coturn definitely works. Normally it's `"all"`, and the browser picks the best route.

```js
if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
}
```
Adds your video track and audio track to the connection. Passing `localStream` as the second argument groups them, so the other side gets them together in `e.streams[0]`.

```js
pc.onicecandidate = (e) => {
    if (e.candidate) send({ type: "candidate", candidate: e.candidate });
};
```
As soon as you call `setLocalDescription`, the browser starts discovering addresses:
- **host**: your LAN IP (for example `192.168.1.20`)
- **srflx** (server-reflexive): your public IP:port, learned from STUN
- **relay**: an address on the TURN server

Each one fires this event and gets sent to the peer straight away. This is called "trickle ICE", and it's faster than waiting for all of them. `e.candidate` is `null` once gathering is done, so we skip that.

```js
pc.ontrack = (e) => { $("remote").srcObject = e.streams[0]; };
```
Fires when the other side's audio or video arrives. Attaching the stream to the `<video>` displays it.

```js
pc.ondatachannel = (e) => setupChannel(e.channel);
```
Only the caller creates the chat channel. The answering side receives it here.

```js
pc.onconnectionstatechange = () => {
    status(conn.connectionState);
    if (conn.connectionState === "connected") logRoute(conn).catch(() => {});
};
```
Shows `new → connecting → connected` (or `failed` / `disconnected`) in the status. Once connected, it logs which route was chosen.

### `setupChannel(ch)`: chat

```js
channel = ch;
channel.onopen    = () => say("-- chat connected --");
channel.onclose   = () => say("-- chat closed --");
channel.onmessage = (e) => say("peer: " + e.data);
```
Both sides end up with a `channel`. The caller creates it, the answerer gets it through `ondatachannel`. Chat messages go peer-to-peer, encrypted, and never touch the server.

### `logRoute()`: did we use TURN?

```js
const stats = await conn.getStats();
stats.forEach((s) => {
    if (s.type === "transport" && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
});
if (!pair) stats.forEach((s) => { if (s.type === "candidate-pair" && s.selected) pair = s; }); // Firefox
```
`getStats()` returns the connection's internal statistics. Chrome records the chosen candidate pair on the `transport` entry, and Firefox flags it with `selected`. We then look up both candidates and print their `candidateType`:

| Output | Meaning |
|---|---|
| `host <-> host` | Direct on the same LAN. Best case. |
| `srflx <-> srflx` (or mixed) | Direct over the internet, NAT punched with STUN's help |
| `relay <-> ...` | Going through your coturn (TURN) |

### `handle(msg)`: the signaling state machine

**`ready`**: you're the caller.
```js
createPeer();
setupChannel(pc.createDataChannel("chat"));
if (!localStream) {
    pc.addTransceiver("video", { direction: "recvonly" });
    pc.addTransceiver("audio", { direction: "recvonly" });
}
await pc.setLocalDescription(await pc.createOffer());
send({ type: "offer", sdp: pc.localDescription });
```
1. Build the connection (tracks already added).
2. Create the chat channel. It must exist **before** `createOffer`, so the offer includes a data section.
3. **No camera?** The offer is a list of "media slots" (one per audio or video track). If the caller has no camera, there are no tracks, so the offer has no video slot. The answerer then has nowhere to put *its* video, and the caller sees nothing. `addTransceiver(..., "recvonly")` adds empty slots that say "I won't send video, but I want to receive it."
4. `createOffer()` writes the SDP. `setLocalDescription` commits to it and starts ICE gathering, which fires `onicecandidate`.
5. Send the offer to the peer.

**`offer`**: you're the callee.
```js
createPeer();
await pc.setRemoteDescription(msg.sdp);
await pc.setLocalDescription(await pc.createAnswer());
send({ type: "answer", sdp: pc.localDescription });
```
Accept their description, generate a matching answer, commit to it (this starts your own ICE gathering), and send it back.

**`answer`**:
```js
if (pc && pc.signalingState === "have-local-offer") await pc.setRemoteDescription(msg.sdp);
```
The caller applies the answer. The state check ignores a stray or duplicate answer instead of throwing an error.

**`candidate`**:
```js
await pc.addIceCandidate(msg.candidate);   // in try/catch
```
Gives the browser one more address to try. Wrapped in `try`, because a single bad candidate (for example an IPv6 address your network can't use) shouldn't break the call.

**`bye`**: the other person left. Close the connection, blank the remote video, and wait. When someone new joins, the server sends you `ready` again, and you call them.

**`full`**: calls `hangup("room is full")`. The server also closes the socket with code 1008 (see `onclose` below), so either path ends up showing "room is full".

### WebSocket messages and `chain`

```js
const socket = new WebSocket(...);
ws = socket;
chain = Promise.resolve();
socket.onmessage = (e) => {
    const msg = JSON.parse(e.data);
    chain = chain.then(() => socket === ws && handle(msg)).catch(console.error);
};
```
- `handle` is `async`. Without the chain, a `candidate` could start being processed while the `offer` before it is still in `await setRemoteDescription(...)`. `addIceCandidate` would then fail with "no remote description". The chain makes each message wait until the previous one is fully done, so they're processed strictly in arrival order. The `.catch` keeps the chain alive if one message throws.
- `socket === ws` checks that the message came from the *current* connection. If you hung up and rejoined, leftover messages from the old socket are skipped.
- `chain = Promise.resolve()` starts a **fresh queue for every join**. This fixes a real bug found in testing. If you hang up while the browser is in the middle of `createOffer()`, `pc.close()` leaves that promise pending **forever** (the WebRTC spec says pending operations on a closed connection never resolve). The old queue would wait on it forever, and rejoining in the same tab would never connect.

### `join()`

```js
try {
    iceServers = (await (await fetch("/config")).json()).iceServers;
} catch (err) {
    status("can't reach server");
    ...
}
localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
$("local").srcObject = localStream;
```
- Get the STUN/TURN list from the server. If the server is unreachable, say so and re-enable Join, instead of leaving the button stuck disabled.
- Ask for camera and mic (the browser shows a permission prompt). This **only works on HTTPS or `localhost`**. That's why the server runs with a certificate. If it fails (no camera, permission denied), we carry on in chat-only mode.

```js
const proto = location.protocol === "https:" ? "wss" : "ws";
ws = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(room)}`);
```
An HTTPS page must use secure WebSockets (`wss://`). Browsers block `ws://` from an `https://` page. `location.host` means it connects back to whatever address you opened the page with (localhost, LAN IP or public IP), so no IP is hardcoded.

```js
socket.onclose = (e) => {
    if (socket === ws) hangup(e.code === 1008 ? "room is full" : "disconnected from server");
};
```
If the server drops us, we clean up and show why. Close code 1008 is what the server uses for "room full". Any other close means the server stopped or the network died. The `socket === ws` check means a socket we closed ourselves (by hanging up) doesn't trigger this.

### `closePeer()` and `hangup(reason)`

- `closePeer()` closes `pc`, forgets the channel, and clears the remote video. It's used on `bye`.
- `hangup(reason)` runs `closePeer()`, closes the WebSocket (the server then sends `bye` to the other person), and **stops the camera tracks**, which turns the camera light off. It also resets the buttons and sets the status to `reason`, or "idle" when you clicked Hang up yourself. `ws` is set to `null` *before* `close()`, so the `onclose` handler sees `socket !== ws` and doesn't run `hangup()` a second time.

### `sendChat()`

Checks that the channel is `open`, calls `channel.send(text)`, and echoes `me: ...` locally. Enter in the input box does the same thing as clicking Send.

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
| `image: coturn/coturn:4.18.0` | The standard open-source STUN/TURN server. **Pinned** to a version: coturn 4.18 removed the `--no-dtls` and `--no-cli` flags, which made an unpinned setup crash on startup. Pinning stops a future image update from breaking it again |
| `3478:3478/udp` and `/tcp` | The STUN/TURN listening port, on both protocols |
| `49160-49200:49160-49200/udp` | Ports coturn uses to relay media. That's 41 ports, about 20 simultaneous relayed calls. The range is kept small because Docker Desktop publishes every port individually |
| `command:` as a YAML list | Each flag is its own list item, so no stray empty arguments sneak in from line breaks |
| `-n` | Don't look for a config file. Everything is set by flags |
| `--lt-cred-mech` + `--user=USER:PASS` | Require a username/password (long-term credentials) |
| `--realm=webrtc.local` | An auth realm name. Any string works, no domain needed |
| `--external-ip=${EXTERNAL_IP}` | **Important.** Inside Docker, coturn only sees its container IP (`172.x`). This tells it which IP to put in relay candidates. Use your LAN IP for LAN testing, or your public IP for internet use |
| `--min-port/--max-port` | Must match the published relay range |
| `--fingerprint` | Adds a checksum to STUN messages. Browsers expect it |
| `--no-tls` | No TURN-over-TLS (that would need a cert and a domain). The media itself is still encrypted by WebRTC (DTLS-SRTP) end to end. TURN only ever sees encrypted packets |
| `--log-file=stdout` | Logs go to `docker compose logs coturn` |

`${TURN_USER}` and the other variables are filled in from `.env` by `docker compose`.

Note: coturn 4.18 always logs `ERROR CONFIG: Unknown argument:` (with nothing after it) at startup, even with no flags at all. It's a harmless quirk of the image.

---

## 6. HTTPS / the certificate

Browsers treat `http://192.168.x.x` as insecure and disable `getUserMedia` there. The `openssl` command in the README makes a self-signed certificate whose `subjectAltName` lists your LAN IP, `127.0.0.1` and `localhost`. Uvicorn serves HTTPS with it (`--ssl-keyfile/--ssl-certfile`). Because nobody "trusted" signed it, each device shows a warning once. After you click Proceed, the page counts as secure, so the camera and `wss://` both work.

If your LAN IP changes (a different Wi-Fi network), regenerate the cert with the new IP and update `.env`.

---

## 7. LAN vs internet: what actually happens

**Same Wi-Fi:** each browser's `host` candidate (its LAN IP) is directly reachable by the other, so ICE picks `host <-> host`. STUN and TURN are gathered but never used. Media never leaves your network.

**Different networks, normal home routers:** host candidates fail. STUN gives each side its public IP:port (`srflx`), and both sides send packets to each other at the same time. Most home NATs let that through (this is "UDP hole punching"). The connection is direct, and TURN isn't used.

**Strict NAT / corporate firewall / some mobile carriers:** hole punching fails. Both sides fall back to `relay` candidates. Media goes browser → coturn → browser. For this to work from outside your home, coturn has to be reachable at your public IP, which is why you need the router port forwards and `EXTERNAL_IP=<public IP>`.

Signaling (port 8000) must always be reachable by both browsers. On a LAN it already is. Over the internet you need the router forward, or a tunnel.

---

## 8. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Camera prompt never appears, "NotAllowedError" or `getUserMedia` undefined | The page is on `http://` with a non-localhost IP. Use `https://` |
| Status stuck on "waiting for peer..." | The other person used a different room name, or their WebSocket can't reach the server (firewall, wrong IP) |
| Status goes `connecting` → `failed` | ICE found no working route. On a LAN, Windows Firewall is blocking. Over the internet, TURN isn't reachable: check the port forwards, `EXTERNAL_IP`, and `docker compose logs coturn` |
| `?relay=1` fails but normal mode works | coturn problem: Docker not running, wrong `EXTERNAL_IP`, a password mismatch between `.env` and the running container (re-run `docker compose up -d`), or UDP 49160-49200 blocked |
| Remote video black but chat works | The other side denied camera access or has no camera. Look for a "chat only" line in their chat log |
| Echo / feedback | Two devices in the same room. Use headphones |
| Works on LAN, not from outside | Port forwards missing, or your ISP uses CGNAT (see README) |
| Cert warning on every visit | Normal for self-signed. Firefox and Chrome remember the exception per address |
| Status "can't reach server" / "disconnected from server" | The `web` container is down. Check `docker compose ps` and `docker compose logs web` |
| Code changes don't show up | Static files are baked into the image. Run `docker compose up -d --build` and hard-refresh (Ctrl+F5) |
| coturn keeps restarting | A flag isn't supported by that coturn version. Run `docker compose logs coturn` and look for "unrecognized option" |

Useful browser pages: `chrome://webrtc-internals` (Chrome) and `about:webrtc` (Firefox) show every candidate, the selected pair, and bitrate graphs.

---

## 9. How it was tested

An automated test drove real Chrome (with a fake camera and mic) against the Docker containers at `https://<LAN_IP>:8000`, and passed repeatedly. It checks:

| Scenario | What's verified |
|---|---|
| Normal call | Both connect, both see each other's video (frames actually advancing), chat works both ways, route is `host <-> host` |
| Third person joins | Gets "room is full"; the existing call is untouched |
| Hang up + rejoin | Other side sees "peer left", camera is released, rejoin reconnects with video and chat |
| Tab closed without hanging up | Other side still gets "peer left" |
| Forced TURN (`?relay=1`) | Connects through coturn (`relay <-> relay`), with video and chat |
| Caller has no camera | Still receives the callee's video, and chat works |
| Nobody has a camera | Chat-only call works |
| Hang up mid-setup, then rejoin | Reconnects (this caught the stuck-queue bug) |
| Server restarted mid-call | UI shows "disconnected from server" and Join is enabled again |
| All pages | No JavaScript errors in the console |

Not covered by the automated tests: a real second device, Firefox and Safari, and calls across the internet (those need your router).
