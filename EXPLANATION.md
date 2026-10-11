# How this P2P file share works

This file walks through every piece of the project. It starts with the ideas, then goes through the server, the browser code, and Docker + the Cloudflare tunnel, and ends with how the browsers find a route to each other and a troubleshooting table.

```
app/
  main.py              FastAPI: serves the page, hands out ICE config, relays signaling messages
  static/index.html    the page (Send box, Receive box, progress bar)
  static/app.js        all the WebRTC + file transfer logic in the browser
  Dockerfile           how the FastAPI app is packaged into a container
  docker-compose.yml   runs "web" (FastAPI), "redis" (active codes) and "tunnel" (Cloudflare)
  .env                 your Metered TURN credentials URL (not committed)
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
| **STUN** | A server that tells a browser "this is what your public IP:port looks like from outside". Only used during setup | Metered's STUN + Google's public STUN |
| **TURN** | A server that **relays** the (still encrypted) data when a direct connection is impossible. It uses bandwidth and is the fallback | Metered's hosted TURN (`METERED_TURN_URL`) |
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
 {name,size,type} ═══════════════════════════════════════════▶ (DataChannel) pick where to save
                  ◀══════════════════════════════════════════ "go"
 64 KB chunk, 64 KB chunk, ... ══════════════════════════════▶ write to disk in 8 MB batches
                  ◀══════════════════════════════════════════ "ack <bytes on disk>" (after each batch)
                  ◀══════════════════════════════════════════ "done"
 close connection, keep waiting on the code                   file saved, leave room
```

---

## 2. Server: `main.py`

### Imports and config

```python
BASE = Path(__file__).parent
load_dotenv(BASE / ".env")

METERED_TURN_URL = os.getenv("METERED_TURN_URL")
```
- `BASE` is the folder `main.py` lives in. All file paths are built from it, so the server works no matter which directory you start it from.
- `load_dotenv` reads `.env` into environment variables. In Docker, `env_file: .env` does the same job.

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

`/` returns `static/index.html`. `/config` returns exactly the object the browser passes to `new RTCPeerConnection(...)`.

It fetches a ready-made `iceServers` list from Metered's hosted STUN/TURN (`METERED_TURN_URL` in `.env`): STUN addresses plus TURN servers with fresh credentials. TURN is reachable from anywhere, so two browsers on any networks (even behind CGNAT or mobile data) can connect. Serving the list from the server keeps the API key out of the page.

The Metered API takes seconds to answer, so the list is cached for an hour (a failed refresh keeps the old list and retries in a minute). If Metered can't be reached at all, `/config` falls back to Google's public STUN only: browsers that can connect directly still do; ones behind strict NAT fail with "connection failed". Open the page with `?relay=1` to force all traffic through TURN and test the relay.

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

### The channel protocol

| Direction | Message | Meaning |
|---|---|---|
| sender → receiver | `{"name","size","type"}` (string) | What's coming |
| receiver → sender | `"go"` | The receiver has somewhere to save it; start sending |
| sender → receiver | binary, 64 KB each | The file, in order |
| receiver → sender | `"ack <n>"` | The first `n` bytes are written to disk |
| receiver → sender | `"done"` | The whole file is saved; the sender closes the connection |

### Sending: `sendFile(ch)`

```js
ch.send(JSON.stringify({ name, size, type }));
while (!go) await nap();                                  // wait for the receiver's "go"
for (let off = 0; off < file.size; off += chunk) {
    while (ch.bufferedAmount > HIGH_WATER || off - acked > WINDOW) await nap();
    ch.send(await file.slice(off, off + chunk).arrayBuffer());
}
```
1. **First message is a string** with the file's name, size and MIME type. Everything after it is binary.
2. **Chunks are 64 KB**, or smaller if the other browser advertises a lower `maxMessageSize`.
3. **Two brakes.** `HIGH_WATER` (1 MB): `send()` only queues, so the loop pauses while that much is waiting to go
   out on the network. `WINDOW` (64 MB): the loop also pauses while it's more than 64 MB ahead of the receiver's last
   `ack`. That second brake is what keeps the *receiver's* memory flat when its disk is slower than the network.
4. `nap()` sleeps until something changes: an `ack`, `"go"`, the network queue draining (`bufferedamountlow`), or the
   channel closing.
5. `file.slice(...).arrayBuffer()` reads only that piece from disk, so the sender never loads the whole file into memory.
6. If the receiver disappears mid-transfer, the channel stops being `open` and the loop stops.
7. The status line repaints at most 4 times a second (`paintDue()`); a 50 GB file is ~800,000 chunks.

There's no size cap on the sender: the receiver decides what it can save.

When the receiver replies `"done"`, the sender closes the connection but **keeps its WebSocket**, so it's still in the room. The receiver then leaves, and the next person who types the code gets the file too.

### Receiving: `receiveInto(ch)` and `openSink(meta)`

When the `{name,size,type}` message arrives, `openSink()` picks where the file goes, best first:

| Browser | Where the bytes go | Size limit |
|---|---|---|
| **Chrome / Edge** (`showSaveFilePicker`) | A "save name (size)" button appears; it opens the system save dialog (it may only open from a click), and every batch is written straight into the chosen file | Free disk space |
| **Firefox / Safari** (`navigator.storage.getDirectory`, OPFS) | The site's private disk storage, then handed over as a normal download at the end | The browser's storage quota for the site (checked before starting), and the size free twice until the download copy is done |
| **Neither** | Memory | `MEM_MAX`, 1 GB |

