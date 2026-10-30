# Deploying to Koyeb

The app runs as one Docker container on [Koyeb](https://www.koyeb.com/), with [Upstash](https://upstash.com/) for Redis and [Metered](https://www.metered.ca/) for TURN. All three have free plans. Koyeb builds the `Dockerfile` straight from GitHub and gives the app an HTTPS URL, so no Cloudflare tunnel is needed.

| Piece | Where | Why |
|---|---|---|
| FastAPI app (page, `/config`, WebSocket signaling) | Koyeb web service, **exactly 1 instance** | Rooms live in memory, so every peer must reach the same process |
| Redis (code states) | Upstash | Koyeb's free plan allows one service, so Redis can't run beside the app |
| TURN relay | Metered | Unchanged from local use |

## 1. Redis on Upstash

1. Sign in at [console.upstash.com](https://console.upstash.com/) and create a **Redis** database.
2. Pick the region closest to the Koyeb region you'll use in step 2: **eu-central-1 (Frankfurt)** for Koyeb Frankfurt, or **us-east-1** for Koyeb Washington. Keep TLS on (the default).
3. Copy the connection URL. It looks like `rediss://default:<password>@<name>.upstash.io:6379`. Note the double `s`: that's TLS.

Each transfer uses only a few Redis commands, so the free plan is plenty.

## 2. The app on Koyeb

1. Sign in at [app.koyeb.com](https://app.koyeb.com/) (GitHub login is simplest).
2. **Create service → Web service → GitHub.** Install the Koyeb GitHub app for `KrBeTect2025/peer` when asked; that lets Koyeb redeploy on every push.
3. Repository `KrBeTect2025/peer`, branch `master`.
4. **Builder:** Dockerfile. Leave the Dockerfile path, command and arguments at their defaults; the `Dockerfile` already starts the server correctly.
5. **Instance:** Free (or any paid size). **Region:** Frankfurt or Washington, matching Upstash.
6. **Environment variables.** Add both as **Secrets**, never as plain text:

   | Name | Value |
   |---|---|
   | `REDIS_URL` | the Upstash `rediss://…` URL from step 1 |
   | `METERED_TURN_URL` | your Metered credentials URL (`https://<app>.metered.live/api/v1/turn/credentials?apiKey=…`) |

   Don't set `PORT`: Koyeb sets it, and the server listens on whatever it says. `CODE_TTL` is optional (default 3600).
7. **Ports:** `8000`, protocol HTTP, route `/`. This is the default.
8. **Health check:** switch from TCP to **HTTP**, port `8000`, path `/healthz`.
9. **Scaling:** 1 instance. On a paid plan, keep min and max at 1: a second instance would split rooms between processes and receivers would get "no such code".
10. Name the service (the name becomes part of the URL) and **Deploy**. The first build takes a few minutes. The logs should end with `Uvicorn running on http://0.0.0.0:8000`.

The app is live at `https://<service>-<org>.koyeb.app`.

## 3. Check the deployment

```bash
APP=https://<service>-<org>.koyeb.app
curl $APP/healthz        # {"ok":true}
curl $APP/config         # must list turn: / turns: servers, not only stun:
```

If `/config` shows only `stun:` servers, `METERED_TURN_URL` is missing or wrong. Check the Koyeb logs for `Metered TURN failed`.

Then try it for real:

1. **Different networks.** Send from a laptop on Wi-Fi to a phone on mobile data. This is the case local testing couldn't cover.
2. **Idle sender.** Pick a file, wait 3 minutes without entering the code anywhere, then receive. This shows Koyeb's proxy isn't cutting a waiting sender's connection (the server pings it every 20 s to prevent that).
3. **Browser tests** against the live URL, from `tests/`:

   ```bash
   APP_URL=$APP/ node browser.test.mjs basic multi senderdrop
   ```

## How the free plan behaves

- **Sleep after 1 hour without traffic.** Koyeb's free instance scales to zero when nothing has reached it for an hour, and the next visitor waits 1–5 seconds while it wakes. An open WebSocket counts as traffic, so a sender waiting for a receiver keeps it awake.
- **Waiting codes die on a redeploy.** Running transfers continue, because the file goes peer to peer and the page ignores a server drop once connected. Senders who were still waiting see "disconnected from server" and pick the file again.
- **Every push to `master` redeploys**, so push when nobody is waiting on a code.

## Updating

Push to `master`. Koyeb rebuilds and swaps the instance automatically. Secrets stay in Koyeb and never go in the repo.
