// P2P file transfer: the file goes browser -> browser over an RTCDataChannel.
// The server only relays the handshake (offer/answer/candidates); it never sees file bytes.

// ---------- state ----------
let ws;                        // WebSocket to the signaling server
let pc;                        // RTCPeerConnection to the other browser
let iceServers = [];           // STUN/TURN list, fetched from /config
let route = "";                // how the browsers reached each other: "direct" or "relay"
let chain = Promise.resolve(); // runs signaling messages one at a time, in order
let file = null;               // sender: the file being shared; receiver: null
let statusEl;                  // status line of whichever side (send/receive) is active
let joinId = 0;                // bumped by leave(), so a join still awaiting config can't revive an old code

const CHUNK = 64 * 1024;             // bytes per DataChannel message
const HIGH_WATER = 1024 * 1024;      // pause reading the file while this much is queued unsent
// the server never sees the file, so the browsers enforce this: the sender won't share more, the receiver won't accept more
const MAX_SIZE = 25 * 1048576;

const $ = (id) => document.getElementById(id);
const status = (t) => (statusEl.textContent = t);
const mb = (n) => (n / 1048576).toFixed(1) + " MB";
const progress = (done, total) => {
    $("bar").hidden = false;
    $("bar").value = total ? done / total : 1;
};
// fetch ICE servers as soon as the page opens, so pressing Send/Receive doesn't wait for it
const loadConfig = () => fetch("/config").then((r) => r.json()).then((c) => c.iceServers);
let configReady = loadConfig();
// the first RTCPeerConnection in a browser can take seconds to create (WebRTC network setup);
// pay that right after the page renders, while the user is still picking a file or typing the code
setTimeout(() => new RTCPeerConnection().close(), 0);
const send = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
};

// ---------- peer connection ----------
function createPeer() {
    if (pc) pc.close();
    const conn = new RTCPeerConnection({
        iceServers,
        // open the page with ?relay=1 to force everything through TURN (for testing the relay)
        iceTransportPolicy: new URLSearchParams(location.search).has("relay") ? "relay" : "all",
    });
    pc = conn;
    pc.onicecandidate = (e) => {
        if (e.candidate) send({ type: "candidate", candidate: e.candidate });
    };
    // whoever joined the code second gets the channel from the other side
    pc.ondatachannel = (e) => setupChannel(e.channel);
    pc.onconnectionstatechange = () => {
        if (conn !== pc) return;
        if (conn.connectionState === "connected") findRoute(conn).catch(() => {});
        if (conn.connectionState === "failed") {
            status("connection failed (different networks need a reachable TURN server)");
        }
    };
}

// host = same network, srflx/prflx = direct through NAT, relay = through the TURN server
async function findRoute(conn) {
    const stats = await conn.getStats();
    let pair;
    stats.forEach((s) => {
        if (s.type === "transport" && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
    });
    if (!pair) stats.forEach((s) => { if (s.type === "candidate-pair" && s.selected) pair = s; }); // Firefox
    const local = pair && stats.get(pair.localCandidateId);
    const remote = pair && stats.get(pair.remoteCandidateId);
    if (!local || !remote) return;
    route = local.candidateType === "relay" || remote.candidateType === "relay" ? "relay"
        : local.candidateType === "host" && remote.candidateType === "host" ? "direct, same network" : "direct";
}

// either side may have created the channel; what matters is who holds the file
function setupChannel(ch) {
    ch.binaryType = "arraybuffer";
    if (!file) return receiveInto(ch);
    const start = () => sendFile(ch).catch((err) => status("send failed: " + err.message));
    if (ch.readyState === "open") start();
    else ch.onopen = start;
}

// ---------- sending ----------
async function sendFile(ch) {
    const chunk = Math.min(CHUNK, pc.sctp?.maxMessageSize || CHUNK);
    ch.bufferedAmountLowThreshold = HIGH_WATER / 2;
    ch.onmessage = (e) => {
        if (e.data !== "done") return;
        closePeer(); // receiver has everything; stay on the code for the next receiver
        status(`sent ✓  code still active, keep this tab open to send again`);
    };

    ch.send(JSON.stringify({ name: file.name, size: file.size, type: file.type }));
    for (let off = 0; off < file.size; off += chunk) {
        if (ch.bufferedAmount > HIGH_WATER) {
            await new Promise((r) => ch.addEventListener("bufferedamountlow", r, { once: true }));
        }
        if (ch.readyState !== "open") return; // receiver left mid-transfer
        ch.send(await file.slice(off, off + chunk).arrayBuffer());
        const done = Math.max(0, Math.min(off + chunk, file.size) - ch.bufferedAmount); // actually sent
        progress(done, file.size);
        status(`sending ${mb(done)} / ${mb(file.size)}  ${route}`);
    }
    status("waiting for receiver to confirm...");
}

// ---------- receiving ----------
function receiveInto(ch) {
    let meta;
    let parts = [];
    let got = 0;
    let t0;

    ch.onmessage = (e) => {
        if (typeof e.data === "string") {
            meta = JSON.parse(e.data);
            t0 = performance.now();
        } else {
            parts.push(e.data);
            got += e.data.byteLength;
        }
        // don't trust the sender's page to have checked the size
        if (!meta || meta.size > MAX_SIZE || got > meta.size) {
            ch.onclose = null;
            leave();
            status(`transfer refused: the file is over the ${mb(MAX_SIZE)} limit`);
            return;
        }
        progress(got, meta.size);
        const speed = mb(got / ((performance.now() - t0) / 1000 || 1));
        status(`receiving ${meta.name}  ${mb(got)} / ${mb(meta.size)}  (${speed}/s, ${route || "connecting"})`);
        if (got === meta.size) {
            save(meta, parts);
            parts = [];
            ch.send("done"); // sender closes the connection when it gets this
        }
    };
    // fires after "done" (sender closed) or if the sender vanished mid-transfer
    ch.onclose = () => {
        if (!meta || got < meta.size) status("transfer stopped: the sender picked another file, closed the tab or lost connection");
        leave();
    };
}

// ponytail: whole file is held in memory until saved; fine at MAX_SIZE, OK up to ~1-2 GB on desktop, less on phones.
// Raising the cap past that needs streaming to disk with showSaveFilePicker() (Chrome) or a service worker.
function save(meta, parts) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(parts, { type: meta.type }));
    a.download = meta.name;
    a.textContent = "save " + meta.name;
    statusEl.replaceChildren("received ✓  ", a);
    a.click();
}

