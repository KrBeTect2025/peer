import os
from pathlib import Path

from dotenv import load_dotenv

BASE = Path(__file__).parent
load_dotenv(BASE / ".env")

# Metered TURN credentials URL (with ?apiKey=...)
METERED_TURN_URL = os.getenv("METERED_TURN_URL")

# VirusTotal API key for the hash lookup (POST /scan/hash). Server only: never sent to the browser.
# Without it the app still works and the receiver sees "Hash check unavailable".
VT_API_KEY = os.getenv("VT_API_KEY", "")
