// Redline UI layer. app.js keeps writing plain status text; this file watches it and
// restyles the page (tones, which column is live, toasts, telemetry). No transfer logic here.
{
    const $ = (id) => document.getElementById(id);
    const size = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(2) + " GB" : (n / 1048576).toFixed(1) + " MB");
    const clock = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
    const icon = (paths) => `<svg class="i" viewBox="0 0 24 24">${paths}</svg>`;
    const ICONS = {
        error: icon('<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>'),
        warning: icon('<circle cx="12" cy="12" r="10"/><path d="M10 15V9"/><path d="M14 15V9"/>'),
        success: icon('<path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><path d="m9 11 3 3L22 4"/>'),
        info: icon('<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>'),
        x: icon('<path d="M18 6 6 18"/><path d="m6 6 12 12"/>'),
    };

    // tone of an app.js status message
    const INLINE = /^(enter the 6-digit code|no such code)/;
    const ERROR = /expired|failed|refused|couldn't|cancelled|server error|can't reach|disconnected|not enough|can only receive|no files|stopped|no longer works/;
    const WARNING = /paused|retrying|receiver left|busy|waiting for your browser/;
    const LIVE = /connecting|sending|receiving|waiting|finishing|getting a code/;
    const toneOf = (t) => (!t ? "" : t.includes("✓") ? "success" : INLINE.test(t) || ERROR.test(t) ? "error"
        : WARNING.test(t) ? "warning" : LIVE.test(t) ? "live" : "info");

    const TITLES = [
        [/sent ✓/, "Delivered"], [/received ✓/, "Received"], [/expired|no longer works/, "Code expired"],
        [/retrying/, "Connection lost"], [/connection failed/, "Couldn't connect"], [/paused|waiting for your browser/, "Download paused"],
        [/receiver left/, "Receiver left"], [/busy/, "Code busy"], [/can't reach|disconnected|server error/, "Server problem"],
        [/storage|can only receive/, "Not enough space"], [/no files/, "Empty folder"], [/cancelled/, "Cancelled"],
        [/refused|stopped|failed|couldn't/, "Transfer stopped"],
    ];
    const titleOf = (t) => (TITLES.find(([re]) => re.test(t)) || [, "Notice"])[1];

    // side toasts: newest in front, two older ones peek behind, hover fans them out
    const toasts = $("toasts");
    const restack = () => [...toasts.children].reverse().forEach((t, i) => {
        t.dataset.depth = i;
        t.hidden = i > 2;
    });
    const dismiss = (t) => {
        t.remove();
        restack();
    };
    const toast = (tone, title, body) => {
        let t = [...toasts.children].find((x) => x.dataset.title === title);
        if (!t) {
            t = document.createElement("div");
            t.className = "toast";
            t.dataset.title = title;
            t.setAttribute("role", tone === "error" ? "alert" : "status");
            t.innerHTML = `${ICONS[tone]}<div><strong></strong><p></p></div><button class="x" aria-label="Dismiss">${ICONS.x}</button>`;
            t.querySelector(".x").onclick = () => dismiss(t);
            t.querySelector("strong").textContent = title;
        }
        t.dataset.tone = tone;
        t.querySelector("p").textContent = body.charAt(0).toUpperCase() + body.slice(1);
        toasts.append(t);
        clearTimeout(t.timer);
        t.querySelector(".timer")?.remove();
        if (tone === "success" || tone === "info") {
            t.insertAdjacentHTML("beforeend", '<span class="timer"></span>');
            t.timer = setTimeout(() => dismiss(t), 6000);
        }
        restack();
    };
    const clearToast = (title) => [...toasts.children].filter((x) => x.dataset.title === title).forEach(dismiss);

    // file chip, incoming file, route
    let current = null;
    const file = (f, count = 1) => {
        current = f;
        $("fileName").textContent = f.name;
        $("fileMeta").textContent = count > 1 ? `${size(f.size)} · ${count} files · zipped while sending` : size(f.size);
    };
    const incoming = (meta) => {
        $("incoming").hidden = !meta;
        if (meta) $("incoming").innerHTML = `<span></span><span class="mono">${size(meta.size)}</span>`;
        if (meta) $("incoming").firstChild.textContent = meta.name;
    };
    const route = (r) => {
        const kind = !r ? "" : r === "relay" ? "relay" : "direct";
        $("route").dataset.kind = kind;
        $("route").lastChild.textContent = r || "connecting";
        $("route").firstChild.classList.toggle("pulse", !r);
    };

    // progress: speed is a moving average of the bytes app.js reports
    let last = null;
    let speed = 0;
    let size0 = 0;
    const progress = (done, total) => {
        const now = performance.now();
        if (last && total === last.total && done > last.done) {
            const s = ((done - last.done) / (now - last.t)) * 1000;
            speed = speed ? speed * 0.7 + s * 0.3 : s;
        }
        if (!last || done !== last.done || total !== last.total) last = { done, total, t: now };
        const p = total ? done / total : 1;
        document.querySelector(".fill").style.setProperty("--p", p);
        $("pct").textContent = `${Math.floor(p * 100)}%`;
        if (total > 1) size0 = total;
        if (total <= 1) return ($("readout").innerHTML = size0 ? `${size(size0)}${speed ? ` · avg <b>${size(speed)}/s</b>` : ""}` : "");
        const left = speed ? clock((total - done) / speed) + " left" : "";
        $("readout").innerHTML = `${size(done)} / ${size(total)}${speed ? ` · <b>${size(speed)}/s</b>` : ""}${left ? " · " + left : ""}`;
    };

    // the code: six cells in two groups, text stays exactly the digits
    const codeEl = $("code");
    let expires = 0;
    const renderCode = () => {
        const digits = codeEl.textContent;
        if (codeEl.dataset.code === digits && codeEl.children.length === 2) return;
        codeEl.dataset.code = digits;
        const cell = (i) => `<span>${digits[i] || ""}</span>`;
        codeEl.innerHTML = [0, 3].map((g) => `<span class="cellgroup">${[g, g + 1, g + 2].map(cell).join("")}</span>`).join("");
        codeEl.classList.toggle("live", !!digits);
        codeEl.setAttribute("aria-label", digits ? `Code ${digits.split("").join(" ")}` : "Getting a code");
        $("codeActions").hidden = !digits;
        expires = digits ? Date.now() + 3600e3 : 0;
        tick();
    };
    const tick = () => {
        if (!expires) return;
        const s = Math.max(0, (expires - Date.now()) / 1000);
        $("expiry").firstElementChild.textContent = `Expires in ${clock(s)}`;
        $("expiry").classList.toggle("soon", s < 300);
    };
    setInterval(tick, 1000);

    // receive cells mirror the real (transparent) input
    const input = $("codeIn");
    const cells = [...document.querySelectorAll("#cells .cellgroup > span")];
    const paintCells = () => {
        const v = input.value.replace(/\D/g, "").slice(0, 6);
        if (v !== input.value) input.value = v;
        const focused = document.activeElement === input;
        cells.forEach((c, i) => {
            c.textContent = v[i] || "";
            c.classList.toggle("cur", focused && i === Math.min(v.length, 5) && v.length < 6);
        });
        $("cells").classList.remove("err");
    };
    for (const ev of ["input", "focus", "blur"]) input.addEventListener(ev, paintCells);

    // react to every status change app.js makes
    const steps = [...document.querySelectorAll("#steps [data-s]")];
    const setStep = (name) => {
        const at = steps.findIndex((s) => s.dataset.s === name);
        steps.forEach((s, i) => {
            s.className = i < at || name === "done" ? "done" : i === at ? "now" : "";
        });
    };
    const lastText = new Map();
    const onStatus = (el) => {
        const text = el.textContent.trim();
        const tone = toneOf(text);
        el.dataset.tone = el.querySelector("#saveAs") ? "" : tone;
        const sending = el.id === "sendStatus";

        if (text && text !== lastText.get(el.id)) {
            if (tone === "error" && !INLINE.test(text)) toast("error", titleOf(text), text);
            else if (tone === "warning" || tone === "success") toast(tone, titleOf(text), text);
            else if (tone === "live") clearToast("Download paused");
            if (!sending && INLINE.test(text)) $("cells").classList.add("err");
        }
        lastText.set(el.id, text);

        const send = $("sendStatus").textContent.trim();
        const recv = $("recvStatus").textContent.trim();
        $("drop").hidden = !!(current && send);
        $("sendView").hidden = !(current && send);
        codeEl.classList.toggle("wait", !codeEl.textContent && /getting a code/.test(send));
        $("recvCol").classList.toggle("dim", !!send && toneOf(send) !== "error");
        $("sendCol").classList.toggle("dim", ["live", "warning", "success"].includes(toneOf(recv)));
        if (!recv) incoming(null);

        if (/connecting/.test(text)) setStep("connect");
        else if (/sending|receiving|waiting for the receiver|paused|waiting for your browser/.test(text)) setStep("transfer");
        else if (tone === "success") setStep("done");
        else if (/enter this code|waiting for sender/.test(text)) setStep("code");
    };
    const watch = (el, fn) => new MutationObserver(() => fn(el)).observe(el, { childList: true, characterData: true, subtree: true });
    watch($("sendStatus"), onStatus);
    watch($("recvStatus"), onStatus);
    watch(codeEl, renderCode);
    new MutationObserver(() => {
        $("telemetry").hidden = $("bar").hidden;
        document.body.classList.toggle("moving", !$("bar").hidden);
        if ($("bar").hidden) {
            last = null;
            speed = 0;
            size0 = 0;
            route("");
        }
    }).observe($("bar"), { attributes: true, attributeFilter: ["hidden"] });

    // buttons that only drive the existing inputs
    $("pickFiles").onclick = () => $("file").click();
    $("change").onclick = () => $("file").click();
    $("copy").onclick = () => navigator.clipboard?.writeText(codeEl.textContent)
        .then(() => toast("success", "Code copied", `${codeEl.textContent} is on your clipboard.`)).catch(() => { });

    const drop = $("drop");
    drop.ondragover = (e) => {
        e.preventDefault();
        drop.classList.add("over");
    };
    drop.ondragleave = () => drop.classList.remove("over");
    drop.ondrop = (e) => {
        e.preventDefault();
        drop.classList.remove("over");
        const items = [...e.dataTransfer.items];
        if (items.some((it) => it.webkitGetAsEntry?.()?.isDirectory)) {
            return toast("info", "Use Choose folder", "Dropped folders can't be read here. Pick it with Choose folder.");
        }
        const files = [...e.dataTransfer.files];
        if (files.length) share(files.length === 1 ? files[0] : zipFiles(files), files.length);
    };

    const online = (ok) => {
        $("online").lastChild.textContent = ok ? "signaling online" : "offline";
        $("online").firstChild.style.background = ok ? "var(--success)" : "var(--warning)";
        $("online").firstChild.classList.toggle("pulse", ok);
    };

    window.ui = { file, incoming, route, progress, online };
    renderCode();
}
