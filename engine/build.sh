#!/usr/bin/env bash
# Builds src/code-execution/quickjs.wasm, code_execution's engine, from quickjs-ng's release pinned
# below, with the patches in engine/patches applied, and engine/interface.c, with a pinned
# toolchain: wasi-sdk 32, checked against the sha256 below, and binaryen 130.0.0's wasm-opt from
# npm, pinned by version (npm checks it against the registry's integrity hash), which runs once.
# The toolchain is fetched into ENGINE_TOOLCHAIN_DIR (default ~/.cache/agent-framework-engine), and
# quickjs-ng's source into this build's own scratch directory, at every build.
#
# The engine changes through the pin or a patch. To bump, change QUICKJS_TAG and QUICKJS_COMMIT to
# the new release, and its line and notice in src/code-execution/quickjs.wasm.LICENSES, and delete
# each patch the release has taken in. To patch, add a `git diff` made
# in a clone of quickjs-ng at QUICKJS_COMMIT to engine/patches/, with a .patch name: the patches
# are applied in the byte order of their names, and there are none today. Either way, run this and
# commit src/code-execution/quickjs.wasm with the change.
#
# On x86_64 Linux, the same sources and toolchain have given the same bytes on two machines, and CI
# rebuilds there and compares the result with the committed module. The pinned wasi-sdk is the
# x86_64 Linux build; elsewhere, set WASI_SDK to an install of wasi-sdk 32, whose output may then
# differ from the committed module.
#
# Usage: engine/build.sh [OUT]   (OUT defaults to src/code-execution/quickjs.wasm)
set -euo pipefail
# Byte order for the patches' names, whatever this machine's locale.
export LC_ALL=C

QUICKJS_TAG=v0.17.0
QUICKJS_COMMIT=6d46d07d04041b40f4f49eaa7fdebe44c314c699
WASI_SDK_URL=https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-32/wasi-sdk-32.0-x86_64-linux.tar.gz
WASI_SDK_SHA256=55fc523ebfbc98f69d1034fcfcb83d1ff5610cd9ab7eceef6cd097a30ba4ef93
BINARYEN_VERSION=130.0.0

here=$(cd "$(dirname "$0")" && pwd)
root=$(dirname "$here")
# Paths given relative to where this was run from, since it changes directory before it uses them.
absolute() { case $1 in /*) printf '%s\n' "$1" ;; *) printf '%s\n' "$PWD/$1" ;; esac; }
out=$(absolute "${1:-$root/src/code-execution/quickjs.wasm}")
cache=$(absolute "${ENGINE_TOOLCHAIN_DIR:-$HOME/.cache/agent-framework-engine}")
if [ -n "${WASI_SDK:-}" ]; then WASI_SDK=$(absolute "$WASI_SDK"); fi
mkdir -p "$cache"

if [ -z "${WASI_SDK:-}" ]; then
  if [ "$(uname -s)-$(uname -m)" != "Linux-x86_64" ]; then
    echo "build.sh: the pinned wasi-sdk is the x86_64 Linux build; set WASI_SDK to an install of wasi-sdk 32" >&2
    exit 1
  fi
  WASI_SDK=$cache/wasi-sdk-32
  if [ ! -x "$WASI_SDK/bin/clang" ]; then
    tarball=$cache/wasi-sdk-32.tar.gz
    curl -fsSL -o "$tarball" "$WASI_SDK_URL"
    echo "$WASI_SDK_SHA256  $tarball" | sha256sum -c --quiet -
    rm -rf "$WASI_SDK.tmp"
    mkdir -p "$WASI_SDK.tmp"
    tar -xzf "$tarball" -C "$WASI_SDK.tmp" --strip-components=1
    rm "$tarball"
    mv "$WASI_SDK.tmp" "$WASI_SDK"
  fi
fi
WASM_OPT=$cache/binaryen-$BINARYEN_VERSION/node_modules/.bin/wasm-opt
if [ ! -x "$WASM_OPT" ]; then
  # npm checks the package against the registry's integrity hash. The directory gets a
  # package.json of its own first: without one, npm installs into the nearest directory above
  # that has one.
  rm -rf "$cache/binaryen-$BINARYEN_VERSION"
  mkdir -p "$cache/binaryen-$BINARYEN_VERSION"
  echo '{ "private": true }' > "$cache/binaryen-$BINARYEN_VERSION/package.json"
  (cd "$cache/binaryen-$BINARYEN_VERSION" && npm install --silent --no-audit --no-fund --no-save "binaryen@$BINARYEN_VERSION" >/dev/null)
fi

CC=$WASI_SDK/bin/clang
SYSROOT=$WASI_SDK/share/wasi-sysroot
build=$(mktemp -d)
trap 'rm -rf "$build"' EXIT

# git with none of this machine's configuration: no system or global config or attributes file, no
# hooks, no templates (it gets an empty directory of them), and no GIT_ variable from the
# environment but the network's (GIT_SSL_*, GIT_HTTP_*, GIT_PROXY_*). Any of the rest can change
# what a checkout or a patch writes, or where, while HEAD still names the pin; the network's carry
# only the fetch, whose objects the commit check after the clone stands for. So a proxy or a CA
# reaches the clone from the environment alone (https_proxy, HTTPS_PROXY, all_proxy,
# GIT_SSL_CAINFO), and a mirror a builder's git configuration names isn't taken.
nogit_home=$build/home
mkdir -p "$nogit_home/templates"
pinned_git() (
  for v in $(compgen -e); do
    case $v in
      GIT_SSL_* | GIT_HTTP_* | GIT_PROXY_*) ;;
      GIT_*) unset "$v" ;;
    esac
  done
  export HOME="$nogit_home" XDG_CONFIG_HOME="$nogit_home" GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 \
    GIT_ATTR_NOSYSTEM=1 GIT_TEMPLATE_DIR="$nogit_home/templates"
  git -c core.attributesFile=/dev/null -c core.hooksPath=/dev/null -c core.autocrlf=false "$@"
)

# quickjs-ng at the pin, checked by its commit, whose hash names every byte of its files. The
# clone writes them as they're committed: upstream's .gitattributes only marks files for diffs.
src=$build/src
mkdir -p "$src"
pinned_git -c advice.detachedHead=false \
  clone --quiet --depth 1 --branch "$QUICKJS_TAG" https://github.com/quickjs-ng/quickjs.git "$src/quickjs-ng"
got=$(pinned_git -C "$src/quickjs-ng" rev-parse HEAD)
if [ "$got" != "$QUICKJS_COMMIT" ]; then
  echo "build.sh: quickjs-ng $QUICKJS_TAG is $got upstream, not the pinned $QUICKJS_COMMIT" >&2
  exit 1
fi
# The patches, each a regular file named *.patch, in an engine/patches that's a directory.
if { [ -e "$here/patches" ] || [ -L "$here/patches" ]; } && { [ ! -d "$here/patches" ] || [ -L "$here/patches" ]; }; then
  echo "build.sh: engine/patches isn't a directory (a symbolic link, even to one, isn't taken); make it one, or remove it" >&2
  exit 1
fi
shopt -s nullglob dotglob
patches=("$here"/patches/*)
shopt -u nullglob dotglob
# Guarded, since bash before 4.4 calls an empty array's expansion unbound under set -u.
for patch in ${patches[@]+"${patches[@]}"}; do
  if [ "${patch%.patch}" = "$patch" ] || [ -L "$patch" ] || [ ! -f "$patch" ]; then
    echo "build.sh: engine/patches/${patch##*/} isn't a regular file named *.patch (a symbolic link, even to one, isn't taken); make it one, or remove it" >&2
    exit 1
  fi
  if ! pinned_git -C "$src/quickjs-ng" apply "$patch"; then
    echo "build.sh: engine/patches/${patch##*/} doesn't apply to quickjs-ng $QUICKJS_TAG" >&2
    exit 1
  fi
