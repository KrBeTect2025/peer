// Checks static/zip.js: builds zips the way sendFile reads them (64 KB slices, front to back), then has
// Python's zipfile verify names, contents and CRCs.  node zip.test.mjs   (ZIP64=1 also runs a 4.3 GB file, slow)
import { readFileSync, openSync, writeSync, closeSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

const zipFiles = new Function(readFileSync(new URL("../static/zip.js", import.meta.url), "utf8") + "; return zipFiles;")();

async function check(files, expect) {
    const zip = zipFiles(files);
    const out = join(tmpdir(), "zip-test.zip");
    for (let round = 0; round < 2; round++) { // twice: a second receiver gets the same zip from the same object
        const fd = openSync(out, "w");
        for (let off = 0; off < zip.size; off += 65536) writeSync(fd, new Uint8Array(await zip.slice(off, off + 65536).arrayBuffer()));
        closeSync(fd);
        const py = `import zipfile,sys,json,hashlib
z=zipfile.ZipFile(sys.argv[1]); assert z.testzip() is None
print(json.dumps({i.filename:[i.file_size,hashlib.sha1(z.read(i)).hexdigest() if i.file_size<2**28 else ""] for i in z.infolist()}))`;
        const got = JSON.parse(execFileSync("python", ["-c", py, out], { encoding: "utf8", maxBuffer: 1 << 26 }));
        const want = JSON.stringify(expect), have = JSON.stringify(got);
        if (have !== want) throw new Error(`mismatch\n want ${want}\n have ${have}`);
    }
    rmSync(out);
    console.log(`PASS  ${files.length} files, ${zip.size} bytes`);
}

const sha1 = async (f) => (await import("node:crypto")).createHash("sha1").update(new Uint8Array(await f.arrayBuffer())).digest("hex");
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

if (process.env.ZIP64) {
    // a file past 4 GB (zeros, never held in memory), then a small one whose offset is past 4 GB
    const size = Math.floor(4.3 * 2 ** 30);
    const big = { name: "big.bin", size, lastModified: Date.now(), slice: (a, b) => ({ arrayBuffer: async () => new ArrayBuffer(b - a) }) };
    await check([big, files[0]], { "big.bin": [size, ""], "photo.jpg": expect["photo.jpg"] });
}
