# Production-event test report

**Date:** 2026-10-24 · **Build:** `master` @ `b78e215` + uncommitted fixes (speed average, zip), running in Docker (`web` + `redis`) · **Browser:** Chrome (headless, Playwright 1.64)

25 production scenarios were run against the real container: real user actions, peers coming and going, and infrastructure failures (server restart, Redis outage, config endpoint down, code expiry). Each was checked against what a user should see. A second server with a 20-second code lifetime (`CODE_TTL=20`) was used for the expiry cases.

## Summary

| Area | Scenarios | Passed |
|---|---|---|
| User input | 8 | 8 |
| Peers joining and leaving | 7 | 7 |
| Infrastructure failures | 7 | 4 (7 after the fixes) |
| Code lifecycle (expiry) | 2 | 2 |
| Phone layout | 1 | 1 |
| **Total** | **25** | **22** (25 after the F1, F2 and F4 fixes) |

All three failures are real app issues (F1, F2 and F4). The tests also turned up 7 more issues that don't fail a scenario: F3 and F5–F10. F1, F2 and F4 are now fixed; the open ones are tracked in [KNOWN-ISSUES.md](../KNOWN-ISSUES.md).

The core is solid. Every transfer that completed was byte-identical (SHA-1 checked). Codes behave correctly through their whole life, Redis failing mid-transfer doesn't hurt a running transfer, and two pairs transferring at once don't interfere.

## Findings

| # | Severity | Finding | How to reproduce | Suggested fix |
|---|---|---|---|---|
| F1 | **High · Fixed** | **A server restart or deploy kills every transfer in progress.** *Fixed: an unplanned signaling drop no longer closes a connected peer; verified with a restart at ~50% of 600 MB → finished byte-identical, sender told to pick the file again.* File data goes directly between the browsers and no longer needs the server, but both sides stop: sender "disconnected from server", receiver "transfer stopped", and the download is marked canceled. | Start a 600 MB transfer, run `docker compose restart web` at 15% | `app.js`: `socket.onclose` calls `closePeer()`. Once the data channel is open, only stop new joins when signaling drops, and keep the peer connection |
| F2 | **High · Fixed** | **Picking the same file again after an error does nothing.** *Fixed: the input is cleared after reading; regression test `samefile` in `browser.test.mjs`.* The browser fires no `change` event for an identical selection, and the app never clears the input. The error messages tell the user to "pick the file again", which is exactly what silently fails. | Share a file, let the code expire (or hit "server error"), pick the same file again | Clear `$("file").value` after reading the files in its `onchange` (the folder input already does this) |
| F3 | Medium | **A receiver refreshing mid-transfer leaves an orphaned download stuck "in progress".** It was still in progress after 150 s and appears never to end. The sender handles it correctly ("receiver left, waiting"), and rejoining with the same code works and completes byte-identical. | Refresh the receiver tab at 15% | On `pagehide`, abort the active sink so the service-worker stream errors and the browser marks the download failed |
| F4 | Medium · Fixed | **The first retry after the server is reachable again still fails** *Fixed: `join()` makes a fresh `/config` request when the stored one had failed; the first retry now works.*, while the pill already says "Signaling online". The user needs a second attempt. | Block `/config`, pick a file ("can't reach server"), unblock, pick again → still "can't reach server"; the third pick works | `join()` awaits the previous, already-failed `configReady` before making a new request. When the stored promise has failed, await a fresh `loadConfig()` |
| F5 | Low | **Unhandled server exception** `starlette.websockets.WebSocketDisconnected` in `relay()` when a socket closes just as the server starts reading it, as happens when files are re-picked quickly. Cleanup still runs (room removed, code expired); the impact is error tracebacks in the logs. | Pick 3–4 files in quick succession | `routers/signaling.py`: catch `WebSocketDisconnected` (or `RuntimeError`) alongside `WebSocketDisconnect` |
| F6 | Low | **After a failed transfer the progress strip stays frozen**, e.g. "16% · 0:11 left" with the Transfer step still lit, so it looks as if it's still running. | Sender closes tab mid-transfer; look at the receiver | When the status turns to an error, mark the strip as stopped or hide it |
| F7 | Low | **One failure shows two error notifications**, e.g. "Code expired" + "Transfer stopped" when the sender leaves, or "Server problem" + "Transfer stopped" on restart. They also overlap while animating in. | Same as F1 / F6 | Merge errors that arrive within ~1 s into one notification |
| F8 | Low | **Typing your own code into Receive in the sender tab** cancels your own share and then says "code expired: the sender closed the tab…", which is confusing because you are the sender. | Share, then type the shown code into Receive in the same tab | If the typed code equals the tab's own code, say "That's your code: enter it on the other device" and don't cancel |
| F9 | Low | With Redis down, the sender sees "getting a code…" for a few seconds (more than 2 s, under 15 s) before "server error". | `docker compose stop redis`, pick a file | Shorter Redis connect timeout in `db/client.py` |
| F10 | Cosmetic | At phone width the step list wraps "DONE" onto a second line. | 390 px wide, during a transfer | Shorter labels or a smaller gap under 400 px |

