import os

import config  # noqa: F401
import redis.asyncio as redis

db = redis.from_url(
    os.getenv("REDIS_URL", "redis://localhost:6379/0"), decode_responses=True
)
CODE_TTL = int(os.getenv("CODE_TTL", "3600"))
