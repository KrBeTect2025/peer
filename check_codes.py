# Smoke check for code states against a running server:
#   python check_codes.py [ws_base] [code_ttl]
#   e.g. python check_codes.py ws://localhost:8000      (default), or wss://<tunnel>.trycloudflare.com
# Pass code_ttl only if the server runs with that short CODE_TTL, to also check the 1-hour cutoff.
import asyncio
import json
import random
import ssl
import sys

import websockets

BASE = sys.argv[1] if len(sys.argv) > 1 else "ws://localhost:8000"
TTL = int(sys.argv[2]) if len(sys.argv) > 2 else 0
SSL = ssl._create_unverified_context() if BASE.startswith("wss") else None  # skip cert checks for wss


def url(code, send=False):
    return f"{BASE}/ws/file-{code}" + ("?role=send" if send else "")


async def close_code(ws):
    try:
        await asyncio.wait_for(ws.recv(), 10)  # the server re-checks expired codes every 5 s
    except websockets.ConnectionClosed as e:
        return e.rcvd.code if e.rcvd else None
    raise AssertionError("expected the server to close the socket")


async def main():
    code = f"{random.randrange(10**6):06d}"

    async with websockets.connect(url(code), ssl=SSL) as r:
        assert await close_code(r) == 4404, "unknown code must be 'no such code'"

    async with websockets.connect(url(code, send=True), ssl=SSL) as s:
        async with websockets.connect(url(code, send=True), ssl=SSL) as s2:
            assert await close_code(s2) == 4409, "a live code must not be handed out twice"
        async with websockets.connect(url(code), ssl=SSL) as r:
            assert json.loads(await s.recv())["type"] == "ready"
            await r.send("hi")
            assert await s.recv() == "hi", "messages must be relayed"
    await asyncio.sleep(0.5)

    async with websockets.connect(url(code), ssl=SSL) as r:
        assert await close_code(r) == 4410, "a code whose sender left must be 'expired'"
    async with websockets.connect(url(code, send=True), ssl=SSL) as s:
        assert await close_code(s) == 4409, "an expired code must not be reused"

    if TTL:
        # no receiver when the time is up: the sender is cut off at once
        code = f"{random.randrange(10**6):06d}"
        async with websockets.connect(url(code, send=True), ssl=SSL) as s:
            await asyncio.sleep(TTL + 1)
            assert await close_code(s) == 4410, "an idle sender must be cut off when the code's time is up"

        # a receiver connected when the time is up may finish; nobody new gets in
        code = f"{random.randrange(10**6):06d}"
        async with websockets.connect(url(code, send=True), ssl=SSL) as s:
            async with websockets.connect(url(code), ssl=SSL) as r:
                await s.recv()  # ready
                await asyncio.sleep(TTL + 1)
                async with websockets.connect(url(code), ssl=SSL) as r2:
                    assert await close_code(r2) == 4410, "no new receiver after the code's time is up"
                await r.send("still here")
                assert await s.recv() == "still here", "the running transfer must keep its signaling"
            # the receiver left: now the sender is cut off
            assert json.loads(await s.recv()) == {"type": "bye", "reason": "left"}
            assert await close_code(s) == 4410, "sender must be cut off once the last receiver leaves"
        async with websockets.connect(url(code, send=True), ssl=SSL) as s:
            assert await close_code(s) == 4409, "the expired code must not be handed out again"

    print("ok")


asyncio.run(main())
