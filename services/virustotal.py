# Asks VirusTotal whether a SHA-256 hash belongs to a known malicious file.
# Only the hash is sent: VirusTotal compares it with files other people have already uploaded,
# so the file being shared never leaves the two browsers.
import httpx

import config

VT_URL = "https://www.virustotal.com/api/v3/files/{}"
# short: the receiver is waiting on this, and a slow answer is worth less than "unavailable" now
TIMEOUT = httpx.Timeout(5.0)


def result(status: str, malicious=0, suspicious=0, total=0, message=""):
    return {
        "status": status,
        "malicious_count": malicious,
        "suspicious_count": suspicious,
        "engines_total": total,
        "message": message,
    }


def from_report(report: dict) -> dict:
    # last_analysis_stats counts how many antivirus engines gave each verdict on their last scan
    stats = report["data"]["attributes"]["last_analysis_stats"]
    malicious = stats.get("malicious", 0)
    suspicious = stats.get("suspicious", 0)
    # engines that gave a verdict; "type-unsupported", "timeout" and "failure" didn't really look at it
    total = malicious + suspicious + stats.get("undetected", 0) + stats.get("harmless", 0)
    if malicious:
        return result("malicious", malicious, suspicious, total)
    if suspicious:
        return result("suspicious", malicious, suspicious, total)
    if total == 0:
        # known hash but no engine has scanned it yet: calling that "clean" would be a lie
        return result("unknown", message="VirusTotal knows this file but has no scan results yet")
    return result("clean", total=total)


async def lookup(sha256: str) -> dict:
    # read at call time (not import time) so a missing key can't crash startup, and tests can change it
    key = config.VT_API_KEY
    if not key:
        return result("error", message="not set up on this server (VT_API_KEY is not set)")
    try:
        async with httpx.AsyncClient(timeout=TIMEOUT) as client:
            resp = await client.get(VT_URL.format(sha256), headers={"x-apikey": key})
    except httpx.TimeoutException:
        return result("error", message="VirusTotal took too long to answer")
    except httpx.HTTPError as err:
        print("virustotal request failed:", err)
        return result("error", message="couldn't reach VirusTotal")

    if resp.status_code == 404:
        # VirusTotal has never seen this file. Most files people make themselves land here.
        return result("unknown", message="not in the VirusTotal database")
    if resp.status_code == 429:
        # free key: 4 lookups a minute and 500 a day, shared by everyone using this site
        return result("error", message="VirusTotal's rate limit was reached, try again later")
    if resp.status_code in (401, 403):
        print("virustotal rejected the API key:", resp.status_code)
        return result("error", message="VirusTotal rejected this server's API key")
    if resp.status_code != 200:
        print("virustotal answered", resp.status_code)
        return result("error", message=f"VirusTotal answered {resp.status_code}")
    try:
        return from_report(resp.json())
    except (ValueError, KeyError, TypeError) as err:
        # a reply we don't understand must not crash the endpoint
        print("unexpected virustotal reply:", err)
        return result("error", message="unexpected reply from VirusTotal")