// ---------- signaling ----------
async function handle(msg) {
    if (msg.type === "ready") {
        // we were on the code first: we make the offer
        createPeer();
        setupChannel(pc.createDataChannel("file"));
        await pc.setLocalDescription(await pc.createOffer());
        send({ type: "offer", sdp: pc.localDescription });
        status("connecting...");
    } else if (msg.type === "offer") {
        createPeer();
        await pc.setRemoteDescription(msg.sdp);
        await pc.setLocalDescription(await pc.createAnswer());
        send({ type: "answer", sdp: pc.localDescription });
        status("connecting...");
    } else if (msg.type === "answer") {
        if (pc && pc.signalingState === "have-local-offer") await pc.setRemoteDescription(msg.sdp);
    } else if (msg.type === "candidate") {
        if (!pc) return;
        try {
            await pc.addIceCandidate(msg.candidate);
        } catch (err) {
            console.warn("bad candidate", err);
        }
    } else if (msg.type === "bye") {
        if (file) {
            // receiver left before finishing (after "done", pc is already null); keep waiting on the same code
            if (!pc) return;
            closePeer();
            status("receiver left, waiting for receiver...");
        } else {
            // the sender closed the tab, picked another file, or the code's hour ran out: the code is gone
            leave();
            status(msg.reason === "expired" ? "code expired (codes last 1 hour)"
                : "the sender closed the tab or picked another file, this code no longer works");
        }
    }
}

const EXPIRED = "code expired: the sender closed the tab, picked another file, or its 1 hour ran out";

async function join(code) {
    const id = joinId;
    try {
        iceServers = await configReady;
    } catch (err) {
        configReady = loadConfig(); // retry on the next attempt
        status("can't reach server");
        return;
    }
    if (id !== joinId) return; // user picked another file / code meanwhile
    route = "";
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${proto}://${location.host}/ws/file-${code}${file ? "?role=send" : ""}`);
    ws = socket;
    chain = Promise.resolve();
    socket.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        chain = chain.then(() => socket === ws && handle(msg)).catch(console.error);
    };
    socket.onclose = (e) => {
        if (socket !== ws) return; // we closed it ourselves
        ws = null;
        closePeer();
        if (e.code === 4409) share(file); // sender's random code is taken: pick another
        else if (e.code === 4404) status("no such code, check the digits");
        else if (e.code === 4410) status(file ? "code expired (codes last 1 hour), pick the file again for a new code" : EXPIRED);
        else if (e.code === 1008) status("code busy, someone is receiving it, try again in a moment");
        else if (e.code === 1011) status("server error, try again in a moment");
        else status("disconnected from server");
        if (file && e.code !== 4409) $("code").textContent = ""; // that code is dead now
    };
}

function closePeer() {
    if (pc) pc.close();
    pc = null;
}

function leave() {
    joinId++;
    closePeer();
    const socket = ws;
    ws = null;
    if (socket) socket.close();
}

// ---------- buttons ----------
$("file").onchange = () => {
    if ($("file").files[0]) share($("file").files[0]);
};

// new file = new code; leave() drops the old code on the server immediately
function share(f) {
    leave();
    statusEl = $("sendStatus");
    $("recvStatus").textContent = "";
    $("bar").hidden = true;
    if (f.size > MAX_SIZE) {
        file = null;
        $("file").value = "";
        $("code").textContent = "";
        status(`${f.name} is ${mb(f.size)}, the limit is ${mb(MAX_SIZE)}`);
        return;
    }
    file = f;
    // 6 random digits: easy to type on a phone
    const code = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, "0");
    $("code").textContent = code;
    status(`${f.name} (${mb(f.size)})  enter this code on the other device, keep this tab open`);
    join(code);
}

$("receive").onclick = () => {
    const code = $("codeIn").value.trim();
    if (!/^\d{6}$/.test(code)) {
        $("recvStatus").textContent = "enter the 6-digit code";
        return;
    }
    leave();
    file = null;
    statusEl = $("recvStatus");
    $("file").value = "";
    $("code").textContent = "";
    $("sendStatus").textContent = "";
    $("bar").hidden = true;
    status("waiting for sender...");
    join(code);
};
$("codeIn").onkeydown = (e) => {
    if (e.key === "Enter") $("receive").click();
};