done
cp "$here/interface.c" "$src/interface.c"

# Relative paths, so nothing of this machine's layout, nor the scratch directory's, reaches the
# module: the sources are compiled as quickjs-ng/*.c and interface.c, as they always have been.
cd "$src"
CFLAGS=(
  --target=wasm32-wasip1 --sysroot="$SYSROOT" -Oz -flto
  -Iquickjs-ng -D_GNU_SOURCE -DQJS_BUILD_LIBC=0
  -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_SIGNAL
  -fvisibility=hidden
  -Wall -Wno-implicit-fallthrough -Wno-sign-compare -Wno-missing-field-initializers
  -Wno-unused-parameter -Wno-unused-but-set-variable
)
for f in quickjs dtoa libregexp libunicode; do
  "$CC" "${CFLAGS[@]}" -c "quickjs-ng/$f.c" -o "$build/$f.o"
done
"$CC" "${CFLAGS[@]}" -Werror -c interface.c -o "$build/interface.o"

# A reactor whose memory the host makes, so the host sets its maximum, the child's budget.
# The stack sits first in memory, at [0, 1 MiB), growing down from its top. QuickJS's limit is
# set below the top as engine_init finds it, 192 KiB at most, and recursion its checks don't see
# that runs past the stack's bottom wraps below address 0, past the memory's end, and traps
# rather than writing over data.
"$CC" --target=wasm32-wasip1 --sysroot="$SYSROOT" -Oz -flto -mexec-model=reactor \
  -lwasi-emulated-process-clocks -lwasi-emulated-signal \
  -Wl,--import-memory -Wl,--stack-first -Wl,-z,stack-size=1048576 -Wl,--strip-debug \
  "$build"/*.o -o "$build/linked.wasm"

"$WASM_OPT" -Oz --strip-debug --strip-producers "$build/linked.wasm" -o "$build/quickjs.wasm"
mkdir -p "$(dirname "$out")"
cp "$build/quickjs.wasm" "$out"
# macOS has shasum, not sha256sum.
if command -v sha256sum >/dev/null; then sum=$(sha256sum "$out"); else sum=$(shasum -a 256 "$out"); fi
size=$(wc -c < "$out")
echo "${sum%% *}  ${size// /} bytes  $out"
