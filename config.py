import os
from pathlib import Path

from dotenv import load_dotenv

BASE = Path(__file__).parent
load_dotenv(BASE / ".env")

# Metered TURN credentials URL (with ?apiKey=...): the relay for when the browsers can't connect directly
METERED_TURN_URL = os.getenv("METERED_TURN_URL")
