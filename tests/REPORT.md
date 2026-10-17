# Test report

How the P2P file share was tested, what was found, and what was fixed. Tests ran on 10–11 Oct 2026 on one
Windows 11 laptop (i7-1355U, 16 GB RAM) with Chrome, Edge and Firefox, against the app running in Docker,
both on `localhost` and through the public Cloudflare link.

## Summary

| Area | Result |
|---|---|
| Receiving into the browser's own downloads (Chrome, Edge, Firefox) | ✅ Download appears in the download bar 0.1–5 s after pressing Receive, no dialog |
| Every received file byte-identical to the original (SHA-1) | ✅ All passing runs, 0 bytes to 50 GB |
| Receiver memory while receiving | ✅ Flat, ~400–570 MB (the browser itself), whatever the file size |
| Largest file | ✅ 50 GB (save-dialog path) · 3 GB over 14.6 min (download-bar path) |
| End-to-end over the public link, real visible Chrome windows | ✅ 5/5 files |
| Failure handling (sender leaves, receiver cancels) | ✅ Clear message on both sides |
| Pausing the download in the download bar | ✅ Both sides say it's paused; resuming carries on where it stopped (checked by hand) |
| Fallbacks (no service worker / Safari-style stream error) | ✅ Falls back to the save-dialog path |

## 1. The download-bar path (`sw.js` + `streamSink`)

### Automated suite: `browser.test.mjs` (final code, all passing)

