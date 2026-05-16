#!/usr/bin/env bash
# Serve demo/ on http://localhost:8765 so the wasm + pthreads + JSPI features
# work (file:// won't). Python is the no-deps option.
cd "$(dirname "$0")"
python3 -m http.server 8765
