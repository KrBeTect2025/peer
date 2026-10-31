# Deploying to Render

The app runs as one Docker container on [Render](https://render.com/), with [Upstash](https://upstash.com/) for Redis and [Metered](https://www.metered.ca/) for TURN. All three have free plans. Render builds the `Dockerfile` straight from GitHub and gives the app an HTTPS URL, so no Cloudflare tunnel is needed. The service is described in [`render.yaml`](render.yaml), so Render sets it up in one pass.

| Piece | Where | Why |
|---|---|---|
| FastAPI app (page, `/config`, WebSocket signaling) | Render web service, **exactly 1 instance** | Rooms live in memory, so every peer must reach the same process |
| Redis (code states) | Upstash | Render's free Key Value store loses its data on every restart |
| TURN relay | Metered | Unchanged from local use |

## 1. Redis on Upstash

1. Sign in at [console.upstash.com](https://console.upstash.com/) and create a **Redis** database in **eu-central-1 (Frankfurt)**, the same region as the Render service. Keep TLS on (the default).
2. On the database page, under **Connect**, open the **TCP** tab (not REST), reveal the password with the eye icon and copy the URL. It must look like:

   ```
   rediss://default:<password>@<name>.upstash.io:6379
   ```

   Note the double `s` in `rediss`: that turns on TLS. The `redis-cli` line at the top of the page says `redis://` with a separate `--tls` flag, which the app doesn't use.

Optional check: `redis-cli -u '<that URL>' ping` prints `PONG`.

## 2. The app on Render

1. Sign in at [dashboard.render.com](https://dashboard.render.com/) with GitHub.
2. **New → Blueprint.** Connect GitHub when asked and give Render access to `KrBeTect2025/peer`.
3. Pick the `KrBeTect2025/peer` repository, branch `master`. Render reads `render.yaml` and shows one web service, `peer` (Docker, Free, Frankfurt, health check `/healthz`).
4. Render asks for the two values marked as secret in `render.yaml`:

   | Name | Value |
   |---|---|
   | `REDIS_URL` | the Upstash `rediss://…` URL from step 1 |
   | `METERED_TURN_URL` | your Metered credentials URL (`https://<app>.metered.live/api/v1/turn/credentials?apiKey=…`), the same one as in your local `.env` |

   Don't set `PORT`: Render sets it, and the server listens on whatever it says.
5. **Apply.** The first build takes a few minutes. The logs should end with `Uvicorn running on http://0.0.0.0:10000` (the port Render picks).

The app is live at `https://peer.onrender.com`, or `https://peer-<random>.onrender.com` if that name is taken. The service page shows the exact URL.

Secrets live only in Render, never in the repo. To change one later: service → **Environment** → edit → **Save, rebuild and deploy**.

## 3. Check the deployment

```bash
APP=https://<your-service>.onrender.com
curl $APP/healthz        # {"ok":true}
curl $APP/config         # must list turn: / turns: servers, not only stun:
```

If `/config` shows only `stun:` servers, `METERED_TURN_URL` is missing or wrong. Check the Render logs for `Metered TURN failed`.

Then try it for real:

1. **Different networks.** Send from a laptop on Wi-Fi to a phone on mobile data. This is the case local testing couldn't cover.
2. **Idle sender.** Pick a file, wait **20 minutes** without entering the code anywhere, then receive. This shows the page's keepalive stops Render from putting the server to sleep under a waiting code.
3. **Browser tests** against the live URL, from `tests/`:

   ```bash
   APP_URL=$APP/ node browser.test.mjs basic multi senderdrop
   ```

## How the free plan behaves

- **Sleep after 15 minutes without traffic.** Render stops a free service when no request or WebSocket message has arrived for 15 minutes. The next visitor sees Render's loading page for about a minute while it starts again.
- **Open pages keep it awake.** Every open page sends a small keepalive over its WebSocket once a minute, which counts as traffic. So a sender waiting for a receiver, or a long transfer, keeps the server up. The server drops these messages instead of relaying them.
- **750 free hours a month** per workspace. One always-on service uses at most 744, so this one service fits. A second free service would share the same hours.
- **Restarts and redeploys.** Render may restart a free service at any time, and every push to `master` redeploys. Running transfers continue, because the file goes peer to peer and the page ignores a server drop once connected. Senders still waiting on a code see "disconnected from server" and pick the file again, so push when nobody is waiting.
- **One instance.** The free plan can't scale beyond one, which is what the app needs. On a paid plan, keep it at 1 instance too: a second one would split rooms between processes and receivers would get "no such code".

## Updating

Push to `master`. Render rebuilds and swaps the instance automatically. To always be awake (no cold start), move the service to a paid instance in its **Settings**; nothing in the code changes.
