// Checks static/filetype.js with plain byte arrays, using Node's built-in test runner (no installs):
//   node --test tests/filetype.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// filetype.js is a plain browser script (no modules, like zip.js), so load it the same way zip.test.mjs does
const { checkFileType, detectFileType, SAFETY_LEVELS } = new Function(
    readFileSync(new URL("../static/filetype.js", import.meta.url), "utf8") + "; return { checkFileType, detectFileType, SAFETY_LEVELS };",
)();

// the first 16 bytes of a file that starts with `start` (the rest padded with zeros)
const head = (...start) => Uint8Array.from({ length: 16 }, (_, i) => start[i] ?? 0);
const text = (s) => head(...new TextEncoder().encode(s));

const EXE = head(0x4d, 0x5a, 0x90);
const ELF = head(0x7f, 0x45, 0x4c, 0x46, 0x02);
const ZIP = head(0x50, 0x4b, 0x03, 0x04);
const PDF = text("%PDF-1.7");
const PNG = head(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
const JPEG = head(0xff, 0xd8, 0xff, 0xe0);
const GIF = text("GIF89a");

test("each signature is detected", () => {
    const cases = [
        [EXE, "Windows program"], [ELF, "Linux program"], [ZIP, "ZIP archive"], [PDF, "PDF"],
        [PNG, "PNG image"], [JPEG, "JPEG image"], [GIF, "GIF image"],
        [head(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1), "old Office file or Windows installer"],
        [text("Rar!\x1a\x07"), "RAR archive"], [head(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c), "7-Zip archive"],
        [head(0x1f, 0x8b, 0x08), "GZIP archive"], [head(0, 0, 0, 0x18, ...new TextEncoder().encode("ftypmp42")), "MP4 / MOV video or HEIC image"],
    ];
    for (const [bytes, label] of cases) assert.equal(detectFileType(bytes)?.label, label);
    assert.equal(detectFileType(text("hello world")), null);
});

test("a matching file is ok", () => {
    for (const [name, bytes] of [["report.pdf", PDF], ["Photo.JPG", JPEG], ["icon.png", PNG], ["cat.gif", GIF], ["letter.docx", ZIP]]) {
        const r = checkFileType(name, bytes);
        assert.equal(r.level, "ok", name);
        assert.deepEqual(r.warnings, [], name);
        assert.match(r.summary, /matches extension/, name);
    }
    assert.equal(checkFileType("report.pdf", PDF).summary, "PDF (matches extension)");
});

test("a zip says its contents aren't checked", () => {
    assert.match(checkFileType("photos.zip", ZIP).summary, /contents not checked/);
});

test("a program always warns, even with an honest name", () => {
    const r = checkFileType("setup.exe", EXE);
    assert.equal(r.level, "warning");
    assert.match(r.warnings[0], /Windows program/);
    assert.equal(checkFileType("tool", ELF).level, "warning");
});

test("a program disguised as an image is danger", () => {
    const r = checkFileType("photo.jpg", EXE);
    assert.equal(r.level, "danger");
    assert.match(r.warnings[0], /really a Windows program.*\.jpg/);
    assert.equal(checkFileType("song.mp3", ELF).level, "danger");
});

test("a mismatch between two harmless types is a warning", () => {
    const r = checkFileType("picture.jpg", PNG);
    assert.equal(r.level, "warning");
    assert.match(r.warnings[0], /really a PNG image/);
    // the name claims a type we can check, but the bytes don't fit it
    assert.match(checkFileType("invoice.pdf", text("<html>")).warnings[0], /doesn't look like a real PDF/);
});

test("double extension hiding a dangerous one", () => {
    const r = checkFileType("invoice.pdf.exe", EXE);
    assert.equal(r.level, "danger");
    assert.ok(r.warnings.some((w) => /\.pdf\.exe/.test(w)));
    // spaces before the last extension are the same trick
    assert.equal(checkFileType("invoice.pdf          .exe", EXE).level, "danger");
    // a script with a decoy extension, where the bytes are plain text
    assert.equal(checkFileType("photo.jpg.vbs", text("MsgBox 1")).level, "danger");
});

test("ordinary dotted names are not double extensions", () => {
    assert.ok(!checkFileType("jquery.min.js", text("!function(){")).warnings.some((w) => /hides behind/.test(w)));
    assert.equal(checkFileType("backup.tar.gz", head(0x1f, 0x8b)).level, "ok");
});

test("script extensions warn", () => {
    for (const ext of ["bat", "cmd", "ps1", "vbs", "js", "sh", "scr"]) {
        const r = checkFileType(`run.${ext}`, text("echo hi"));
        assert.ok(SAFETY_LEVELS[r.level] >= SAFETY_LEVELS.warning, ext);
        assert.ok(r.warnings.some((w) => w.includes(`.${ext} can run code`)), ext);
    }
});

test("reversed-text characters in the name are danger", () => {
    assert.equal(checkFileType("invoice‮fdp.exe", EXE).level, "danger");
});

test("unknown and empty files are grey, not green", () => {
    const r = checkFileType("notes.txt", text("just some notes"));
    assert.equal(r.level, "info");
    assert.equal(r.summary, "not recognised, so not checked");
    assert.equal(checkFileType("empty.txt", new Uint8Array()).summary, "empty file");
});
