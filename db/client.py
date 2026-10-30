import os

import config  # noqa: F401
import redis.asyncio as redis

# rediss:// (TLS) works too, e.g. Upstash in production.
# Short timeouts so a Redis outage fails fast instead of leaving "getting a code..." hanging;
# health checks reconnect after a hosted Redis closes an idle connection.
db = redis.from_url(
    os.getenv("REDIS_URL", "redis://localhost:6379/0"),
    decode_responses=True,
    socket_connect_timeout=5,
    socket_timeout=5,
    socket_keepalive=True,
    health_check_interval=30,
)
CODE_TTL = int(os.getenv("CODE_TTL", "3600"))
