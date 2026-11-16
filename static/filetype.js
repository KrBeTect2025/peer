// File-type check for received files. A file's name can say anything, but most formats start with a
// fixed byte pattern ("magic bytes"), so the first bytes show what the file really is. Comparing that
// with the name catches disguised files, like a program renamed to photo.jpg. It is not a virus scan:
// a real PDF or ZIP can still carry something harmful, and this never looks inside.
// Used by app.js on the first chunk of a transfer; tested by tests/filetype.test.mjs.

// what each format starts with. `at` is the offset when the pattern isn't at the very start.
// `exts` are the names that format normally has; `program` marks files that run code when opened.
const FILE_SIGNATURES = [
    { label: "Windows program", bytes: [0x4d, 0x5a], program: true, exts: ["exe", "dll", "scr", "sys", "com", "cpl", "ocx", "efi"] },
    { label: "Linux program", bytes: [0x7f, 0x45, 0x4c, 0x46], program: true, exts: ["", "so", "bin", "elf", "run", "appimage", "out", "o", "ko"] },
    { label: "ZIP archive", bytes: [0x50, 0x4b, 0x03, 0x04], exts: ["zip", "docx", "xlsx", "pptx", "odt", "ods", "odp", "epub", "apk", "jar", "aab", "ipa", "xpi", "vsix", "whl", "nupkg", "kmz", "3mf"] },
    { label: "PDF", bytes: [0x25, 0x50, 0x44, 0x46], exts: ["pdf", "ai"] },
    { label: "PNG image", bytes: [0x89, 0x50, 0x4e, 0x47], exts: ["png", "apng"] },
    { label: "JPEG image", bytes: [0xff, 0xd8, 0xff], exts: ["jpg", "jpeg", "jpe", "jfif"] },
    { label: "GIF image", bytes: [0x47, 0x49, 0x46, 0x38], exts: ["gif"] },
    // beyond the minimum list: common enough that leaving them "not recognised" would be noise
    { label: "old Office file or Windows installer", bytes: [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], exts: ["doc", "xls", "ppt", "msi", "msg", "pub", "vsd"] },
    { label: "RAR archive", bytes: [0x52, 0x61, 0x72, 0x21, 0x1a, 0x07], exts: ["rar"] },
    { label: "7-Zip archive", bytes: [0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c], exts: ["7z"] },
    { label: "GZIP archive", bytes: [0x1f, 0x8b], exts: ["gz", "tgz"] },
    { label: "MP4 / MOV video or HEIC image", at: 4, bytes: [0x66, 0x74, 0x79, 0x70], exts: ["mp4", "m4v", "m4a", "mov", "3gp", "heic", "heif", "avif"] },
];

// extensions that run code when double-clicked: scripts, programs, installers and shortcuts
const RUNNABLE_EXTS = new Set(["bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "hta", "sh", "scr",
    "exe", "dll", "com", "pif", "cpl", "msi", "lnk", "reg", "jar", "apk"]);

// ordinary document and media types: "invoice.pdf.exe" uses one of these to hide the real extension.
// A list (not "any extension") so names like jquery.min.js or app.v2.sh aren't flagged.
const DECOY_EXTS = new Set(["pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "txt", "rtf", "csv", "odt",
    "jpg", "jpeg", "png", "gif", "bmp", "webp", "heic", "mp3", "wav", "mp4", "mov", "avi", "mkv", "zip", "rar", "html"]);

// right-to-left override and similar invisible characters: "invoice‮fdp.exe" shows as "invoiceexe.pdf"
const BIDI_CHARS = /[‎‏‪-‮⁦-⁩]/;

// how bad a result is, so two checks can be combined as "the worst of both"
const SAFETY_LEVELS = { ok: 0, info: 1, warning: 2, danger: 3 };

function detectFileType(bytes) {
    return FILE_SIGNATURES.find((sig) => {
        const at = sig.at || 0;
        return bytes.length >= at + sig.bytes.length && sig.bytes.every((b, i) => bytes[at + i] === b);
    }) || null;
}

// name: the file name the sender gave; bytes: a Uint8Array with at least the first 16 bytes
// returns { label, level, summary, warnings }: level is one of SAFETY_LEVELS, summary is one short line
function checkFileType(name, bytes) {
    const sig = detectFileType(bytes);
    // "Invoice.PDF   .exe" -> ["pdf", "exe"]: spaces before an extension are another way to hide it
    const exts = name.toLowerCase().split(".").slice(1).map((e) => e.trim());
    const ext = exts.at(-1) ?? "";
    const shown = ext ? "." + ext : "no extension";
    // the type the name claims, when it's one we can check
    const claimed = ext ? FILE_SIGNATURES.find((s) => s.exts.includes(ext)) : null;

    let level = "ok";
    const warnings = [];
    const raise = (lvl, text) => {
        warnings.push(text);
        if (SAFETY_LEVELS[lvl] > SAFETY_LEVELS[level]) level = lvl;
    };

    if (BIDI_CHARS.test(name)) raise("danger", "The name contains hidden characters that reverse text, a trick to disguise the real extension.");

    if (sig?.program) {
        // always warn about programs, even when the name is honest about it
        if (sig.exts.includes(ext)) raise("warning", `This is a ${sig.label}. Only run it if you trust the sender.`);
        else raise("danger", `This is really a ${sig.label}, but its name ends in ${shown}. Don't open it.`);
    } else if (claimed && claimed !== sig) {
        raise("warning", sig
            ? `The name ends in ${shown}, but the file is really a ${sig.label}.`
            : `The name ends in ${shown}, but the file doesn't look like a real ${claimed.label}.`);
    }

    if (exts.length >= 2 && RUNNABLE_EXTS.has(ext) && DECOY_EXTS.has(exts.at(-2))) {
        raise("danger", `The name ends in .${exts.at(-2)}.${ext}: the real extension, .${ext}, hides behind .${exts.at(-2)}.`);
    }
    if (RUNNABLE_EXTS.has(ext) && !sig?.program) raise("warning", `Files ending in .${ext} can run code on your computer when opened.`);

    let summary;
    if (!bytes.length) summary = "empty file";
    else if (sig && sig.exts.includes(ext)) summary = `${sig.label} (matches extension)`;
    else if (sig) summary = `${sig.label} (name says ${shown})`;
    else if (claimed) summary = `not a real ${claimed.label} (name says ${shown})`;
    else summary = "not recognised, so not checked";
    if (sig?.label === "ZIP archive") summary += ", contents not checked";

    // nothing wrong, but nothing verified either: grey, not green
    if (level === "ok" && !sig) level = "info";
    return { label: sig?.label || null, level, summary, warnings };
}
