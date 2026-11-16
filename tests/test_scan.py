# Tests for POST /scan/hash. VirusTotal is faked with respx and Redis with fakeredis,
# so no test ever calls the real VirusTotal API or needs a Redis server.
#   python -m pytest tests
import fakeredis
import httpx
import pytest
import respx
from fastapi.testclient import TestClient

import config
import main  # noqa: F401  (registers every route)
from core.server import app
from routers import scan

HASH = "a" * 64
VT = f"https://www.virustotal.com/api/v3/files/{HASH}"


def report(**stats):
    return {"data": {"attributes": {"last_analysis_stats": stats}}}


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setattr(config, "VT_API_KEY", "test-key")
    monkeypatch.setattr(scan, "db", fakeredis.FakeAsyncRedis(decode_responses=True))
    with respx.mock(assert_all_called=False) as vt:
        c = TestClient(app)
        c.vt = vt
        yield c


def ask(client, sha256=HASH, ip="1.1.1.1"):
    return client.post("/scan/hash", json={"sha256": sha256}, headers={"cf-connecting-ip": ip})


def test_malicious(client):
    client.vt.get(VT).respond(200, json=report(malicious=12, suspicious=1, undetected=50, harmless=7, **{"type-unsupported": 5}))
    body = ask(client).json()
    assert body["status"] == "malicious"
    assert (body["malicious_count"], body["suspicious_count"], body["engines_total"]) == (12, 1, 70)


def test_suspicious(client):
    client.vt.get(VT).respond(200, json=report(malicious=0, suspicious=2, undetected=60))
    body = ask(client).json()
    assert body["status"] == "suspicious"
    assert body["suspicious_count"] == 2


def test_clean(client):
    client.vt.get(VT).respond(200, json=report(malicious=0, suspicious=0, undetected=60, harmless=10))
    body = ask(client).json()
    assert body["status"] == "clean"
    assert body["engines_total"] == 70


def test_known_but_never_scanned_is_unknown_not_clean(client):
    client.vt.get(VT).respond(200, json=report(malicious=0, suspicious=0, undetected=0))
    assert ask(client).json()["status"] == "unknown"


def test_unknown_404(client):
    client.vt.get(VT).respond(404, json={"error": {"code": "NotFoundError"}})
    assert ask(client).json()["status"] == "unknown"


def test_timeout(client):
    client.vt.get(VT).mock(side_effect=httpx.ReadTimeout("slow"))
    body = ask(client).json()
    assert body["status"] == "error"
    assert "too long" in body["message"]


def test_rate_limited_by_virustotal(client):
    client.vt.get(VT).respond(429, json={"error": {"code": "QuotaExceededError"}})
    body = ask(client).json()
    assert body["status"] == "error"
    assert "rate limit" in body["message"]


def test_unreadable_reply(client):
    client.vt.get(VT).respond(200, json={"data": {}})
    assert ask(client).json()["status"] == "error"


def test_missing_api_key(client, monkeypatch):
    monkeypatch.setattr(config, "VT_API_KEY", "")
    route = client.vt.get(VT)
    body = ask(client).json()
    assert body["status"] == "error"
    assert "VT_API_KEY" in body["message"]
    assert not route.called  # never contacts VirusTotal without a key


@pytest.mark.parametrize("bad", ["", "abc", "g" * 64, "a" * 63, "a" * 65, HASH + "\n"])
def test_invalid_hash_is_422(client, bad):
    assert client.post("/scan/hash", json={"sha256": bad}).status_code == 422


def test_missing_field_is_422(client):
    assert client.post("/scan/hash", json={}).status_code == 422


def test_cache_hit_skips_virustotal(client):
    route = client.vt.get(VT).respond(200, json=report(undetected=60))
    assert ask(client).json()["status"] == "clean"
    # uppercase is the same hash, so it must come from the cache too
    assert ask(client, HASH.upper()).json()["status"] == "clean"
    assert route.call_count == 1


def test_errors_are_not_cached(client):
    route = client.vt.get(VT)
    route.side_effect = [httpx.Response(429), httpx.Response(200, json=report(undetected=60))]
    assert ask(client).json()["status"] == "error"
    assert ask(client).json()["status"] == "clean"
    assert route.call_count == 2


def test_per_ip_limit(client):
    # every request is a new hash, so none are cache hits
    client.vt.get(url__regex=r".*/files/.*").respond(404)
    hashes = [f"{i:064x}" for i in range(scan.PER_MINUTE + 1)]
    answers = [ask(client, h).json() for h in hashes]
    assert all(a["status"] == "unknown" for a in answers[:-1])
    assert answers[-1]["status"] == "error" and "too many" in answers[-1]["message"]
    # someone else is not affected
    assert ask(client, "f" * 64, ip="2.2.2.2").json()["status"] == "unknown"


def test_client_ip_prefers_cloudflare_header():
    # X-Forwarded-For is written by the browser, so it must never decide whose limit is used
    def req(headers):
        scope = {"type": "http", "headers": [(k.encode(), v.encode()) for k, v in headers.items()], "client": ("9.9.9.9", 1)}
        return scan.Request(scope)

    assert scan.client_ip(req({"cf-connecting-ip": "3.3.3.3", "x-forwarded-for": "10.0.0.1"})) == "3.3.3.3"
    assert scan.client_ip(req({"x-forwarded-for": "10.0.0.1"})) == "9.9.9.9"


def test_api_key_never_in_reply(client):
    client.vt.get(VT).respond(200, json=report(undetected=60))
    assert "test-key" not in ask(client).text
