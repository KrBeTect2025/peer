// Browser tests: two real browsers (Chrome sender; Chrome, Edge or Firefox receiver) against a running app.
//   npm i && npx playwright-core install firefox      (once; Chrome and Edge must be installed)
//   node browser.test.mjs <test>...
//   tests: basic edge zero unicode html second pause senderdrop cancel nosw dataclone firefox long
//   env:   APP_URL (default http://localhost:8000/), TEST_DIR (big files + downloads; default <tmp>/p2p-test),
//          LONG_MB (size of the "long" test, default 3072), NOPING=1 (run "firefox" without the keep-alive ping)
import { chromium, firefox } from "playwright-core";
import { createHash, randomBytes } from "node:crypto";
import { createReadStream, openSync, writeSync, closeSync, writeFileSync, rmSync, mkdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

const URL = process.env.APP_URL || "http://localhost:8000/";
const BIG = process.env.TEST_DIR || join(tmpdir(), "p2p-test");
process.env.TEMP = process.env.TMP = `${BIG}/tmp`; // Playwright saves downloads under TEMP: keep big ones in TEST_DIR
mkdirSync(`${BIG}/tmp`, { recursive: true });
const PROFILES = join(tmpdir(), "p2p-test-profiles");
const MB = 1 << 20;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
let failures = 0;
const check = (ok, what) => {
    console.log(`   ${ok ? "PASS" : "FAIL"}  ${what}`);
    if (!ok) failures++;
};

function makeFile(name, size, content) {
    const path = `${BIG}/${name}`;
    const h = createHash("sha1");
    const fd = openSync(path, "w");
    if (content !== undefined) {
        writeSync(fd, content);
        h.update(content);
    } else {
        const BLOCK = 8 * MB, base = randomBytes(BLOCK);
        for (let off = 0, i = 0; off < size; off += BLOCK, i++) {
            base.writeBigUInt64LE(BigInt(i), 0); // every block different, so order mistakes change the hash
            const buf = base.subarray(0, Math.min(BLOCK, size - off));
            writeSync(fd, buf);
            h.update(buf);
        }
    }
    closeSync(fd);
    return { path, sha1: h.digest("hex"), name };
}
async function sha1(path) {
    const h = createHash("sha1");
    for await (const c of createReadStream(path, { highWaterMark: 8 * MB })) h.update(c);
    return h.digest("hex");
}

async function launch(kind, name) {
    const dir = join(PROFILES, name);
    rmSync(dir, { recursive: true, force: true });
    if (kind === "firefox") {
        return firefox.launchPersistentContext(dir, {
            headless: true, acceptDownloads: true,
            firefoxUserPrefs: { "media.peerconnection.ice.obfuscate_host_addresses": false },
        });
    }
    // mDNS hides local IPs as .local names, which two headless browsers on one PC sometimes can't resolve
    return chromium.launchPersistentContext(dir, {
        channel: kind, headless: true, acceptDownloads: true, args: ["--disable-features=WebRtcHideLocalIpsWithMdns"],
    });
}
async function page(ctx, { waitForSW = true } = {}) {
    const p = await ctx.newPage();
    await p.goto(URL);
    if (waitForSW) await p.waitForFunction(() => !!navigator.serviceWorker?.controller, null, { timeout: 15000 });
    return p;
}
async function share(sp, file) {
    await sp.setInputFiles("#file", file.path);
    await sp.waitForFunction(() => /^\d{6}$/.test(document.querySelector("#code").textContent));
    return sp.textContent("#code");
}
const recvStatus = (rp) => rp.textContent("#recvStatus");
const sendStatus = (sp) => sp.textContent("#sendStatus");
const until = (p, re, ms = 30000, sel = "#recvStatus") =>
    p.waitForFunction(([s, src]) => new RegExp(src).test(document.querySelector(s).textContent), [sel, re.source], { timeout: ms })
        .then(() => true, () => false);

// one full transfer through the streamed download; returns timings and the downloaded file's path
async function transfer(sp, rp, file, { timeout = 600000 } = {}) {
    const code = await share(sp, file);
    const dlEvent = rp.waitForEvent("download", { timeout });
    const t0 = Date.now();
    await rp.fill("#codeIn", code);
    await rp.click("#receive");
    const d = await dlEvent;
    const tDownloadShown = (Date.now() - t0) / 1000;
    const path = await d.path();
    const tDone = (Date.now() - t0) / 1000;
    return { d, path, tDownloadShown, tDone };
}

async function basic(kind = "chrome", sizeMB = 100) {
    const send = await launch("chrome", "send"), recv = await launch(kind, "recv");
    try {
        if (process.env.NOPING) {
            // experiment: the app without its keep-alive ping, to see whether the browser kills the worker
            const js = await (await fetch(URL + "static/app.js")).text();
            const stripped = js.replace('setInterval(() => sw.postMessage("ping"), 10000)', "setInterval(() => {}, 10000)");
            if (stripped === js) throw new Error("ping line not found");
            await recv.route("**/static/app.js", (r) => r.fulfill({ body: stripped, contentType: "text/javascript" }));
        }
        const sp = await page(send, { waitForSW: false }), rp = await page(recv);
        const f = makeFile(`basic-${kind}.bin`, sizeMB * MB);
        let buttonSeen = false;
        rp.on("console", (m) => m.type() === "warning" && log("receiver console:", m.text()));
        const watch = setInterval(async () => (buttonSeen ||= !!(await rp.$("#saveAs").catch(() => null))), 300);
        const r = await transfer(sp, rp, f);
        clearInterval(watch);
        if (process.env.NOPING) {
            const ok = await until(rp, /stopped responding/, 120000);
            check(ok, `without the ping: receiver ends with a clear error, not a hang (${await recvStatus(rp)})`);
            check(await until(sp, /receiver left/, 30000, "#sendStatus"), `without the ping: sender says: ${await sendStatus(sp)}`);
            return;
        }
        check(r.tDownloadShown < 15, `download appeared in the browser right away (${r.tDownloadShown.toFixed(1)} s after Receive)`);
        check(!buttonSeen, "no save dialog / button needed");
        check(r.d.suggestedFilename() === f.name, `file name kept (${r.d.suggestedFilename()})`);
        check((await sha1(r.path)) === f.sha1, `${sizeMB} MB received byte-identical (${r.tDone.toFixed(0)} s)`);
        check(await until(rp, /in your downloads/), `receiver says: ${await recvStatus(rp)}`);
        check(await until(sp, /sent ✓/, 30000, "#sendStatus"), `sender says: ${await sendStatus(sp)}`);
        rmSync(f.path); rmSync(r.path, { force: true });
    } finally {
        await Promise.allSettled([send.close(), recv.close()]);
    }
}

async function special(name, content, label) {
    const send = await launch("chrome", "send"), recv = await launch("chrome", "recv");
    try {
        const sp = await page(send, { waitForSW: false }), rp = await page(recv);
        const f = makeFile(name, content.length, content);
        const pagesBefore = recv.pages().length;
        const r = await transfer(sp, rp, f, { timeout: 60000 });
        check(r.d.suggestedFilename() === name, `${label}: saved as "${r.d.suggestedFilename()}"`);
        check((await sha1(r.path)) === f.sha1 && statSync(r.path).size === content.length, `${label}: content identical (${content.length} bytes)`);
        check(rp.url() === URL && recv.pages().length === pagesBefore && (await rp.title()) !== "pwned", `${label}: page didn't navigate, open a tab or run the file`);
        check(await until(rp, /in your downloads/), `${label}: receiver says: ${await recvStatus(rp)}`);
        rmSync(f.path); rmSync(r.path, { force: true });
    } finally {
        await Promise.allSettled([send.close(), recv.close()]);
    }
}

async function second() {
    const send = await launch("chrome", "send"), recv = await launch("chrome", "recv");
    try {
        const sp = await page(send, { waitForSW: false }), rp = await page(recv);
        for (const n of [1, 2]) {
            const f = makeFile(`second-${n}.bin`, 20 * MB);
            const r = await transfer(sp, rp, f, { timeout: 120000 });
            check((await sha1(r.path)) === f.sha1, `receive #${n} in the same tab: byte-identical`);
            await until(sp, /sent ✓/, 30000, "#sendStatus");
            rmSync(f.path); rmSync(r.path, { force: true });
        }
    } finally {
        await Promise.allSettled([send.close(), recv.close()]);
    }
}

async function midway(action) {
    const send = await launch("chrome", "send"), recv = await launch("chrome", "recv");
    try {
        const sp = await page(send, { waitForSW: false }), rp = await page(recv);
        const f = makeFile(`midway-${action === "cancel" ? "c" : "s"}.bin`, 300 * MB);
        const code = await share(sp, f);
        const dlEvent = rp.waitForEvent("download");
        await rp.fill("#codeIn", code);
        await rp.click("#receive");
        const d = await dlEvent;
        await until(rp, /receiving .*?  ([2-9]\d|\d{3,})\.\d MB \//, 60000); // 20+ MB in
        if (action === "senderdrop") {
            let dialog = "";
            sp.once("dialog", (dl) => { dialog = dl.type(); dl.dismiss(); });
            await sp.close({ runBeforeUnload: true });
            await new Promise((r) => setTimeout(r, 1500));
            check(dialog === "beforeunload", `closing the sender tab mid-transfer asks first (${dialog || "no dialog"})`);
            await send.close(); // now really gone
            const failure = await Promise.race([d.failure(), new Promise((r) => setTimeout(r, 30000, "STILL RUNNING"))]);
            check(failure && failure !== "STILL RUNNING", `receiver's download marked failed, not stuck (${failure})`);
            check(await until(rp, /transfer stopped/), `receiver says: ${await recvStatus(rp)}`);
        } else {
            await d.cancel();
            check(await until(rp, /^download cancelled$/), `receiver says: ${await recvStatus(rp)}`);
            await new Promise((r) => setTimeout(r, 3000)); // let any late error overwrite the status, if it's going to
            check(/receiver left/.test(await sendStatus(sp)), `sender says: ${await sendStatus(sp)}`);
        }
        rmSync(f.path);
    } finally {
        await Promise.allSettled([send.close(), recv.close()]);
    }
}

// The receiver pauses its download for 90 s (longer than any timeout should be). Pausing in the download bar
// makes the browser stop taking data; here the stream writes are held instead, which looks the same to the app.
async function pause() {
    const send = await launch("chrome", "send"), recv = await launch("chrome", "recv");
    try {
        await recv.addInitScript(() => {
            const write = WritableStreamDefaultWriter.prototype.write;
            let held = null, release;
            window.pauseDownload = () => (held = new Promise((r) => (release = r)));
            window.resumeDownload = () => { held = null; release(); };
            WritableStreamDefaultWriter.prototype.write = function (chunk) {
                return held ? held.then(() => write.call(this, chunk)) : write.call(this, chunk);
            };
        });
        const sp = await page(send, { waitForSW: false }), rp = await page(recv);
        const f = makeFile("pause.bin", 300 * MB);
        const code = await share(sp, f);
        const dlEvent = rp.waitForEvent("download");
        await rp.fill("#codeIn", code);
        await rp.click("#receive");
        const d = await dlEvent;
        await until(rp, /receiving .*?  ([2-9]\d|\d{3,})\.\d MB \//, 60000); // 20+ MB saved
        await rp.evaluate(() => pauseDownload());
        check(await until(rp, /is the download paused\?/, 20000), `receiver notices the pause: ${await recvStatus(rp)}`);
        check(await until(sp, /paused or busy/, 20000, "#sendStatus"), `sender notices it: ${await sendStatus(sp)}`);
        await new Promise((r) => setTimeout(r, 90000));
        check(/is the download paused\?/.test(await recvStatus(rp)), `still just waiting after 90 s, nothing cancelled`);
        await rp.evaluate(() => resumeDownload());
        check((await sha1(await d.path())) === f.sha1, "resumed and finished: byte-identical");
        check(await until(rp, /in your downloads/), `receiver says: ${await recvStatus(rp)}`);
        check(await until(sp, /sent ✓/, 30000, "#sendStatus"), `sender says: ${await sendStatus(sp)}`);
        rmSync(f.path);
    } finally {
        await Promise.allSettled([send.close(), recv.close()]);
    }
}

// fallbacks: browser without a service worker, and one that can't hand a stream to it (Safari's DataCloneError)
async function fallback(kind) {
    const send = await launch("chrome", "send"), recv = await launch("chrome", "recv");
    try {
        if (kind === "nosw") {
            await recv.addInitScript(() => Object.defineProperty(Navigator.prototype, "serviceWorker", { get: () => undefined }));
        } else {
            await recv.addInitScript(() => {
                const orig = ServiceWorker.prototype.postMessage;
                ServiceWorker.prototype.postMessage = function (m, t) {
                    if (m?.stream) throw new DOMException("ReadableStream could not be cloned", "DataCloneError");
                    return orig.call(this, m, t);
                };
            });
        }
        // stand in for the native save dialog: hand back a file in the browser's disk storage
        await recv.addInitScript(() => {
            window.showSaveFilePicker = async ({ suggestedName }) =>
                (await navigator.storage.getDirectory()).getFileHandle(suggestedName, { create: true });
        });
        const sp = await page(send, { waitForSW: false }), rp = await page(recv, { waitForSW: kind !== "nosw" });
        const f = makeFile(`fallback-${kind}.bin`, 20 * MB);
        const code = await share(sp, f);
        await rp.fill("#codeIn", code);
        await rp.click("#receive");
        const btn = await rp.waitForSelector("#saveAs", { timeout: 30000 }).catch(() => null);
        check(btn && /^save /.test(await btn.textContent()), `${kind}: falls back to the save-dialog path (${btn ? await btn.textContent() : "no button"})`);
        await btn?.click();
        check(await until(rp, /saved as/, 60000), `${kind}: receiver says: ${await recvStatus(rp)}`);
        const sum = await rp.evaluate(async (name) => {
            const file = await (await (await navigator.storage.getDirectory()).getFileHandle(name)).getFile();
            return [...new Uint8Array(await crypto.subtle.digest("SHA-1", await file.arrayBuffer()))].map((b) => b.toString(16).padStart(2, "0")).join("");
        }, f.name);
        check(sum === f.sha1, `${kind}: file identical`);
        rmSync(f.path);
    } finally {
        await Promise.allSettled([send.close(), recv.close()]);
    }
}

// long transfer: the service worker must survive (browsers stop idle workers after ~30 s), memory must stay flat
async function long(sizeMB) {
    const send = await launch("chrome", "send"), recv = await launch("chrome", "recv");
    const memPs1 = join(PROFILES, "mem.ps1");
    writeFileSync(memPs1, `$all = Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Select-Object ProcessId, ParentProcessId, CommandLine, PrivatePageCount
$roots = $all | Where-Object { $_.CommandLine -like "*p2p-test-profiles\\recv*" -and $_.CommandLine -notlike "*--type=*" }
$ids = @($roots.ProcessId); do { $more = $all | Where-Object { $ids -contains $_.ParentProcessId -and $ids -notcontains $_.ProcessId }; $ids += @($more.ProcessId) } while ($more)
[math]::Round((($all | Where-Object { $ids -contains $_.ProcessId } | Measure-Object PrivatePageCount -Sum).Sum) / 1MB)`);
    let peak = 0; // receiver browser's memory, sampled with PowerShell (Windows only)
    const mem = process.platform !== "win32" ? null : setInterval(() => {
        try { peak = Math.max(peak, Number(execFileSync("powershell", ["-NoProfile", "-File", memPs1]).toString().trim())); } catch {}
    }, 15000);
    try {
        const sp = await page(send, { waitForSW: false }), rp = await page(recv);
        const f = makeFile(`long-${sizeMB}.bin`, sizeMB * MB);
        const progress = setInterval(async () => log((await recvStatus(rp).catch(() => "")).slice(0, 90), `| receiver peak ${peak} MB`), 60000);
        const r = await transfer(sp, rp, f, { timeout: 3 * 3600000 });
        clearInterval(progress);
        check((await sha1(r.path)) === f.sha1, `${sizeMB} MB over ${(r.tDone / 60).toFixed(1)} min: byte-identical (worker stayed alive)`);
        if (mem) check(peak > 0 && peak < 1000, `receiver memory flat: peak ${peak} MB`);
        rmSync(f.path); rmSync(r.path, { force: true });
    } finally {
        clearInterval(mem);
        await Promise.allSettled([send.close(), recv.close()]);
    }
}

const tests = {
    basic: () => basic("chrome", 100),
    edge: () => basic("msedge", 50),
    firefox: () => basic("firefox", 300), // ~90 s: past Firefox's 30 s idle-worker limit
    zero: () => special("empty.txt", Buffer.alloc(0), "0-byte file"),
    unicode: () => special("तस्वीर (1) 'x' #&.jpg", randomBytes(5000), "Hindi/quotes/brackets name"),
    html: () => special("evil.html", Buffer.from("<script>document.title='pwned';parent.document.title='pwned'</script><h1>hi</h1>"), ".html from the sender"),
    second,
    pause,
    senderdrop: () => midway("senderdrop"),
    cancel: () => midway("cancel"),
    nosw: () => fallback("nosw"),
    dataclone: () => fallback("dataclone"),
    long: () => long(Number(process.env.LONG_MB || 3072)),
};
for (const name of process.argv.slice(2)) {
    log(`--- ${name}`);
    try {
        await tests[name]();
    } catch (err) {
        check(false, `${name} crashed: ${String(err.message).split("\n")[0]}`);
    }
}
log(failures ? `${failures} FAILED` : "ALL PASSED");
process.exit(failures ? 1 : 0);
