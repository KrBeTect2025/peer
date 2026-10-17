// stored (uncompressed) zip built while sending; ZIP64 past 4 GB

const MAX32 = 0xffffffff;
const FLAGS = 0x0808; // bit 3: CRC comes after the data; bit 11: names are UTF-8

const CRC_TABLE = new Int32Array(256).map((_, n) => {
    for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
    return n;
});
function crc32(crc, bytes) {
    crc = ~crc;
    for (let i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return ~crc >>> 0;
}

function pack(...fields) {
    const out = new Uint8Array(fields.reduce((n, f) => n + (f instanceof Uint8Array ? f.length : f[1]), 0));
    const view = new DataView(out.buffer);
    let at = 0;
    for (const f of fields) {
        if (f instanceof Uint8Array) out.set(f, at);
        else if (f[1] === 8) view.setBigUint64(at, BigInt(f[0]), true);
        else if (f[1] === 4) view.setUint32(at, f[0], true);
        else view.setUint16(at, f[0], true);
        at += f instanceof Uint8Array ? f.length : f[1];
    }
    return out;
}

// MS-DOS date (high 16 bits) and time (low 16 bits), local time, 2 s resolution
function dosTime(ms) {
    const d = new Date(Math.max(ms, 315532800000));
    return ((((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) << 16
        | (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) >>> 0;
}

function zipFiles(files) {
    const enc = new TextEncoder();
    const parts = [];
    const entries = [];
    let offset = 0;
    const add = (size, read) => {
        parts.push({ start: offset, size, read });
        offset += size;
    };

    for (const f of files) {
        const e = { name: enc.encode(f.name), size: f.size, offset, crc: 0, time: dosTime(f.lastModified) };
        e.zip64 = f.size >= MAX32 || offset >= MAX32;
        entries.push(e);
        const header = pack([0x04034b50, 4], [45, 2], [FLAGS, 2], [0, 2], [e.time, 4], [0, 4], [0, 4], [0, 4],
            [e.name.length, 2], [0, 2], e.name);
        add(header.length, (a, b) => header.subarray(a, b));
        add(f.size, async (a, b) => {
            const bytes = new Uint8Array(await f.slice(a, b).arrayBuffer());
            e.crc = crc32(a ? e.crc : 0, bytes);
            return bytes;
        });
        const descriptor = () => pack([0x08074b50, 4], [e.crc, 4], ...(e.zip64 ? [[e.size, 8], [e.size, 8]] : [[e.size, 4], [e.size, 4]]));
        add(e.zip64 ? 24 : 16, (a, b) => descriptor().subarray(a, b));
    }

    const cdStart = offset;
    const cdSize = entries.reduce((n, e) => n + 46 + e.name.length + (e.zip64 ? 28 : 0), 0);
    const count = entries.length;
    const zip64 = entries.some((e) => e.zip64) || cdStart + cdSize >= MAX32 || count >= 0xffff;
    const trailer = () => pack(
        ...entries.flatMap((e) => [
            [0x02014b50, 4], [45, 2], [45, 2], [FLAGS, 2], [0, 2], [e.time, 4], [e.crc, 4],
            [e.zip64 ? MAX32 : e.size, 4], [e.zip64 ? MAX32 : e.size, 4], [e.name.length, 2], [e.zip64 ? 28 : 0, 2],
            [0, 2], [0, 2], [0, 2], [0, 4], [e.zip64 ? MAX32 : e.offset, 4], e.name,
            ...(e.zip64 ? [[1, 2], [24, 2], [e.size, 8], [e.size, 8], [e.offset, 8]] : []),
        ]),
        ...(zip64 ? [
            [0x06064b50, 4], [44, 8], [45, 2], [45, 2], [0, 4], [0, 4], [count, 8], [count, 8], [cdSize, 8], [cdStart, 8],
            [0x07064b50, 4], [0, 4], [cdStart + cdSize, 8], [1, 4],
        ] : []),
        [0x06054b50, 4], [0, 2], [0, 2], [Math.min(count, 0xffff), 2], [Math.min(count, 0xffff), 2],
        [Math.min(cdSize, MAX32), 4], [Math.min(cdStart, MAX32), 4], [0, 2],
    );
    add(cdSize + (zip64 ? 76 : 0) + 22, (a, b) => trailer().subarray(a, b));

    // reads must go front to back, CRCs are computed on the way
    let next = 0;
    const read = async (start, end) => {
        if (start === 0) next = 0;
        const out = new Uint8Array(end - start);
        for (let i = next; i < parts.length && parts[i].start < end; i++) {
            const p = parts[i];
            const a = Math.max(start, p.start), b = Math.min(end, p.start + p.size);
            if (a < b) out.set(await p.read(a - p.start, b - p.start), a - start);
            if (p.start + p.size <= end) next = i + 1;
        }
        return out.buffer;
    };
    return {
        name: `${count} files.zip`,
        size: offset,
        type: "application/zip",
        slice: (start, end) => ({ arrayBuffer: () => read(start, Math.min(end, offset)) }),
    };
}