Then the receiver sends `"go"`, and for every chunk:
- adds it to a batch; at 8 MB (`FLUSH`) the batch is written to disk as one `Blob`, and `"ack <bytes so far>"` goes
  back once the write has finished. Writes are chained on one promise, so they land in order.
- refuses (and leaves) if more bytes arrive than were announced, so a modified sender page can't push more.
- when `got` reaches `meta.size`, waits for the last write, closes the file (Chrome writes into `name.crswap` and
  renames it here), sends `"done"`, and shows "received ✓". An empty file works too.

`ch.onclose` fires when the sender closes the connection after `"done"`, or if the sender vanishes. If not everything arrived, it shows "transfer stopped". Either way it calls `leave()`.

**Tested:** a 50 GB file through the Chrome save dialog and 9.5 GB through OPFS, both byte-identical, with the receiving browser flat at ~420 MB the whole time. The old in-memory version needed ~2.4× the file size in RAM and broke at 8 GB on a 16 GB laptop. Chrome and Edge gave a site 10 GB of OPFS on the test machine, which is why they use the save dialog instead.

### `closePeer()` and `leave()`

- `closePeer()` closes `pc` and sets it to `null`.
- `leave()` also closes the WebSocket (the server then sends `bye` to the other side). `ws` is set to `null` *before* `close()`, so `onclose` sees `socket !== ws` and doesn't report an error.

### Security

DataChannels are always encrypted (DTLS). Even when the data goes through TURN, the relay only sees encrypted packets. Anyone who knows the code while the sender's tab is open can download the file, so treat the code like a password and close the tab when you're done.

---

## 5. Docker: `Dockerfile` + `docker-compose.yml`

`docker compose up -d --build` starts three containers: `web`, `redis` and `tunnel`.

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
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]   # plain HTTP: the tunnel adds HTTPS
```
- Requirements are copied and installed **before** the code. Docker caches each step, so editing `app.js` doesn't reinstall FastAPI.
- `--host 0.0.0.0` listens on all interfaces. `127.0.0.1` would only accept connections from inside the container.
- `.dockerignore` keeps `.env` and `__pycache__` out of the image, so secrets are never baked in.

In `docker-compose.yml`:
```yaml
web:
  build: .
  ports: ["127.0.0.1:8000:8000"]   # this PC only: everyone else comes in through the tunnel
  env_file: .env                   # METERED_TURN_URL for /config
  environment:
    REDIS_URL: redis://redis:6379/0
  dns: [1.1.1.1, 8.8.8.8]          # some networks' DNS is flaky; /config needs to reach Metered
redis:
  image: redis:7-alpine            # no persistence: codes live an hour at most anyway
```
Because static files are baked in, **re-run `docker compose up -d --build` after editing code**.

---

## 6. HTTPS: the Cloudflare tunnel

The `tunnel` container runs `cloudflared tunnel --url http://web:8000`.
The server only speaks plain HTTP on port 8000. `cloudflared` opens an outbound connection to Cloudflare and gives you a public `https://xxxx.trycloudflare.com` address with a real certificate, so no router port forwarding, no self-signed certificate warnings, and it works behind CGNAT. The page then uses `wss://` for signaling automatically (`location.protocol` is `https:`). A quick tunnel's address changes every time it restarts; `curl http://127.0.0.1:20241/quicktunnel` (its metrics port) prints the current one.

---

## 7. How the browsers find a route

ICE tries every route and keeps the best one that works. `findRoute()` in `app.js` shows which one won in the status line.

**Same network:** each browser's `host` candidate (its local IP) is directly reachable by the other, so ICE picks `host <-> host` ("direct, same network"). The file never leaves your network, even though both people opened the Cloudflare link.

**Different networks, normal home routers:** STUN gives each side its public IP:port (`srflx`), and both sides send packets to each other at the same time. Most home NATs let that through ("UDP hole punching"). The transfer is direct.

**Strict NAT / mobile data / CGNAT:** hole punching often fails. Both sides fall back to `relay` candidates, and data goes browser → Metered TURN → browser (still encrypted end to end). This uses your Metered bandwidth quota.

---

## 8. Troubleshooting

| Symptom | Likely cause / fix |
|---|---|
| Link doesn't load | The tunnel container restarted, so the address changed. Get the new one with `curl http://127.0.0.1:20241/quicktunnel` |
| "code busy, try again in a moment" | Someone else is receiving on that code right now. Wait for them to finish |
| "connection failed" | ICE found no working route, so TURN wasn't usable: check `METERED_TURN_URL` and your Metered quota, and look for "Metered TURN failed" in `docker compose logs web` |
| "sender disconnected before the file finished" | The sender's tab closed, slept, or lost network mid-transfer. Phones pause background tabs, so keep the sender's screen on |
| Download doesn't start on a phone | Tap the "save filename" link |
| "not enough browser storage" | Firefox/Safari path: the file is bigger than the site's storage quota. Receive it in Chrome or Edge, which save straight to a file |
| Status "can't reach server" / "disconnected from server" | The `web` container is down. Check `docker compose ps` and `docker compose logs web` |
| Code changes don't show up | Static files are baked into the image. Run `docker compose up -d --build` and hard-refresh (Ctrl+F5) |

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
