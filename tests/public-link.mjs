// End-to-end over the public link, in visible browser windows: sender = Chrome driven by Playwright,
// receiver = a plain Chrome window driven over raw CDP (real clicks, real downloads, nothing overridden),
// saving into Downloads\p2p-test. Every file is checked byte-for-byte; results go to public-link.json.
//   node public-link.mjs https://<your-link>.trycloudflare.com/      env: CHROME_PATH, TEST_DIR
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, readdirSync, readFileSync, existsSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";

const LINK = process.argv[2];
const DL = join(process.env.USERPROFILE, "Downloads", "p2p-test");
const SRC = join(process.env.TEST_DIR || join(tmpdir(), "p2p-test"), "public-link");
const CHROME = process.env.CHROME_PATH || "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PROF = join(tmpdir(), "p2p-test-profiles", "public-link-recv");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha1 = (b) => createHash("sha1").update(b).digest("hex");
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

mkdirSync(DL, { recursive: true });
mkdirSync(SRC, { recursive: true });
rmSync(PROF, { recursive: true, force: true });
mkdirSync(join(PROF, "Default"), { recursive: true });
writeFileSync(join(PROF, "Default", "Preferences"), JSON.stringify({
    download: { default_directory: DL, prompt_for_download: false, directory_upgrade: true },
}));

const files = [
    ["hello.txt", Buffer.from("Hello from the P2P file share!\nThis came browser-to-browser over WebRTC.\n")],
    ["photo तस्वीर (1).jpg", randomBytes(3 << 20)],
    ["empty.txt", Buffer.alloc(0)],
    ["page.html", Buffer.from("<script>alert('this must never run')</script><h1>just a file</h1>")],
    ["video-200MB.bin", randomBytes(200 << 20)],
];

// receiver: a plain, visible Chrome window
const chrome = spawn(CHROME, [
    `--user-data-dir=${PROF}`, "--remote-debugging-port=9342", "--no-first-run", "--no-default-browser-check",
    "--disable-features=WebRtcHideLocalIpsWithMdns", "--window-position=760,40", "--window-size=700,600", "about:blank"]);
let target;
for (let i = 0; i < 40 && !target; i++) {
    target = await fetch(`http://127.0.0.1:9342/json/new?${LINK}`, { method: "PUT" }).then((r) => r.json()).catch(() => null);
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
const recvStatus = () => js(`document.querySelector("#recvStatus").textContent`);
for (let i = 0; i < 60 && !(await js("!!navigator.serviceWorker?.controller")); i++) await sleep(500);
const controlled = await js("!!navigator.serviceWorker?.controller");
log(`receiver window open on ${LINK}, service worker active: ${controlled}`);

// sender: a visible Chrome window
const send = await chromium.launchPersistentContext(join(tmpdir(), "p2p-test-profiles", "public-link-send"), {
    channel: "chrome", headless: false, args: ["--disable-features=WebRtcHideLocalIpsWithMdns", "--window-position=40,40", "--window-size=700,600"] });
const sp = send.pages()[0] || await send.newPage();
await sp.goto(LINK);

const results = [];
for (const [name, data] of files) {
    const src = join(SRC, name);
    writeFileSync(src, data);
    rmSync(join(DL, name), { force: true });
    await sp.setInputFiles("#file", src);
    await sp.waitForFunction(() => /^\d{6}$/.test(document.querySelector("#code").textContent));
    const code = await sp.textContent("#code");
    await js(`document.querySelector("#codeIn").value = ${JSON.stringify(code)}`);
    const t0 = Date.now();
    await realClick("#receive");
    let status = "", route = "", sawButton = false;
    while (Date.now() - t0 < 600000) {
        status = await recvStatus();
        if (/\((direct[^)]*|relay)\)|, (direct[^)]*|relay)\)/.test(status)) route = status.match(/(direct, same network|direct|relay)\)/)?.[1] || route;
        if (await js(`!!document.querySelector("#saveAs")`)) sawButton = true;
        if (/in your downloads|stopped|refused|cancelled|couldn't|failed|expired|no such/.test(status)) break;
        await sleep(300);
    }
    const secs = (Date.now() - t0) / 1000;
    let saved = "";
    for (let i = 0; i < 40 && !existsSync(join(DL, name)); i++) await sleep(250); // Chrome renames .crdownload at the end
    if (existsSync(join(DL, name))) saved = sha1(readFileSync(join(DL, name)));
    const ok = /in your downloads/.test(status) && saved === sha1(data);
    const r = { name, bytes: data.length, ok, identical: saved === sha1(data), seconds: +secs.toFixed(1),
        MBps: +(data.length / 1048576 / secs).toFixed(2), route: route || "(too fast to show)", buttonNeeded: sawButton, status };
    results.push(r);
    log(`${ok ? "PASS" : "FAIL"}  ${name}  ${data.length} bytes  ${secs.toFixed(1)} s  ${r.route}  -> ${status}`);
    await sp.waitForFunction(() => /sent ✓|waiting for receiver/.test(document.querySelector("#sendStatus").textContent), null, { timeout: 30000 }).catch(() => {});
    rmSync(src);
}
const pageTitle = await js("document.title");
log(`receiver page still on the app (title "${pageTitle}"), saved files: ${readdirSync(DL).join(", ")}`);
writeFileSync(join(process.cwd(), "public-link.json"), JSON.stringify({ link: LINK, controlled, pageTitle, folder: DL, results }, null, 2));
await sleep(3000);
await send.close();
ws.close();
chrome.kill();
await sleep(1500);
rmSync(PROF, { recursive: true, force: true });
log(results.every((r) => r.ok) ? "ALL PASSED" : "SOME FAILED");
