# Build environment for the contracts: Ubuntu 22.04 + Antelope CDT 4.1.1.
#
# CDT publishes only an amd64 .deb, so on Apple Silicon this image must be
# built and run with `--platform linux/amd64` (Docker Desktop emulates it).
#
#   docker build --platform linux/amd64 -t vaulta-dex-lab-cdt:4.1.1 docker/
#
# scripts/build.sh builds this image automatically when it is missing.
FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ARG CDT_VERSION=4.1.1

RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl \
 && curl -fsSL -o /tmp/cdt.deb \
      "https://github.com/AntelopeIO/cdt/releases/download/v${CDT_VERSION}/cdt_${CDT_VERSION}-1_amd64.deb" \
 && apt-get install -y /tmp/cdt.deb \
 && rm /tmp/cdt.deb \
 && rm -rf /var/lib/apt/lists/*

# Spring (nodeos/cleos) is NOT installed: the tests run in the VeRT emulator
# on the host, so only the compiler is needed here.

WORKDIR /work
