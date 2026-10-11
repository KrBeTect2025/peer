import json
import time
import urllib.request

metered_cache: tuple[float, list] = (0.0, [])  # (fetched at, iceServers)


def metered_ice_servers(url: str):
    # the Metered API takes seconds to answer; its credentials don't change per request, so reuse them for an hour
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
            metered_cache = (
                time.time() - 3600 + 60,
                servers,
            )  # keep the old credentials, retry in a minute
    return servers
