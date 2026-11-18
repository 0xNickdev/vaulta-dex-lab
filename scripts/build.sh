#!/usr/bin/env bash
# Compiles every contract to build/<name>/<name>.wasm + <name>.abi.
#
# The compiler (cdt-cpp from Antelope CDT 4.1.1) exists only for linux/amd64,
# so it always runs inside a Docker container, never on the host.
#
# Image selection:
#   1. $CDT_IMAGE if you set it;
#   2. otherwise vaulta-dex-lab-cdt:4.1.1, built from docker/Dockerfile on first use.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE="${CDT_IMAGE:-vaulta-dex-lab-cdt:4.1.1}"

if ! docker info >/dev/null 2>&1; then
  echo "error: Docker is not running. Start Docker Desktop and retry." >&2
  exit 1
fi

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  if [ -n "${CDT_IMAGE:-}" ]; then
    echo "error: Docker image '$IMAGE' (from \$CDT_IMAGE) not found." >&2
    exit 1
  fi
  echo "==> image $IMAGE not found, building it from docker/Dockerfile"
  docker build --platform linux/amd64 -t "$IMAGE" "$ROOT/docker"
fi

# One source file = one contract. The contract name is the file name.
SOURCES=(
  contracts/token/token.cpp
  contracts/vault/vault.cpp
  contracts/pool/pool.cpp
)
shopt -s nullglob
for f in "$ROOT"/contracts/vulnerable/*.cpp; do
  SOURCES+=("contracts/vulnerable/$(basename "$f")")
done

# Build the list of compile commands and run them all in a single container
# (starting an emulated amd64 container is the slow part).
CMDS="set -e; cdt-cpp --version;"
for src in "${SOURCES[@]}"; do
  name="$(basename "$src" .cpp)"
  CMDS+=" echo '==> $name'; mkdir -p build/$name;"
  CMDS+=" cdt-cpp -abigen --no-missing-ricardian-clause -contract $name -o build/$name/$name.wasm $src;"
done

rm -rf "$ROOT/build"
docker run --rm --platform linux/amd64 -v "$ROOT":/work -w /work "$IMAGE" bash -c "$CMDS"

echo "==> done:"
ls -1 "$ROOT"/build/*/*.wasm
