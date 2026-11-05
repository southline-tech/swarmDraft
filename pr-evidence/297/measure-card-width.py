#!/usr/bin/env python3
"""Run measure-dom-width.mjs (Chrome CDP border-box width for .st-dlg--feedback)."""
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
proc = subprocess.run(["node", str(ROOT / "measure-dom-width.mjs")], check=False)
sys.exit(proc.returncode)
