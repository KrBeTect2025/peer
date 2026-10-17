// Real Chrome download behaviour, driven over raw CDP (no Playwright on the receiver, so nothing overrides
// Chrome's download handling): two receives in the same tab. Chrome may block a 2nd automatic download from a
// page; the app should then offer a "download" button, and a real click on it must start the download.
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
//   node real-chrome.mjs        env: APP_URL (default http://localhost:8000/), CHROME_PATH, TEST_DIR

const URL = process.env.APP_URL || "http://localhost:8000/";
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const WORK = process.env.TEST_DIR || join(tmpdir(), "p2p-test");
const DIR = join(WORK, "real-chrome-downloads"), PROF = join(tmpdir(), "p2p-test-profiles", "real-chrome");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
rmSync(DIR, { recursive: true, force: true }); rmSync(PROF, { recursive: true, force: true });
mkdirSync(DIR, { recursive: true }); mkdirSync(`${PROF}/Default`, { recursive: true });
writeFileSync(`${PROF}/Default/Preferences`, JSON.stringify({
    download: { default_directory: DIR, prompt_for_download: false, directory_upgrade: true },
}));
const chrome = spawn(CHROME, [
    "--headless=new", `--user-data-dir=${PROF}`, "--remote-debugging-port=9341", "--no-first-run",
    "--disable-features=WebRtcHideLocalIpsWithMdns", "about:blank"]);
let target;
for (let i = 0; i < 40 && !target; i++) {
    target = await fetch(`http://127.0.0.1:9341/json/new?${URL}`, { method: "PUT" }).then((r) => r.json()).catch(() => null);
    if (!target) await sleep(500);
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => (ws.onopen = r));
let id = 0;
const waiting = new Map();
ws.onmessage = (e) => { const m = JSON.parse(e.data); waiting.get(m.id)?.(m); };
const cdp = (method, params = {}) => new Promise((r) => { waiting.set(++id, r); ws.send(JSON.stringify({ id, method, params })); });
const js = async (expression) => (await cdp("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true })).result?.result?.value;
const realClick = async (sel) => {
    const { x, y } = await js(`(() => { const r = document.querySelector(${JSON.stringify(sel)}).getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
    for (const type of ["mousePressed", "mouseReleased"]) await cdp("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
};
const waitFor = async (expr, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) if (await js(expr)) return true; return false; };

await waitFor("!!navigator.serviceWorker?.controller", 15000);
const send = await chromium.launchPersistentContext(join(tmpdir(), "p2p-test-profiles", "real-chrome-send"), {
    channel: "chrome", headless: true, args: ["--disable-features=WebRtcHideLocalIpsWithMdns"] });
const sp = await send.newPage(); await sp.goto(URL);

for (const n of [1, 2, 3]) {
    if (n === 3) {
        // simulate a browser blocking the automatic download: the first iframe never makes its request
        await js(`(() => { const d = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "src"); let first = true;
            Object.defineProperty(HTMLIFrameElement.prototype, "src", { configurable: true, get: d.get,
                set(v) { if (first) { first = false; return; } d.set.call(this, v); } }); })()`);
    }
    const data = randomBytes(5 << 20), name = `plain-${n}.bin`, src = join(WORK, name);
    writeFileSync(src, data);
    await sp.setInputFiles("#file", src);
    await sp.waitForFunction(() => /^\d{6}$/.test(document.querySelector("#code").textContent));
    await js(`document.querySelector("#codeIn").value = ${JSON.stringify(await sp.textContent("#code"))}`);
    await realClick("#receive");
    let how = "neither";
    for (const end = Date.now() + 60000; Date.now() < end && how === "neither"; await sleep(300)) {
        if (await js(`/in your downloads/.test(document.querySelector("#recvStatus").textContent)`)) how = "started by itself";
        else if (await js(`!!document.querySelector("#saveAs")`)) how = `button shown: "${await js(`document.querySelector("#saveAs").textContent`)}"`;
    }
    console.log(`receive #${n}: ${how}`);
    if (how.startsWith("button")) {
        await realClick("#saveAs");
        const ok = await waitFor(`/in your downloads/.test(document.querySelector("#recvStatus").textContent)`, 60000);
        console.log(`   after a real click on the button: ${ok ? "received" : "STUCK: " + await js(`document.querySelector("#recvStatus").textContent`)}`);
    }
    if (how === "neither") console.log(`   receiver status: ${await js(`document.querySelector("#recvStatus").textContent`)}`);
    await sleep(2500); // let Chrome rename .crdownload
    const saved = readdirSync(DIR);
    const same = saved.includes(name) && createHash("sha1").update(readFileSync(`${DIR}/${name}`)).digest("hex") === createHash("sha1").update(data).digest("hex");
    console.log(`   Chrome's download folder: ${saved.join(", ") || "(nothing)"} -> ${same ? `${name} byte-identical` : "MISSING/DIFFERENT"}`);
    await sp.waitForFunction(() => /sent ✓|waiting for receiver/.test(document.querySelector("#sendStatus").textContent), null, { timeout: 30000 }).catch(() => {});
    rmSync(src);
}
await send.close(); ws.close(); chrome.kill();
await sleep(1500);
rmSync(PROF, { recursive: true, force: true }); rmSync(DIR, { recursive: true, force: true });
