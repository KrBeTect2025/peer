# Design v3 — Redline "Quiet Console"

v2 fixed the fold but felt cluttered. It kept **every element of v1** (37 text items in the main area, the same count as v1) and only removed the space between them. v3 keeps v2's above-the-fold layout and **removes or merges elements**, then gives the freed space back as breathing room. **This is the version to build.**

- Previous versions: [designver1.md](designver1.md) (original Console) · [designver2.md](designver2.md) (reoriented). v3 inherits everything in v2 that is not listed below: tokens, fonts, buttons, the code cells and glow, the below-the-fold sections, the toast anatomy, and the app.js message mapping (designver2 §7).
- Canvas: https://superdesign.dev/teams/835466be-e0c2-49d5-94fd-a281c2a1146c/projects/250f3606-8825-4cfa-8b74-3ae14d885d0b

## 1. Principle: one job per line
Each column reads as four lines and nothing else: **label → one quiet line → the six cells → one action**. If a piece of information doesn't help the next action, it moves below the fold or appears only when it matters.

## 2. What was removed or merged (v2 → v3)

| v2 element | v3 | Why |
|---|---|---|
| TopBar pill `● SIGNALING ONLINE` | **Removed.** An amber `● OFFLINE` appears only when there's a problem | A healthy connection needs no announcement |
| Hero eyebrow `// DEVICE TO DEVICE` | Removed | Competed with the headline and the console eyebrows |
| Hero paragraph (right side) | **Moved** to the top of *How it works* as its intro (18px) | Explanation belongs with the explanation |
| FileChip (grey box, icon, 3-part meta, zip note) | **One line:** `quarterly-report-final.zip  2.00 GB · 12 files  …  CHANGE` | No box inside a box |
| `YOUR CODE` / `CODE` labels | Removed | Six giant digits explain themselves |
| Receive hint row and label | **One line:** `Type the code from the sending device.` | Mirrors Send's file line, so rows still align |
| Expiry, stacked on 2 lines | One line: `Expires in 59:12 · keep this tab open` | |
| Dropzone icon and sub-copy | Removed: just `Drop files or a folder here` + the two buttons | The buttons already say files/folder |
| Telemetry eyebrow `TRANSFER` + 4-step stepper | Removed | The % and the status line already say where you are |
| Telemetry route pill | Plain coloured word at the end of the readout: `· direct` (emerald) / `· relay` (amber) | |
| Tachometer ticks | Removed; bar is 4px instead of 6px | |
| Toast `+2 more · hover to expand` text | Removed; older toasts only peek as edges | |
| Inline status lines duplicating toasts | Kept only where they say something the toast doesn't | |
| Fallback-save demo box under Done | **Its own state** (*Click to save*), in place in the Receive column | No demo boxes on real screens |

Result: about **20 text items** in the main area instead of 37.

## 3. Layout (desktop 1440×900)

```
0     TopBar 64px        ■ peer                                   How it works
112   Send it straight across.            (44px, pt-12 pb-10, no eyebrow, no paragraph)
196   ┌────────────────────────────┬────────────────────────────┐
      │ 01 // SEND                  │ 02 // RECEIVE               │   p-12 (48px), label mb-8
      │ file.zip  2.00 GB · 12 files  CHANGE │ Type the code from the sending device. │   24px line, mb-8
      │ [4][8][2] [9][1][3]  (glow) │ [▌][ ][ ] [ ][ ][ ]          │   72×96 cells
      │ [COPY CODE] Expires in 59:12 · keep this tab open │ [ RECEIVE FILES → ] │   mt-8
576   └────────────────────────────┴────────────────────────────┘
616   64%                         1.28 / 2.00 GB · 84.2 MB/s · 0:09 left · direct
684   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━   (4px)
900   ── fold ──   How it works (intro paragraph + 3 steps) → red SpecBand → Footer
```

Measured in headless Chrome: Console 196 → 576px, transfer bar ends 684px. More empty space than v2 (48px column padding instead of 32px) and still fully above the fold.

