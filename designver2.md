# Design v2 — Redline "Console", reoriented (above the fold)

Version 2 of Superdesign draft **A: Console**. Same design as [designver1.md](designver1.md) (same tokens, components, copy and states) with the page **reoriented** so Send and Receive are fully visible the moment the page loads, without scrolling. **This is the version to build.**

- Draft: `a2d35821-729e-4da8-ab6c-3b51ee7ea670` (version 2; version 1 is still in the draft's history and can be restored) · [preview](https://p.superdesign.dev/draft/a2d35821-729e-4da8-ab6c-3b51ee7ea670)
- Project canvas: https://superdesign.dev/teams/835466be-e0c2-49d5-94fd-a281c2a1146c/projects/250f3606-8825-4cfa-8b74-3ae14d885d0b

---

## 1. What changed from v1

| Area | v1 | v2 | Why |
|---|---|---|---|
| TopBar height | 72px | **64px** | Reclaim 8px |
| Page top padding | `pt-24` (96px) | **`pt-8` (32px)** | Hero no longer floats in empty space |
| Hero layout | Stacked: eyebrow / 72px headline on 2 lines / paragraph below | **One row:** left = eyebrow + 44px headline on one line (`whitespace-nowrap`); right = lead paragraph, right-aligned, max 360px, bottom-aligned (`flex justify-between items-end`) | Hero shrinks from about 330px to about 70px tall |
| Hero to Console gap | `mb-24` (96px) | **`pb-8` (32px)** | |
| Console height | `min-h-[560px]` | **Content height** (about 408px) | No forced empty space |
| Column padding | `p-12` (48px) desktop | **`p-8` (32px)** | |
| Column eyebrow margin | `mb-12` | **`mb-6`** | |
| FileChip margin | `mb-12` | **`mb-6`** | |
| Content alignment | Send code pinned to the bottom (`mt-auto`), Receive pinned to the bottom (`justify-end`) | **Top-aligned.** Receive cells line up with the Send code cells, and the Receive button sits on the same row as COPY CODE | Both columns read as one row of equal parts |
| TelemetryStrip gap | `mt-8` | **`mt-6`** | |

**Measured at 1440×900 (headless Chrome):** Console spans **198 → 606px**, the TelemetryStrip ends about 760px, and nothing in Send or Receive needs a scroll. In v1 the Console started at about 518px and the code digits were cut off at the fold.

Unchanged: all colours, fonts, the 72×96 code cells with the red glow, buttons, the dimmed Receive state, TelemetryStrip, How it works, the red SpecBand and the Footer.

## 2. Theme tokens (same as v1)

| Token | Value | Use |
|---|---|---|
| canvas | `#0a0a0a` | Page background, code cells |
| surface | `#171717` | Console panel, badges |
| surface-raised | `#262626` | FileChip, hairlines, progress track |
| hairline-strong | `#404040` | Cell borders, outline button |
| ink | `#fafafa` | Headlines, digits |
| body | `#a3a3a3` | Running text, labels |
| muted | `#737373` | `·` separators only |
| red | `#dc2626` | Primary button, progress fill, code glow, spec band |
| red-text | `#ef4444` | Eyebrows and step numbers in red |
| success | `#34d399` | Online dot, route badge dot |

- **Fonts:** Archivo 400/600/700 and JetBrains Mono 500/700 (Google Fonts).
- **Corners:** 0px everywhere, pills only for badges.
- **Only shadow:** the code glow, `0 0 0 1px #dc2626, 0 8px 32px -8px rgba(220,38,38,.45)`.
- **Icons:** Lucide via Iconify.

## 3. Page structure (desktop, top to bottom)

```
0     ┌ TopBar 64px ─ ■ peer ··························· ● SIGNALING ONLINE  How it works ┐
96    │ // DEVICE TO DEVICE                                   Files stream browser to   │
      │ Send it straight across.  (44px, one line)        browser. The server only… │  Hero row
198   ├──────────────────────────────┬──────────────────────────────┤
      │ 01 // SEND                    │ 02 // RECEIVE  (dimmed 40%)   │
      │ [FileChip ················ CHANGE] │                               │
      │ YOUR CODE                     │                               │  Console
      │ [4][8][2]  [9][1][3]  (glow)  │ [ ][ ][ ]  [ ][ ][ ]           │  (cells aligned)
      │ [COPY CODE] Expires in 59:12  │ [ RECEIVE FILES → ]           │
606   ├──────────────────────────────┴──────────────────────────────┤
      │ TRANSFER | CODE → CONNECT → TRANSFER → DONE       ● DIRECT · SAME NETWORK │
      │ 64%  1.28 GB / 2.00 GB · 84.2 MB/s · 0:09 left               │  Telemetry
~760  │ ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━──────────────│
900   ── fold ───────────────────────────────────────────────────────
      How it works (3 cols) → red SpecBand (0 B · ∞ · DTLS · 60 min) → Footer
```

## 4. Components

### TopBar
64px, sticky, 95% canvas + backdrop blur, 1px `#262626` bottom border, `px-8`. Left: 8px red square + `peer` (bold 20px). Right: pill `● SIGNALING ONLINE` (mono 11px, pulsing emerald dot, `#171717` with `#262626` border) and a `How it works` link (14px, `#a3a3a3` → `#fafafa`).

### Hero row
`flex justify-between items-end gap-8 pb-8`.
- Left: eyebrow `// DEVICE TO DEVICE` (mono 12px, `#ef4444`, 0.08em, `mb-2`) and H1 `Send it straight across.` (44px, line-height 1, semibold, -0.03em, one line).
- Right: `Files stream browser to browser. The server only makes the introduction and never sees a byte.` (16px/1.6, `#a3a3a3`, max-w 360px, right-aligned).
- Below `md`, stack it: paragraph under the headline, left-aligned, headline allowed to wrap.

### Console
`#171717` panel, 1px `#262626` border, two equal columns (`flex-1`) split by a 1px hairline, `p-8` each. Height comes from content.

**Send column (`01 // SEND`, code-ready state):**
- Eyebrow (mono 12px `#a3a3a3`, `mb-6`).
- FileChip: `#262626`, `p-4`, `mb-6`. Archive icon, file name 14px medium, meta `2.00 GB · 12 files · zipped while sending` (mono 12px), `CHANGE` text button.
- Eyebrow `YOUR CODE` (`mb-4`) → two groups of three 72×96 cells (`#0a0a0a`, `#404040` border, mono 64px bold digits), `gap-4` between groups, red glow on each group.
- Action row (`mt-6`): `COPY CODE` outline button (48px) + `Expires in 59:12` (mono 14px ink) over `Keep this tab open` (14px `#a3a3a3`).

**Receive column (`02 // RECEIVE`):**
- Dimmed while sending (`opacity-40 grayscale pointer-events-none`, 300ms transition). At idle it is full strength.
- Six empty 72×96 cells (3+3) on the **same row** as the Send code cells, then the full-width red `RECEIVE FILES →` button (48px) on the same row as COPY CODE.
- **Build note:** the draft lines these up with a hard-coded `mt-[120px]`. In the real build, use a shared grid instead: make the Console `grid grid-cols-2 grid-rows-[auto_auto_auto_auto]` with rows *eyebrow / chip / cells / actions*, and put an `Enter the 6-digit code from the sender` hint in Receive's chip row. The rows then stay aligned when the file name wraps or the chip is absent.

### TelemetryStrip (`mt-6`)
- Row 1: `TRANSFER | CODE → CONNECT → TRANSFER → DONE` (mono 12px; current step in ink, the rest in `#404040`) · right: pill `● DIRECT · SAME NETWORK`.
- Row 2: `64%` (mono 56px bold) + `1.28 GB / 2.00 GB · 84.2 MB/s · 0:09 left` (mono 14px, speed in ink).
- Bar: 6px `#262626` track, 10 ticks, red fill with a 2px white leading cap.
- Only shown while a transfer runs. At idle the space collapses, so the page is shorter.

### Below the fold (unchanged from v1)
- **How it works:** `py-32`, three columns, red mono `01/02/03`, 24px headings: *Pick a file*, *Share the code*, *It streams straight over*.
- **SpecBand:** full-bleed `#dc2626`, four cells: `0 B` on our server · `∞` file size limit · `DTLS` end-to-end encrypted · `60` min code lifetime.
- **Footer:** `peer` (`#404040`) + `Open source` link.

### Buttons
| Variant | Style |
|---|---|
| Primary | `#dc2626`, white, 48px, 13px bold uppercase 0.1em, 0 radius |
| Outline | transparent, 1px `#404040`, hover fill `#262626` |
| Text | `#a3a3a3` → `#fafafa`, uppercase |

## 5. Rules to keep when building
1. **Above the fold:** at 1440×900 and 1280×720 the whole Console, including the Receive button and COPY CODE row, must be visible without scrolling. Recheck with a screenshot after any change above the Console.
2. **One red moment:** the code glow while waiting, the Receive button at idle, the progress fill during a transfer.
3. **Errors are not just red:** use a `#450a0a` panel with a ⚠ icon and a sentence. Warnings are amber `#fbbf24`, success is emerald.
4. **Keep the `app.js` ids:** `file`, `folder`, `pickFolder`, `code`, `sendStatus`, `codeIn`, `receive`, `recvStatus`, `bar`, and the injected `saveAs`. `tests/browser.test.mjs` depends on them.
5. **Mobile (< 768px):** see the Mobile state in 6.

## 6. Screen states (drawn)

All on the project canvas, built on the v2 layout and checked by screenshot at 1440×900 (desktop) and 390×844 (mobile).

| State | Draft | What it shows |
|---|---|---|
| Code ready (main v2) | [a2d35821](https://p.superdesign.dev/draft/a2d35821-729e-4da8-ab6c-3b51ee7ea670) | Sender waiting with a live code, transfer at 64% |
| Idle | [03f05b28](https://p.superdesign.dev/draft/03f05b28-224a-4365-8969-c6e1f941d1db) | Dropzone (dashed, CHOOSE FILES red + CHOOSE FOLDER outline). Receive at full strength with the caret in the first cell and RECEIVE FILES disabled (`#262626` / `#737373`) until 6 digits are typed. No TelemetryStrip. |
| Receiving | [9409a151](https://p.superdesign.dev/draft/9409a151-6275-4ea9-9992-5fbbcc04e44b) | Receive live: file row `holiday-photos.zip · 8.16 GB from 482 913`, locked cells, amber inline status. Send dimmed. Telemetry 38% with an amber `RELAY` pill and a TURN tooltip. One warning toast: *Download paused*. |
| Errors | [8c98b9fa](https://p.superdesign.dev/draft/8c98b9fa-8444-464f-b1ab-f5f3ba556c6f) | Inline field error (red cell borders + `⚠ No such code. Check the digits.`), the button becomes TRY AGAIN. Collapsed toast stack: *Code expired* in front, 2 more behind. TopBar pill switches to amber `OFFLINE`. |
| Done | [1f64c367](https://p.superdesign.dev/draft/1f64c367-77f2-458d-b1a9-2cb6b91b6cbb) | Code still live, emerald `✓ Sent. Code still active, send again any time.`, all stepper steps ticked, 100%, `DIRECT` pill, success toast *Delivered*. Plus the receiver's fallback save button: `DOWNLOAD HOLIDAY-PHOTOS.ZIP (8.16 GB)`. |
| Mobile | [3ff30536](https://p.superdesign.dev/draft/3ff30536-1c10-4105-a15d-4852e5a5b687) | 56px TopBar (dot only), compact hero, sticky `SEND | RECEIVE` segmented control (red active segment), stacked Send panel with 48×64 cells, full-width COPY CODE, a transfer bottom sheet pinned to the viewport, full-width top toast, and a 2×2 SpecBand. |

## 7. Notifications (side toasts)

Errors and warnings **never cover the screen** and are never modal. They appear in two places at once:

1. **Inline, at the field they relate to:** red cell borders and a one-line `⚠` message under the code cells, or an amber or emerald status line in the column. This is the persistent record.
2. **A side toast, top-right:** the "something happened" signal.

**Toast placement:** `position: fixed; top: 80px; right: 24px; width: 340px`. This sits under the TopBar, in the corner beside the hero. A collapsed stack shows only the newest toast in full. Up to 2 older toasts peek 8px and 16px below it (scaled 96% and 92%, fading), with a `+N more · hover to expand` label. On hover or focus the stack fans out into a column with 12px gaps. At 1440×900 and 1280×720 the collapsed stack overlaps only the hero tagline and the empty top-right corner of the Console, never the cells or buttons.

**Toast anatomy:** `#171717` fill, 1px `#262626` border, soft dark shadow, a 3px left bar in the tone colour, a Lucide icon in the tone colour (`alert-triangle` for error, `pause-circle` for warning, `check-circle-2` for success, `info` for info), a 14px semibold title, a 13px `#a3a3a3` body, an optional uppercase action (`TRY AGAIN`, `GOT IT`, `RESUME IN DOWNLOADS`), and a close ×. 0px corners.

**Behaviour:** slides in from the right (24px, 200ms ease-out). Success, info and recoverable warnings auto-dismiss after 6s, shown by a 2px draining timer line along the bottom edge. Errors and the *Download paused* warning stay until dismissed or resolved. Errors use `role="alert"`, everything else `role="status"` inside an `aria-live="polite"` region. Under reduced motion there is no slide and no timer animation.

**Mobile:** a single full-width toast under the TopBar (16px gutters) with the same anatomy. Only the newest toast shows.

**Which app.js messages become toasts** (the rest stay inline status only):

| Toast | Tone | Trigger in app.js |
|---|---|---|
| Code expired | error | close 4410, or `bye` with reason `expired` |
| No such code | inline only | close 4404 |
| Can't reach the server | error | `configReady` rejected, close 1011 |
| Disconnected from server | error | other socket close |
| Code busy | warning | close 1008 |
| Connection lost, retrying (n/4) | warning | `retry()` |
| Connection failed | error | `retries >= MAX_RETRIES` |
| Download paused | warning (sticky) | `waiting for your browser…` / `receiver's download is paused…` |
| Transfer stopped / refused, couldn't save | error | `stop()` / `ch.onclose` early |
| Delivered / Saved to downloads | success | `done` / `sink.close()` |
| Code copied | success | COPY CODE |
