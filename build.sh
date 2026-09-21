#!/usr/bin/env bash
set -Eeuo pipefail

###############################################################################
# WebPython2 - CPython wasm32-emscripten build
#
# Goals:
#   - Reproducible Codespaces build
#   - Use CPython's official Platforms/emscripten "build all"
#   - Install/use Node.js 24 without modifying CPython
#   - Install the exact Emscripten SDK required by this CPython checkout
#   - Keep a persistent build log
#   - Preserve existing build data so failed builds can be resumed
#   - Package the resulting Python WASM build into a ZIP
###############################################################################

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CPYTHON="$ROOT/cpython"
CROSS_BUILD="$CPYTHON/cross-build"
EMSDK_CACHE="$CROSS_BUILD/emsdk"

LOG_DIR="$ROOT/logs"
DIST_DIR="$ROOT/dist"

mkdir -p "$LOG_DIR" "$DIST_DIR"

LOG_FILE="$LOG_DIR/build.log"

# Keep everything visible in the terminal AND save it permanently.
exec > >(tee -a "$LOG_FILE") 2>&1

START_TIME="$(date '+%Y-%m-%d %H:%M:%S')"

echo
echo "============================================================"
echo " WebPython2 - CPython WASM Build"
echo "============================================================"
echo "Start : $START_TIME"
echo "Root  : $ROOT"
echo "Log   : $LOG_FILE"
echo "============================================================"
echo

###############################################################################
# Error handler
###############################################################################

on_error() {
    local exit_code=$?
    echo
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    echo " BUILD FAILED"
    echo " Exit code : $exit_code"
    echo " Log file  : $LOG_FILE"
    echo "!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
    exit "$exit_code"
}

trap on_error ERR

###############################################################################
# 1. Basic tools
###############################################################################

echo "[1/7] Checking basic tools..."

for cmd in git python3 curl bash tar; do
    if ! command -v "$cmd" >/dev/null 2>&1; then
        echo "ERROR: required command not found: $cmd"
        exit 1
    fi
done

echo "git     : $(git --version)"
echo "python  : $(python3 --version)"
echo "curl    : $(curl --version | head -n 1)"
echo

###############################################################################
# 2. Get CPython
###############################################################################

echo "[2/7] Preparing CPython..."

if [ ! -d "$CPYTHON/.git" ]; then
    echo "CPython checkout not found."
    echo "Cloning official CPython repository..."

    git clone \
        --depth 1 \
        https://github.com/python/cpython.git \
        "$CPYTHON"
else
    echo "Existing CPython checkout detected."
fi

cd "$CPYTHON"

echo
echo "CPython commit:"
git rev-parse --short HEAD

echo
echo "CPython branch:"
git branch --show-current || true

echo

###############################################################################
# 3. Install / activate Node.js 24
###############################################################################

echo "[3/7] Preparing Node.js 24..."

# CPython's Emscripten build currently requires Node 24.
# Prefer an already-installed Node 24.
NODE_BIN=""

if command -v node >/dev/null 2>&1; then
    CURRENT_NODE="$(node --version 2>/dev/null || true)"

    if [[ "$CURRENT_NODE" =~ ^v24\. ]]; then
        NODE_BIN="$(command -v node)"
        echo "Using existing Node.js:"
        echo "  $NODE_BIN"
        echo "  $CURRENT_NODE"
    else
        echo "Existing Node.js is $CURRENT_NODE, not Node 24."
    fi
fi

# If a suitable Node is not already available, install NVM locally.
if [ -z "$NODE_BIN" ]; then

    export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

    if [ ! -s "$NVM_DIR/nvm.sh" ]; then
        echo "NVM not found."
        echo "Installing NVM into:"
        echo "  $NVM_DIR"

        curl -fsSL \
            https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh \
            | bash
    fi

    # shellcheck disable=SC1090
    source "$NVM_DIR/nvm.sh"

    echo "Installing/activating Node.js 24..."
    nvm install 24
    nvm use 24
    nvm alias default 24 >/dev/null

    NODE_BIN="$(command -v node)"
fi

if [ -z "$NODE_BIN" ] || [ ! -x "$NODE_BIN" ]; then
    echo "ERROR: Node.js 24 could not be prepared."
    exit 1
fi

export PATH="$(dirname "$NODE_BIN"):$PATH"

echo
echo "Node executable:"
echo "  $NODE_BIN"

echo "Node version:"
node --version

echo "npm version:"
npm --version

# Final major-version verification.
NODE_MAJOR="$(node --version | sed 's/^v//' | cut -d. -f1)"

