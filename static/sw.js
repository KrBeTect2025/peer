// Service worker: turns an incoming file into a normal browser download (download bar, progress, time left).
// The page hands over a stream plus a one-use URL /dl/<random id>; when the page's hidden iframe asks for that URL,
// this answers with a Response built from the stream, and the browser's download manager writes it to disk.
// Served from /sw.js (see main.py), so its scope is the whole site and it can answer /dl/... requests.

const pending = new Map(); // download url -> { name, size, stream, port }; each is used once

self.addEventListener("install", () => self.skipWaiting());                      // take over at once,
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));    // even for open tabs

self.addEventListener("message", (e) => {
    if (e.data === "ping") return; // keep-alive from the page: every event resets the browser's idle timer
    const { url, name, size, stream } = e.data;
    const port = e.ports[0];
    pending.set(url, { name, size, stream, port });
    port.postMessage("ready"); // the page may now point its iframe at the url
});

// RFC 5987 (filename*=): encodeURIComponent leaves ' ( ) * unescaped, which aren't allowed there
const rfc5987 = (s) => encodeURIComponent(s).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

self.addEventListener("fetch", (e) => {
    const dl = pending.get(e.request.url);
    if (!dl) return; // every other request goes to the network untouched
    pending.delete(e.request.url);
    dl.port.postMessage("started"); // the browser accepted the download: the page can let the sender start
    e.respondWith(new Response(dl.stream, {
        headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(dl.size), // exact: the page refuses anything beyond the announced size
            "Content-Disposition": "attachment; filename*=UTF-8''" + rfc5987(dl.name),
            // the file comes from an untrusted sender: it must never render as a page on this site
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "X-Content-Type-Options": "nosniff",
        },
    }));
});
