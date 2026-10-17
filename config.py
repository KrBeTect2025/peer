import os
from pathlib import Path

from dotenv import load_dotenv

BASE = Path(__file__).parent
load_dotenv(BASE / ".env")

# Metered TURN credentials URL (with ?apiKey=...)
METERED_TURN_URL = os.getenv("METERED_TURN_URL")
