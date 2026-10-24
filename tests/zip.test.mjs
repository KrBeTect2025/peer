// Checks static/zip.js: builds zips the way sendFile reads them (64 KB slices, front to back), then has
// Python's zipfile verify names, contents and CRCs.  node zip.test.mjs   (ZIP64=1 also runs a 4.3 GB file, slow)
import { readFileSync, openSync, writeSync, closeSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes, createHash } from "node:crypto";

const zipFiles = new Function(readFileSync(new URL("../static/zip.js", import.meta.url), "utf8") + "; return zipFiles;")();

// writes the zip to `out` reading 64 KB slices in the given order of offsets
async function save(zip, out, offsets) {
    const fd = openSync(out, "w");
    for (const off of offsets) writeSync(fd, new Uint8Array(await zip.slice(off, off + 65536).arrayBuffer()), 0, undefined, off);
    closeSync(fd);
}
const forward = (zip) => Array.from({ length: Math.ceil(zip.size / 65536) }, (_, i) => i * 65536);

async function check(files, expect, how = "twice") {
    const zip = zipFiles(files);
    const out = join(tmpdir(), "zip-test.zip");
    const outs = [out];
    if (how === "twice") { // a second receiver gets the same zip from the same object, one after the other
        await save(zip, out, forward(zip));
    } else if (how === "together") { // two receivers read the same object at the same time, interleaved
        outs.push(join(tmpdir(), "zip-test-2.zip"));
        const offs = forward(zip);
        const fds = outs.map((o) => openSync(o, "w"));
        for (let i = 0; i < offs.length; i++) {
            const [x, y] = await Promise.all([zip.slice(offs[i], offs[i] + 65536).arrayBuffer(), zip.slice(offs[Math.max(0, i - 3)], offs[Math.max(0, i - 3)] + 65536).arrayBuffer()]);
            writeSync(fds[0], new Uint8Array(x), 0, undefined, offs[i]);
            writeSync(fds[1], new Uint8Array(y), 0, undefined, offs[Math.max(0, i - 3)]);
        }
        for (let i = Math.max(0, offs.length - 3); i < offs.length; i++) writeSync(fds[1], new Uint8Array(await zip.slice(offs[i], offs[i] + 65536).arrayBuffer()), 0, undefined, offs[i]);
        fds.forEach(closeSync);
    } else { // back to front: the trailer and descriptors are asked for before any data was read
        await save(zip, out, forward(zip).reverse());
    }
    for (const [round, file] of (how === "twice" ? [out, out] : outs).entries()) {
        if (how === "twice" && round === 1) await save(zip, out, forward(zip));
        const py = `import zipfile,sys,json,hashlib
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print(json.dumps({i.filename:[i.file_size,hashlib.sha1(z.read(i)).hexdigest() if i.file_size<2**28 else ""] for i in z.infolist()}))`;
        const got = JSON.parse(execFileSync("python", ["-c", py, file], { encoding: "utf8", maxBuffer: 1 << 26 }));
        const want = JSON.stringify(expect), have = JSON.stringify(got);
        if (have !== want) throw new Error(`${how}: mismatch\n want ${want}\n have ${have}`);
    }
    outs.forEach((o) => rmSync(o));
    console.log(`PASS  ${files.length} files, ${zip.size} bytes${how === "twice" ? "" : `, read ${how}`}`);
}

const sha1 = async (f) => createHash("sha1").update(new Uint8Array(await f.arrayBuffer())).digest("hex");
const files = [
    new File([randomBytes(200000)], "photo.jpg"),
    new File([], "empty.txt"),
    new File([randomBytes(65536 - 30)], "तस्वीर (1) 'x' #&.jpg"), // ends right on a slice boundary
    new File([randomBytes(5)], "tiny.bin"),
];
const expect = {};
for (const f of files) expect[f.name] = [f.size, await sha1(f)];
await check(files, expect);
await check(Array.from({ length: 300 }, (_, i) => new File([String(i)], `f${i}.txt`)),
    Object.fromEntries(await Promise.all(Array.from({ length: 300 }, async (_, i) => [`f${i}.txt`, [String(i).length, await sha1(new File([String(i)], ""))]]))));
{
    // a picked folder: entries keep their paths (webkitRelativePath), same file name in two subfolders
    const inFolder = (path, f) => Object.defineProperty(f, "webkitRelativePath", { value: path });
    const folder = [
        inFolder("trip/a.txt", new File(["a"], "a.txt")),
        inFolder("trip/day 1/photo.jpg", new File([files[0]], "photo.jpg")),
        inFolder("trip/day 2/photo.jpg", new File([randomBytes(1000)], "photo.jpg")),
    ];
    const want = {};
    for (const f of folder) want[f.webkitRelativePath] = [f.size, await sha1(f)];
    await check(folder, want);
    if (zipFiles(folder, "trip.zip").name !== "trip.zip") throw new Error("zip name not used");
}

{
    // many files: the central directory once overflowed the stack ("Maximum call stack size exceeded"),
    // and from 65535 entries on the count needs ZIP64. 65536 is the smallest count that covers both.
    const many = Array.from({ length: 65536 }, (_, i) => new File([String(i)], `many/f${i}.txt`));
    await check(many, Object.fromEntries(await Promise.all(many.map(async (f) => [f.name, [f.size, await sha1(f)]]))));
}

// two receivers at once, and reads out of order: CRCs and the central directory must still come out right
await check(files, expect, "together");
await check(files, expect, "backwards");

if (process.env.ZIP64) {
    // a file past 4 GB (zeros, never held in memory), then a small one whose offset is past 4 GB
    const size = Math.floor(4.3 * 2 ** 30);
    const big = { name: "big.bin", size, lastModified: Date.now(), slice: (a, b) => ({ arrayBuffer: async () => new ArrayBuffer(b - a) }) };
    await check([big, files[0]], { "big.bin": [size, ""], "photo.jpg": expect["photo.jpg"] });
}
