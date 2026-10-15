"""Make `walfly_asr` importable when pytest runs from the repo root."""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
