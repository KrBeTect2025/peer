
let ws;
let pc;
let iceServers = [];
let route = "";
let chain = Promise.resolve();
let file = null;
let statusEl;
let joinId = 0;
let myCode = "";
let offerer = false;
let retries = 0;
const MAX_RETRIES = 4;
const RETRY_DELAY = 8000;

const CHUNK = 64 * 1024;
const HIGH_WATER = 1024 * 1024;
const WINDOW = 64 * 1048576;
const FLUSH = 8 * 1048576;
const MEM_MAX = 1024 * 1048576;

const $ = (id) => document.getElementById(id);
const status = (t) => (statusEl.textContent = t);
const mb = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(2) + " GB" : (n / 1048576).toFixed(1) + " MB");
const progress = (done, total) => {
    $("bar").hidden = false;
    $("bar").value = total ? done / total : 1;
};
let painted = 0;
const paintDue = () => {
    const now = performance.now();
    if (now - painted < 250) return false;
    painted = now;
    return true;
};
const loadConfig = () => fetch("/config").then((r) => r.json()).then((c) => c.iceServers);
let configReady = loadConfig();
navigator.serviceWorker?.register("/sw.js").catch(() => { });
addEventListener("beforeunload", (e) => {
    if (pc) e.preventDefault();
});
setTimeout(() => new RTCPeerConnection().close(), 0);
const send = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
};

function createPeer() {
    if (pc) pc.close();
    offerer = false;
    retries = 0;
    const conn = new RTCPeerConnection({
        iceServers,
        // ?relay=1 forces TURN, for testing
        iceTransportPolicy: new URLSearchParams(location.search).has("relay") ? "relay" : "all",
    });
    pc = conn;
    pc.onicecandidate = (e) => {
        if (e.candidate) send({ type: "candidate", candidate: e.candidate });
    };
    pc.ondatachannel = (e) => setupChannel(e.channel);
    pc.onconnectionstatechange = () => {
        if (conn !== pc) return;
        if (conn.connectionState === "connected") findRoute(conn).catch(() => { });
        if (conn.connectionState === "connected") retries = 0;
        if (conn.connectionState === "failed") retry(conn);
    };
}

// only the offerer restarts ICE, so the two sides never send offers at each other
function retry(conn) {
    if (retries >= MAX_RETRIES) {
        status("connection failed (different networks need a reachable TURN server)");
        return;
    }
    retries++;
    status(`connection lost, retrying (${retries}/${MAX_RETRIES})...`);
    if (!offerer) return;
    setTimeout(() => {
        if (conn !== pc || conn.connectionState !== "failed") return;
        chain = chain.then(async () => {
            conn.restartIce();
            await conn.setLocalDescription(await conn.createOffer({ iceRestart: true }));
            send({ type: "offer", sdp: conn.localDescription, restart: true });
        }).catch((err) => console.warn("ICE restart failed", err));
    }, RETRY_DELAY);
}

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

function setupChannel(ch) {
    ch.binaryType = "arraybuffer";
    if (!file) return receiveInto(ch);
    const start = () => sendFile(ch).catch((err) => status("send failed: " + err.message));
    if (ch.readyState === "open") start();
    else ch.onopen = start;
}

// protocol: {name,size,type} -> "go" -> chunks, with "ack <bytes>" back -> "done"
async function sendFile(ch) {
    const chunk = Math.min(CHUNK, pc.sctp?.maxMessageSize || CHUNK);
    ch.bufferedAmountLowThreshold = HIGH_WATER / 2;
    let go = false;
    let acked = 0;
    let ackedAt = performance.now();
    let wake = () => { };
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
            closePeer();
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
        while (ch.bufferedAmount > HIGH_WATER || off - acked > WINDOW) {
            if (ch.readyState !== "open") return;
            if (off - acked > WINDOW && performance.now() - ackedAt > 5000) {
                status(`receiver's download is paused or busy, waiting...  ${mb(acked)} of ${mb(file.size)} saved`);
            }
            await nap();
        }
        const data = await file.slice(off, off + chunk).arrayBuffer();
        if (ch.readyState !== "open") return;
        ch.send(data);
        if (paintDue()) {
            progress(acked, file.size);
            status(`sending ${mb(acked)} / ${mb(file.size)}  ${route}`);
        }
    }
    progress(1, 1);
    status("waiting for receiver to confirm...");
}

