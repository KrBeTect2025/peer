import json
import time
import urllib.request

metered_cache: tuple[float, list] = (0.0, [])


def metered_ice_servers(url: str):
    global metered_cache
    fetched_at, servers = metered_cache
    if not servers or time.time() - fetched_at > 3600:
        try:
            with urllib.request.urlopen(url, timeout=5) as resp:
                servers = json.load(resp)
            metered_cache = (time.time(), servers)
        except Exception:
            if not servers:
                raise
            metered_cache = (time.time() - 3600 + 60, servers)
    return servers
