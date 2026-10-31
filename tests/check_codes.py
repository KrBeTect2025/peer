# Smoke check for code states against a running server:
#   python tests/check_codes.py [ws_base] [code_ttl]
#   e.g. python tests/check_codes.py ws://localhost:8000      (default), or wss://<tunnel>.trycloudflare.com
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
    # the server sends {"type": "closed", "code": ...} before closing, because some proxies (Render's)
    # drop the close frame; where the frame does arrive, it must carry the same code
    sent = None
    try:
        while True:
            msg = json.loads(await asyncio.wait_for(ws.recv(), 10))  # the server re-checks expired codes every 5 s
            assert msg.get("type") == "closed" and sent is None, f"expected the server to close the socket, got {msg}"
            sent = msg["code"]
    except websockets.ConnectionClosed as e:
        if e.rcvd and sent is not None:
            assert e.rcvd.code == sent, f"close frame {e.rcvd.code} differs from the announced {sent}"
        return sent if sent is not None else e.rcvd.code if e.rcvd else None
    except TimeoutError:
        if sent is not None:
            return sent  # announced, but the proxy swallowed the close frame
        raise


async def main():
    code = f"{random.randrange(10**6):06d}"

    async with websockets.connect(url(code), ssl=SSL) as r:
        assert await close_code(r) == 4404, "unknown code must be 'no such code'"

    async with websockets.connect(url(code, send=True), ssl=SSL) as s:
        assert json.loads(await s.recv()) == {"type": "created"}, "the sender must be told once its code exists"
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
            assert json.loads(await s.recv()) == {"type": "created"}, "the sender must be told once its code exists"
            await asyncio.sleep(TTL + 1)
            assert await close_code(s) == 4410, "an idle sender must be cut off when the code's time is up"

        # a receiver connected when the time is up may finish; nobody new gets in
        code = f"{random.randrange(10**6):06d}"
        async with websockets.connect(url(code, send=True), ssl=SSL) as s:
            assert json.loads(await s.recv()) == {"type": "created"}, "the sender must be told once its code exists"
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