function receiveInto(ch) {
    let meta;
    let sink;
    let got = 0;
    let saved = 0;
    let handed = 0;
    let waitingSince = 0;
    let watch;
    let batch = [];
    let batchBytes = 0;
    let writes = Promise.resolve();
    let failed = false;
    let t0;

    const paint = () => {
        if (!sink || failed) return;
        progress(saved, meta.size);
        if (handed > saved && performance.now() - waitingSince > 5000) {
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
        sink?.abort();
        leave();
        status(why);
    };
    // cancelling in the download bar rejects the write with no error
    const saveFailed = (err) => failed || stop(err ? "couldn't save the file: " + (err.message || err) : "download cancelled");
    const flush = () => {
        const blob = new Blob(batch);
        const upto = got;
        if (handed === saved) waitingSince = performance.now();
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
            ch.send("done");
        }).catch(saveFailed);
    };

    ch.onmessage = (e) => {
        if (typeof e.data === "string") {
            meta = JSON.parse(e.data);
            openSink(meta).then((s) => {
                if (failed || ch.readyState !== "open") return s.abort();
                sink = s;
                t0 = performance.now();
                watch = setInterval(paint, 1000);
                ch.send("go");
                if (meta.size === 0) finish();
            }, (err) => stop(err.name === "AbortError" ? "save cancelled" : "transfer refused: " + err.message));
            return;
        }
        if (!sink || got + e.data.byteLength > meta.size) return stop("transfer refused: the sender sent more than it announced");
        batch.push(e.data);
        batchBytes += e.data.byteLength;
        got += e.data.byteLength;
        if (batchBytes >= FLUSH || got === meta.size) flush();
        if (got === meta.size) finish();
        else if (paintDue()) paint();
    };
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

// save paths, best first: service worker download, file picker, OPFS, memory
async function openSink(meta) {
    if (navigator.serviceWorker?.controller) {
        try {
            return await streamSink(meta);
        } catch (err) {
            console.warn("streamed download unavailable, using the next save path", err);
        }
    }
    if (window.showSaveFilePicker) {
        await clickTo(`save ${meta.name} (${mb(meta.size)})`);
        const handle = await showSaveFilePicker({ suggestedName: meta.name });
        return fileSink(handle, () => statusEl.replaceChildren(`received ✓  saved as ${handle.name}`));
    }
    if (navigator.storage?.getDirectory) {
        const dir = await navigator.storage.getDirectory();
        for await (const name of dir.keys()) await dir.removeEntry(name);
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
    await Promise.race([ready, new Promise((_, no) => setTimeout(no, 3000, new Error("service worker didn't answer")))]);

    // browsers stop an idle worker after ~30s, which kills the download
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
    document.querySelectorAll("iframe.download").forEach((f) => f.remove());
    startDownload();
    if (await Promise.race([started.then(() => true), new Promise((r) => setTimeout(r, 3000, false))]) === false) {
        clickTo(`download ${meta.name} (${mb(meta.size)})`).then(startDownload);
        await started;
    }
    return {
        write: async (blob) => out.write(new Uint8Array(await blob.arrayBuffer())),
        close: async () => {
            end();
            await out.close();
            statusEl.replaceChildren(`received ✓  ${meta.name} is in your downloads`);
        },
        abort: () => {
            end();
            out.abort("transfer stopped").catch(() => { });
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
        abort: () => out.abort().catch(() => { }),
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

async function handle(msg) {
    if (msg.type === "created") {
        $("code").textContent = myCode;
        status(`${file.name} (${mb(file.size)})  enter this code on the other device, keep this tab open`);
    } else if (msg.type === "ready") {
        createPeer();
        offerer = true;
        setupChannel(pc.createDataChannel("file"));
        await pc.setLocalDescription(await pc.createOffer());
        send({ type: "offer", sdp: pc.localDescription });
        status("connecting...");
    } else if (msg.type === "offer") {
        if (!msg.restart || !pc) createPeer();
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
            if (!pc) return;
            closePeer();
            status("receiver left, waiting for receiver...");
        } else {
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
        configReady = loadConfig();
        status("can't reach server");
        return;
    }
    if (id !== joinId) return;
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
        if (socket !== ws) return;
        ws = null;
        closePeer();
        if (e.code === 4409) share(file);
        else if (e.code === 4404) status("no such code, check the digits");
        else if (e.code === 4410) status(file ? "code expired (codes last 1 hour), pick the file again for a new code" : EXPIRED);
        else if (e.code === 1008) status("code busy, someone is receiving it, try again in a moment");
        else if (e.code === 1011) status("server error, try again in a moment");
        else status("disconnected from server");
        if (file && e.code !== 4409) $("code").textContent = "";
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

$("file").onchange = () => {
    const files = [...$("file").files];
    if (files.length) share(files.length === 1 ? files[0] : zipFiles(files));
};

function share(f) {
    leave();
    statusEl = $("sendStatus");
    $("recvStatus").textContent = "";
    $("bar").hidden = true;
    file = f;
    myCode = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1e6).padStart(6, "0");
    $("code").textContent = "";
    status(`${f.name} (${mb(f.size)})  getting a code...`);
    join(myCode);
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
