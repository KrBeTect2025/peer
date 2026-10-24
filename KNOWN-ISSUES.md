# Known issues

Open problems found by the production-event test run (see [tests/PROD-TEST-REPORT.md](tests/PROD-TEST-REPORT.md), 2026-10-24). None of them loses or corrupts data: every transfer that completes is byte-identical. The three high and medium issues that blocked release (F1, F2 and F4) are fixed.

| # | Severity | Issue | User impact | Workaround | Likely fix |
|---|---|---|---|---|---|
| F3 | Medium | A receiver who refreshes the page mid-transfer leaves the partial download stuck "in progress" in the browser's download bar (still there after 150 s). | A stuck, half-written download entry. Re-entering the same code still works and completes. | Cancel the stuck entry in the download bar | On `pagehide`, abort the active sink in `static/app.js` so the service-worker stream errors and the browser marks the download failed |
| F5 | Low | Unhandled `starlette.websockets.WebSocketDisconnected` in `relay()` when a socket closes just as the server starts reading it (files re-picked quickly). | None for users: cleanup still runs, codes and rooms are released. Error tracebacks in the server log. | — | `routers/signaling.py`: catch it alongside `WebSocketDisconnect` |
| F6 | Low | After a failed transfer the progress strip stays frozen (e.g. "16% · 0:11 left", Transfer step lit). | Looks like the transfer is still running; the error line below it is correct. | — | `static/ui.js`: mark the strip stopped or hide it when the status turns to an error |
| F7 | Low | One failure can show two error notifications (e.g. "Code expired" + "Transfer stopped"), overlapping while they animate in. | Noisy. | — | `static/ui.js`: merge errors arriving within ~1 s |
| F8 | Low | Typing your own code into Receive in the sender tab cancels your share and says "code expired: the sender closed the tab…". | Confusing message; the share has to be started again. | Enter the code on the other device | Detect the tab's own code and explain instead of cancelling |
| F9 | Low | With Redis down, the sender sees "getting a code…" for a few seconds (2–15 s) before "server error". | Slow error. | — | Shorter Redis connect timeout in `db/client.py` |
| F10 | Cosmetic | At phone width the step list wraps "DONE" onto a second line. | Cosmetic. | — | Shorter labels or a smaller gap under 400 px |

## Not yet tested

- Two different networks through the Metered TURN relay (all runs were on one machine, so the route was "direct, same network")
- Real network drops: Wi-Fi off, switching to mobile data, laptop sleep
- Safari, Firefox, Edge and real phones for the production scenarios (Firefox and Edge are covered by `browser.test.mjs` for basic transfers)
- A real 1-hour code expiry (simulated with `CODE_TTL=20`)
- A server restart combined with a network glitch during the same transfer: the "connection failed while the server was restarting" path from the F1 fix
- Load and abuse testing

## Deployment notes

- The server must run as **one worker**: rooms live in memory (`services/rooms.py`). Only the code states are in Redis.
- A restart or deploy no longer stops transfers already in progress (F1), but every waiting code dies with the old process. Senders see "disconnected from server" and pick the file again.
- Without `METERED_TURN_URL`, only direct connections work. Users on strict networks will see "connection failed (different networks need a reachable TURN server)".
- Right after a restart, the first `/config` request can take up to 5 s while TURN credentials are fetched from Metered.