| Test | What it checks | Result |
|---|---|---|
| `basic` | Chrome → Chrome, 100 MB | Download shown 0.1 s after Receive; no button; name kept; byte-identical; both sides say done |
| `edge` | Chrome → Edge, 50 MB | Same as above |
| `firefox` | Chrome → Firefox, 300 MB (~2 min, well past Firefox's 30 s idle-worker limit) | Same as above |
| `zero` | 0-byte file | Empty file saved |
| `unicode` | Name `तस्वीर (1) 'x' #&.jpg` | Saved with exactly that name |
| `html` | Sender sends an `.html` file with a script | Saved as a file; page didn't navigate, open a tab or run it |
| `second` | Two receives in the same tab | Both byte-identical |
| `multi` | Three files picked at once (30 MB, a Hindi name, 0 bytes) | Saved as `3 files.zip`; Python's `zipfile` finds all three byte-identical, CRCs valid |
| `senderdrop` | Sender closes the tab at ~20 MB | The browser asks first (beforeunload); the receiver's download is marked **failed**, not stuck; receiver says "transfer stopped" |
| `cancel` | Receiver cancels in the download bar | Receiver says "download cancelled"; sender says "receiver left, waiting for receiver..." |
| `nosw` | Browser without service workers | Falls back to the "save …" button / save dialog; file identical |
| `dataclone` | Browser that can't hand a stream to the worker (what Safari 17 does) | Same fallback; file identical |
| `long` | 1 GB (final code) and 3 GB (same download path, one build earlier) | 1 GB in 4.7 min, peak 466 MB · 3 GB in 14.6 min, peak 568 MB; both byte-identical |

### Real Chrome, nothing overridden: `real-chrome.mjs`
Test tools normally take over a browser's downloads, so this one drives a plain Chrome through its debugging
protocol, with real mouse clicks and Chrome's own download folder.

| Case | Result |
|---|---|
| 1st receive | Started by itself; file byte-identical in Chrome's download folder |
| 2nd receive, same tab | Started by itself (Chrome didn't block it: each one follows a real click on Receive) |
| 3rd receive with the download blocked (simulated) | After 3 s a "download name (size)" button appeared; a real click on it started the download; file byte-identical |

### End-to-end over the public link: `public-link.mjs`
Two visible Chrome windows on `https://…trycloudflare.com`; the receiver is a plain Chrome saving into
`Downloads\p2p-test`.

| File | Size | Time | Result |
|---|---|---|---|
| `hello.txt` | 73 B | 1.0 s | ✅ identical |
| `photo तस्वीर (1).jpg` | 3 MB | 2.2 s | ✅ identical |
| `empty.txt` | 0 B | 1.0 s | ✅ identical |
| `page.html` | 65 B | 0.9 s | ✅ identical, never rendered |
| `video-200MB.bin` | 200 MB | 95 s | ✅ identical |

### Experiment: is the keep-alive ping really needed?
The same Firefox test with the ping removed: **the download died at exactly 30 s** (199 of 300 MB), because Firefox
stopped the "idle" service worker. With the ping it completes. This is why `streamSink` pings the worker every 10 s.

### Pausing the download (checked by hand in Chrome)
Pausing in the download bar makes the browser stop taking data. The receiver keeps at most ~64 MB more in memory,
then the sender stops and waits (no acks). After 5 s both pages say the download is paused. Resuming in the
download bar carries on exactly where it stopped. An automated version of this check was written but hung in the
test harness, so it isn't in `browser.test.mjs`.

## 2. Bugs found by testing, and fixed

| # | Found by | Bug | Fix |
|---|---|---|---|
| 1 | Public-link test (4 of 5 files failed) | The sender showed its code before the server had registered it; over the internet a quick receiver got "no such code" | The server sends `{"type":"created"}` once the code exists; the page only shows the code then |
| 2 | `cancel` test | If the receiver left while the sender was reading the next chunk from disk, the sender showed "send failed: …readyState is not 'open'" | Check the channel again after the disk read |
| 3 | `cancel` test | Cancelling in the download bar showed "couldn't save the file: Cannot read properties of undefined" | The browser rejects with no error at all; that now reads "download cancelled" |
| 4 | Ping experiment, then a real pause | Without progress the receiver just said "receiving…" forever. A first fix (end the transfer after 60 s without progress) turned out to also kill downloads **paused** for over a minute | Never end a transfer on a timer. After 5 s without progress both sides say so ("is the download paused?" / "receiver's download is paused or busy"), and both pages now count *saved* bytes, so they match the download bar |
| 5 | Earlier, 1-hour test | A code expiring after 1 hour also killed a transfer still running | After the hour no one new can join, but the running transfer finishes |

## 3. Earlier results: why the receiver writes to disk at all

The first version kept the whole file in memory until it was saved.

| Version | File | Result | Receiver's peak memory |
|---|---|---|---|
| In memory | 2 GB | ✅ | 2.9 GB |
| In memory | 4 GB | ✅ | 9.7 GB |
| In memory | 8 GB | ❌ stopped at 15 GB to keep the PC usable | 15 GB |
| Save dialog, written as it arrives | **50 GB** | ✅ identical, ~5 h | **422 MB** |
| Browser storage (OPFS), written as it arrives | 9.5 GB | ✅ identical | 409 MB |
| Browser storage (OPFS) | 50 GB | refused up front: Chrome and Edge give a site 10 GB | — |

In memory needed ~2.4× the file size in RAM. Writing to disk keeps memory flat, so the limit became free disk space.

## 4. What wasn't tested

- **Safari and phones** (no device). Safari's stream error is simulated (`dataclone`) and falls back correctly.
- **Two different networks through the Metered TURN relay.** All runs had both browsers on one PC, so the route
  was always "direct, same network" (signaling did go through the public link).
- **Real-world speed.** On this PC every WebRTC transfer topped out at ~3 MB/s, the same as its Wi-Fi link speed
  (24 Mbps), even between two tabs, and even with no app code involved. Speeds above are for this PC only.
- **Chrome's "Ask where to save each file" setting**.
- **Resume after a drop**: not supported; a broken transfer starts over.

## Running the tests

```bash
cd tests
npm i                                   # playwright-core
npx playwright-core install firefox     # once, for the Firefox tests (Chrome and Edge must be installed)

python check_codes.py ws://127.0.0.1:8000                          # server: code states
node browser.test.mjs basic edge firefox zero unicode html second multi senderdrop cancel nosw dataclone
LONG_MB=1024 node browser.test.mjs long                            # long transfer + memory (Windows)
node real-chrome.mjs                                               # plain Chrome, real downloads
node public-link.mjs https://<your-link>.trycloudflare.com/        # visible windows, Downloads\p2p-test
```
In PowerShell, set variables first instead: `$env:LONG_MB = 1024; node browser.test.mjs long`.
Big test files and downloads go to `TEST_DIR` (default: a `p2p-test` folder in the system temp folder).
For the 1-hour rule, see the top of `check_codes.py` (it needs a server started with a short `CODE_TTL`).
