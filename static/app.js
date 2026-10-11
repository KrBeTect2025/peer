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
const WINDOW = 64 * 1048576;         // sender stays at most this far ahead of what the receiver has on disk
const FLUSH = 8 * 1048576;           // receiver writes to disk in batches of this size
// only for browsers with no disk access at all: they hold the file in memory until it's saved
const MEM_MAX = 1024 * 1048576;

const $ = (id) => document.getElementById(id);
const status = (t) => (statusEl.textContent = t);
const mb = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(2) + " GB" : (n / 1048576).toFixed(1) + " MB");
const progress = (done, total) => {
    $("bar").hidden = false;
    $("bar").value = total ? done / total : 1;
};
// a 50 GB file is ~800k chunks: repaint the status a few times a second, not on every chunk
let painted = 0;
const paintDue = () => {
    const now = performance.now();
    if (now - painted < 250) return false;
    painted = now;
    return true;
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
// protocol on the channel: sender -> {name,size,type}; receiver -> "go" once it has somewhere to save;
// sender -> binary chunks; receiver -> "ack <bytes on disk>" after each disk write, then "done"
async function sendFile(ch) {
    const chunk = Math.min(CHUNK, pc.sctp?.maxMessageSize || CHUNK);
    ch.bufferedAmountLowThreshold = HIGH_WATER / 2;
    let go = false;
    let acked = 0; // bytes the receiver has written to disk
    let wake = () => {};
    const nap = () => new Promise((r) => (wake = r));
    ch.addEventListener("bufferedamountlow", () => wake());
    ch.addEventListener("close", () => wake());
    ch.onmessage = (e) => {
        if (e.data === "go") go = true;
        else if (e.data.startsWith("ack ")) acked = Number(e.data.slice(4));
        else if (e.data === "done") {
            closePeer(); // receiver has everything; stay on the code for the next receiver
            status(`sent ✓  code still active, keep this tab open to send again`);
        }
        wake();
    };

    ch.send(JSON.stringify({ name: file.name, size: file.size, type: file.type }));
    status("waiting for the receiver to choose where to save...");
    while (!go) {
        if (ch.readyState !== "open") return;
        await nap();
    }
    for (let off = 0; off < file.size; off += chunk) {
        // wait while the network queue is full, or the receiver's disk is behind
        while (ch.bufferedAmount > HIGH_WATER || off - acked > WINDOW) {
            if (ch.readyState !== "open") return; // receiver left mid-transfer
            await nap();
        }
        if (ch.readyState !== "open") return;
        ch.send(await file.slice(off, off + chunk).arrayBuffer());
        if (paintDue()) {
            const done = Math.max(0, Math.min(off + chunk, file.size) - ch.bufferedAmount); // actually sent
            progress(done, file.size);
            status(`sending ${mb(done)} / ${mb(file.size)}  ${route}`);
        }
    }
    progress(1, 1);
    status("waiting for receiver to confirm...");
}

// ---------- receiving ----------
function receiveInto(ch) {
    let meta;
    let sink;                      // where the bytes go: see openSink()
    let got = 0;                   // bytes received
    let batch = [];                // received but not yet handed to the disk
    let batchBytes = 0;
    let writes = Promise.resolve(); // disk writes, strictly in order
    let failed = false;
    let t0;

    const stop = (why) => {
        failed = true;
        ch.onclose = null;
        leave();
        status(why);
    };
    const flush = () => {
        const blob = new Blob(batch);
        const upto = got; // everything received so far is in this batch or an earlier one
        batch = [];
        batchBytes = 0;
        writes = writes
            .then(() => !failed && sink.write(blob))
            .then(() => ch.readyState === "open" && ch.send("ack " + upto))
            .catch((err) => failed || stop("couldn't save the file: " + err.message));
    };
    const finish = () => {
        writes = writes.then(async () => {
            if (failed) return;
            status("finishing...");
            await sink.close();
            ch.send("done"); // sender closes the connection when it gets this
        }).catch((err) => failed || stop("couldn't save the file: " + err.message));
    };

    ch.onmessage = (e) => {
        if (typeof e.data === "string") {
            meta = JSON.parse(e.data);
            openSink(meta).then((s) => {
                sink = s;
                t0 = performance.now();
                ch.send("go");
                if (meta.size === 0) finish();
            }, (err) => stop(err.name === "AbortError" ? "save cancelled" : "transfer refused: " + err.message));
            return;
        }
        // don't trust the sender to stick to what it announced
        if (!sink || got + e.data.byteLength > meta.size) return stop("transfer refused: the sender sent more than it announced");
        batch.push(e.data);
        batchBytes += e.data.byteLength;
        got += e.data.byteLength;
        if (batchBytes >= FLUSH || got === meta.size) flush();
        if (got === meta.size) finish();
        if (paintDue() || got === meta.size) {
            progress(got, meta.size);
            const speed = mb(got / ((performance.now() - t0) / 1000 || 1));
            status(`receiving ${meta.name}  ${mb(got)} / ${mb(meta.size)}  (${speed}/s, ${route || "connecting"})`);
        }
    };
    // fires after "done" (sender closed) or if the sender vanished mid-transfer
    ch.onclose = () => {
        if (!meta || got < meta.size) status("transfer stopped: the sender picked another file, closed the tab or lost connection");
        leave();
    };
}

// Where the incoming file goes, best first:
// 1. Chrome/Edge: a file the user picks; every batch is written straight into it (no size limit but free disk)
// 2. other browsers: the site's private disk storage (OPFS), then handed over as a normal download at the end
//    (needs the file's size free twice until the download copy is done; capped by the browser's storage quota)
// 3. no disk access at all: memory, up to MEM_MAX
async function openSink(meta) {
    if (window.showSaveFilePicker) {
        await clickToSave(meta); // the save dialog may only open from a click
        const handle = await showSaveFilePicker({ suggestedName: meta.name });
        return fileSink(handle, () => statusEl.replaceChildren(`received ✓  saved as ${handle.name}`));
    }
    if (navigator.storage?.getDirectory) {
        const dir = await navigator.storage.getDirectory();
        for await (const name of dir.keys()) await dir.removeEntry(name); // the previous transfer's copy
        const { quota, usage } = await navigator.storage.estimate();
        if (meta.size > quota - usage) throw new Error(`not enough browser storage (${mb(quota - usage)} free)`);
        const handle = await dir.getFileHandle("incoming", { create: true });
        return fileSink(handle, async () => save(meta, await handle.getFile()));
    }
    if (meta.size > MEM_MAX) throw new Error(`this browser can only receive files up to ${mb(MEM_MAX)}`);
    const parts = [];
    return {
        write: async (blob) => parts.push(blob),
        close: async () => save(meta, new Blob(parts, { type: meta.type })),
    };
}

async function fileSink(handle, done) {
    const out = await handle.createWritable();
    return {
        write: (blob) => out.write(blob),
        close: async () => {
            await out.close();
            await done();
        },
    };
}

function clickToSave(meta) {
    return new Promise((resolve) => {
        const b = document.createElement("button");
        b.id = "saveAs";
        b.textContent = `save ${meta.name} (${mb(meta.size)})`;
        b.onclick = resolve;
        statusEl.replaceChildren(b);
    });
}

function save(meta, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
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
    file = f; // no size cap here: the receiver checks what it can save (see openSink)
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
