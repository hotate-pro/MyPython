#!/usr/bin/env bash
set -euo pipefail

echo "=========================================="
echo " WebPython2 - CPython WASM build"
echo "=========================================="

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CPYTHON="$ROOT/cpython"

cd "$ROOT"

echo
echo "[1/6] Checking tools..."
command -v git
command -v python3

python3 --version
git --version

echo
echo "[2/6] Getting CPython..."

if [ ! -d "$CPYTHON/.git" ]; then
    git clone --depth 1 https://github.com/python/cpython.git "$CPYTHON"
fi

cd "$CPYTHON"

echo
echo "[3/6] Installing Emscripten..."
python3 Platforms/emscripten install-emscripten

echo
echo "[4/6] Configuring build Python..."
python3 Platforms/emscripten configure-build-python

echo
echo "[5/6] Building native build Python..."
python3 Platforms/emscripten make-build-python

echo
echo "[6/6] Building Emscripten Python..."
python3 Platforms/emscripten configure-host
python3 Platforms/emscripten make-host

echo
echo "=========================================="
echo " BUILD SUCCESS!"
echo "=========================================="

python3 Platforms/emscripten pythoninfo-host