if [ "$NODE_MAJOR" != "24" ]; then
    echo "ERROR: Expected Node.js 24.x, got Node.js $NODE_MAJOR.x"
    exit 1
fi

echo

###############################################################################
# 4. Install exact Emscripten SDK
###############################################################################

echo "[4/7] Installing / validating exact Emscripten SDK..."

mkdir -p "$EMSDK_CACHE"

export EMSDK_CACHE

echo "EMSDK_CACHE:"
echo "  $EMSDK_CACHE"

echo
echo "Running CPython's official Emscripten installer..."

python3 Platforms/emscripten install-emscripten \
    --emsdk-cache "$EMSDK_CACHE"

echo
echo "Emscripten installation/validation complete."
echo

###############################################################################
# 5. Build everything using official build system
###############################################################################

echo "[5/7] Building CPython for wasm32-emscripten..."
echo
echo "This uses:"
echo "  python3 Platforms/emscripten build all"
echo
echo "Node runner:"
echo "  $NODE_BIN"
echo

# IMPORTANT:
# --host-runner explicitly tells CPython which Node executable to use.
# This prevents CPython from trying to source ~/.nvm/nvm.sh itself.
#
# Do NOT add --clean here.
# Keeping the existing cross-build directory lets us resume after an error
# instead of rebuilding everything from zero.

python3 Platforms/emscripten build all \
    --emsdk-cache "$EMSDK_CACHE" \
    --host-runner "$NODE_BIN"

echo
echo "CPython official build command completed successfully."
echo

###############################################################################
# 6. Verify resulting files
###############################################################################

echo "[6/7] Searching for Python WASM output..."

WASM_ROOT="$CROSS_BUILD/wasm32-emscripten"

if [ ! -d "$WASM_ROOT" ]; then
    echo "ERROR: Expected build directory not found:"
    echo "  $WASM_ROOT"
    exit 1
fi

echo
echo "Searching for python.wasm..."
echo

mapfile -t WASM_FILES < <(
    find "$WASM_ROOT" \
        -type f \
        -name "python.wasm" \
        -print
)

if [ "${#WASM_FILES[@]}" -eq 0 ]; then
    echo "ERROR: python.wasm was not found."
    echo
    echo "Relevant files currently present:"
    find "$WASM_ROOT" \
        -type f \
        \( \
            -name "python.js" -o \
            -name "python.html" -o \
            -name "*.wasm" \
        \) \
        -print | head -n 100
    exit 1
fi

echo "FOUND:"
for wasm in "${WASM_FILES[@]}"; do
    ls -lh "$wasm"
done

echo

###############################################################################
# 7. Package the host build
###############################################################################

echo "[7/7] Packaging WASM build..."

# CPython's Emscripten host build is normally here.
HOST_BUILD="$WASM_ROOT/build/python"

if [ ! -d "$HOST_BUILD" ]; then
    echo "WARNING: expected host build directory was not found:"
    echo "  $HOST_BUILD"
    echo
    echo "Packaging the WASM-containing directory instead."
    HOST_BUILD="$WASM_ROOT"
fi

TIMESTAMP="$(date '+%Y%m%d-%H%M%S')"

PACKAGE_DIR="$DIST_DIR/python-wasm-$TIMESTAMP"
PACKAGE_ZIP="$DIST_DIR/python-wasm-$TIMESTAMP.zip"

rm -rf "$PACKAGE_DIR"
mkdir -p "$PACKAGE_DIR"

echo
echo "Copying build output..."
cp -a "$HOST_BUILD"/. "$PACKAGE_DIR"/

echo
echo "Creating ZIP:"
echo "  $PACKAGE_ZIP"

(
    cd "$DIST_DIR"
    zip -r -q \
        "$(basename "$PACKAGE_ZIP")" \
        "$(basename "$PACKAGE_DIR")"
)

echo
echo "============================================================"
echo " BUILD SUCCESS!"
echo "============================================================"
echo
echo "python.wasm:"
for wasm in "${WASM_FILES[@]}"; do
    echo "  $wasm"
done

echo
echo "Package:"
echo "  $PACKAGE_ZIP"

echo
echo "Package size:"
ls -lh "$PACKAGE_ZIP"

echo
echo "Persistent build log:"
echo "  $LOG_FILE"

echo
echo "Finished:"
date '+%Y-%m-%d %H:%M:%S'

echo
echo "============================================================"
echo " NEXT STEP"
echo "============================================================"
echo
echo "Download the ZIP from:"
echo "  $PACKAGE_ZIP"
echo
