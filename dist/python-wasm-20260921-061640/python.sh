#!/bin/sh

# Macs come with FreeBSD coreutils which doesn't have the -s option
# so feature detect and work around it.
if which grealpath > /dev/null 2>&1; then
    # It has brew installed gnu core utils, use that
    REALPATH="grealpath -s"
elif which realpath > /dev/null 2>&1 && realpath --version > /dev/null 2>&1 && realpath --version | grep GNU > /dev/null 2>&1; then
    # realpath points to GNU realpath so use it.
    REALPATH="realpath -s"
else
    # Shim for macs without GNU coreutils
    abs_path () {
        echo "$(cd "$(dirname "$1")" || exit; pwd)/$(basename "$1")"
    }
    REALPATH=abs_path
fi

# Before node 24, --experimental-wasm-jspi uses different API,
# After node 24 JSPI is on by default.
ARGS=$(/home/codespace/nvm/current/bin/node -e "$(cat <<"EOF"
const major_version = Number(process.version.split(".")[0].slice(1));
if (major_version === 24) {
    process.stdout.write("--experimental-wasm-jspi");
}
EOF
)")

# We compute our own path, not following symlinks and pass it in so that
# node_entry.mjs can set sys.executable correctly.
# Intentionally allow word splitting on NODEFLAGS.
exec /home/codespace/nvm/current/bin/node $NODEFLAGS $ARGS /workspaces/MyPython/cpython/cross-build/wasm32-emscripten/build/python/node_entry.mjs --this-program="$($REALPATH "$0")" "$@"
