// stored (uncompressed) zip built while sending; ZIP64 past 4 GB

const MAX32 = 0xffffffff;
const FLAGS = 0x0808; // bit 3: CRC comes after the data; bit 11: names are UTF-8

// CRC-32, slicing-by-8: eight tables, 8 bytes per step (about 3x byte at a time)
function crcTables() {
    const t = Array.from({ length: 8 }, () => new Int32Array(256));
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        t[0][n] = c;
    }
    for (let k = 1; k < 8; k++) {
        for (let n = 0; n < 256; n++) t[k][n] = t[0][t[k - 1][n] & 255] ^ (t[k - 1][n] >>> 8);
    }
    return t;
}
const CRC_TABLES = crcTables();
function crc32(crc, bytes) {
    const [t0, t1, t2, t3, t4, t5, t6, t7] = CRC_TABLES;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const end8 = bytes.length & ~7;
    let i = 0;
    crc = ~crc;
    for (; i < end8; i += 8) {
        const a = crc ^ view.getInt32(i, true), b = view.getInt32(i + 4, true);
        crc = t7[a & 255] ^ t6[(a >>> 8) & 255] ^ t5[(a >>> 16) & 255] ^ t4[a >>> 24]
            ^ t3[b & 255] ^ t2[(b >>> 8) & 255] ^ t1[(b >>> 16) & 255] ^ t0[b >>> 24];
    }
    for (; i < bytes.length; i++) crc = t0[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return ~crc >>> 0;
}

// The CRCs are worked out in a worker so they never hold up the thread that sends. Done inline on a slow
// sender (a phone), they made 33 files (280 MB) take about a third longer than one file of the same size.
// Messages reach the worker in order, so each file's bytes are folded in front to back. Without a worker
// (Node, which runs the zip tests, or a browser where it didn't start) they're worked out inline.
const crcWorker = (() => {
    if (typeof Worker === "undefined") return null;
    const src = `const CRC_TABLES = (${crcTables})();\n${crc32}\nconst crcs = new Map();
onmessage = ({ data: [id, bytes] }) => {
    if (bytes) return crcs.set(id, crc32(crcs.get(id) || 0, bytes));
    postMessage([id, crcs.get(id) || 0]);
    crcs.delete(id);
};
postMessage("ready");`;
    let w;
    try {
        w = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
    } catch {
        return null;
    }
    const waiting = new Map();
    let failed = false;
    const api = {
        ready: false, // only zips made after the worker answered use it
        add: (id, bytes) => w.postMessage([id, bytes]),
        result: (id) => new Promise((resolve, reject) => {
            if (failed) return reject(new Error("checksum worker stopped"));
            waiting.set(id, { resolve, reject });
            w.postMessage([id]);
        }),
    };
    w.onmessage = ({ data }) => {
        if (data === "ready") return (api.ready = true);
        waiting.get(data[0])?.resolve(data[1]);
        waiting.delete(data[0]);
    };
    w.onerror = () => {
        failed = true;
        api.ready = false;
        for (const p of waiting.values()) p.reject(new Error("checksum worker stopped"));
        waiting.clear();
    };
    return api;
})();
let crcIds = 0;

// writes fields (Uint8Array, or [number, byte count]) little-endian into out at `at`; returns the new offset
function packInto(out, view, at, fields) {
    for (const f of fields) {
        if (f instanceof Uint8Array) out.set(f, at);
        else if (f[1] === 8) view.setBigUint64(at, BigInt(f[0]), true);
        else if (f[1] === 4) view.setUint32(at, f[0], true);
        else view.setUint16(at, f[0], true);
        at += f instanceof Uint8Array ? f.length : f[1];
    }
    return at;
}
function pack(...fields) {
    const out = new Uint8Array(fields.reduce((n, f) => n + (f instanceof Uint8Array ? f.length : f[1]), 0));
    packInto(out, new DataView(out.buffer), 0, fields);
    return out;
}

// MS-DOS date (high 16 bits) and time (low 16 bits), local time, 2 s resolution
function dosTime(ms) {
    const d = new Date(Math.max(ms, 315532800000));
    return ((((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) << 16
        | (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) >>> 0;
}

function zipFiles(files, name) {
    const enc = new TextEncoder();
    const parts = [];
    const entries = [];
    let offset = 0;
    const add = (size, read) => {
        parts.push({ start: offset, size, read });
        offset += size;
    };

    // A CRC only moves forward on the byte right after the last one it covered, so re-reads, a second
    // receiver reading the same object, or out-of-order reads can't corrupt it. Gaps are read on demand.
    const feed = (e, a, bytes) => {
        if (a !== e.upto) return;
        if (e.viaWorker) crcWorker.add(e.id, bytes);
        else e.crc = crc32(e.crc, bytes);
        e.upto += bytes.length;
    };
    const finalCrc = async (e) => {
        while (e.upto < e.size) {
            const a = e.upto, b = Math.min(e.size, a + 1048576);
            feed(e, a, new Uint8Array(await e.file.slice(a, b).arrayBuffer()));
        }
        // asked once, after every byte went to the worker; later calls (descriptor, trailer, a second receiver) reuse it
        if (e.viaWorker) e.crc = await (e.done ??= crcWorker.result(e.id));
        return e.crc;
    };

    const viaWorker = !!crcWorker?.ready;
    for (const f of files) {
        const e = { file: f, name: enc.encode(f.webkitRelativePath || f.name), size: f.size, offset, crc: 0, upto: 0, time: dosTime(f.lastModified), id: ++crcIds, viaWorker };
        e.zip64 = f.size >= MAX32 || offset >= MAX32;
        entries.push(e);
        const header = pack([0x04034b50, 4], [45, 2], [FLAGS, 2], [0, 2], [e.time, 4], [0, 4], [0, 4], [0, 4],
            [e.name.length, 2], [0, 2], e.name);
        add(header.length, (a, b) => header.subarray(a, b));
        add(f.size, async (a, b) => {
            const bytes = new Uint8Array(await f.slice(a, b).arrayBuffer());
            feed(e, a, bytes);
            return bytes;
        });
        const descriptor = async () => pack([0x08074b50, 4], [await finalCrc(e), 4], ...(e.zip64 ? [[e.size, 8], [e.size, 8]] : [[e.size, 4], [e.size, 4]]));
        add(e.zip64 ? 24 : 16, async (a, b) => (await descriptor()).subarray(a, b));
    }

    const cdStart = offset;
    const cdSize = entries.reduce((n, e) => n + 46 + e.name.length + (e.zip64 ? 28 : 0), 0);
    const count = entries.length;
    const zip64 = entries.some((e) => e.zip64) || cdStart + cdSize >= MAX32 || count >= 0xffff;
    // Packed straight into one buffer: spreading every entry into a single pack() call overflows the stack
    // with tens of thousands of files. Built once all CRCs are final, so every reader gets the same bytes;
    // dropped once its last byte has been read so a finished share doesn't keep it in memory.
    const trailerSize = cdSize + (zip64 ? 76 : 0) + 22;
    const buildTrailer = async () => {
        for (const e of entries) await finalCrc(e);
        const out = new Uint8Array(trailerSize);
        const view = new DataView(out.buffer);
        let at = 0;
        for (const e of entries) {
            at = packInto(out, view, at, [
                [0x02014b50, 4], [45, 2], [45, 2], [FLAGS, 2], [0, 2], [e.time, 4], [e.crc, 4],
                [e.zip64 ? MAX32 : e.size, 4], [e.zip64 ? MAX32 : e.size, 4], [e.name.length, 2], [e.zip64 ? 28 : 0, 2],
                [0, 2], [0, 2], [0, 2], [0, 4], [e.zip64 ? MAX32 : e.offset, 4], e.name,
                ...(e.zip64 ? [[1, 2], [24, 2], [e.size, 8], [e.size, 8], [e.offset, 8]] : []),
            ]);
        }
        packInto(out, view, at, [
            ...(zip64 ? [
                [0x06064b50, 4], [44, 8], [45, 2], [45, 2], [0, 4], [0, 4], [count, 8], [count, 8], [cdSize, 8], [cdStart, 8],
                [0x07064b50, 4], [0, 4], [cdStart + cdSize, 8], [1, 4],
            ] : []),
            [0x06054b50, 4], [0, 2], [0, 2], [Math.min(count, 0xffff), 2], [Math.min(count, 0xffff), 2],
            [Math.min(cdSize, MAX32), 4], [Math.min(cdStart, MAX32), 4], [0, 2],
        ]);
        return out;
    };
    let trailer = null;
    add(trailerSize, async (a, b) => {
        const t = await (trailer ??= buildTrailer());
        if (b === trailerSize) trailer = null;
        return t.subarray(a, b);
    });

    // no cursor shared between reads: find the first part that ends after `start`
    const firstPart = (start) => {
        let lo = 0, hi = parts.length;
        while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if (parts[mid].start + parts[mid].size > start) hi = mid;
            else lo = mid + 1;
        }
        return lo;
    };
    const read = async (start, end) => {
        const out = new Uint8Array(end - start);
        for (let i = firstPart(start); i < parts.length && parts[i].start < end; i++) {
            const p = parts[i];
            const a = Math.max(start, p.start), b = Math.min(end, p.start + p.size);
            if (a < b) out.set(await p.read(a - p.start, b - p.start), a - start);
        }
        return out.buffer;
    };
    return {
        name: name || `${count} files.zip`,
        size: offset,
        type: "application/zip",
        slice: (start, end) => ({ arrayBuffer: () => read(start, Math.min(end, offset)) }),
    };
}