## What worked (scenario by scenario)

| Scenario | Result |
|---|---|
| Wrong code | Inline "no such code, check the digits", red cells, no notification |
| 3 digits submitted | Inline "enter the 6-digit code", no server call |
| Letters and spaces pasted | Stripped; only digits kept |
| Enter instead of clicking | Same as clicking Receive |
| Copy code | Code on the clipboard, "Code copied" notification |
| Drag and drop a file | Shared, code shown, file name in the chip |
| Folder with subfolders | Arrives as `trip.zip`, paths kept, valid zip |
| Third person on a busy code | "code busy, someone is receiving it"; the running transfer completes |
| Receiver refreshes and rejoins | Sender: "receiver left, waiting"; rejoin completes byte-identical (see F3) |
| Sender picks another file mid-transfer | Receiver: "transfer stopped"; download marked canceled; sender gets a new code |
| Sender closes the tab before / during | Receiver: "code expired" / "transfer stopped"; download marked canceled, never stuck |
| Sender refreshes after a finished transfer | Old code reads as expired |
| Two pairs at the same time | Both byte-identical |
| Server restart while a sender waits | Sender: "disconnected from server", code cleared; old code reads as expired |
| Redis down | Both sides: "server error, try again in a moment"; sharing works again 1 s after Redis is back (with a different file, see F2) |
| Redis dies mid-transfer | Transfer finishes byte-identical |
| `/config` down at page load | "Offline" pill and "can't reach server" (recovery: see F4) |
| Receiver goes offline for 5 s mid-transfer | Transfer completes |
| Code expires while waiting | Sender: "code expired… pick the file again", code cleared; late receiver: "code expired" |
| Code expires mid-transfer | 52% done at expiry; finishes byte-identical; a latecomer is turned away |
| Full transfer at phone size | Completes; no sideways scrolling |

## Not covered by this run

- **Two different networks / the TURN relay.** Every run was on one machine, so the route was always "direct, same network".
- **Real network drops** (Wi-Fi off, switching to mobile data, laptop sleep). Browser offline mode doesn't cut a loopback WebRTC link, so the "receiver goes offline" test shows the transfer survives losing the signaling path, not a real radio drop.
- **Safari, Firefox, Edge and real phones.** This run used Chrome only; phone size was simulated.
- **A real 1-hour expiry.** It was simulated with a 20 s lifetime.
- **Pausing the download** in the browser's download bar (manual-only, see `REPORT.md`).
- **Load and abuse testing**, which was out of scope.

## How it was run

The harness, screenshots and raw results are kept outside the repo (scratchpad). Infrastructure events were triggered with `docker compose restart web` and `docker compose stop/start redis`; a second server ran `CODE_TTL=20 uvicorn main:app --port 8001` against the same Redis.