## 4. Component changes

- **TopBar:** brand + `How it works` only. Problem flag: `● OFFLINE` in mono 11px amber, only when `/config` fails or the socket drops.
- **Hero:** `<h1>` only, 44px semibold, -0.03em, padding 48px top and 40px bottom.
- **Column label:** `01 // SEND` / `02 // RECEIVE`, mono 12px `#a3a3a3`, `mb-8`.
- **Line row** (both columns, 24px tall, `mb-8`):
  - Send: file name 15px medium ink + mono 13px `2.00 GB · 12 files` + right-aligned `CHANGE` text button.
  - Receive at idle: `Type the code from the sending device.` (15px `#a3a3a3`).
  - Receive while receiving: incoming file name + size.
- **Cells:** unchanged from v2 (72×96, 64px mono, red glow on the live code).
- **Action row** (`mt-8`):
  - Send: `COPY CODE` (outline, no wrap) + `Expires in 59:12 · keep this tab open` (14px, time in mono ink).
  - Receive: `RECEIVE FILES →` (disabled until 6 digits) / `TRY AGAIN` / `SAVE <FILE>` (fallback).
- **Status note** (replaces the action row when something is in progress): 48px tall, dot or icon + one sentence, tone-coloured. E.g. amber `● Is the download paused in your browser?`, emerald `✓ Sent. The code still works.`
- **Dropzone:** dashed `#404040`, min-height 232px, centred `Drop files or a folder here` (16px `#a3a3a3`) + CHOOSE FILES (red) and CHOOSE FOLDER (outline).
- **Transfer:** `mt-10`. Left: `64%` mono 48px. Right, on the same baseline: `1.28 / 2.00 GB · 84.2 MB/s · 0:09 left · direct` (mono 13px, speed in ink, route in emerald or amber). Below: 4px bar, red fill, 2px white cap. Hidden at idle.
- **Toasts:** same anatomy and placement as v2 (top-right, 340px, collapsed stack) with shorter bodies and no counter text.
- **How it works:** opens with the moved paragraph (18px `#a3a3a3`, max 560px, `mb-16`), then the three steps.

## 5. States

| State | Draft |
|---|---|
| Code ready (main) | [241744ca](https://p.superdesign.dev/draft/241744ca-b780-4b22-8201-e56f1ff3e066) |
| Idle | [96d2eb11](https://p.superdesign.dev/draft/96d2eb11-de4a-452b-bd9d-492a6ca87737) |
| Receiving, download paused (relay) | [c2071967](https://p.superdesign.dev/draft/c2071967-3047-4aae-9456-aa98e9fdf0dd) |
| Errors (inline + side toast, offline flag) | [6b290e06](https://p.superdesign.dev/draft/6b290e06-a528-44c0-899a-cea84e6f22ca) |
| Done (sender) | [a938f1f5](https://p.superdesign.dev/draft/a938f1f5-1399-41f7-b7ea-61cbe386fdec) |
| Click to save (receiver fallback) | [0eaf492a](https://p.superdesign.dev/draft/0eaf492a-312a-4940-adb0-166552a664ac) |

Mobile: use the v2 mobile draft with the same removals (no hero paragraph, file line instead of the chip, no "YOUR CODE" label, bottom sheet showing only % + bar + one readout line).

## 6. Rules to keep when building
1. **Clutter budget:** each column has at most 4 visible lines (label, line, cells, action). New information replaces a line; it doesn't add one.
2. **Above the fold:** at 1440×900 and 1280×720 both columns, including their action rows, stay visible without scrolling.
3. **Errors** show inline at the field plus a top-right side toast; they never cover the screen (designver2 §7).
4. **Keep the `app.js` ids** `file`, `folder`, `pickFolder`, `code`, `sendStatus`, `codeIn`, `receive`, `recvStatus`, `bar`, `saveAs`. `tests/browser.test.mjs` and `tests/public-link.mjs` select by them.
