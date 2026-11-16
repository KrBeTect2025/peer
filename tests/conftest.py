# lets the tests import the app's modules (config, routers, ...) from the repo root
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))
