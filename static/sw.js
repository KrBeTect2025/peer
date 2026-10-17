
const pending = new Map();

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("message", (e) => {
    if (e.data === "ping") return;
    const { url, name, size, stream } = e.data;
    const port = e.ports[0];
    pending.set(url, { name, size, stream, port });
    port.postMessage("ready");
});

// RFC 5987: encodeURIComponent leaves ' ( ) * unescaped
const rfc5987 = (s) => encodeURIComponent(s).replace(/['()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());

self.addEventListener("fetch", (e) => {
    const dl = pending.get(e.request.url);
    if (!dl) return;
    pending.delete(e.request.url);
    dl.port.postMessage("started");
    e.respondWith(new Response(dl.stream, {
        headers: {
            "Content-Type": "application/octet-stream",
            "Content-Length": String(dl.size),
            "Content-Disposition": "attachment; filename*=UTF-8''" + rfc5987(dl.name),
            // untrusted sender: never render it as a page on this site
            "Content-Security-Policy": "default-src 'none'; sandbox",
            "X-Content-Type-Options": "nosniff",
        },
    }));
});
