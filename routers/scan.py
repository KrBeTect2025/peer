import json

import redis.asyncio as redis
from core.server import app
from db.client import db
from fastapi import Request
from pydantic import BaseModel, Field
from services.virustotal import lookup, result

# Results are cached in Redis (not in memory) because Render restarts and sleeps the free instance,
# which would wipe an in-memory cache. 1 hour: long enough that re-sent files don't use the quota,
# short enough that a file VirusTotal learns about later gets a fresh answer.
CACHE_TTL = 3600

# Per-IP limits on lookups that reach VirusTotal. The free key allows 4 a minute and 500 a day for the
# whole site, so these stop one person from using it all up. They can't stop many people doing so.
PER_MINUTE = 4
PER_DAY = 40


class HashIn(BaseModel):
    # exactly 64 hex characters; anything else gets FastAPI's automatic 422 reply
    sha256: str = Field(pattern=r"^[0-9a-fA-F]{64}$")


def client_ip(request: Request) -> str:
    # Render's edge and the cloudflared tunnel both run through Cloudflare, which sets CF-Connecting-IP
    # and overwrites any value the browser sent. X-Forwarded-For can't be used: its first entry is
    # whatever the browser wrote, and uvicorn (--forwarded-allow-ips "*") trusts exactly that entry.
    return request.headers.get("cf-connecting-ip") or (request.client.host if request.client else "unknown")


async def allowed(ip: str) -> bool:
    # one counter per time window; the key expires with the window, so nothing needs cleaning up
    try:
        for window, limit in ((60, PER_MINUTE), (86400, PER_DAY)):
            key = f"scanrate:{window}:{ip}"
            count = await db.incr(key)
            if count == 1:
                await db.expire(key, window)
            if count > limit:
                return False
    except redis.RedisError as err:
        # without Redis the codes don't work either; don't add a second failure on top
        print("redis error:", err)
    return True


@app.post("/scan/hash")
async def scan_hash(body: HashIn, request: Request):
    sha256 = body.sha256.lower()  # VirusTotal and the cache key both use lowercase
    key = f"scan:{sha256}"

    try:
        cached = await db.get(key)
        if cached:
            return json.loads(cached)
    except redis.RedisError as err:
        print("redis error:", err)

    if not await allowed(client_ip(request)):
        return result("error", message="too many hash checks from your network, try again later")

    answer = await lookup(sha256)
    if answer["status"] != "error":
        # errors aren't cached: the next try may succeed
        try:
            await db.set(key, json.dumps(answer), ex=CACHE_TTL)
        except redis.RedisError as err:
            print("redis error:", err)
    return answer
