# Design v1 — Redline "Console" (draft A, as generated)

Snapshot of Superdesign draft **A: Console** before any changes. This is the reference version; [designver2.md](designver2.md) describes the reoriented version.

- Draft: `a2d35821-729e-4da8-ab6c-3b51ee7ea670` (version 1) · [preview](https://p.superdesign.dev/draft/a2d35821-729e-4da8-ab6c-3b51ee7ea670)
- Project canvas: https://superdesign.dev/teams/835466be-e0c2-49d5-94fd-a281c2a1146c/projects/250f3606-8825-4cfa-8b74-3ae14d885d0b
- Inspiration: Ferrari and Sanity DESIGN.md files on [getdesign.md](https://getdesign.md) (black canvas, a single red, sharp corners, huge mono numerals, mono eyebrow labels).

---

## 1. Theme tokens

| Token | Value | Use |
|---|---|---|
| canvas | `#0a0a0a` | Page background, code cells |
| surface | `#171717` | Console panel, badges |
| surface-raised | `#262626` | FileChip, hairlines, progress track |
| hairline-strong | `#404040` | Cell borders, outline button, separators |
| ink | `#fafafa` | Headlines, digits |
| body | `#a3a3a3` | Running text, labels |
| muted | `#737373` | Separators `·` only |
| red | `#dc2626` | Primary button, progress fill, code glow, spec band |
| red-text | `#ef4444` | Eyebrow `// DEVICE TO DEVICE`, step numbers |
| success | `#34d399` | Online dot, route badge dot |

- **Fonts:** Archivo 400/600/700 (UI and headings) and JetBrains Mono 500/700 (digits, eyebrows, readouts), from Google Fonts.
- **Corners:** 0px everywhere. Pills only for the two status badges.
- **Elevation:** no shadows except the code glow, `0 0 0 1px #dc2626, 0 8px 32px -8px rgba(220,38,38,.45)`.
- **Icons:** Iconify Lucide (`lucide:file-archive`).
- **Motion:** `pulse-dot` 1.6s on the online dot, `transition-colors` on hover.
- Built with the Tailwind CDN and arbitrary values.

## 2. Page structure (top to bottom, desktop)

| # | Section | Size / spacing | Content |
|---|---|---|---|
| 1 | **TopBar** (sticky) | 72px tall, `px-8`, 1px bottom hairline, 95% canvas + blur | 8px red square + `peer` wordmark · right: pill `● SIGNALING ONLINE` (pulsing emerald dot), `How it works` link |
| 2 | **Hero** | `pt-24` (96px) above, `mb-24` (96px) below, max-w 2xl | Eyebrow `// DEVICE TO DEVICE` (red mono 12px) · H1 `Send it straight across.` 72px/0.95 semibold, wraps to 2 lines · lead paragraph 16px body colour |
| 3 | **Console** | `bg #171717`, 1px border, `min-h-[560px]`, 2 equal columns split by a 1px hairline, `p-12` per column | see 3 below |
| 4 | **TelemetryStrip** | `mt-8` under the console | see 3 below |
| 5 | **How it works** | `py-32`, top hairline, 3 columns `gap-16` | Red mono `01/02/03` + 24px heading + body |
| 6 | **SpecBand** | full-bleed `#dc2626`, `py-24`, 4 cells with white/25 dividers | STORAGE `0 B` · LIMITS `∞` · SECURITY `DTLS` · EXPIRY `60` min, all mono 56px |
| 7 | **Footer** | `py-12`, top hairline | `peer` in `#404040` · `Open source` link |

Container: `max-w-[1120px]`, `px-4`.

## 3. Components

### Console, Send column (`01 // SEND`), shown in the "code ready" state
- **Header:** mono 12px eyebrow, `mb-12`.
- **FileChip:** `#262626` row, `p-4`, `mb-12`. Archive icon · `quarterly-report-final.zip` (14px medium) · meta `2.00 GB · 12 files · zipped while sending` (mono 12px) · `CHANGE` text button (13px bold uppercase 0.1em tracking).
- **CodeDisplay:** pushed to the bottom with `mt-auto`. Eyebrow `YOUR CODE` → two groups of 3 cells (`gap-4` between groups), each cell **72×96**, `#0a0a0a` with `#404040` borders, mono **64px** bold tabular digits `482 913`. Each group carries the red glow.
- **Action row:** `COPY CODE` outline button (48px, `#404040` border) + stacked `Expires in 59:12` (mono 14px ink) / `Keep this tab open` (14px body).

### Console, Receive column (`02 // RECEIVE`), shown dimmed
- `opacity-40 grayscale pointer-events-none`, because the send side is live.
- Content sits at the bottom (`justify-end`): 6 empty 72×96 cells (3+3), then a full-width red button `RECEIVE FILES →` (48px).

### TelemetryStrip
- Top row: `TRANSFER | CODE → CONNECT → TRANSFER → DONE` (current step in ink, others in `#404040`) · right: pill `● DIRECT · SAME NETWORK`.
- Readout row: `64%` mono 56px bold + `1.28 GB / 2.00 GB · 84.2 MB/s · 0:09 left` (mono 14px, speed in ink).
- Tachometer bar: 6px `#262626` track, 10 tick dividers, red fill at 64% with a 2px white leading cap.

### Buttons
| Variant | Style |
|---|---|
| Primary | `#dc2626` fill, white, 48px, 13px bold uppercase 0.1em, 0 radius |
| Outline | transparent, 1px `#404040`, hover `#262626` fill |
| Text | `#a3a3a3` → `#fafafa`, uppercase |

## 4. Known issue (why there is a v2)
**Send and Receive are not fully visible on first view.** At 1440×900 (about 800px usable height) the Console starts about 590px down: 72px bar + 96px top padding + about 330px of hero + 96px gap. Its 560px minimum height then pushes the bottom of both columns (the code cells and the Receive button) below the fold. Fixing this is a reorientation, not a redesign: same components, tokens and states; only the vertical order, alignment and spacing change.
