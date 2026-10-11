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
let myCode = "";               // sender: the code being set up / shared

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
// the service worker turns incoming files into normal browser downloads (see sw.js, streamSink);
// registering at page load means it's active long before a transfer. No service worker: the other save paths.
navigator.serviceWorker?.register("/sw.js").catch(() => {});
// the file only exists between the two tabs: closing either one mid-transfer kills it, so ask first
addEventListener("beforeunload", (e) => {
    if (pc) e.preventDefault();
});
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
    let acked = 0; // bytes the receiver has saved
    let ackedAt = performance.now();
    let wake = () => {};
    // wakes on any event below, and at least once a second so the status can say when the receiver is stuck
    const nap = () => new Promise((r) => {
        wake = r;
        setTimeout(r, 1000);
    });
    ch.addEventListener("bufferedamountlow", () => wake());
    ch.addEventListener("close", () => wake());
    ch.onmessage = (e) => {
        if (e.data === "go") go = true;
        else if (e.data.startsWith("ack ")) {
            acked = Number(e.data.slice(4));
            ackedAt = performance.now();
        }
        else if (e.data === "done") {
            closePeer(); // receiver has everything; stay on the code for the next receiver
            status(`sent ✓  code still active, keep this tab open to send again`);
        }
        wake();
    };

    ch.send(JSON.stringify({ name: file.name, size: file.size, type: file.type }));
    status("waiting for the receiver to start saving...");
    while (!go) {
        if (ch.readyState !== "open") return;
        await nap();
    }
    for (let off = 0; off < file.size; off += chunk) {
        // wait while the network queue is full, or the receiver's disk is behind
        while (ch.bufferedAmount > HIGH_WATER || off - acked > WINDOW) {
            if (ch.readyState !== "open") return; // receiver left mid-transfer
            if (off - acked > WINDOW && performance.now() - ackedAt > 5000) {
                // the receiver isn't saving: usually its download is paused. Just wait, it carries on when resumed
                status(`receiver's download is paused or busy, waiting...  ${mb(acked)} of ${mb(file.size)} saved`);
            }
            await nap();
        }
        const data = await file.slice(off, off + chunk).arrayBuffer();
        if (ch.readyState !== "open") return; // the receiver may have left while that was read from disk
        ch.send(data);
        if (paintDue()) {
            // what the receiver has saved: matches its page and its download bar (sent can be up to 64 MB ahead)
            progress(acked, file.size);
            status(`sending ${mb(acked)} / ${mb(file.size)}  ${route}`);
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
    let saved = 0;                 // bytes the sink has taken (for the download bar: what the browser has saved)
    let handed = 0;                // bytes handed to the sink (saved <= handed <= got)
    let waitingSince = 0;          // since when the sink has had a batch it hasn't taken yet
    let watch;                     // repaints while the transfer runs, so a paused download gets noticed
    let batch = [];                // received but not yet handed to the disk
    let batchBytes = 0;
    let writes = Promise.resolve(); // disk writes, strictly in order
    let failed = false;
    let t0;

    // shows what's saved, like the download bar; the bytes received but not yet saved (at most ~64 MB) wait in memory
    const paint = () => {
        if (!sink || failed) return;
        progress(saved, meta.size);
        // (a batch still filling up on a slow connection doesn't count: only batches the browser hasn't taken)
        if (handed > saved && performance.now() - waitingSince > 5000) {
            // the browser stopped taking data: usually the download was paused in the download bar.
            // The sender stops 64 MB ahead and both just wait; resuming carries on where it stopped.
            status(`waiting for your browser: is the download paused? ${mb(saved)} of ${mb(meta.size)} saved`);
        } else {
            const speed = mb(saved / ((performance.now() - t0) / 1000 || 1));
            status(`receiving ${meta.name}  ${mb(saved)} / ${mb(meta.size)}  (${speed}/s, ${route || "connecting"})`);
        }
    };
    const stop = (why) => {
        clearInterval(watch);
        failed = true;
        ch.onclose = null;
        sink?.abort(); // a half-saved file is thrown away / the download shows as failed, not stuck
        leave();
        status(why);
    };
    // cancelling in the browser's download bar rejects the write with no error at all
    const saveFailed = (err) => failed || stop(err ? "couldn't save the file: " + (err.message || err) : "download cancelled");
    const flush = () => {
        const blob = new Blob(batch);
        const upto = got; // everything received so far is in this batch or an earlier one
        if (handed === saved) waitingSince = performance.now(); // the sink was idle until now
        handed = upto;
        batch = [];
        batchBytes = 0;
        writes = writes
            .then(() => !failed && sink.write(blob))
            .then(() => {
                saved = upto;
                waitingSince = performance.now();
                if (ch.readyState === "open") ch.send("ack " + upto);
            })
            .catch(saveFailed);
    };
    const finish = () => {
        writes = writes.then(async () => {
            clearInterval(watch);
            if (failed) return;
            progress(1, 1);
            status("finishing...");
            await sink.close();
            ch.send("done"); // sender closes the connection when it gets this
        }).catch(saveFailed);
    };

    ch.onmessage = (e) => {
        if (typeof e.data === "string") {
            meta = JSON.parse(e.data);
            openSink(meta).then((s) => {
                if (failed || ch.readyState !== "open") return s.abort(); // the sender left while we were opening it
                sink = s;
                t0 = performance.now();
                watch = setInterval(paint, 1000);
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
        else if (paintDue()) paint();
    };
    // fires after "done" (sender closed) or if the sender vanished mid-transfer
    ch.onclose = () => {
        clearInterval(watch);
        if (!meta || got < meta.size) {
            failed = true;
            sink?.abort();
            status("transfer stopped: the sender picked another file, closed the tab or lost connection");
        }
        leave();
    };
}

// Where the incoming file goes, best first. Every sink has write(blob), close() and abort().
// 1. Chrome/Edge/Firefox on HTTPS or localhost: a normal browser download, fed as the bytes arrive
//    (no dialog, no copy, no size limit but free disk)
// 2. Chrome/Edge without a service worker: a file the user picks; every batch is written straight into it
// 3. other browsers (Safari): the site's private disk storage (OPFS), then handed over as a normal download
//    (needs the file's size free twice until the download copy is done; capped by the browser's storage quota)
// 4. no disk access at all: memory, up to MEM_MAX
async function openSink(meta) {
    if (navigator.serviceWorker?.controller) {
        try {
            return await streamSink(meta);
        } catch (err) {
            console.warn("streamed download unavailable, using the next save path", err); // Safari: DataCloneError
        }
    }
    if (window.showSaveFilePicker) {
        await clickTo(`save ${meta.name} (${mb(meta.size)})`); // the save dialog may only open from a click
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
    let parts = [];
    return {
        write: async (blob) => parts.push(blob),
        close: async () => save(meta, new Blob(parts, { type: meta.type })),
        abort: () => (parts = []),
    };
}

// A normal browser download fed by a stream: the page keeps the writable half of a TransformStream and hands
// the readable half to the service worker, which answers a hidden iframe's request for a one-use URL with it.
// Throws where a stream can't be handed to the worker (Safari), so openSink falls back.
async function streamSink(meta) {
    const sw = (await navigator.serviceWorker.ready).active;
    const { readable, writable } = new TransformStream();
    const url = `${location.origin}/dl/${crypto.randomUUID()}`;
    const { port1, port2 } = new MessageChannel();
    let onReady, onStarted;
    const ready = new Promise((r) => (onReady = r));
    const started = new Promise((r) => (onStarted = r));
    port1.onmessage = (e) => (e.data === "ready" ? onReady() : onStarted());
    sw.postMessage({ url, name: meta.name, size: meta.size, stream: readable }, [port2, readable]);
    // the worker knows the url before the iframe asks for it (no answer: give up and use the next save path)
    await Promise.race([ready, new Promise((_, no) => setTimeout(no, 3000, new Error("service worker didn't answer")))]);

    // the bytes never run through the worker's own code, so nothing else keeps it awake: browsers stop an idle
    // worker after ~30 s, which would kill the download. Any message counts as activity.
    const ping = setInterval(() => sw.postMessage("ping"), 10000);
    const out = writable.getWriter();
    const end = () => clearInterval(ping);
    const startDownload = () => {
        const frame = document.createElement("iframe");
        frame.className = "download";
        frame.hidden = true;
        frame.src = url;
        document.body.append(frame);
    };
    document.querySelectorAll("iframe.download").forEach((f) => f.remove()); // earlier transfers' (finished) frames
    startDownload();
    // a browser that blocks downloads nobody clicked for (e.g. a 2nd one in the same tab) never asks for the url:
    // after 3 s offer a button, since a click is always allowed to start a download
    if (await Promise.race([started.then(() => true), new Promise((r) => setTimeout(r, 3000, false))]) === false) {
        clickTo(`download ${meta.name} (${mb(meta.size)})`).then(startDownload);
        await started;
    }
    return {
        // resolves once the download has taken the batch (the stream applies backpressure), so "ack" still
        // limits the sender to what this side has actually saved. While the download is paused it just waits
        // (receiveInto says so after 5 s); never time out here, a pause can be as long as the person likes.
        write: async (blob) => out.write(new Uint8Array(await blob.arrayBuffer())),
        close: async () => {
            end();
            await out.close();
            statusEl.replaceChildren(`received ✓  ${meta.name} is in your downloads`);
        },
        abort: () => {
            end();
            out.abort("transfer stopped").catch(() => {}); // the download shows as failed instead of hanging
        },
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
        abort: () => out.abort().catch(() => {}), // deletes the half-written temp file
    };
}

function clickTo(label) {
    return new Promise((resolve) => {
        const b = document.createElement("button");
        b.id = "saveAs";
        b.textContent = label;
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
    if (msg.type === "created") {
        // the server has registered the code: only now show it (shown earlier, a quick receiver got "no such code")
        $("code").textContent = myCode;
        status(`${file.name} (${mb(file.size)})  enter this code on the other device, keep this tab open`);
    } else if (msg.type === "ready") {
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
    myCode = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, "0");
    $("code").textContent = "";
    status(`${f.name} (${mb(f.size)})  getting a code...`);
    join(myCode); // the code appears once the server confirms it (see "created" in handle)
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
