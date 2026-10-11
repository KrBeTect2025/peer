import os

import config  # noqa: F401  (loads .env before REDIS_URL / CODE_TTL are read)
import redis.asyncio as redis

# redis holds each code's state: "active" while its sender is connected (max CODE_TTL),
# then "expired" for another CODE_TTL, so a stale code reads as expired and a typo as wrong
db = redis.from_url(
    os.getenv("REDIS_URL", "redis://localhost:6379/0"), decode_responses=True
)
CODE_TTL = int(os.getenv("CODE_TTL", "3600"))  # a code lives 1 hour at most
