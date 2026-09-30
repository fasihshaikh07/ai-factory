#!/usr/bin/env bash
# Download the pinned raw files listed in sources.json into bench/external/raw/ (git-ignored).
# AIDev and OpenHands are read remotely by their derive scripts (DuckDB over HTTP), so only METR needs a download.
set -euo pipefail
cd "$(dirname "$0")"
mkdir -p raw
python3 - <<'PY' | while read -r dest url; do echo "fetch $dest"; curl -fsSL -o "$dest" "$url"; done
import json
for dest, url in json.load(open("sources.json"))["metr"]["files"].items():
    print(dest, url)
PY
shasum -a 256 raw/* | tee raw/SHA256SUMS
