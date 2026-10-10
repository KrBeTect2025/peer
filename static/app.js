// ---------- state ----------
let ws;                        // WebSocket to our FastAPI signaling server
let pc;                        // RTCPeerConnection to the other browser
let channel;                   // RTCDataChannel used for chat
let localStream;               // our camera + mic
let iceServers = [];           // STUN/TURN list, fetched from /config
let chain = Promise.resolve(); // runs signaling messages one at a time, in order

const $ = (id) => document.getElementById(id);
const status = (t) => ($("status").textContent = t);
const say = (t) => {
    $("chat").textContent += t + "\n";
    $("chat").scrollTop = $("chat").scrollHeight;
};
const send = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
};

// open the page with ?relay=1 to force all traffic through TURN (for testing coturn)
const forceRelay = new URLSearchParams(location.search).has("relay");

// ---------- peer connection ----------
function createPeer() {
    if (pc) pc.close();
    const conn = new RTCPeerConnection({
        iceServers,
        iceTransportPolicy: forceRelay ? "relay" : "all",
    });
    pc = conn;

    // send our camera/mic to the other side
    if (localStream) {
        localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }

    // every network address (candidate) we discover goes to the peer via the server
    pc.onicecandidate = (e) => {
        if (e.candidate) send({ type: "candidate", candidate: e.candidate });
    };

    // the peer's video/audio arrived
    pc.ontrack = (e) => {
        $("remote").srcObject = e.streams[0];
    };

    // the answering side receives the chat channel the offerer created
    pc.ondatachannel = (e) => setupChannel(e.channel);

    pc.onconnectionstatechange = () => {
        status(conn.connectionState);
        if (conn.connectionState === "connected") logRoute(conn).catch(() => {});
    };
}

function setupChannel(ch) {
    channel = ch;
    channel.onopen = () => say("-- chat connected --");
    channel.onclose = () => say("-- chat closed --");
    channel.onmessage = (e) => say("peer: " + e.data);
}

// shows how the two browsers actually reached each other:
// host = direct on LAN, srflx = direct through NAT (STUN), relay = through TURN
async function logRoute(conn) {
    const stats = await conn.getStats();
    let pair;
    stats.forEach((s) => {
        if (s.type === "transport" && s.selectedCandidatePairId) pair = stats.get(s.selectedCandidatePairId);
    });
    if (!pair) stats.forEach((s) => { if (s.type === "candidate-pair" && s.selected) pair = s; }); // Firefox
    if (!pair) return;
    const local = stats.get(pair.localCandidateId);
    const remote = stats.get(pair.remoteCandidateId);
    if (!local || !remote) return;
    say(`-- route: ${local.candidateType} <-> ${remote.candidateType} --`);
}

// ---------- signaling ----------
async function handle(msg) {
    if (msg.type === "ready") {
        // we were here first: we make the offer
        createPeer();
        setupChannel(pc.createDataChannel("chat"));
        if (!localStream) {
            // no camera here: still ask to *receive* the peer's video/audio
            pc.addTransceiver("video", { direction: "recvonly" });
            pc.addTransceiver("audio", { direction: "recvonly" });
        }
        await pc.setLocalDescription(await pc.createOffer());
        send({ type: "offer", sdp: pc.localDescription });
        status("calling...");
    } else if (msg.type === "offer") {
        // someone is calling us: answer
        createPeer();
        await pc.setRemoteDescription(msg.sdp);
        await pc.setLocalDescription(await pc.createAnswer());
        send({ type: "answer", sdp: pc.localDescription });
    } else if (msg.type === "answer") {
        if (pc && pc.signalingState === "have-local-offer") {
            await pc.setRemoteDescription(msg.sdp);
        }
    } else if (msg.type === "candidate") {
        if (!pc) return;
        try {
            await pc.addIceCandidate(msg.candidate);
        } catch (err) {
            console.warn("bad candidate", err);
        }
    } else if (msg.type === "bye") {
        closePeer();
        status("peer left, waiting...");
        say("-- peer left --");
    } else if (msg.type === "full") {
        hangup("room is full");
    }
}

// ---------- buttons ----------
async function join() {
    const room = $("room").value.trim();
    if (!room || ws) return;
    $("join").disabled = true;
    status("starting...");

    try {
        iceServers = (await (await fetch("/config")).json()).iceServers;
    } catch (err) {
        status("can't reach server");
        $("join").disabled = false;
        return;
    }

    try {
        localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
        $("local").srcObject = localStream;
    } catch (err) {
        say("-- no camera/mic (" + err.name + "), chat only --");
    }

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${proto}://${location.host}/ws/${encodeURIComponent(room)}`);
    ws = socket;
    // fresh queue: if we hung up mid-setup, the old queue may be stuck on a closed connection forever
    chain = Promise.resolve();
    socket.onopen = () => status("waiting for peer...");
    socket.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        // skip messages from an old socket if the user hung up and rejoined meanwhile
        chain = chain.then(() => socket === ws && handle(msg)).catch(console.error);
    };
    socket.onclose = (e) => {
        // 1008 = server refused us because the room already has 2 people
        if (socket === ws) hangup(e.code === 1008 ? "room is full" : "disconnected from server");
    };
    $("hangup").disabled = false;
}

function closePeer() {
    if (pc) pc.close();
    pc = null;
    channel = null;
    $("remote").srcObject = null;
}

function hangup(reason) {
    closePeer();
    const socket = ws;
    ws = null;
    if (socket) socket.close();
    if (localStream) localStream.getTracks().forEach((t) => t.stop());
    localStream = null;
    $("local").srcObject = null;
    $("join").disabled = false;
    $("hangup").disabled = true;
    status(reason || "idle");
}

function sendChat() {
    const text = $("msg").value;
    if (!text) return;
    if (!channel || channel.readyState !== "open") {
        say("-- not connected yet --");
        return;
    }
    channel.send(text);
    say("me: " + text);
    $("msg").value = "";
}

$("join").onclick = join;
$("hangup").onclick = () => hangup();
$("send").onclick = sendChat;
$("msg").onkeydown = (e) => {
    if (e.key === "Enter") sendChat();
};
